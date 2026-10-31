import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { newId, sameData } from './api';
import { copyTitle, titleFacts, titleFromFacts } from './tripTitles';

const UNSAVABLE = 'This route cannot be saved. Choose a Google place for every stop and calculate again.';
const noStore = { subscribe: () => () => {}, version: () => 0 };
// Where a status is kept: with the trip it belongs to, with a route whose trip was deleted elsewhere,
// or with a route that cannot be saved at all.
const tripKey = (id) => 'trip:' + id;
const LOOSE = 'loose';
const routeKey = (id) => 'route:' + id;
// What a route's status line says. A route with no trip the writer knows was let go, so it is not saved.
const phaseOf = (writer, route, held, status) => {
  if (!route) return 'idle';
  if (!writer) return 'signed-out';
  const phase = status ? status.phase : 'saved';
  return phase === 'saved' && !(held && writer.known(held.id)) ? 'unsaved' : phase;
};

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
  const live = useRef({ writer, trip, result, onTrip, onChanged });
  live.current = { writer, trip, result, onTrip, onChanged };
  const store = writer || noStore;
  useSyncExternalStore(store.subscribe, store.version);
  // Per writer: routes saved once already; per trip, the planner's latest route and the title facts the
  // server's title was last confirmed from; and a route whose trip was deleted elsewhere.
  const lane = useRef({ writer: null });
  if (lane.current.writer !== writer) lane.current = { writer, done: new Set(), trips: new Map(), loose: null, showing: new Set() };
  const [statuses, setStatuses] = useState({ writer: null, byKey: {} });
  // Kept beside the state, so a load can ask how a save ended ahead of the next render.
  const latest = useRef(statuses);

  const show = useCallback((key, status, token) => {
    const old = latest.current;
    const byKey = old.writer === live.current.writer ? old.byKey : {};
    if (token && byKey[key]?.token !== token) return;
    latest.current = { writer: live.current.writer, byKey: { ...byKey, [key]: status } };
    setStatuses(latest.current);
  }, []);
  const statusOf = (byKey, route, held) => {
    if (!route) return null;
    const { loose } = lane.current;
    return byKey[routeKey(route.id)] || (held ? byKey[tripKey(held.id)] : loose?.resultId === route.id ? byKey[LOOSE] : null) || null;
  };

  // Shows how a save of a trip ended, unless a newer save of that trip has taken over its status.
  const track = useCallback((tripId, promise, { create = false, retry }) => {
    const { writer: owner } = live.current;
    const own = lane.current;
    const key = tripKey(tripId);
    const token = {};
    // A trip loaded into the planner again starts a new record, which an older save can no longer touch.
    const record = own.trips.get(tripId);
    const replaced = () => own.trips.get(tripId) !== record;
    show(key, { phase: 'saving', message: '', token });
    const shown = promise.then(() => {
      if (live.current.writer === owner) live.current.onChanged?.();
      if (replaced()) return;
      if (record) { record.failedCreate = null; record.created = true; }
      show(key, { phase: 'saved', message: '' }, token);
    }, (error) => {
      if (live.current.writer !== owner || replaced()) return;
      // A change dropped behind a new trip that failed to save shows that failure, with its Retry.
      if (error.kind === 'dropped') { show(key, record?.failedCreate || null, token); return; }
      if (error.kind === 'refused') {
        // A new trip the server would not take never existed, so calculating again starts a new one.
        if (create && record && !record.created) {
          own.trips.delete(tripId);
          live.current.onTrip((held) => (held?.id === tripId ? null : held));
          show(routeKey(record.route.id), { phase: 'unsavable', message: 'This route cannot be saved. Calculate it again to save it.' });
          show(key, null);
          return;
        }
        show(key, { phase: 'unsavable', message: record?.created
          ? 'Your latest changes cannot be saved. Calculate the route again to save it.'
          : 'This route cannot be saved. Calculate it again to save it.' }, token);
        return;
      }
      const status = { phase: 'error', message: '' };
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
    const finish = () => own.showing.delete(shown);
    own.showing.add(shown);
    shown.then(finish, finish);
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
    live.current.trip = { id, title, opened: false, facts };
    live.current.onTrip(live.current.trip);
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
      created.then(() => { if (record.edited && lane.current.trips.get(tripId) === record) sendLatest(tripId); }, () => {});
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
    return facts;
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

  // Whether the route on screen is not saved, as of the last save to end: 'failed' with its Retry, 'refused'
  // with none, 'unsaved' if its trip was deleted, or null. A save whose reply was lost may have landed after
  // all: a route the trip holds, as last read, is not unsaved.
  const unsaved = useCallback(() => {
    const box = latest.current;
    const { writer: current, result: route, trip: held } = live.current;
    const phase = phaseOf(current, route, held, statusOf(box.writer === current ? box.byKey : {}, route, held));
    if (phase === 'unsaved') return 'unsaved';
    if (phase !== 'error' && phase !== 'unsavable') return null;
    const confirmed = held && current?.known(held.id);
    if (confirmed && route.snapshot && sameData(confirmed.snapshot, route.snapshot)) return null;
    return phase === 'error' ? 'failed' : 'refused';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Resolves once every save under way has ended and shown how.
  const saveEnded = useCallback(async () => {
    const { showing } = lane.current;
    while (showing.size) await Promise.allSettled([...showing]); // eslint-disable-line no-await-in-loop
  }, []);

  const status = statusOf(statuses.writer === writer ? statuses.byKey : {}, result, trip);
  // A saved trip deleted from My trips leaves its route here, unsaved.
  const phase = phaseOf(writer, result, trip, status);
  const retry = useCallback(() => status?.retry?.(), [status]);
  return { phase, message: status?.message || '', trip: shown, retry, rename, saveAsNew, saveAgain, saveEdits, hold, unsaved, saveEnded };
}
