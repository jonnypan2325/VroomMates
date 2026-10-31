import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { newId } from './api';
import { copyTitle, titleFacts, titleFromFacts } from './tripTitles';

const UNSAVABLE = 'This route cannot be saved. Choose a Google place for every stop and calculate again.';
const noStore = { subscribe: () => () => {}, version: () => 0 };

/**
 * Calculating a route saves it for a signed-in user: the first calculation creates the trip and
 * later ones update it, through the account's trip writer. `trip` is the trip the planner is working
 * on ({ id, opened, facts }); only what the person does sets it, through `onTrip`. A save never moves
 * the planner to another trip, except that a trip deleted elsewhere lets go of the route.
 *
 * Each route's status follows its latest save, so it always ends as saved, not saved with Retry, or
 * cannot be saved: never "Saving…" once the writer is idle.
 */
export default function useTripAutoSave({ writer, result, trip, onTrip, onChanged }) {
  const live = useRef({ writer, trip, onTrip, onChanged });
  live.current = { writer, trip, onTrip, onChanged };
  const store = writer || noStore;
  useSyncExternalStore(store.subscribe, store.version);
  // Per writer: routes saved once already, the planner's latest route for each trip, and new trips whose save failed.
  const lane = useRef({ writer: null });
  if (lane.current.writer !== writer) lane.current = { writer, done: new Set(), latest: new Map(), failedCreates: new Map() };
  const [statuses, setStatuses] = useState({ writer: null, byResult: {} });

  // Shows how a save ended, unless a newer save for the same route has taken over its status.
  const track = useCallback((resultId, tripId, promise, { create = false, retryFor }) => {
    const { writer: owner } = live.current;
    const own = lane.current;
    const token = {};
    const show = (status, only) => setStatuses((old) => {
      const byResult = old.writer === owner ? old.byResult : {};
      if (only && byResult[resultId]?.token !== token) return old;
      return { writer: owner, byResult: { ...byResult, [resultId]: status } };
    });
    show({ phase: 'saving', message: '', token });
    promise.then(() => {
      own.failedCreates.delete(tripId);
      const latest = own.latest.get(tripId);
      if (latest) latest.created = true;
      show({ phase: 'saved', message: '' }, true);
      if (live.current.writer === owner) live.current.onChanged?.();
    }, (error) => {
      if (live.current.writer !== owner) return;
      // A change dropped behind a new trip that failed to save shows that failure, with its Retry.
      if (error.kind === 'dropped') { show(own.failedCreates.get(tripId) || null, true); return; }
      if (error.kind === 'refused') {
        show({ phase: 'unsavable', message: own.latest.get(tripId)?.created
          ? 'Your latest changes cannot be saved. Calculate the route again to save it.'
          : 'This route cannot be saved. Calculate it again to save it.' }, true);
        return;
      }
      if (error.kind === 'detached' && live.current.trip?.id === tripId) live.current.onTrip(null);
      const status = { phase: 'error', message: error.status === 401 ? 'Your sign-in expired.' : '', retry: retryFor(error) };
      if (create) own.failedCreates.set(tripId, status);
      show(status, true);
    });
    return promise;
  }, []);

  // A new trip for a route: its ID becomes the planner's trip at once, so later changes queue behind it.
  const saveNew = useCallback((route, copyOf = null) => {
    if (!live.current.writer || !route?.snapshot) return;
    const id = newId();
    const facts = titleFacts(route);
    const title = copyOf ? copyTitle(copyOf.title) : titleFromFacts(facts);
    lane.current.latest.set(id, { route, snapshot: route.snapshot, facts, sentFacts: facts, created: false, edited: false });
    live.current.onTrip({ id, title, opened: false, facts });
    sendCreate(route.id, id, live.current.writer.create({ id, title, snapshot: route.snapshot, facts }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry of a new trip resends exactly what may already have been saved, then any change made since.
  function sendCreate(resultId, tripId, promise) {
    track(resultId, tripId, promise, { create: true, retryFor: (error) => () => {
      const own = lane.current;
      const latest = own.latest.get(tripId);
      // Its ID turned out to be taken: save the route again as a new trip.
      if (error.kind === 'conflict' || error.kind === 'detached' || !error.retry) { saveNew(latest.route); return; }
      own.failedCreates.delete(tripId);
      sendCreate(resultId, tripId, error.retry().then((saved) => (latest.edited ? live.current.writer.update(tripId,
        { snapshot: latest.snapshot, follow: { before: latest.sentFacts, after: latest.facts } }, { slot: 'planner' }) : saved)));
    } });
  }

  // The planner's latest route for a trip, as one change that a newer one replaces while it waits.
  const sendLatest = useCallback((resultId, tripId) => {
    const latest = lane.current.latest.get(tripId);
    const before = latest.sentFacts;
    latest.sentFacts = latest.facts;
    track(resultId, tripId, live.current.writer.update(tripId, { snapshot: latest.snapshot,
      ...(before ? { follow: { before, after: latest.facts } } : {}) }, { slot: 'planner' }),
    { retryFor: (error) => (error.kind === 'detached' ? () => saveNew(latest.route) : () => sendLatest(resultId, tripId)) });
  }, [track, saveNew]);

  // The route changed for the trip the planner holds: remember it and send it.
  const queueRoute = useCallback((route) => {
    const own = lane.current;
    const current = live.current.trip;
    if (!live.current.writer || !current || !route?.snapshot) return false;
    const previous = own.latest.get(current.id);
    own.latest.set(current.id, { route, snapshot: route.snapshot, facts: titleFacts(route), edited: true,
      sentFacts: previous ? previous.sentFacts : current.facts, created: previous ? previous.created : true });
    // A new trip whose save failed keeps the change for its Retry.
    if (!own.failedCreates.has(current.id)) sendLatest(route.id, current.id);
    return true;
  }, [sendLatest]);

  useEffect(() => {
    const own = lane.current;
    if (!writer || !result || result.origin !== 'calculated' || own.done.has(result.id)) return;
    own.done.add(result.id);
    if (!result.snapshot) {
      setStatuses((old) => ({ writer, byResult: { ...(old.writer === writer ? old.byResult : {}),
        [result.id]: { phase: 'unsavable', message: result.saveError || UNSAVABLE } } }));
      return;
    }
    if (!queueRoute(result)) saveNew(result);
  }, [writer, result, queueRoute, saveNew]);

  const known = writer && trip ? writer.known(trip.id) : null;
  const shown = known ? { ...trip, title: known.title } : null;
  // New names, or a new arrive-by time, update the trip saved for this route.
  const saveEdits = useCallback((next) => { queueRoute(next); }, [queueRoute]);
  const saveAgain = useCallback(() => saveNew(result), [saveNew, result]);
  const saveAsNew = useCallback(() => {
    const { writer: current, trip: held } = live.current;
    const copied = current && held ? current.known(held.id) : null;
    if (copied) saveNew(result, copied);
  }, [saveNew, result]);
  const rename = useCallback(async (text) => {
    const { writer: current, trip: held } = live.current;
    if (!current || !held) return;
    await current.update(held.id, { title: text });
    live.current.onChanged?.();
  }, []);

  const status = statuses.writer === writer && result ? statuses.byResult[result.id] : null;
  let phase = 'idle';
  if (result && !writer) phase = 'signed-out';
  else if (result && status) phase = status.phase;
  else if (result) phase = shown ? 'saved' : 'unsaved';
  // A saved trip deleted from My trips leaves its route here, unsaved.
  if (phase === 'saved' && !shown) phase = 'unsaved';
  const retry = useCallback(() => status?.retry?.(), [status]);
  return { phase, message: status?.message || '', trip: shown, retry, rename, saveAsNew, saveAgain, saveEdits };
}
