import { useCallback, useEffect, useRef, useState } from 'react';
import { SavedApiError, canonicalText, newId, requestJSON, sameData } from './api';
import { canonicalSnapshot, readTrip } from './SavedTripsPanel';

const shortPlace = (point) => point.label || point.place_name || (point.address || '').split(',')[0].trim() || 'destination';

/** "Trip to BCD Tofu, Oct 22": renamable, and always within the 200-character title limit. */
export function automaticTitle(result, now = new Date()) {
  const place = Array.from(shortPlace(result.inputs.destination)).slice(0, 80).join('');
  const day = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return canonicalText(`Trip to ${place}, ${day}`, 200, 200);
}

// After a save, any newer names for the same route are saved next.
function followLatest(lane, resultId, sent) {
  const latest = lane.latest;
  if (!lane.next && latest?.resultId === resultId && latest.snapshot !== sent) lane.next = { ...latest };
}

const copyTitle = (title) => canonicalText(Array.from('Copy of ' + title).slice(0, 200).join(''), 200, 200);

/**
 * Calculating a route saves it for a signed-in user: the first calculation creates the trip and
 * later ones update it. Saves run one at a time in order, and a failed save never touches the route.
 * `trip` is the trip the planner is working on ({ id, title, opened }); `onTrip` replaces it.
 */
export default function useTripAutoSave({ auth, result, trip, onTrip, onChanged }) {
  const scope = auth?.status === 'authenticated' && typeof auth.profile?.id === 'string'
    ? `${auth.profile.id}:${auth.generation}` : null;
  const live = useRef({ scope, trip, auth, onTrip, onChanged });
  live.current = { scope, trip, auth, onTrip, onChanged };
  // `latest` is the newest snapshot of the route on screen, which a rename can change while a save is under way.
  const queue = useRef({ scope, busy: false, next: null, done: new Set(), retry: null, latest: null });
  const [state, setState] = useState({ scope, resultId: null, phase: 'idle', message: '' });

  if (queue.current.scope !== scope) queue.current = { scope, busy: false, next: null, done: new Set(), retry: null, latest: null };

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
      if (live.current.scope === owner) {
        // A save queued behind this one must update this trip, even before the next render.
        live.current.trip = { id: saved.id, title: saved.title, opened: false };
        live.current.onTrip(live.current.trip);
      }
      return saved;
    }
    const response = await requestJSON(account, `/saved-trips/${job.id}`, { method: 'PATCH', body: job.body });
    const saved = readTrip(response, job.id);
    if ((job.body.title && saved.title !== job.body.title) || (job.body.snapshot && !sameData(saved.snapshot, job.body.snapshot))) {
      throw new SavedApiError(503, 'INVALID_RESPONSE', 'The change could not be confirmed.');
    }
    if (live.current.scope === owner && live.current.trip?.id === saved.id) {
      live.current.trip = { ...live.current.trip, title: saved.title };
      live.current.onTrip(live.current.trip);
    }
    return saved;
  }, []);

  const drain = useCallback(async () => {
    const lane = queue.current;
    if (lane.busy || !lane.next) return;
    const { resultId, snapshot, asNew } = lane.next;
    lane.next = null;
    lane.busy = true;
    const owner = lane.scope;
    const current = live.current.trip;
    let job;
    try {
      job = current && !asNew
        ? { scope: owner, kind: 'update', id: current.id, body: { snapshot: canonicalSnapshot(snapshot) } }
        : { scope: owner, kind: 'create', body: { id: newId(), title: asNew && current ? copyTitle(current.title) : lane.title(),
          snapshot: canonicalSnapshot(snapshot) } };
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
      if (queue.current !== lane) return;
      // A definite rejection starts over with a new ID; anything unclear retries this exact save.
      const definite = error instanceof SavedApiError && [400, 404, 409, 413, 415].includes(error.status);
      lane.retry = { resultId, snapshot, asNew, job: definite ? null : { ...job, reconcile: job.kind === 'create' } };
      report(owner, { resultId, phase: 'error', message: error?.status === 401 ? 'Your sign-in expired.' : '' });
    } finally {
      lane.busy = false;
      if (queue.current === lane) void drain();
    }
  }, [report, send]);

  const enqueue = useCallback((request) => {
    queue.current.next = request;
    queue.current.latest = { resultId: request.resultId, snapshot: request.snapshot };
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
    lane.title = () => automaticTitle(result);
    enqueue({ resultId: result.id, snapshot: result.snapshot });
  }, [scope, result, enqueue, report]);

  const retry = useCallback(() => {
    const lane = queue.current;
    const failed = lane.retry;
    if (!failed || lane.busy) return;
    lane.retry = null;
    if (!failed.job) { enqueue(failed); return; }
    lane.busy = true;
    report(lane.scope, { resultId: failed.resultId, phase: 'saving', message: '' });
    send(failed.job).then(() => {
      if (queue.current !== lane) return;
      report(lane.scope, { resultId: failed.resultId, phase: 'saved', message: '' });
      live.current.onChanged?.();
      followLatest(lane, failed.resultId, failed.snapshot);
    }, () => {
      if (queue.current !== lane) return;
      lane.retry = failed;
      report(lane.scope, { resultId: failed.resultId, phase: 'error', message: '' });
    }).finally(() => { lane.busy = false; if (queue.current === lane) void drain(); });
  }, [enqueue, report, send, drain]);

  const saveAsNew = useCallback(() => {
    if (!result?.snapshot || !live.current.trip) return;
    if (!queue.current.title) queue.current.title = () => automaticTitle(result);
    enqueue({ resultId: result.id, snapshot: result.snapshot, asNew: true });
  }, [result, enqueue]);

  const saveAgain = useCallback(() => {
    if (!result?.snapshot) return;
    queue.current.title = () => automaticTitle(result);
    enqueue({ resultId: result.id, snapshot: result.snapshot });
  }, [result, enqueue]);

  // New names, or a new arrive-by time, update the trip saved for this route, or the save still under way.
  const saveEdits = useCallback((next) => {
    const lane = queue.current;
    if (!scope || !next?.snapshot) return;
    // A trip reopened into the planner has no automatic title yet; a save that must create it needs one.
    if (!lane.title) lane.title = () => automaticTitle(next);
    // A queued "Save as new trip" stays a copy.
    const request = { resultId: next.id, snapshot: next.snapshot, asNew: lane.next?.resultId === next.id && lane.next.asNew };
    if (live.current.trip || lane.busy || lane.next) { enqueue(request); return; }
    lane.latest = request;
    // A failed first save retries with the names as they are now.
    if (lane.retry && !lane.retry.job && lane.retry.resultId === next.id) lane.retry = { ...lane.retry, snapshot: next.snapshot };
  }, [scope, enqueue]);

  const rename = useCallback(async (next) => {
    const current = live.current.trip;
    if (!current) return;
    const title = canonicalText(next, 200, 200);
    await send({ scope, kind: 'update', id: current.id, body: { title } });
    live.current.onChanged?.();
  }, [scope, send]);

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
