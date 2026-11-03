import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import AddressInput from './components/AddressInput';
import SavedTripsPanel, { editedDate } from './saving/SavedTripsPanel';
import { newId, sameData } from './saving/api';
import InlineEdit from './saving/InlineEdit';
import TripSaveStatus from './saving/TripSaveStatus';
import useSavedLocations from './saving/useSavedLocations';
import createTripWriter from './saving/tripWriter';
import useTripAutoSave from './saving/useTripAutoSave';
import { copyTitle, titleFacts } from './saving/tripTitles';
import RouteResults from './results/RouteResults';
import useRouteMap from './results/useRouteMap';
import { SavedLocationControls, SavedLocationsPanel } from './saving/SavedLocationControls';
import { freezeInputs, makeResult, newDriver, newPoint, newPassengerPickup, resizePickup, expandPassengerPickups, groupPassengerPickups, reopenSnapshot,
  arriveByChange, changeApplies, nameChange, renameDestination, renameInResult, renameInSnapshot, renamePoints } from './saving/tripSnapshot';
import { hasCoordinates, resolvePlace } from './saving/places';
import './saving/Saving.css';

const API_BASE_URL = (process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');

const placed = (points) => points.length > 0 && points.every((point) => hasCoordinates(point.coordinates));

function SectionHeading({ title, done, column }) {
  return <div className="driver-section-heading">
    <h3>{title}{done && <><svg className="section-done" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span className="visually-hidden"> (complete)</span></>}
      {column && <span className="section-column" aria-hidden="true">{column}</span>}</h3>
  </div>;
}

function listNames(names) {
  return names.join(', ');
}

/** Planner rows picked from My locations follow later renames, moves and deletions there. */
function SavedRowSync({ saved, map, drivers, passengers, destination, setDrivers, setPassengers, setDestination, onMove }) {
  useEffect(() => {
    // Confirmed renames and moves always apply, but only a complete list proves a deletion:
    // a loading or failed list keeps rows whose location is missing from it.
    const complete = !saved.loading && !saved.error;
    const byId = new Map(saved.locations.map((row) => [row.id, row]));
    const relabel = (point) => {
      if (!point.saved_id) return point;
      const row = byId.get(point.saved_id);
      if (!row) return complete ? { ...point, label: '', saved_id: null } : point;
      if (row.source.place_id !== point.source?.place_id || row.label === point.label) return point;
      return { ...point, label: row.label };
    };
    const relabelList = (list) => {
      const next = list.map(relabel);
      return next.some((point, index) => point !== list[index]) ? next : list;
    };
    setDrivers(relabelList);
    setPassengers(relabelList);
    setDestination(relabel);
    const moved = new Set([...drivers, ...passengers, destination].filter((point) => point.saved_id
      && byId.get(point.saved_id) && byId.get(point.saved_id).source.place_id !== point.source?.place_id)
      .map((point) => point.saved_id));
    const controller = new AbortController();
    moved.forEach(async (savedId) => {
      const row = byId.get(savedId);
      // Any route through the old place is stale as soon as the move is known, even if the lookup fails.
      onMove(savedId);
      try {
        const details = await resolvePlace(map, row.source.place_id, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const follow = (point) => point.saved_id === savedId ? { ...point, ...details, label: row.label } : point;
        onMove(savedId);
        setDrivers((list) => list.map(follow));
        setPassengers((list) => list.map(follow));
        setDestination(follow);
      } catch (_) { /* A failed or superseded lookup leaves the row at its last place. */ }
    });
    return () => controller.abort();
  }, [saved.locations, saved.loading, saved.error, map, drivers, passengers, destination,
    setDrivers, setPassengers, setDestination, onMove]);
  return null;
}

/**
 * A trip opened before My locations loaded could not tell which of its places had moved; once the
 * list arrives it opens again against it, so the moved notice and the rename block apply.
 */
function ViewedLinksSync({ saved, map, view, onRelinked }) {
  useEffect(() => {
    if (!view?.linksPending || saved.loading || saved.error) return undefined;
    const controller = new AbortController();
    reopenSnapshot(view.trip.snapshot, (placeId) => resolvePlace(map, placeId, { signal: controller.signal }), saved.locations)
      .then((restored) => { if (!controller.signal.aborted) onRelinked(view, restored); }, () => {});
    return () => controller.abort();
  }, [view, saved.locations, saved.loading, saved.error, map, onRelinked]);
  return null;
}

function AccountBoundary({ auth, savedRef, children }) {
  const saved = useSavedLocations(auth);
  // Opening a trip reads the owner's locations later, outside render.
  useEffect(() => { savedRef.current = saved; }, [saved, savedRef]);
  return children(saved);
}

/** Names the saved locations that moved, which the route still visits at their old places. */
function ChangedNotice({ result, onRecalculate, busy }) {
  const ids = new Set(result.moved || []);
  const places = [...new Set([...result.inputs.drivers, ...result.inputs.passengers, result.inputs.destination]
    .filter((point) => ids.has(point.stop_id)).map((point) => point.label || point.place_name || point.address))];
  const list = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(places);
  return <div className="trip-notice" role="status">
    <p>{places.length ? `${list} ${places.length === 1 ? 'has' : 'have'} moved.` : 'Some locations have moved.'}</p>
    <button type="button" className="trip-notice-primary" disabled={busy} onClick={onRecalculate}>Recalculate</button>
  </div>;
}

/** Asks before Edit trip or Edit a copy replaces a route in the planner that is not saved: one the server refused has no way to save it. */
function UnsavedPrompt({ kind, retrying, onRetry, onReplace, onCancel }) {
  const prompt = useRef(null);
  useEffect(() => { if (!retrying) prompt.current?.focus(); }, [retrying]);
  return <div ref={prompt} className="trip-notice trip-unsaved" role="group" aria-labelledby="trip-unsaved-question" tabIndex={-1}>
    <p id="trip-unsaved-question">{kind === 'refused' ? "Your current route can't be saved." : "Your current route isn't saved."}</p>
    <div className="trip-unsaved-actions">
      {kind !== 'refused' && <button type="button" className="trip-notice-primary" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Saving…' : kind === 'failed' ? 'Retry save' : 'Save this trip'}</button>}
      <button type="button" className="secondary-button" disabled={retrying} onClick={onReplace}>Replace it</button>
      <button type="button" className="text-button" disabled={retrying} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

const unsavedRoute = (kind) => Object.assign(new Error('The planner holds a route that is not saved.'), { name: 'UnsavedRoute', kind });

function TripView({ view, route, selected, onSelect, onRetry, onBack, onEdit, onCopy, onTitle, onRename, onArriveBy, onRetrySave, busy, saveStatus }) {
  const { trip, result } = view;
  const drivers = result.inputs.drivers.length;
  const people = result.inputs.passengers.length;
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  // The Edit trip or Edit a copy waiting for an answer about the planner's unsaved route.
  const [waiting, setWaiting] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const editButton = useRef(null);
  // A failed name or copy says so here and changes nothing.
  const attempt = async (action) => {
    setError('');
    try { await action(); } catch (failure) { setError(failure.message); throw failure; }
  };
  // Either action stops short of an unsaved route and comes back here, to carry on once the person has answered.
  const load = async (action, replacing = false) => {
    setWaiting(null);
    try { await attempt(() => action(replacing)); } catch (failure) {
      if (failure.name === 'UnsavedRoute') { setError(''); setWaiting({ action, kind: failure.kind }); }
    }
  };
  const edit = (recalculate) => load((replacing) => onEdit(recalculate, replacing));
  const copied = async (replacing) => {
    setCopying(true);
    try { await onCopy(replacing); } finally { setCopying(false); }
  };
  const retrySave = async () => {
    setRetrying(true);
    let left = waiting.kind;
    try { left = await onRetrySave(); } finally { setRetrying(false); }
    if (left) setWaiting({ ...waiting, kind: left }); else void load(waiting.action);
  };
  const cancel = () => { flushSync(() => setWaiting(null)); editButton.current?.focus(); };
  // While the trip loads into the planner nothing here can change it, which would race the load; going back still can.
  const locked = busy ? '' : undefined;
  return <div className="trip-view">
    <button type="button" className="text-button trip-view-back" onClick={onBack}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>
      My trips</button>
    <h2 aria-label={trip.title} inert={locked}><InlineEdit value={trip.title} label="Trip name" className="trip-view-title" onCommit={(next) => attempt(() => onTitle(next))} /></h2>
    <p className="saving-note trip-view-meta">{drivers} {drivers === 1 ? 'driver' : 'drivers'} · {people} {people === 1 ? 'passenger' : 'passengers'} · last edited {editedDate(trip)}</p>
    {result.changed && <ChangedNotice result={result} busy={busy} onRecalculate={() => edit(true)} />}
    <div inert={locked}><RouteResults result={result} routes={route.routes} legs={route.legs} status={route.status}
      selected={selected} onSelect={onSelect} onRetry={onRetry} onRename={onRename} onArriveBy={onArriveBy}>{saveStatus}</RouteResults></div>
    {error && <p className="saving-error" role="alert">{error}</p>}
    {waiting ? <UnsavedPrompt kind={waiting.kind} retrying={retrying} onRetry={() => void retrySave()} onReplace={() => void load(waiting.action, true)} onCancel={cancel} />
      : <div className="trip-view-actions">
        <button ref={editButton} type="button" className="secondary-button" disabled={busy} onClick={() => edit(false)}>Edit trip</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void load(copied)}>{copying ? 'Copying…' : 'Edit a copy'}</button>
      </div>}
  </div>;
}

export default function LocationInput({ map, auth }) {
  const [drivers, setDrivers] = useState(() => [newDriver()]);
  const [passengers, setPassengers] = useState(() => [newPassengerPickup()]);
  const [destination, setDestination] = useState(newPoint);
  // When everyone should reach the destination, as "2026-11-01T18:30"; kept with the stops, so Recalculate keeps it.
  const [arriveBy, setArriveBy] = useState('');
  const [result, setResult] = useState(null);
  // The chosen driver belongs to one result; any other result opens as the all-drivers overview.
  const [selection, setSelection] = useState({ id: null, index: null });
  const [viewedTrip, setViewedTrip] = useState(null);
  const [lostEdit, setLostEdit] = useState('');
  const [listVersion, setListVersion] = useState(0);
  const [calculateNext, setCalculateNext] = useState(false);
  const savedRef = useRef(null);
  const submitRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState('plan');
  const [openedTrip, setOpenedTrip] = useState(null);
  const [cleared, setCleared] = useState(null);
  const scrollPane = useRef(null);
  const addDriverButton = useRef(null);
  const addPassengerButton = useRef(null);
  const viewButtons = useRef({});
  const [mapAttempt, setMapAttempt] = useState(0);
  const revision = useRef(0);
  const operation = useRef(0);
  const controllers = useRef(new Set());
  const mounted = useRef(true);
  const privateOwner = useRef(null);
  const authKey = auth.status === 'authenticated' ? auth.profile.id + ':' + auth.generation : 'anonymous:' + auth.generation;
  const latest = useRef({ authKey, map });
  latest.current = { authKey, map, activeView };
  const previousLifetime = useRef({ authKey, map });
  const privateStale = privateOwner.current && privateOwner.current !== authKey;
  const mapResult = privateStale ? null : activeView === 'trips' && viewedTrip ? viewedTrip.result : result;
  const selected = selection.id && selection.id === mapResult?.id ? selection.index : null;
  const selectDriver = (index) => setSelection({ id: mapResult?.id || null, index });
  const route = useRouteMap(map, mapResult, selected, mapAttempt);
  // One writer per signed-in account saves every change to its trips; a new account gets a new one,
  // and the old one lets go of anything still waiting.
  const scope = auth.status === 'authenticated' && typeof auth.profile?.id === 'string' ? authKey : null;
  const authRef = useRef(auth);
  authRef.current = auth;
  const writer = useMemo(() => (scope ? createTripWriter(() => authRef.current) : null), [scope]);
  const writerRef = useRef(writer);
  writerRef.current = writer;
  useEffect(() => () => { if (writerRef.current !== writer) writer?.close(); }, [writer]);
  const autoSave = useTripAutoSave({ writer: privateStale ? null : writer, result: privateStale ? null : result, trip: openedTrip,
    // A saved trip is private, so the planner holding it clears when the account changes.
    onTrip: (trip) => { privateOwner.current = authKey; setOpenedTrip(trip); },
    onChanged: () => setListVersion((version) => version + 1) });

  const invalidate = useCallback(() => {
    setCleared(null); // Any new edit, load or account change ends the chance to undo a reset.
    revision.current += 1;
    operation.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setBusy(false);
  }, []);
  const resultRef = useRef(result);
  resultRef.current = result;
  // A route calculated through a saved place that has since moved still visits the old place,
  // so it is cleared and must be calculated again before it can be saved or updated.
  const followSavedMove = useCallback((savedId) => {
    invalidate();
    const current = resultRef.current;
    if (!current) return;
    const { drivers: routeDrivers, passengers: routePassengers, destination: routeDestination } = current.inputs;
    if (![...routeDrivers, ...routePassengers, routeDestination].some((point) => point.saved_id === savedId)) return;
    setResult(null);
    setError('A saved place in this route moved. Calculate the route again.');
  }, [invalidate]);

  useLayoutEffect(() => {
    const previous = previousLifetime.current;
    if (previous.authKey !== authKey || previous.map !== map) {
      previousLifetime.current = { authKey, map };
      invalidate();
      setError('');
      setLostEdit('');
      if (previous.authKey !== authKey) { setActiveView('plan'); setViewedTrip(null); }
      if (privateOwner.current && privateOwner.current !== authKey) {
        privateOwner.current = null;
        setOpenedTrip(null);
        setDrivers([newDriver()]);
        setPassengers([newPassengerPickup()]);
        setDestination(newPoint());
        setArriveBy('');
        setResult(null);
      }
    }
  }, [authKey, map, invalidate]);

  useEffect(() => {
    mounted.current = true;
    const pendingControllers = controllers.current;
    return () => {
      mounted.current = false;
      operation.current += 1;
      pendingControllers.forEach((controller) => controller.abort());
      pendingControllers.clear();
    };
  }, []);

  const edit = (setter, id, patch) => {
    invalidate();
    setError('');
    setter((list) => list.map((point) => point.stop_id === id ? { ...point, ...patch } : point));
  };
  // A confirmed save names the row only if it still holds the place that was saved.
  const nameSaved = (setter, id, row) => setter((list) => list.map((point) => point.stop_id === id
    && point.source?.place_id === row.source.place_id ? { ...point, label: row.label, saved_id: row.id } : point));
  const removePoint = (setter, id, addButton) => {
    invalidate(); setError('');
    setter((list) => list.filter((point) => point.stop_id !== id));
    addButton.current?.focus();
  };
  const editDestination = (patch) => {
    invalidate(); setError('');
    setDestination((point) => ({ ...point, ...patch }));
  };

  // Clears the planner (and any opened trip) but never saved trips or locations; Undo restores it.
  const startOver = () => {
    const before = { drivers, passengers, destination, arriveBy, result, openedTrip };
    invalidate(); setError('');
    setOpenedTrip(null);
    setDrivers([newDriver()]);
    setPassengers([newPassengerPickup()]);
    setDestination(newPoint());
    setArriveBy('');
    setResult(null);
    setCleared(before);
    scrollPane.current?.scrollTo({ top: 0 });
  };
  const undoStartOver = () => {
    if (!cleared) return;
    invalidate();
    setDrivers(cleared.drivers);
    setPassengers(cleared.passengers);
    setDestination(cleared.destination);
    setArriveBy(cleared.arriveBy);
    setResult(cleared.result);
    setOpenedTrip(cleared.openedTrip);
  };
  const filled = (point) => Boolean(point.address.trim() || point.source);
  const dirty = Boolean(result || drivers.length !== 1 || passengers.length !== 1
    || [...drivers, ...passengers, destination].some(filled));

  const token = () => ({ owner: latest.current.authKey, revision: revision.current, operation: ++operation.current, map: latest.current.map });
  const current = (captured) => mounted.current && captured.owner === latest.current.authKey &&
    captured.revision === revision.current && captured.operation === operation.current && captured.map === latest.current.map;
  const abortError = () => new DOMException('The current route or account changed.', 'AbortError');

  const submit = async () => {
    invalidate(); setError('');
    if (!drivers.length) {
      setError('Add at least one driver before calculating a route.');
      addDriverButton.current?.focus();
      return;
    }
    if (!passengers.length) {
      setError('Add at least one passenger before calculating a route.');
      addPassengerButton.current?.focus();
      return;
    }
    if (drivers.length > 8) { setError('Plan with at most 8 drivers.'); return; }
    let expanded;
    try { expanded = expandPassengerPickups(passengers); }
    catch (failure) { setError(failure.message); return; }
    const inputs = { ...freezeInputs(drivers, expanded, destination), ...(arriveBy ? { arrive_by: arriveBy } : {}) };
    if (![...inputs.drivers, ...inputs.passengers, inputs.destination].every((point) => hasCoordinates(point.coordinates)) ||
        inputs.drivers.some((point) => !Number.isSafeInteger(point.capacity) || point.capacity < 1)) {
      setError('Choose a Google suggestion for every location and enter a positive seat count.');
      return;
    }
    if (inputs.drivers.reduce((total, point) => total + point.capacity, 0) < inputs.passengers.length) {
      setError('Add enough passenger seats for everyone at your pickups.'); return;
    }
    const captured = token();
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    try {
      const response = await fetch(API_BASE_URL + '/routeoptimizer/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          drivers: inputs.drivers.map((point) => ({ location: point.coordinates, capacity: point.capacity })),
          passengers: inputs.passengers.map((point) => point.coordinates),
          destination: inputs.destination.coordinates,
        }),
      });
      if (!current(captured)) return;
      let body = null;
      // A gateway or proxy error page is not JSON; its status still says what went wrong.
      try { body = await response.json(); } catch (_) { body = null; }
      if (!current(captured)) return;
      if (!response.ok) {
        throw new Error(typeof body?.error === 'string' ? body.error : response.status >= 500
          ? 'The route optimizer is unavailable. Please retry.' : 'The route could not be calculated. Please check your inputs.');
      }
      if (!body) throw new Error('The route optimizer sent an unreadable reply. Please retry.');
      const frozen = makeResult(inputs, body.optimizedRoutes);
      // A route calculated while signed in is that account's, like a trip it opens; signed out, it is anyone's.
      if (auth.status === 'authenticated') privateOwner.current = captured.owner;
      setResult(frozen);
    } catch (failure) {
      if (current(captured) && failure.name !== 'AbortError') setError(failure.message || 'Could not reach the route optimizer. Please retry.');
    } finally {
      controllers.current.delete(controller);
      if (current(captured)) setBusy(false);
    }
  };

  submitRef.current = submit;

  const viewVisit = useRef(0);
  const beginLoad = () => {
    invalidate(); setError(''); setLostEdit('');
    const captured = token();
    setBusy(true);
    return captured;
  };
  const endLoad = (captured) => { if (captured && current(captured)) setBusy(false); };
  // Opening a saved trip shows it read-only; its linked stops follow the owner's My locations.
  // A saved route with its places looked up again; its linked stops follow the owner's My locations once known.
  const restoreTrip = async (snapshot) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const saved = savedRef.current;
      const complete = saved && !saved.loading && !saved.error ? saved.locations : null;
      const restored = await reopenSnapshot(snapshot, (placeId) => resolvePlace(map, placeId, { signal: controller.signal }), complete);
      return { restored, complete };
    } finally { controllers.current.delete(controller); }
  };
  const viewTrip = async (trip, captured) => {
    if (!captured || !current(captured)) throw abortError();
    setBusy(true);
    try {
      let kept = trip;
      let restored, complete;
      // The trip as last confirmed: this read, unless a save from here confirmed something newer meanwhile.
      // Looking up places takes time, so a save that lands meanwhile starts this again from what it saved.
      for (let shown = null; !shown || !sameData(kept.snapshot, shown.snapshot);) {
        shown = kept;
        ({ restored, complete } = await restoreTrip(shown.snapshot)); // eslint-disable-line no-await-in-loop
        if (!current(captured)) throw abortError();
        kept = writerRef.current?.remember(kept) || kept;
      }
      privateOwner.current = captured.owner;
      viewVisit.current += 1;
      setViewedTrip({ trip: kept, result: restored, linksPending: !complete });
      scrollPane.current?.scrollTo({ top: 0 });
    } finally {
      if (current(captured)) setBusy(false);
    }
  };
  // Edit trip loads the viewed trip into Plan trip once its changes still being saved are in; Recalculate also
  // calculates it again, which updates the trip. Edit a copy loads the same route as the copy.
  // The open trip as last changed, ahead of the next render: Edit trip reads it once its saves are in.
  const latestView = useRef(viewedTrip);
  latestView.current = viewedTrip;
  const changeView = (update) => {
    latestView.current = update(latestView.current);
    setViewedTrip(update);
  };
  // Both wait, busy, for the trip's saves; a save that confirmed meanwhile (from the planner, say) can be newer
  // than the trip as opened, so the planner then starts from the trip as last confirmed. A copy passes the
  // trip it was made from, so it opens even if the person went back meanwhile, unless something newer started.
  // Going back from a trip while Edit trip waits ends the wait; a place that cannot load is reported.
  const editLoad = useRef(null);
  // An unsaved route in the planner stops either one, which then carries on only when told to replace it.
  const askFirst = (replacing) => {
    const kind = replacing ? null : autoSave.unsaved();
    if (kind) throw unsavedRoute(kind);
  };
  const editInPlanner = async (recalculate, trip = null, source = null, replacing = false) => {
    const start = source || latestView.current;
    if (!start) return;
    askFirst(replacing);
    const id = start.trip.id;
    const failures = editsFailed(id);
    const captured = beginLoad();
    if (!source) editLoad.current = captured;
    const shown = () => source || (latestView.current?.trip.id === id ? latestView.current : null);
    try {
      // A copy is already confirmed, so only the trip itself is waited for.
      if (!trip) await writerRef.current?.settled(id);
      // A save under way may still fail, leaving a route that cannot be replaced unasked.
      if (!replacing) await autoSave.saveEnded();
      const view = shown();
      if (!view || !current(captured)) return;
      let confirmed = trip || writerRef.current?.known(id);
      let restored = view.result;
      // Looking up places takes time, so a save that lands meanwhile starts this again from what it saved.
      for (;;) {
        if (confirmed && !sameData(confirmed.snapshot, restored.snapshot)) {
          ({ restored } = await restoreTrip(confirmed.snapshot));
          if (!shown() || !current(captured)) return;
        }
        if (trip) break;
        await writerRef.current?.settled(id);
        if (!shown() || !current(captured)) return;
        const now = writerRef.current?.known(id);
        const same = !now || sameData(now.snapshot, restored.snapshot);
        confirmed = now || confirmed;
        if (same) break;
      }
      stopAtFailedEdit(id, failures);
      askFirst(replacing);
      const target = confirmed || view.trip;
      invalidate(); setError('');
      setDrivers(restored.inputs.drivers);
      setPassengers(groupPassengerPickups(restored.inputs.passengers));
      setDestination(restored.inputs.destination);
      setArriveBy(restored.inputs.arrive_by || '');
      setResult(restored);
      const facts = autoSave.hold(restored, target.id);
      setOpenedTrip({ id: target.id, title: target.title, opened: true, created_at: target.created_at, facts });
      setViewedTrip(null);
      setActiveView('plan');
      viewButtons.current.plan?.focus();
      if (recalculate) setCalculateNext(true);
    } catch (failure) {
      if (failure.name === 'UnsavedRoute' || failure.name === 'EditFailed') throw failure;
      if (failure.name === 'AbortError' || !current(captured)) return;
      throw new Error(failure.name === 'TripWriteError' ? 'This trip could not be read. Check your connection and try again.'
        : 'This trip could not be loaded. Check place availability and try again.');
    } finally {
      if (editLoad.current === captured) editLoad.current = null;
      endLoad(captured);
    }
  };
  const closeView = () => {
    setViewedTrip(null);
    if (editLoad.current) endLoad(editLoad.current);
  };
  // Names and the arrive-by time belong to this trip: the planner keeps them for the next calculation,
  // and the route stays as drawn.
  const renameInPlanner = (change) => {
    setDrivers((list) => renamePoints(list, change));
    setPassengers((list) => renamePoints(list, change));
    setDestination((point) => renameDestination(point, change));
    if (change.arriveBy !== undefined) setArriveBy(change.arriveBy);
    if (!resultRef.current) return null;
    const next = renameInResult(resultRef.current, change);
    setResult(next);
    return next;
  };
  // Anything done in the planner after Edit a copy started means a late copy no longer takes it over.
  const plannerUse = useRef(0);
  const touchPlanner = (action) => (...args) => { plannerUse.current += 1; return action(...args); };
  const editPlanned = (change) => {
    plannerUse.current += 1;
    const next = renameInPlanner(change);
    if (next) autoSave.saveEdits(next);
  };
  const renamePlanned = async (target, text) => editPlanned(nameChange(target, text, resultRef.current));
  const arrivePlanned = async (value) => editPlanned(arriveByChange(value));
  // A trip opened from My trips saves a change straight away, through the writer, in turn with any other
  // change to that trip; the stops it follows from My locations keep their own names.
  const openedRef = useRef(openedTrip);
  openedRef.current = openedTrip;
  const editViewed = async (change, what) => {
    const view = viewedTrip;
    const editor = writerRef.current;
    if (!view || !editor) return;
    const id = view.trip.id;
    // A change that no longer fits the trip is refused rather than shown: this view can be behind it.
    const refused = `The ${what} can't be saved on this trip as it stands. Open the trip again and retry.`;
    // The planner may be saving this same trip; its saves then carry the change, so neither overwrites the other.
    if (openedRef.current?.id === id && resultRef.current?.snapshot) {
      if (!changeApplies(resultRef.current.snapshot, change)) throw new Error(refused);
      editPlanned(change);
      changeView((current) => current?.trip.id === id ? { ...current, trip: { ...current.trip,
        snapshot: renameInSnapshot(current.trip.snapshot, change, current.result.inputs.destination.source) },
      result: renameInResult(current.result, change) } : current);
      return;
    }
    const place = view.result.inputs.destination.source;
    // The stored destination has no landmark name, so an automatic title reads it from the place shown.
    const shown = view.result.inputs.destination;
    const factsOf = (snapshot) => titleFacts({ inputs: { ...snapshot.inputs,
      destination: { place_name: shown.place_name, address: shown.address, ...snapshot.inputs.destination } } });
    let saved;
    try {
      saved = await editor.update(id, { snapshot: (current) => {
        if (!changeApplies(current, change)) throw new Error(refused);
        return renameInSnapshot(current, change, place);
      }, follow: (current, next) => ({ before: factsOf(current.snapshot), after: factsOf(next) }) });
    } catch (error) {
      throw Object.assign(new Error(error.kind === 'refused' ? refused : `The ${what} was not saved. Check your connection and try again.`),
        { dropped: error.kind === 'dropped' });
    }
    changeView((current) => current?.trip.id === id ? { ...current, trip: saved, result: renameInResult(current.result, change) } : current);
    // The planner may have opened this trip while the save was under way.
    if (openedRef.current?.id === id) renameInPlanner(change);
    // My trips lists a trip by its title and dates it by its arrive-by time, so its list goes stale.
    if (change.arriveBy !== undefined || saved.title !== view.trip.title) setListVersion((version) => version + 1);
  };
  // Leaving a trip view is what saves a name still being typed, so an edit can fail once its view has gone: it
  // then says so above every tab. Either way it stops an Edit trip or Edit a copy that was waiting for it.
  const failedEdits = useRef(new Map());
  const editsFailed = (id) => failedEdits.current.get(id)?.count || 0;
  const stopAtFailedEdit = (id, before) => {
    if (editsFailed(id) !== before) throw Object.assign(new Error(failedEdits.current.get(id).message), { name: 'EditFailed' });
  };
  const viewEdit = async (view, action) => {
    if (!view) return;
    const { id } = view.trip;
    const visit = viewVisit.current;
    try { await action(); } catch (failure) {
      if (failure.dropped) throw failure;
      const message = `The change to ${writerRef.current?.known(id)?.title || view.trip.title} was not saved. Check your connection and try again.`;
      failedEdits.current.set(id, { count: editsFailed(id) + 1, message });
      if (latestView.current?.trip.id !== id || viewVisit.current !== visit) setLostEdit(message);
      throw failure;
    }
  };
  // Edit a copy saves a new trip with the trip as it stands, once its changes still being saved are in, then
  // edits the copy; the original is never touched. An unclear failure retries the same copy, never making two.
  const copyRetry = useRef(null);
  const copyViewed = async (replacing = false) => {
    const view = viewedTrip;
    const editor = writerRef.current;
    if (!view || !editor) return;
    askFirst(replacing);
    const id = view.trip.id;
    const failures = editsFailed(id);
    const use = plannerUse.current;
    const captured = beginLoad();
    const earlier = copyRetry.current?.tripId === id ? copyRetry.current : null;
    copyRetry.current = null;
    let copy = earlier?.copy && editor.known(earlier.copy.id);
    // What the first press asked for: the copy as it was made, whatever has become of it since.
    let sent = earlier?.sent;
    if (!copy) {
      try {
        if (earlier?.retry) copy = await earlier.retry();
        else {
          await editor.settled(id);
          stopAtFailedEdit(id, failures);
          const source = editor.known(id) || view.trip;
          sent = { title: copyTitle(source.title), snapshot: source.snapshot };
          copy = await editor.create({ id: newId(), ...sent });
        }
      } catch (error) {
        if (error.retry) copyRetry.current = { tripId: id, retry: error.retry, sent };
        endLoad(captured);
        throw error.name === 'EditFailed' ? error : new Error('The copy was not saved. Check your connection and try again.');
      }
      setListVersion((version) => version + 1);
    }
    // Something newer has started, or the person went on in the planner: the copy is saved, and stays in My trips.
    const movedOn = () => latestView.current?.trip.id !== id && plannerUse.current !== use;
    // A later press keeps the copy's ID, so its copy stands as the trip did at the first press; it takes the
    // trip as it stands now, except where the copy has been changed since. A trip that cannot be read leaves it.
    if (earlier && !movedOn() && current(captured)) {
      try {
        await Promise.all([id, copy.id].map((trip) => editor.settled(trip).catch(() => {})));
        stopAtFailedEdit(id, failures);
        const source = editor.known(id);
        const held = editor.known(copy.id) || copy;
        const title = source && copyTitle(source.title);
        const change = {
          ...(source && held.title === sent.title && held.title !== title ? { title } : {}),
          ...(source && sameData(held.snapshot, sent.snapshot) && !sameData(held.snapshot, source.snapshot) ? { snapshot: source.snapshot } : {}),
        };
        copy = Object.keys(change).length ? await editor.update(copy.id, change) : held;
      } catch (failure) {
        copyRetry.current = { tripId: id, copy, sent };
        endLoad(captured);
        throw failure.name === 'EditFailed' ? failure : new Error('The copy was not saved. Check your connection and try again.');
      }
    }
    if (movedOn()) endLoad(captured);
    if (movedOn() || !current(captured)) return;
    try { await editInPlanner(false, copy, view, replacing); } catch (failure) {
      copyRetry.current = { tripId: id, copy, sent };
      endLoad(captured);
      throw failure;
    }
  };
  // A new name here is the person's own, so a later arrive-by date leaves it as it is.
  const titleViewed = (text) => viewEdit(viewedTrip, async () => {
    const editor = writerRef.current;
    if (!editor) return;
    try { await editor.update(viewedTrip.trip.id, { title: text }); } catch (error) {
      throw Object.assign(new Error('The name was not saved. Check your connection and try again.'), { dropped: error.kind === 'dropped' });
    }
    setListVersion((version) => version + 1);
  });
  // Retry from the question over an unsaved route: says how the route stands now.
  const retryPlanner = async () => {
    if (autoSave.unsaved() === 'unsaved') autoSave.saveAgain(); else autoSave.retry();
    await autoSave.saveEnded();
    return autoSave.unsaved();
  };
  const relinkViewed = useCallback((view, restored) => {
    setViewedTrip((current) => current === view ? { trip: current.trip, result: restored } : current);
  }, []);
  const renameViewed = (target, text) => viewEdit(viewedTrip, () => editViewed(nameChange(target, text, viewedTrip.result), 'name'));
  const arriveViewed = (value) => viewEdit(viewedTrip, () => editViewed(arriveByChange(value), 'time'));
  // Recalculate waits one render, so the calculation reads the trip just loaded into the planner.
  useEffect(() => {
    if (!calculateNext) return;
    setCalculateNext(false);
    void submitRef.current();
  }, [calculateNext]);

  const selectPlace = async (record, point, setter, isDestination = false, append = false) => {
    invalidate(); setError('');
    const captured = token();
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const details = await resolvePlace(map, record.source.place_id, { signal: controller.signal });
      if (!current(captured)) throw abortError();
      privateOwner.current = captured.owner;
      const patch = { ...details, label: record.label, saved_id: record.id };
      if (isDestination) setter((old) => old.stop_id === point.stop_id ? { ...old, ...patch } : old);
      else setter((list) => append ? [...list, { ...point, ...patch }]
        : list.map((old) => old.stop_id === point.stop_id ? { ...old, ...patch } : old));
    } finally { controllers.current.delete(controller); }
  };

  useLayoutEffect(() => {
    scrollPane.current?.scrollTo({ top: 0 });
  }, [activeView]);

  const navigate = (view, focus = false) => {
    if (view !== 'trips') { closeView(); plannerUse.current += 1; }
    setActiveView(view);
    if (focus) viewButtons.current[view]?.focus();
  };
  const navigateWithKeyboard = (event, view) => {
    const views = auth.status === 'authenticated' ? ['plan', 'trips', 'locations'] : ['plan'];
    const index = views.indexOf(view);
    let next;
    if (event.key === 'ArrowRight') next = views[(index + 1) % views.length];
    else if (event.key === 'ArrowLeft') next = views[(index + views.length - 1) % views.length];
    else if (event.key === 'Home') next = views[0];
    else if (event.key === 'End') next = views[views.length - 1];
    if (next) { event.preventDefault(); navigate(next, true); }
  };

  const savedChoices = (saved, onSavedSelect) => auth.status === 'authenticated'
    ? { savedLocations: saved.locations, onSavedSelect } : {};
  const unplaced = [...drivers.map((point, index) => [point, 'Driver ' + (index + 1)]),
    ...passengers.map((point, index) => [point, 'Pickup ' + (index + 1)]), [destination, 'destination']]
    .filter(([point]) => !hasCoordinates(point.coordinates)).map(([, name]) => name);
  const missing = !drivers.length ? 'Add a driver.'
    : !passengers.length ? 'Add a pickup.'
      : unplaced.length > 3 ? `Missing places for ${unplaced.length} stops.`
        : unplaced.length ? `Missing: ${listNames(unplaced)}.` : '';
  // Calculate stays focusable while places are missing; pressing it leads to the first empty field.
  const focusFirstMissing = () => {
    const name = unplaced[0];
    if (!name) return;
    const label = name === 'destination' ? 'Destination' : name + ' location';
    scrollPane.current?.querySelector(`input[aria-label="${label}"]`)?.focus();
  };
  // Hide private form/result during the account-transition render; layout reset precedes paint.
  if (privateStale) return null;
  return (
    <AccountBoundary key={authKey} auth={auth} savedRef={savedRef}>
      {(saved) => { return (
        <div className="planner">
          {auth.status === 'authenticated' && <SavedRowSync saved={saved} map={map} drivers={drivers} passengers={passengers}
            destination={destination} setDrivers={setDrivers} setPassengers={setPassengers} setDestination={setDestination}
            onMove={followSavedMove} />}
          {auth.status === 'authenticated' && <ViewedLinksSync saved={saved} map={map} view={viewedTrip} onRelinked={relinkViewed} />}
          <div className="planner-nav" role="tablist" aria-label="Planner views">
            {[['plan', 'Plan trip'], ['trips', 'My trips'], ['locations', 'My locations']].map(([view, label]) => (
              <button key={view} type="button" role="tab" id={'planner-tab-' + view}
                aria-controls={view === 'trips' && auth.status !== 'authenticated' ? undefined : 'planner-panel-' + view} aria-selected={activeView === view}
                tabIndex={activeView === view ? 0 : -1}
                disabled={view !== 'plan' && auth.status !== 'authenticated'}
                ref={(button) => { viewButtons.current[view] = button; }}
                onClick={() => navigate(view)} onKeyDown={(event) => navigateWithKeyboard(event, view)}>
                {label}
              </button>
            ))}
          </div>
          <div className="planner-scroll" ref={scrollPane} tabIndex="0" aria-label="Planner content">
          {lostEdit && <p className="saving-error" role="alert">{lostEdit}</p>}
          <div id="planner-panel-plan" role="tabpanel" aria-labelledby="planner-tab-plan" hidden={activeView !== 'plan'}>
          {openedTrip?.opened && auth.status === 'authenticated' ? <div className="editing-trip">
            <p>Editing <strong>{autoSave.trip?.title || openedTrip.title}</strong></p>
            <button type="button" className="text-button" onClick={startOver}>Start over</button>
          </div> : null}
          <SectionHeading title="Drivers" done={placed(drivers)} column="Seats" />
          <p id="driver-seats-help" className="visually-hidden">Seats: room for passengers, not counting the driver.</p>
          {drivers.map((point, index) => (
            <div className="planner-location" key={point.stop_id}>
              <SavedLocationControls showPicker={false} auth={auth} point={point} saved={saved}
                fieldLabel={'Driver ' + (index + 1)} onSelect={(record) => selectPlace(record, point, setDrivers)}
                onSaved={(row) => nameSaved(setDrivers, point.stop_id, row)}
                renderAddress={(action) => <div className="driver-input-group">
                  <AddressInput map={map} value={point.address} label={'Driver ' + (index + 1) + ' location'} nickname={point.label} placeName={point.place_name}
                    placeholder={'Driver ' + (index + 1) + ' location'} action={action}
                    {...savedChoices(saved, (record) => selectPlace(record, point, setDrivers))}
                    onChange={(patch) => edit(setDrivers, point.stop_id, patch)} />
                  <label className="planner-quantity-field">
                    <input type="number" min="1" inputMode="numeric" value={point.capacity}
                      aria-label={'Driver ' + (index + 1) + ' passenger seats'} aria-describedby="driver-seats-help"
                      onChange={(event) => edit(setDrivers, point.stop_id, { capacity: Number(event.target.value) })} />
                  </label>
                  <button type="button" className="remove-location-button" aria-label={'Remove Driver ' + (index + 1)}
                    title={'Remove Driver ' + (index + 1)} onClick={() => removePoint(setDrivers, point.stop_id, addDriverButton)}>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  </button>
                </div>} />
            </div>
          ))}
          <button type="button" ref={addDriverButton} className="secondary-button" onClick={() => {
            invalidate(); setDrivers((list) => [...list, newDriver()]);
          }}>Add Driver</button>

          <SectionHeading title="Passenger pickups" done={placed(passengers)} column="People" />
          <p id="pickup-people-help" className="visually-hidden">People: how many wait at this pickup. They may ride in different cars.</p>
          {passengers.map((point, index) => (
            <div className="planner-location" key={point.stop_id}>
              <SavedLocationControls showPicker={false} auth={auth} point={point} saved={saved}
                fieldLabel={'Pickup ' + (index + 1)} onSelect={(record) => selectPlace(record, point, setPassengers)}
                onSaved={(row) => nameSaved(setPassengers, point.stop_id, row)}
                renderAddress={(action) => <div className="passenger-input-group">
                  <AddressInput map={map} value={point.address} label={'Pickup ' + (index + 1) + ' location'} nickname={point.label} placeName={point.place_name}
                    placeholder={'Pickup ' + (index + 1) + ' location'} action={action}
                    {...savedChoices(saved, (record) => selectPlace(record, point, setPassengers))}
                    onChange={(patch) => edit(setPassengers, point.stop_id, patch)} />
                  <label className="planner-quantity-field">
                    <input type="number" min="1" max="12" step="1" inputMode="numeric" value={point.count}
                      aria-label={'Passengers at pickup ' + (index + 1)} aria-describedby="pickup-people-help"
                      onChange={(event) => edit(setPassengers, point.stop_id,
                        resizePickup(point, event.target.value === '' ? '' : Number(event.target.value)))} />
                  </label>
                  <button type="button" className="remove-location-button" aria-label={'Remove pickup ' + (index + 1)}
                    title={'Remove pickup ' + (index + 1)} onClick={() => removePoint(setPassengers, point.stop_id, addPassengerButton)}>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  </button>
                </div>} />
            </div>
          ))}
          <button type="button" ref={addPassengerButton} className="secondary-button" onClick={() => {
            invalidate(); setPassengers((list) => [...list, newPassengerPickup()]);
          }}>Add pickup</button>

          <SectionHeading title="Destination" done={placed([destination])} />
          <div className="planner-location">
            <SavedLocationControls showPicker={false} auth={auth} point={destination} saved={saved} fieldLabel="Destination"
              onSelect={(record) => selectPlace(record, destination, setDestination, true)}
              onSaved={(row) => setDestination((point) => point.source?.place_id === row.source.place_id
                ? { ...point, label: row.label, saved_id: row.id } : point)}
              renderAddress={(action) => <AddressInput map={map} className="full-width-input" value={destination.address}
                label="Destination" placeholder="Destination" onChange={editDestination}
                {...savedChoices(saved, (record) => selectPlace(record, destination, setDestination, true))}
                nickname={destination.label} placeName={destination.place_name} action={action} />} />
          </div>
          <button type="button" className={'submit-btn' + (missing ? ' is-unavailable' : '')} disabled={busy}
            aria-disabled={missing ? 'true' : undefined} aria-describedby={missing ? 'calculate-missing' : undefined}
            onClick={missing ? focusFirstMissing : submit}>
            {busy ? 'Loading route…' : 'Calculate route'}
          </button>
          {/* One fixed row under Calculate: status on the left, Start over or Undo on the right, so nothing above it moves. */}
          {(missing || cleared || dirty) && <div className="calculate-row">
            {cleared ? <p className="saving-note" role="status">Planner cleared.</p>
              : <p id="calculate-missing" className="saving-note">{missing}</p>}
            {cleared ? <button type="button" className="text-button" onClick={undoStartOver}>Undo</button>
              : dirty && !(openedTrip?.opened && auth.status === 'authenticated')
                && <button type="button" className="text-button" onClick={startOver}>Start over</button>}
          </div>}
          {error && <p role="alert" className="saving-error">{error}</p>}

          {/* A route being calculated replaces this one, so a change made to it meanwhile would be lost. */}
          {result && mapResult === result && <div inert={busy ? '' : undefined}><RouteResults result={result} routes={route.routes} legs={route.legs}
            status={route.status} selected={selected} onSelect={selectDriver} onRetry={() => setMapAttempt((attempt) => attempt + 1)}
            onRename={renamePlanned} onArriveBy={arrivePlanned}>
            <TripSaveStatus auth={auth} save={{ ...autoSave, retry: touchPlanner(autoSave.retry), saveAgain: touchPlanner(autoSave.saveAgain),
              saveAsNew: touchPlanner(autoSave.saveAsNew), rename: touchPlanner(autoSave.rename) }} />
            {result.changed && <ChangedNotice result={result} busy={busy} onRecalculate={submit} />}
          </RouteResults></div>}
          </div>
          <SavedTripsPanel auth={auth} activeView={activeView} openedTrip={openedTrip}
            writer={writer} onOpened={setOpenedTrip}
            listVersion={listVersion} viewing={!!viewedTrip}
            onBeginLoad={beginLoad} onEndLoad={endLoad} onView={viewTrip}>
            {viewedTrip && <TripView key={viewedTrip.trip.id} route={route}
              // The trip's name and dates as last confirmed, whoever changed them.
              view={{ ...viewedTrip, trip: writer?.known(viewedTrip.trip.id) || viewedTrip.trip }} selected={selected} onSelect={selectDriver} busy={busy}
              onRetry={() => setMapAttempt((attempt) => attempt + 1)} onBack={closeView} onEdit={(recalculate, replacing) => editInPlanner(recalculate, null, null, replacing)}
              onCopy={copyViewed} onTitle={titleViewed} onRetrySave={retryPlanner}
              onRename={renameViewed} onArriveBy={arriveViewed}
              // This trip is also in the planner, whose saves carry its names: a failed or refused save shows here too.
              saveStatus={openedTrip?.id === viewedTrip.trip.id && ['error', 'unsavable'].includes(autoSave.phase)
                ? <TripSaveStatus save={autoSave} auth={auth} /> : null} />}
          </SavedTripsPanel>
          <div id="planner-panel-locations" role="tabpanel" aria-labelledby="planner-tab-locations" hidden={activeView !== 'locations'}>
            <SavedLocationsPanel auth={auth} saved={saved} map={map} activeView={activeView} />
          </div>
          </div>
        </div>
      ); }}
    </AccountBoundary>
  );
}
