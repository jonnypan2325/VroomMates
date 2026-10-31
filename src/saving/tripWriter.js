import { SavedApiError, canonicalText, requestJSON, sameData } from './api';
import { canonicalSnapshot, readTrip } from './SavedTripsPanel';
import { followTitle } from './tripTitles';

/**
 * Why a save did not go through. `failed` may have been lost on the way and can be retried;
 * `refused` would only be refused again; `detached` means the trip is gone; `dropped` means the save
 * was let go (its trip deleted, or the account changed) and never sent; `conflict` means a new trip's
 * ID is already taken by different content.
 */
export class TripWriteError extends Error {
  constructor(kind, cause, retry = null) {
    super(cause?.message || kind);
    this.name = 'TripWriteError';
    this.kind = kind;
    this.status = cause instanceof SavedApiError ? cause.status : 0;
    this.retry = retry;
    this.cause = cause;
  }
}

const kindOf = (error, create) => {
  if (!(error instanceof SavedApiError)) return 'failed';
  if ([400, 413, 415].includes(error.status)) return 'refused';
  if (error.status === 409) return create ? 'conflict' : 'refused';
  if (error.status === 404 && !create) return 'detached';
  return 'failed';
};

/**
 * The one way the app writes to saved trips, for one signed-in account. Writes to a trip run one at a
 * time in order, whoever asks: the planner's auto-save, an open trip's edits, a rename in My trips, or
 * a copy. Each write is built when its turn comes, from the trip as last confirmed by the server, and
 * applies only its own change, so a later write never undoes an earlier one.
 *
 * The writer also remembers each trip as last confirmed, for anything that shows it.
 */
export default function createTripWriter(getAuth) {
  const trips = new Map();
  // The title facts each confirmed title was made from, when this writer made it.
  const facts = new Map();
  const queues = new Map();
  const failedCreates = new Set();
  // Trips whose copy here came through this queue, which a read from outside it may have overtaken.
  const written = new Set();
  // Trips deleted here: nothing more is sent for them, and nothing still on its way is kept.
  const forgotten = new Set();
  // Trips whose last write may or may not have been saved: the next write reads them again first.
  const uncertain = new Set();
  // The title such a write sent, with the facts it was made from.
  const unconfirmed = new Map();
  const listeners = new Set();
  let version = 0;
  let closed = false;

  const notify = () => { version += 1; listeners.forEach((listener) => listener()); };
  const confirm = (trip, made) => {
    trips.set(trip.id, trip);
    if (made) facts.set(trip.id, made);
    notify();
    return trip;
  };
  // The server's answer after a lost reply: a title the lost write sent came from that write's facts.
  const settle = (trip) => {
    const sent = unconfirmed.get(trip.id);
    uncertain.delete(trip.id);
    unconfirmed.delete(trip.id);
    written.add(trip.id);
    return confirm(trip, sent?.title === trip.title ? sent.facts : undefined);
  };
  const gone = (id) => { trips.delete(id); facts.delete(id); uncertain.delete(id); unconfirmed.delete(id); written.delete(id); };
  const queueFor = (id) => {
    if (!queues.has(id)) queues.set(id, { running: false, jobs: [], idle: [] });
    return queues.get(id);
  };

  async function createTrip(job) {
    const { body } = job;
    // An ID is random, so a trip found under it is this one, saved by an earlier try: what the server has stands.
    const find = async () => {
      try { return readTrip(await requestJSON(getAuth(), `/saved-trips/${body.id}`), body.id); } catch (error) {
        if (error instanceof SavedApiError && error.status === 404) return null;
        throw error;
      }
    };
    const earlier = job.reconcile ? await find() : null;
    if (earlier) return earlier;
    // A trip deleted, or an account left, while it was being checked for is not saved again.
    if (closed || forgotten.has(body.id)) throw new TripWriteError('dropped');
    let response;
    try { response = await requestJSON(getAuth(), '/saved-trips', { method: 'POST', body }); } catch (error) {
      const taken = error instanceof SavedApiError && error.status === 409 ? await find() : null;
      if (taken) return taken;
      throw error;
    }
    const saved = readTrip(response, body.id);
    if (saved.title !== body.title || !sameData(saved.snapshot, body.snapshot)) {
      throw new SavedApiError(409, 'TRIP_CONFLICT', 'The saved trip has different content.');
    }
    return saved;
  }

  async function updateTrip(job) {
    const { id, change } = job;
    if (failedCreates.has(id)) throw new TripWriteError('dropped');
    let current = trips.get(id);
    const editsSnapshot = typeof change.snapshot === 'function';
    if (uncertain.has(id) || (!current && (editsSnapshot || change.follow))) {
      current = readTrip(await requestJSON(getAuth(), `/saved-trips/${id}`), id);
      if (closed || forgotten.has(id)) throw new TripWriteError('dropped');
      settle(current);
    }
    const body = {};
    let title, follow;
    // A change that cannot be put into a valid save is refused: retrying would only fail the same way.
    try {
      if (change.snapshot !== undefined) body.snapshot = canonicalSnapshot(editsSnapshot ? change.snapshot(current.snapshot) : change.snapshot);
      title = change.title !== undefined ? canonicalText(change.title, 200, 200) : undefined;
    } catch (error) { throw new TripWriteError('refused', error); }
    // An automatic title follows its trip; checked against the title the server has now, so a rename always wins.
    // Follow facts can depend on the trip as confirmed now; a function works them out when the write runs.
    // If the new name cannot be made, the route still saves under the name it has.
    try {
      follow = typeof change.follow === 'function' && current ? change.follow(current, body.snapshot || current.snapshot) : change.follow;
      if (title === undefined && follow && current) {
        title = followTitle(current.title, facts.get(id) || follow.before, follow.after, current.created_at);
      }
    } catch (_) { follow = undefined; }
    if (title !== undefined && title !== current?.title) body.title = title;
    job.made = follow?.after;
    if (!Object.keys(body).length) return current;
    if (body.title && job.made) job.sent = { title: body.title, facts: job.made };
    const saved = readTrip(await requestJSON(getAuth(), `/saved-trips/${id}`, { method: 'PATCH', body }), id);
    if ((body.title && saved.title !== body.title) || (body.snapshot && !sameData(saved.snapshot, body.snapshot))) {
      throw new SavedApiError(503, 'INVALID_RESPONSE', 'The change could not be confirmed.');
    }
    return saved;
  }

  async function pump(id) {
    const queue = queueFor(id);
    if (queue.running) return;
    queue.running = true;
    while (queue.jobs.length) {
      const job = queue.jobs.shift();
      job.started = true;
      const create = job.kind === 'create';
      // A delete takes its turn, so nothing already on its way can land after it and bring the trip back.
      if (job.kind === 'delete') {
        try {
          await job.send();
          forget(id);
          job.resolve();
        } catch (error) { job.reject(error); }
        continue;
      }
      // A read after a lost reply brings the trip as remembered up to date; it ends quietly either way.
      if (job.kind === 'read') {
        // A closed writer asks nothing more of the old account's session.
        if (closed) { job.resolve(); continue; }
        try {
          const read = readTrip(await requestJSON(getAuth(), `/saved-trips/${id}`), id);
          if (!closed && !forgotten.has(id)) settle(read);
        } catch (error) {
          if (error instanceof SavedApiError && error.status === 404 && !closed) { gone(id); notify(); }
        }
        job.resolve();
        continue;
      }
      try {
        const saved = create ? await createTrip(job) : await updateTrip(job);
        if (closed || forgotten.has(id)) throw new TripWriteError('dropped');
        if (create) failedCreates.delete(id);
        // Facts belong to the title they made, which an adopted trip may no longer have.
        const made = create ? (saved.title === job.body.title ? job.facts : undefined) : job.made;
        written.add(id);
        job.resolve(confirm(saved, made));
      } catch (error) {
        if (closed || forgotten.has(id) || error instanceof TripWriteError) {
          job.reject(error instanceof TripWriteError && !forgotten.has(id) ? error : new TripWriteError('dropped'));
          continue;
        }
        const kind = kindOf(error, create);
        // A trip already read exists, whatever this attempt to save it says.
        if (create && kind !== 'conflict' && !trips.has(id)) failedCreates.add(id);
        if (kind === 'detached') { gone(id); notify(); }
        // A reply lost on its way may hide a write the server made, so the trip is read again: now, and
        // before the next write if that read fails too.
        if (kind === 'failed' && !create) {
          uncertain.add(id);
          if (job.sent) unconfirmed.set(id, job.sent);
          if (!queue.jobs.some((item) => item.kind === 'read')) queue.jobs.push(readJob(id));
        }
        // Retry sends the same change again, built afresh when its turn comes; a new trip checks its ID first.
        const retry = kind === 'failed' ? () => (create ? enqueue({ ...job, reconcile: true }) : enqueue({ kind: 'update', id, change: job.change })) : null;
        job.reject(new TripWriteError(kind, error, retry));
      }
    }
    queue.running = false;
    // An idle trip keeps no queue.
    queues.delete(id);
    queue.idle.splice(0).forEach((resolve) => resolve());
  }

  /** A trip deleted: writes still waiting are let go, and nothing more is remembered of it. */
  const forget = (id) => {
    forgotten.add(id);
    const queue = queues.get(id);
    if (queue) { queue.jobs.forEach((job) => job.reject(new TripWriteError('dropped'))); queue.jobs = []; }
    gone(id);
    failedCreates.delete(id);
    notify();
  };

  const readJob = (id) => {
    const entry = { kind: 'read', id };
    entry.promise = new Promise((yes) => { entry.resolve = yes; entry.reject = yes; });
    return entry;
  };

  function enqueue({ resolve, reject, started, promise, ...job }) {
    if (closed || forgotten.has(job.id)) return Promise.reject(new TripWriteError('dropped'));
    const queue = queueFor(job.id);
    // The planner's newer route replaces one still waiting: its latest route, from the oldest title facts.
    if (job.slot) {
      const waiting = queue.jobs.find((item) => item.slot === job.slot && !item.started);
      if (waiting) {
        const before = waiting.change.follow?.before;
        waiting.change = { ...job.change, ...(job.change.follow ? { follow: { ...job.change.follow, ...(before ? { before } : {}) } } : {}) };
        return waiting.promise;
      }
    }
    const entry = { ...job };
    entry.promise = new Promise((yes, no) => { entry.resolve = yes; entry.reject = no; });
    queue.jobs.push(entry);
    void pump(job.id);
    return entry.promise;
  }

  /** Resolves once every write to this trip so far has finished, however it ended. */
  const drain = (id) => {
    const queue = queues.get(id);
    return !queue || (!queue.running && !queue.jobs.length) ? Promise.resolve() : new Promise((resolve) => queue.idle.push(resolve));
  };

  return {
    /** Saves a new trip under `id`; `facts` are what its automatic title was made from. */
    create: ({ id, title, snapshot, facts: made }) => {
      failedCreates.delete(id);
      let body;
      try { body = { id, title: canonicalText(title, 200, 200), snapshot: canonicalSnapshot(snapshot) }; } catch (error) {
        return Promise.reject(new TripWriteError('refused', error));
      }
      return enqueue({ kind: 'create', id, facts: made, body });
    },
    /**
     * Changes a saved trip: `snapshot` is a new route or a function editing the confirmed one,
     * `title` a new name, and `follow` ({ before, after } title facts, or a function of the confirmed trip
     * and its new route giving them) lets an automatic title follow.
     * A `slot` lets a newer change of the same kind replace one still waiting.
     */
    update: (id, change, { slot } = {}) => enqueue({ kind: 'update', id, change, slot }),
    drain,
    /** As drain, and then the trip as remembered is the server's: read again after a lost reply, or a failure. */
    settled: async (id) => {
      await drain(id);
      if (closed || forgotten.has(id) || !uncertain.has(id)) return;
      const read = readJob(id);
      queueFor(id).jobs.push(read);
      void pump(id);
      await read.promise;
      if (uncertain.has(id)) throw new TripWriteError('failed');
    },
    forget,
    /** Deletes a trip in its turn through `send`, then forgets it; if `send` fails, later writes go on. */
    remove: (id, send) => (forgotten.has(id) ? Promise.resolve() : enqueue({ kind: 'delete', id, send })),
    /** The account changed: nothing waiting is sent, and nothing still on its way is kept. */
    close: () => {
      closed = true;
      queues.forEach((queue) => { queue.jobs.forEach((job) => job.reject(new TripWriteError('dropped'))); queue.jobs = []; });
    },
    /**
     * A trip read from the server, so later writes build on it: kept if it is at least as new as the
     * copy held, so an edit made on another device is never written over. A read wins a tie, except with
     * a copy from a save or read in turn here, which it may have overtaken on its way back. It also proves
     * the trip exists.
     */
    remember: (trip) => {
      if (closed || forgotten.has(trip.id)) return trips.get(trip.id);
      failedCreates.delete(trip.id);
      const held = trips.get(trip.id);
      const edited = (copy) => Date.parse(copy.updated_at || copy.created_at);
      if (!held || edited(trip) > edited(held) || (edited(trip) === edited(held) && !written.has(trip.id))) {
        written.delete(trip.id);
        // The title facts were for the copy held; the newer copy's title is followed from what callers say.
        if (held && held.title !== trip.title) facts.delete(trip.id);
        confirm(trip);
      }
      return trips.get(trip.id);
    },
    known: (id) => trips.get(id),
    /** How many trips have writes waiting or running; with an ID, whether this one does. */
    queued: (id) => (id === undefined ? queues.size : queues.has(id)),
    /** Whether the trip as remembered may be behind the server, after a write whose reply was lost. */
    uncertain: (id) => uncertain.has(id),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    version: () => version,
  };
}
