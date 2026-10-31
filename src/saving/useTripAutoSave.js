import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { newId } from './api';
import { copyTitle, titleFacts, titleFromFacts } from './tripTitles';

const UNSAVABLE = 'This route cannot be saved. Choose a Google place for every stop and calculate again.';
const noStore = { subscribe: () => () => {}, version: () => 0 };
// Where a status is kept: with the trip it belongs to, with a route whose trip was deleted elsewhere,
// or with a route that cannot be saved at all.
const tripKey = (id) => 'trip:' + id;
const LOOSE = 'loose';
const routeKey = (id) => 'route:' + id;

/**
 * Calculating a route saves it for a signed-in user: the first calculation creates the trip and
 * later ones update it, through the account's trip writer. `trip` is the trip the planner is working
 * on ({ id, opened, facts }); only what the person does sets it, through `onTrip`. A save never moves
 * the planner to another trip, except that a trip deleted elsewhere lets go of the route.
 *
 * A save's status, and its Retry, belong to the trip, so they carry over to a newer route of the same
 * trip; each ends as saved, not saved with Retry, or cannot be saved: never "Saving…" once the writer
 * is idle. Retry always saves the planner's latest route for that trip.
 */
export default function useTripAutoSave({ writer, result, trip, onTrip, onChanged }) {
  const live = useRef({ writer, trip, onTrip, onChanged });
  live.current = { writer, trip, onTrip, onChanged };
  const store = writer || noStore;
  useSyncExternalStore(store.subscribe, store.version);
  // Per writer: routes saved once already; per trip, the planner's latest route and the title facts the
  // server's title was last confirmed from; and a route whose trip was deleted elsewhere.
  const lane = useRef({ writer: null });
  if (lane.current.writer !== writer) lane.current = { writer, done: new Set(), trips: new Map(), loose: null };
  const [statuses, setStatuses] = useState({ writer: null, byKey: {} });

  const show = useCallback((key, status, token) => setStatuses((old) => {
    const byKey = old.writer === live.current.writer ? old.byKey : {};
    if (token && byKey[key]?.token !== token) return old;
    return { writer: live.current.writer, byKey: { ...byKey, [key]: status } };
  }), []);

  // Shows how a save of a trip ended, unless a newer save of that trip has taken over its status.
  const track = useCallback((tripId, promise, { create = false, retry }) => {
    const { writer: owner } = live.current;
    const own = lane.current;
    const key = tripKey(tripId);
    const token = {};
    show(key, { phase: 'saving', message: '', token });
    promise.then(() => {
      const record = own.trips.get(tripId);
      if (record) { record.failedCreate = null; record.created = true; }
      show(key, { phase: 'saved', message: '' }, token);
      if (live.current.writer === owner) live.current.onChanged?.();
    }, (error) => {
      if (live.current.writer !== owner) return;
      const record = own.trips.get(tripId);
      // A change dropped behind a new trip that failed to save shows that failure, with its Retry.
      if (error.kind === 'dropped') { show(key, record?.failedCreate || null, token); return; }
      if (error.kind === 'refused') {
        // A new trip the server would not take never existed, so calculating again starts a new one.
        if (create && record && !record.created) {
          own.trips.delete(tripId);
          if (live.current.trip?.id === tripId) live.current.onTrip(null);
          show(routeKey(record.route.id), { phase: 'unsavable', message: 'This route cannot be saved. Calculate it again to save it.' });
          show(key, null);
          return;
        }
        show(key, { phase: 'unsavable', message: record?.created
          ? 'Your latest changes cannot be saved. Calculate the route again to save it.'
          : 'This route cannot be saved. Calculate it again to save it.' }, token);
        return;
      }
      const status = { phase: 'error', message: error.status === 401 ? 'Your sign-in expired.' : '' };
      // A trip deleted elsewhere lets go of the route; its changes are kept, and Retry saves them as a new trip.
      if (error.kind === 'detached' && live.current.trip?.id === tripId && record) {
        own.loose = { route: record.route, resultId: record.route.id };
        live.current.onTrip(null);
        show(LOOSE, { ...status, retry: () => saveNew(own.loose.route) });
      }
      status.retry = error.kind === 'detached' || error.kind === 'conflict' ? () => saveNew(record.route) : () => retry(error);
      if (create && record) record.failedCreate = status;
      show(key, status, token);
    });
    return promise;
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new trip for a route: its ID becomes the planner's trip at once, so later changes queue behind it.
  const saveNew = useCallback((route, copyOf = null) => {
    if (!live.current.writer || !route?.snapshot) return;
    let facts, title;
    // A name that still cannot be made says the route cannot be saved, rather than taking the page down.
    try {
      facts = titleFacts(route);
      title = copyOf ? copyTitle(copyOf.title) : titleFromFacts(facts);
    } catch (_) {
      show(routeKey(route.id), { phase: 'unsavable', message: UNSAVABLE });
      return;
    }
    const id = newId();
    const own = lane.current;
    own.loose = null;
    own.trips.set(id, { route, facts, confirmed: facts, created: false, edited: false, failedCreate: null });
    live.current.onTrip({ id, title, opened: false, facts });
    sendCreate(id, live.current.writer.create({ id, title, snapshot: route.snapshot, facts }));
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry of a new trip resends exactly what may already have been saved, then the latest route since,
  // which is an ordinary save of a trip that now exists.
  function sendCreate(tripId, promise) {
    track(tripId, promise, { create: true, retry: (error) => {
      const record = lane.current.trips.get(tripId);
      record.failedCreate = null;
      const created = error.retry();
      sendCreate(tripId, created);
      created.then(() => { if (record.edited) sendLatest(tripId); }, () => {});
    } });
  }

  // The planner's latest route for a trip, as one change that a newer one replaces while it waits. Its
  // title follows from the facts last confirmed, which only a confirmed save moves on.
  function sendRoute(tripId) {
    const record = lane.current.trips.get(tripId);
    const after = record.facts;
    return live.current.writer.update(tripId, { snapshot: record.route.snapshot,
      ...(record.confirmed ? { follow: { before: record.confirmed, after } } : {}) }, { slot: 'planner' })
      .then((saved) => { record.confirmed = after; return saved; });
  }
  const sendLatest = useCallback((tripId) => {
    track(tripId, sendRoute(tripId), { retry: () => sendLatest(tripId) });
  }, [track]); // eslint-disable-line react-hooks/exhaustive-deps

  // The planner now shows this trip as confirmed. What it held for the trip before is off screen, and a
  // save of that which failed ends here: Retry only ever saves the route shown.
  const hold = useCallback((route, tripId) => {
    let facts = null;
    try { facts = titleFacts(route); } catch (_) { /* The trip keeps the title it has. */ }
    lane.current.trips.set(tripId, { route, facts, confirmed: facts, created: true, edited: false, failedCreate: null });
    show(tripKey(tripId), null);
  }, [show]);

  // The route changed: remember it for the trip the planner holds, and send it.
  const queueRoute = useCallback((route) => {
    const own = lane.current;
    const current = live.current.trip;
    if (!live.current.writer || !route?.snapshot) return false;
    if (!current) {
      // A route whose trip was deleted elsewhere keeps its changes for Retry.
      if (own.loose && own.loose.resultId === route.id) own.loose.route = route;
      return false;
    }
    let facts;
    try { facts = titleFacts(route); } catch (_) { facts = null; }
    const record = own.trips.get(current.id) || { created: true, confirmed: current.facts, failedCreate: null };
    Object.assign(record, { route, facts: facts || record.facts, edited: true });
    own.trips.set(current.id, record);
    // A new trip whose save failed keeps the change for its Retry.
    if (!record.failedCreate) sendLatest(current.id);
    return true;
  }, [sendLatest]);

  useEffect(() => {
    const own = lane.current;
    if (!writer || !result || result.origin !== 'calculated' || own.done.has(result.id)) return;
    own.done.add(result.id);
    if (!result.snapshot) { show(routeKey(result.id), { phase: 'unsavable', message: result.saveError || UNSAVABLE }); return; }
    if (!queueRoute(result)) saveNew(result);
  }, [writer, result, queueRoute, saveNew, show]);

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

  const byKey = statuses.writer === writer ? statuses.byKey : {};
  const loose = lane.current.loose;
  let status = null;
  if (result) {
    status = byKey[routeKey(result.id)]
      || (trip ? byKey[tripKey(trip.id)] : loose?.resultId === result.id ? byKey[LOOSE] : null) || null;
  }
  let phase = 'idle';
  if (result && !writer) phase = 'signed-out';
  else if (result && status) phase = status.phase;
  else if (result) phase = shown ? 'saved' : 'unsaved';
  // A saved trip deleted from My trips leaves its route here, unsaved.
  if (phase === 'saved' && !shown) phase = 'unsaved';
  const retry = useCallback(() => status?.retry?.(), [status]);
  return { phase, message: status?.message || '', trip: shown, retry, rename, saveAsNew, saveAgain, saveEdits, hold };
}
