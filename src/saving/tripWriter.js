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
  const queueFor = (id) => {
    if (!queues.has(id)) queues.set(id, { running: false, jobs: [], idle: [] });
    return queues.get(id);
  };

  async function createTrip(job) {
    const { body } = job;
    let response;
    if (job.reconcile) {
      // An unclear earlier reply may still have saved it; the same ID finds it, if it has the same content.
      try { response = await requestJSON(getAuth(), `/saved-trips/${body.id}`); } catch (error) {
        if (!(error instanceof SavedApiError && error.status === 404)) throw error;
      }
    }
    if (!response) response = await requestJSON(getAuth(), '/saved-trips', { method: 'POST', body });
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
    if (!current && (editsSnapshot || change.follow)) current = readTrip(await requestJSON(getAuth(), `/saved-trips/${id}`), id);
    const body = {};
    if (change.snapshot !== undefined) body.snapshot = canonicalSnapshot(editsSnapshot ? change.snapshot(current.snapshot) : change.snapshot);
    let title = change.title !== undefined ? canonicalText(change.title, 200, 200) : undefined;
    // An automatic title follows its trip; checked against the title the server has now, so a rename always wins.
    if (title === undefined && change.follow && current) {
      title = followTitle(current.title, facts.get(id) || change.follow.before, change.follow.after, current.created_at);
    }
    if (title !== undefined && title !== current?.title) body.title = title;
    if (!Object.keys(body).length) return current;
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
      try {
        const saved = create ? await createTrip(job) : await updateTrip(job);
        if (closed) throw new TripWriteError('dropped');
        if (create) failedCreates.delete(id);
        const made = create ? job.facts : job.change.follow?.after;
        job.resolve(confirm(saved, made));
      } catch (error) {
        if (closed || error instanceof TripWriteError) { job.reject(error instanceof TripWriteError ? error : new TripWriteError('dropped')); continue; }
        const kind = kindOf(error, create);
        if (create && kind !== 'conflict') failedCreates.add(id);
        if (kind === 'detached') { trips.delete(id); facts.delete(id); notify(); }
        // Retry sends the same change again, built afresh when its turn comes; a new trip checks its ID first.
        const retry = kind === 'failed' ? () => (create ? enqueue({ ...job, reconcile: true }) : enqueue({ kind: 'update', id, change: job.change })) : null;
        job.reject(new TripWriteError(kind, error, retry));
      }
    }
    queue.running = false;
    queue.idle.splice(0).forEach((resolve) => resolve());
  }

  function enqueue({ resolve, reject, started, promise, ...job }) {
    if (closed) return Promise.reject(new TripWriteError('dropped'));
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

  return {
    /** Saves a new trip under `id`; `facts` are what its automatic title was made from. */
    create: ({ id, title, snapshot, facts: made }) => {
      failedCreates.delete(id);
      return enqueue({ kind: 'create', id, facts: made, body: { id, title: canonicalText(title, 200, 200), snapshot: canonicalSnapshot(snapshot) } });
    },
    /**
     * Changes a saved trip: `snapshot` is a new route or a function editing the confirmed one,
     * `title` a new name, and `follow` ({ before, after } title facts) lets an automatic title follow.
     * A `slot` lets a newer change of the same kind replace one still waiting.
     */
    update: (id, change, { slot } = {}) => enqueue({ kind: 'update', id, change, slot }),
    /** Resolves once every write to this trip so far has finished, however it ended. */
    drain: (id) => {
      const queue = queues.get(id);
      return !queue || (!queue.running && !queue.jobs.length) ? Promise.resolve() : new Promise((resolve) => queue.idle.push(resolve));
    },
    /** A trip deleted: writes still waiting are let go, and nothing more is remembered of it. */
    forget: (id) => {
      const queue = queues.get(id);
      if (queue) queue.jobs.filter((job) => !job.started).forEach((job) => job.reject(new TripWriteError('dropped')));
      if (queue) queue.jobs = queue.jobs.filter((job) => job.started);
      trips.delete(id); facts.delete(id); failedCreates.delete(id);
      notify();
    },
    /** The account changed: nothing waiting is sent, and nothing still on its way is kept. */
    close: () => {
      closed = true;
      queues.forEach((queue) => { queue.jobs.forEach((job) => job.reject(new TripWriteError('dropped'))); queue.jobs = []; });
    },
    /** A trip read from the server, so later writes build on it. */
    remember: (trip) => { if (!closed && !trips.has(trip.id)) confirm(trip); },
    known: (id) => trips.get(id),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    version: () => version,
  };
}
