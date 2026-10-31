import { useCallback, useEffect, useRef, useState } from 'react';
import { SavedApiError, canonicalText, newId, requestJSON, sameData } from './api';
import { canonicalSnapshot, readTrip } from './SavedTripsPanel';
import { copyTitle, followTitle, titleFacts, titleFromFacts } from './tripTitles';

// After a save, any newer names for the same route are saved next.
function followLatest(lane, resultId, sent) {
  const latest = lane.latest;
  if (!lane.next && latest?.resultId === resultId && latest.snapshot !== sent) lane.next = { ...latest };
}


/**
 * Calculating a route saves it for a signed-in user: the first calculation creates the trip and
 * later ones update it. Saves run one at a time in order, and a failed save never touches the route.
 * `trip` is the trip the planner is working on ({ id, title, opened }); `onTrip` replaces it.
 * `session` changes whenever the planner lets go of its work (Start over, opening another trip, deleting
 * this one): saves still waiting are dropped, and one that lands later is kept for Undo, never attached.
 */
export default function useTripAutoSave({ auth, result, trip, onTrip, onChanged, session = 0 }) {
  const scope = auth?.status === 'authenticated' && typeof auth.profile?.id === 'string'
    ? `${auth.profile.id}:${auth.generation}` : null;
  const live = useRef({ scope, trip, auth, onTrip, onChanged, session });
  live.current = { scope, trip, auth, onTrip, onChanged, session };
  // `latest` is the newest snapshot of the route on screen, which a rename can change while a save is under way.
  const queue = useRef({ scope, session, busy: false, next: null, done: new Set(), retry: null, latest: null, kept: new Map() });
  const [state, setState] = useState({ scope, resultId: null, phase: 'idle', message: '' });

  if (queue.current.scope !== scope) {
    queue.current.rename?.reject(new Error('The account changed.'));
    queue.current = { scope, session, busy: false, next: null, done: new Set(), retry: null, latest: null, kept: new Map() };
  }
  if (queue.current.session !== session) {
    const lane = queue.current;
    lane.rename?.reject(new Error('The planner moved on.'));
    Object.assign(lane, { session, next: null, retry: null, latest: null, rename: null });
  }

  const report = useCallback((owner, change) => {
    if (live.current.scope === owner) setState((old) => ({ ...old, scope: owner, ...change }));
  }, []);

  const send = useCallback(async (job) => {
    const owner = job.scope;
    const { auth: account } = live.current;
    if (job.kind === 'create') {
      let response;
      if (job.reconcile) {
        // An unclear earlier reply may still have committed; the same ID makes the retry safe.
        try { response = await requestJSON(account, `/saved-trips/${job.body.id}`); } catch (error) {
          if (!(error instanceof SavedApiError && error.status === 404)) throw error;
        }
      }
      if (!response) response = await requestJSON(account, '/saved-trips', { method: 'POST', body: job.body });
      const saved = readTrip(response, job.body.id);
      if (saved.title !== job.body.title || !sameData(saved.snapshot, job.body.snapshot)) {
        throw new SavedApiError(409, 'TRIP_CONFLICT', 'The saved trip has different content.');
      }
      const trip = { id: saved.id, title: saved.title, opened: false, created_at: saved.created_at,
        ...(saved.updated_at ? { updated_at: saved.updated_at } : {}), facts: job.facts };
      // A trip saved for a planner session that has since moved on waits for Undo instead.
      if (live.current.scope === owner && live.current.session !== job.session) queue.current.kept.set(job.session, trip);
      if (live.current.scope === owner && live.current.session === job.session) {
        // A save queued behind this one must update this trip, even before the next render.
        live.current.trip = trip;
        live.current.onTrip(trip);
      }
      return saved;
    }
    const response = await requestJSON(account, `/saved-trips/${job.id}`, { method: 'PATCH', body: job.body });
    const saved = readTrip(response, job.id);
    if ((job.body.title && saved.title !== job.body.title) || (job.body.snapshot && !sameData(saved.snapshot, job.body.snapshot))) {
      throw new SavedApiError(503, 'INVALID_RESPONSE', 'The change could not be confirmed.');
    }
    if (live.current.scope === owner && live.current.session === job.session && live.current.trip?.id === saved.id) {
      // Only a save that sent a name changes the one shown; a route save's reply may carry a name from elsewhere.
      live.current.trip = { ...live.current.trip, ...(job.body.title ? { title: saved.title } : {}),
        ...(saved.updated_at ? { updated_at: saved.updated_at } : {}), ...(job.facts ? { facts: job.facts } : {}) };
      live.current.onTrip(live.current.trip);
    }
    return saved;
  }, []);

  const drain = useCallback(async () => {
    const lane = queue.current;
    if (lane.busy) return;
    if (lane.rename) {
      // A new name waits its turn, so it never crosses a save that also sets the title.
      const { title, resolve, reject } = lane.rename;
      lane.rename = null;
      lane.busy = true;
      const current = live.current.trip;
      try {
        if (!current) throw new Error('This trip is not saved yet.');
        await send({ scope: lane.scope, session: lane.session, kind: 'update', id: current.id, body: { title } });
        resolve();
        if (queue.current === lane) live.current.onChanged?.();
      } catch (error) { reject(error); } finally {
        lane.busy = false;
        if (queue.current === lane) void drain();
      }
      return;
    }
    if (!lane.next) return;
    const { resultId, snapshot, asNew, facts, job: prepared } = lane.next;
    lane.next = null;
    lane.busy = true;
    const owner = lane.scope;
    const current = live.current.trip;
    let job;
    try {
      // The title and the route travel in one save, so they never disagree.
      const title = current && !asNew && current.facts ? followTitle(current.title, current.facts, facts, current.created_at) : current?.title;
      job = prepared || (current && !asNew
        ? { scope: owner, session: lane.session, kind: 'update', id: current.id, facts,
          body: { ...(title !== current.title ? { title } : {}), snapshot: canonicalSnapshot(snapshot) } }
        : { scope: owner, session: lane.session, kind: 'create', facts, body: { id: newId(),
          title: asNew && current ? copyTitle(current.title) : titleFromFacts(facts, new Date()), snapshot: canonicalSnapshot(snapshot) } });
    } catch (_) {
      lane.busy = false;
      report(owner, { resultId, phase: 'unsavable', message: 'This route cannot be saved. Choose a Google place for every stop and calculate again.' });
      return;
    }
    report(owner, { resultId, phase: 'saving', message: '' });
    try {
      await send(job);
      if (queue.current !== lane) return;
      lane.retry = null;
      report(owner, { resultId, phase: 'saved', message: '' });
      live.current.onChanged?.();
      followLatest(lane, resultId, snapshot);
    } catch (error) {
      if (queue.current !== lane || lane.session !== job.session) return;
      const status = error instanceof SavedApiError ? error.status : 0;
      // Content the server refuses would only be refused again, so there is no Retry.
      if ([400, 413, 415].includes(status) || (job.kind === 'update' && status === 409)) {
        report(owner, { resultId, phase: 'unsavable', message: current && !asNew
          ? 'Your latest changes cannot be saved. Calculate the route again to save it.'
          : 'This route cannot be saved. Calculate it again to save it.' });
        return;
      }
      // A trip deleted elsewhere lets go of the route, so Retry saves it as a new trip.
      if (job.kind === 'update' && status === 404 && live.current.trip?.id === job.id) {
        live.current.trip = null;
        live.current.onTrip(null);
      }
      // A definite rejection starts over with a new ID; anything unclear retries this exact save.
      const definite = [404, 409].includes(status);
      lane.retry = { resultId, snapshot, asNew, facts, job: definite ? null : { ...job, reconcile: job.kind === 'create' } };
      report(owner, { resultId, phase: 'error', message: status === 401 ? 'Your sign-in expired.' : '' });
    } finally {
      lane.busy = false;
      if (queue.current === lane) void drain();
    }
  }, [report, send]);

  const enqueue = useCallback((request) => {
    queue.current.next = request;
    queue.current.latest = { resultId: request.resultId, snapshot: request.snapshot, facts: request.facts };
    void drain();
  }, [drain]);

  useEffect(() => {
    const lane = queue.current;
    if (!scope || !result || result.origin !== 'calculated' || lane.done.has(result.id)) return;
    lane.done.add(result.id);
    if (!result.snapshot) {
      report(scope, { resultId: result.id, phase: 'unsavable', message: result.saveError });
      return;
    }
    enqueue({ resultId: result.id, snapshot: result.snapshot, facts: titleFacts(result) });
  }, [scope, result, enqueue, report]);

  // Retry resends a save whose outcome is unclear exactly as it was, or builds a refused one again.
  const retry = useCallback(() => {
    const lane = queue.current;
    const failed = lane.retry;
    if (!failed || lane.busy) return;
    lane.retry = null;
    enqueue(failed);
  }, [enqueue]);

  // Undo of Start over returns to a planner session; a trip saved for it meanwhile becomes its trip again.
  useEffect(() => {
    const lane = queue.current;
    const kept = lane.kept.get(session);
    if (!kept || live.current.trip) return;
    lane.kept.delete(session);
    live.current.trip = kept;
    live.current.onTrip(kept);
  }, [session]);

  const saveAsNew = useCallback(() => {
    if (!result?.snapshot || !live.current.trip) return;
    enqueue({ resultId: result.id, snapshot: result.snapshot, asNew: true, facts: titleFacts(result) });
  }, [result, enqueue]);

  const saveAgain = useCallback(() => {
    if (!result?.snapshot) return;
    enqueue({ resultId: result.id, snapshot: result.snapshot, facts: titleFacts(result) });
  }, [result, enqueue]);

  // New names, or a new arrive-by time, update the trip saved for this route, or the save still under way.
  const saveEdits = useCallback((next) => {
    const lane = queue.current;
    if (!scope || !next?.snapshot) return;
    // A queued "Save as new trip" stays a copy.
    const request = { resultId: next.id, snapshot: next.snapshot, facts: titleFacts(next),
      asNew: lane.next?.resultId === next.id && lane.next.asNew };
    if (live.current.trip || lane.busy || lane.next) { enqueue(request); return; }
    lane.latest = request;
    // A failed first save retries with the names as they are now.
    if (lane.retry && !lane.retry.job && lane.retry.resultId === next.id) lane.retry = { ...lane.retry, snapshot: next.snapshot, facts: request.facts };
  }, [scope, enqueue]);

  const rename = useCallback((next) => new Promise((resolve, reject) => {
    const lane = queue.current;
    if (!live.current.trip && !lane.busy) { resolve(); return; }
    const title = canonicalText(next, 200, 200);
    // A newer name replaces one still waiting.
    lane.rename?.resolve();
    lane.rename = { title, resolve, reject };
    void drain();
  }), [drain]);

  const active = state.scope === scope && state.resultId === result?.id ? state : null;
  let phase = 'idle';
  if (result && !scope) phase = 'signed-out';
  else if (result && active) phase = active.phase;
  else if (result && trip) phase = 'saved';
  else if (result) phase = 'unsaved';
  // A saved trip deleted from My trips leaves its route here, unsaved.
  if (phase === 'saved' && !trip) phase = 'unsaved';
  return { phase, message: active?.message || '', trip, retry, rename, saveAsNew, saveAgain, saveEdits };
}
