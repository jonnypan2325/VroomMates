import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import AddressInput from './components/AddressInput';
import SavedTripsPanel, { canonicalSnapshot, editedDate, readTrip } from './saving/SavedTripsPanel';
import { SavedApiError, canonicalText, newId, requestJSON } from './saving/api';
import InlineEdit from './saving/InlineEdit';
import TripSaveStatus from './saving/TripSaveStatus';
import useSavedLocations from './saving/useSavedLocations';
import useTripAutoSave, { copyTitle, followTitle, titleFacts } from './saving/useTripAutoSave';
import RouteResults from './results/RouteResults';
import useRouteMap from './results/useRouteMap';
import { SavedLocationControls, SavedLocationsPanel } from './saving/SavedLocationControls';
import { freezeInputs, makeResult, newDriver, newPoint, newPassengerPickup, resizePickup, expandPassengerPickups, groupPassengerPickups, reopenSnapshot,
  arriveByChange, nameChange, renameDestination, renameInResult, renameInSnapshot, renamePoints } from './saving/tripSnapshot';
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

function TripView({ view, route, selected, onSelect, onRetry, onBack, onEdit, onCopy, onTitle, onRename, onArriveBy, busy, saveStatus }) {
  const { trip, result } = view;
  const drivers = result.inputs.drivers.length;
  const people = result.inputs.passengers.length;
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  // A failed name or copy says so here and changes nothing.
  const attempt = async (action) => {
    setError('');
    try { await action(); } catch (failure) { setError(failure.message); throw failure; }
  };
  const copy = async () => {
    setCopying(true);
    try { await attempt(onCopy); } catch (_) { /* Shown above. */ } finally { setCopying(false); }
  };
  return <div className="trip-view">
    <button type="button" className="text-button trip-view-back" onClick={onBack}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>
      My trips</button>
    <h2 aria-label={trip.title}><InlineEdit value={trip.title} label="Trip name" className="trip-view-title" onCommit={(next) => attempt(() => onTitle(next))} /></h2>
    <p className="saving-note trip-view-meta">{drivers} {drivers === 1 ? 'driver' : 'drivers'} · {people} {people === 1 ? 'passenger' : 'passengers'} · last edited {editedDate(trip)}</p>
    {result.changed && <ChangedNotice result={result} busy={busy} onRecalculate={() => onEdit(true)} />}
    <RouteResults result={result} routes={route.routes} legs={route.legs} status={route.status}
      selected={selected} onSelect={onSelect} onRetry={onRetry} onRename={onRename} onArriveBy={onArriveBy}>{saveStatus}</RouteResults>
    {error && <p className="saving-error" role="alert">{error}</p>}
    <div className="trip-view-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onEdit(false)}>Edit trip</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void copy()}>{copying ? 'Copying…' : 'Edit a copy'}</button>
    </div>
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
  const autoSave = useTripAutoSave({ auth, result: privateStale ? null : result, trip: openedTrip,
    // A saved trip is private, so the planner holding it clears when the account changes.
    onTrip: (trip) => {
      privateOwner.current = authKey;
      setOpenedTrip(trip);
      // A new title, and the time of the edit, show in the open trip too.
      setViewedTrip((view) => view?.trip.id === trip.id && (view.trip.title !== trip.title || view.trip.updated_at !== trip.updated_at)
        ? { ...view, trip: { ...view.trip, title: trip.title, ...(trip.updated_at ? { updated_at: trip.updated_at } : {}) } } : view);
    },
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
      setResult(frozen);
    } catch (failure) {
      if (current(captured) && failure.name !== 'AbortError') setError(failure.message || 'Could not reach the route optimizer. Please retry.');
    } finally {
      controllers.current.delete(controller);
      if (current(captured)) setBusy(false);
    }
  };

  submitRef.current = submit;

  const beginLoad = () => {
    invalidate(); setError('');
    const captured = token();
    setBusy(true);
    return captured;
  };
  const endLoad = (captured) => { if (captured && current(captured)) setBusy(false); };
  // Opening a saved trip shows it read-only; its linked stops follow the owner's My locations.
  const viewTrip = async (trip, captured) => {
    if (!captured || !current(captured)) throw abortError();
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    try {
      const saved = savedRef.current;
      const complete = saved && !saved.loading && !saved.error ? saved.locations : null;
      const restored = await reopenSnapshot(trip.snapshot,
        (placeId) => resolvePlace(map, placeId, { signal: controller.signal }), complete);
      if (!current(captured)) throw abortError();
      privateOwner.current = captured.owner;
      setViewedTrip({ trip, result: restored });
      scrollPane.current?.scrollTo({ top: 0 });
    } finally {
      controllers.current.delete(controller);
      if (current(captured)) setBusy(false);
    }
  };
  // Edit in planner loads the viewed trip into Plan trip; Recalculate also calculates it again, which updates the trip.
  const editInPlanner = (recalculate, trip = viewedTrip?.trip) => {
    if (!viewedTrip) return;
    const { result: restored } = viewedTrip;
    invalidate(); setError('');
    setDrivers(restored.inputs.drivers);
    setPassengers(groupPassengerPickups(restored.inputs.passengers));
    setDestination(restored.inputs.destination);
    setArriveBy(restored.inputs.arrive_by || '');
    setResult(restored);
    setOpenedTrip({ id: trip.id, title: trip.title, opened: true, created_at: trip.created_at, facts: titleFacts(restored) });
    setViewedTrip(null);
    setActiveView('plan');
    viewButtons.current.plan?.focus();
    if (recalculate) setCalculateNext(true);
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
  const editPlanned = (change) => {
    const next = renameInPlanner(change);
    if (next) autoSave.saveEdits(next);
  };
  const renamePlanned = async (target, text) => editPlanned(nameChange(target, text, resultRef.current));
  const arrivePlanned = async (value) => editPlanned(arriveByChange(value));
  // A trip opened from My trips saves a change straight away; the stops it follows from My locations keep their own names.
  const editViewed = async (change, what) => {
    const view = viewedTrip;
    if (!view) return;
    // The planner may be saving this same trip; its queue then carries the change, so neither save overwrites the other.
    if (openedTrip?.id === view.trip.id && resultRef.current?.snapshot) {
      editPlanned(change);
      setViewedTrip((current) => current?.trip.id === view.trip.id ? { trip: { ...current.trip,
        snapshot: renameInSnapshot(current.trip.snapshot, change, current.result.inputs.destination.source) },
      result: renameInResult(current.result, change) } : current);
      return;
    }
    const snapshot = renameInSnapshot(view.trip.snapshot, change, view.result.inputs.destination.source);
    const facts = titleFacts(renameInResult(view.result, change));
    const title = followTitle(view.trip.title, titleFacts(view.result), facts, view.trip.created_at);
    let saved;
    try {
      const response = await requestJSON(auth, `/saved-trips/${view.trip.id}`, { method: 'PATCH',
        body: { ...(title !== view.trip.title ? { title } : {}), snapshot: canonicalSnapshot(snapshot) } });
      saved = readTrip(response, view.trip.id);
    } catch (_) {
      throw new Error(`The ${what} was not saved. Check your connection and try again.`);
    }
    setViewedTrip((current) => current?.trip.id === saved.id
      ? { trip: saved, result: renameInResult(current.result, change) } : current);
    if (openedTrip?.id === saved.id) {
      renameInPlanner(change);
      setOpenedTrip((trip) => trip?.id === saved.id ? { ...trip, title: saved.title, facts } : trip);
    }
    // My trips lists a trip by its title and dates it by its arrive-by time, so its list goes stale.
    if (change.arriveBy !== undefined || saved.title !== view.trip.title) setListVersion((version) => version + 1);
  };
  // Edit a copy saves a new trip with the same route first, then edits that one; the original is never touched.
  const copyAttempt = useRef(null);
  const copyViewed = async () => {
    const view = viewedTrip;
    if (!view) return;
    const captured = beginLoad();
    if (copyAttempt.current?.tripId !== view.trip.id) copyAttempt.current = { tripId: view.trip.id, id: newId(), unclear: false };
    const pending = copyAttempt.current;
    let copy;
    try {
      let response;
      // An unclear earlier reply may still have saved the copy; the same ID finds it rather than making two.
      if (pending.unclear) {
        try { response = await requestJSON(auth, `/saved-trips/${pending.id}`); } catch (error) {
          if (!(error instanceof SavedApiError && error.status === 404)) throw error;
        }
      }
      if (!response) {
        response = await requestJSON(auth, '/saved-trips', { method: 'POST',
          body: { id: pending.id, title: copyTitle(view.trip.title), snapshot: canonicalSnapshot(view.trip.snapshot) } });
      }
      copy = readTrip(response, pending.id);
    } catch (error) {
      const definite = error instanceof SavedApiError && [400, 409, 413, 415].includes(error.status);
      copyAttempt.current = definite ? null : { ...pending, unclear: true };
      endLoad(captured);
      throw new Error('The copy was not saved. Check your connection and try again.');
    }
    copyAttempt.current = null;
    setListVersion((version) => version + 1);
    if (current(captured)) editInPlanner(false, copy);
  };
  // A new name here is the person's own, so a later arrive-by date leaves it as it is.
  const titleViewed = async (text) => {
    const view = viewedTrip;
    if (!view) return;
    try {
      // The planner may be saving this same trip; its queue then sends the name in turn.
      if (openedTrip?.id === view.trip.id) { await autoSave.rename(text); return; }
      const response = await requestJSON(auth, `/saved-trips/${view.trip.id}`, { method: 'PATCH',
        body: { title: canonicalText(text, 200, 200) } });
      const saved = readTrip(response, view.trip.id);
      setViewedTrip((current) => current?.trip.id === saved.id ? { ...current, trip: saved } : current);
      setListVersion((version) => version + 1);
    } catch (_) {
      throw new Error('The name was not saved. Check your connection and try again.');
    }
  };
  const renameViewed = async (target, text) => editViewed(nameChange(target, text, viewedTrip?.result), 'name');
  const arriveViewed = async (value) => editViewed(arriveByChange(value), 'time');
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
    if (view !== 'trips') setViewedTrip(null);
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
          <div id="planner-panel-plan" role="tabpanel" aria-labelledby="planner-tab-plan" hidden={activeView !== 'plan'}>
          {openedTrip?.opened && auth.status === 'authenticated' ? <div className="editing-trip">
            <p>Editing <strong>{openedTrip.title}</strong></p>
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

          {result && mapResult === result && <RouteResults result={result} routes={route.routes} legs={route.legs}
            status={route.status} selected={selected} onSelect={selectDriver} onRetry={() => setMapAttempt((attempt) => attempt + 1)}
            onRename={renamePlanned} onArriveBy={arrivePlanned}>
            <TripSaveStatus save={autoSave} auth={auth} />
            {result.changed && <ChangedNotice result={result} busy={busy} onRecalculate={submit} />}
          </RouteResults>}
          </div>
          <SavedTripsPanel auth={auth} activeView={activeView} openedTrip={openedTrip} onOpened={setOpenedTrip}
            listVersion={listVersion} viewing={!!viewedTrip}
            onBeginLoad={beginLoad} onEndLoad={endLoad} onView={viewTrip}>
            {viewedTrip && <TripView key={viewedTrip.trip.id} view={viewedTrip} route={route} selected={selected} onSelect={selectDriver} busy={busy}
              onRetry={() => setMapAttempt((attempt) => attempt + 1)} onBack={() => setViewedTrip(null)} onEdit={editInPlanner}
              onCopy={copyViewed} onTitle={titleViewed}
              onRename={renameViewed} onArriveBy={arriveViewed}
              // This trip is also in the planner, whose queue saves its names: a failed save shows here too, with Retry.
              saveStatus={openedTrip?.id === viewedTrip.trip.id && autoSave.phase === 'error'
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
