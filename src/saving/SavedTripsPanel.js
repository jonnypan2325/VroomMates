import React, { useEffect, useRef, useState } from 'react';
import { SavedApiError, canonicalText, requestJSON, sameData } from './api';
import InlineEdit from './InlineEdit';
import { validArriveBy } from './tripSnapshot';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STOP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      || !Object.keys(value).every((key) => [...required, ...optional].includes(key))) {
    throw new Error('Invalid saved trip.');
  }
}

export function canonicalSnapshot(value) {
  fields(value, ['schema_version', 'inputs', 'routes']);
  if (value.schema_version !== 1) throw new Error('Unsupported saved trip.');
  fields(value.inputs, ['drivers', 'passengers', 'destination'], ['arrive_by']);
  if (value.inputs.arrive_by !== undefined && !validArriveBy(value.inputs.arrive_by)) throw new Error('Invalid arrive-by time.');
  // Drivers and pickups may name a person; a destination is only a place.
  const point = (row, driver = false, person = true) => {
    fields(row, driver ? ['stop_id', 'source', 'capacity'] : ['stop_id', 'source'],
      person ? ['label', 'location_id', 'person'] : ['label', 'location_id']);
    if (typeof row.stop_id !== 'string' || !STOP_ID.test(row.stop_id)) throw new Error('Invalid stop.');
    fields(row.source, ['kind', 'place_id']);
    const place = row.source.place_id;
    if (row.source.kind !== 'google_places' || typeof place !== 'string' || !place
        || /[\s\p{C}]/u.test(place) || new TextEncoder().encode(place).length > 4096) {
      throw new Error('Invalid place reference.');
    }
    const label = canonicalText(row.label === undefined ? '' : row.label, 1000, 1000, true);
    const result = { stop_id: row.stop_id, label, source: { kind: 'google_places', place_id: place } };
    if (row.location_id !== undefined) {
      if (typeof row.location_id !== 'string' || !UUID.test(row.location_id)) throw new Error('Invalid saved location link.');
      result.location_id = row.location_id;
    }
    if (row.person !== undefined) result.person = canonicalText(row.person, 80, 320);
    if (driver) {
      if (!Number.isSafeInteger(row.capacity) || row.capacity < 1) throw new Error('Invalid capacity.');
      result.capacity = row.capacity;
    }
    return result;
  };
  if (!Array.isArray(value.inputs.drivers) || value.inputs.drivers.length < 1 || value.inputs.drivers.length > 64
      || !Array.isArray(value.inputs.passengers) || value.inputs.passengers.length < 1 || value.inputs.passengers.length > 256) {
    throw new Error('Invalid saved inputs.');
  }
  const drivers = value.inputs.drivers.map((row) => point(row, true));
  const passengers = value.inputs.passengers.map((row) => point(row));
  const destination = point(value.inputs.destination, false, false);
  const ids = [...drivers, ...passengers, destination].map((row) => row.stop_id);
  if (new Set(ids).size !== ids.length || !Array.isArray(value.routes) || value.routes.length !== drivers.length) {
    throw new Error('Invalid saved assignments.');
  }
  const passengerIds = new Set(passengers.map((row) => row.stop_id));
  const seen = new Set();
  const routes = value.routes.map((row, index) => {
    fields(row, ['driver_id', 'stop_ids']);
    if (row.driver_id !== drivers[index].stop_id || !Array.isArray(row.stop_ids)
        || row.stop_ids.length < 2 || row.stop_ids.length > 258
        || row.stop_ids[0] !== row.driver_id || row.stop_ids[row.stop_ids.length - 1] !== destination.stop_id
        || row.stop_ids.length - 2 > drivers[index].capacity) throw new Error('Invalid saved route.');
    row.stop_ids.slice(1, -1).forEach((id) => {
      if (!passengerIds.has(id) || seen.has(id)) throw new Error('Invalid saved pickup.');
      seen.add(id);
    });
    return { driver_id: row.driver_id, stop_ids: [...row.stop_ids] };
  });
  if (seen.size !== passengers.length) throw new Error('Missing saved pickup.');
  const arrive = value.inputs.arrive_by === undefined ? {} : { arrive_by: value.inputs.arrive_by };
  return { schema_version: 1, inputs: { drivers, passengers, destination, ...arrive }, routes };
}

function validStamp(value) {
  return typeof value === 'string' && STAMP.test(value) && Number.isFinite(Date.parse(value));
}

export function readTrip(body, id) {
  fields(body, ['trip']);
  const trip = body.trip;
  fields(trip, ['id', 'title', 'created_at', 'snapshot']);
  if (trip.id !== id || !UUID.test(trip.id) || !validStamp(trip.created_at)) throw new Error('Invalid saved trip response.');
  const title = canonicalText(trip.title, 200, 200);
  const snapshot = canonicalSnapshot(trip.snapshot);
  if (title !== trip.title || !sameData(snapshot, trip.snapshot)) throw new Error('Invalid saved trip response.');
  return { id: trip.id, title, created_at: trip.created_at, snapshot };
}

function readList(body) {
  fields(body, ['trips', 'next_cursor']);
  if (!Array.isArray(body.trips) || body.trips.length > 20
      || !(body.next_cursor === null || (typeof body.next_cursor === 'string'
        && /^[A-Za-z0-9_-]{1,512}$/.test(body.next_cursor)))) throw new Error('Invalid saved trips response.');
  const ids = new Set();
  return { trips: body.trips.map((trip) => {
    fields(trip, ['id', 'title', 'created_at', 'schema_version', 'driver_count', 'passenger_count'], ['arrive_by']);
    if (trip.arrive_by !== undefined && !validArriveBy(trip.arrive_by)) throw new Error('Invalid saved trip summary.');
    if (typeof trip.id !== 'string' || !UUID.test(trip.id) || ids.has(trip.id) || !validStamp(trip.created_at)
        || trip.schema_version !== 1 || !Number.isInteger(trip.driver_count) || trip.driver_count < 1 || trip.driver_count > 64
        || !Number.isInteger(trip.passenger_count) || trip.passenger_count < 1 || trip.passenger_count > 256
        || canonicalText(trip.title, 200, 200) !== trip.title) throw new Error('Invalid saved trip summary.');
    ids.add(trip.id);
    return { ...trip };
  }), cursor: body.next_cursor };
}

function failureMessage(error, fallback) {
  if (error instanceof SavedApiError) {
    if (error.status === 401) return 'Your sign-in expired. Please sign in again.';
    if (error.code === 'SAVED_TRIP_UNREADABLE') return 'This trip could not be read. Try again later.';
    if (error.status === 404) return 'This trip is no longer available. Refresh My Trips.';
    if (error.status === 503) return 'Saved trips are temporarily unavailable. Please retry.';
  }
  return fallback;
}

// A saved trip is dated by when everyone arrives, in full ("arrive Oct 30, 2026"), or else by when it was saved.
function tripDate(trip) {
  if (!trip.arrive_by) return new Date(trip.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const [year, month, day] = trip.arrive_by.slice(0, 10).split('-').map(Number);
  return 'arrive ' + new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const emptyList = (scope) => ({ scope, trips: [], cursor: null, loaded: false, loading: false, error: '' });

/** My trips: the saved list, renamed and deleted in place; Open shows a trip read-only through `onView`. */
export default function SavedTripsPanel({ auth, onView, onBeginLoad, onEndLoad, activeView = 'all',
  openedTrip = null, onOpened, listVersion = 0, viewing = false, children }) {
  const authenticated = auth?.status === 'authenticated' && typeof auth.profile?.id === 'string';
  const scope = authenticated ? `${auth.profile.id}:${auth.generation}` : null;
  const refreshButton = useRef(null);
  const returnFocus = useRef(false);
  const mounted = useRef(false);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const controllers = useRef(new Set());
  const listSequence = useRef(0);
  const actionLock = useRef(false);
  // Replies arrive after awaits, so they compare against the trip opened now, not at the click.
  const openedRef = useRef(openedTrip);
  openedRef.current = openedTrip;
  const [list, setList] = useState(() => emptyList(scope));
  const tripsVisible = activeView === 'trips' || activeView === 'all';
  const tripsVisibleRef = useRef(tripsVisible);
  tripsVisibleRef.current = tripsVisible;
  const fetchListRef = useRef(null);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [deleteId, setDeleteId] = useState(null);

  useEffect(() => {
    const pending = controllers.current;
    mounted.current = true;
    actionLock.current = false;
    returnFocus.current = false;
    setList(emptyList(scope));
    setAction(null); setActionError(''); setActionSuccess(''); setDeleteId(null);
    return () => {
      mounted.current = false;
      listSequence.current += 1;
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, [scope]);

  useEffect(() => {
    if (!action && returnFocus.current && scope === currentScope.current) {
      returnFocus.current = false;
      refreshButton.current?.focus();
    }
  }, [action, deleteId, scope]);

  const startRequest = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return { scope, controller };
  };
  const isCurrent = (request) => mounted.current && request.scope !== null
    && request.scope === currentScope.current && !request.controller.signal.aborted;
  const finishRequest = (request) => controllers.current.delete(request.controller);
  const activeList = list.scope === scope ? list : emptyList(scope);

  const fetchList = async (append = false) => {
    if (!scope || (append && (!activeList.cursor || activeList.loading))) return;
    const request = startRequest();
    const sequence = ++listSequence.current;
    const cursor = append ? activeList.cursor : null;
    setList((old) => ({ ...(old.scope === scope ? old : emptyList(scope)), loading: true, error: '' }));
    try {
      const response = await requestJSON(auth, `/saved-trips?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        { signal: request.controller.signal });
      if (!isCurrent(request) || sequence !== listSequence.current) return;
      const page = readList(response);
      if (cursor && page.cursor === cursor) throw new Error('Invalid pagination response.');
      setList((old) => {
        const prior = append && old.scope === scope ? old.trips : [];
        const ids = new Set(prior.map((trip) => trip.id));
        return { scope, trips: [...prior, ...page.trips.filter((trip) => !ids.has(trip.id))],
          cursor: page.cursor, loaded: true, loading: false, error: '' };
      });
    } catch (error) {
      if (isCurrent(request) && sequence === listSequence.current) {
        setList((old) => ({ ...old, loading: false, error: failureMessage(error, 'My Trips could not be loaded. Please retry.') }));
      }
    } finally { finishRequest(request); }
  };
  fetchListRef.current = fetchList;

  useEffect(() => {
    if (scope && tripsVisible && list.scope === scope && !activeList.loaded && !activeList.loading && !activeList.error) {
      void fetchListRef.current();
    }
  }, [scope, tripsVisible, list.scope, activeList.loaded, activeList.loading, activeList.error]);

  // A trip saved or renamed elsewhere makes the first page stale; it is fetched again when shown.
  useEffect(() => {
    if (!listVersion) return;
    listSequence.current += 1;
    setList((old) => ({ ...old, loaded: false, loading: false, error: '' }));
  }, [listVersion]);

  const loadTrip = async (id) => {
    if (!scope || actionLock.current) return;
    const request = startRequest();
    const endLoad = onEndLoad;
    let loadToken;
    actionLock.current = true; setAction({ scope, id, kind: 'load' }); setDeleteId(null);
    setActionError(''); setActionSuccess('');
    try {
      // Capture the planner revision at the click, before the detail request can race an edit.
      loadToken = onBeginLoad?.();
      if (!isCurrent(request)) return;
      const response = await requestJSON(auth, `/saved-trips/${id}`, { signal: request.controller.signal });
      if (!isCurrent(request)) return;
      const trip = readTrip(response, id);
      await onView(trip, loadToken);
    } catch (error) {
      if (isCurrent(request)) setActionError(failureMessage(error, 'This trip could not be loaded. Check place availability and try again.'));
    } finally {
      try {
        // Parent cleanup checks its token; run even after account changes or unmount.
        endLoad?.(loadToken);
      } finally {
        finishRequest(request);
        if (isCurrent(request)) { actionLock.current = false; setAction(null); }
      }
    }
  };

  // PATCH replaces the named fields, so a retry after an unclear reply repeats the same change.
  const patchTrip = async (id, body) => {
    const request = startRequest();
    try {
      const response = await requestJSON(auth, `/saved-trips/${id}`, { method: 'PATCH', body, signal: request.controller.signal });
      if (!isCurrent(request)) return null;
      const trip = readTrip(response, id);
      if ((body.title && trip.title !== body.title) || (body.snapshot && !sameData(trip.snapshot, body.snapshot))) {
        throw new SavedApiError(503, 'INVALID_RESPONSE', 'The change could not be confirmed.');
      }
      // The list summary counts the stored stops, so it follows the confirmed snapshot too.
      const summary = { title: trip.title, driver_count: trip.snapshot.inputs.drivers.length,
        passenger_count: trip.snapshot.inputs.passengers.length };
      setList((old) => ({ ...old, trips: old.trips.map((row) => row.id === id ? { ...row, ...summary } : row) }));
      if (openedRef.current?.id === id) onOpened?.({ ...openedRef.current, title: trip.title });
      return trip;
    } finally { finishRequest(request); }
  };

  const renameTrip = async (trip, next) => {
    setActionError(''); setActionSuccess('');
    let name;
    try { name = canonicalText(next, 200, 200); }
    catch (error) { setActionError('Use a trip name of up to 200 characters.'); throw error; }
    const owner = scope;
    try {
      const updated = await patchTrip(trip.id, { title: name });
      if (!updated) return;
      setActionSuccess(`Renamed to “${updated.title}”.`);
    } catch (error) {
      if (error?.name === 'AbortError' || currentScope.current !== owner) throw error;
      setActionError(failureMessage(error, 'The new name could not be saved. Please retry.'));
      throw error;
    }
  };

  const removeTrip = async (id) => {
    if (!scope || actionLock.current) return;
    const request = startRequest();
    actionLock.current = true; setAction({ scope, id, kind: 'delete' });
    setActionError(''); setActionSuccess('');
    listSequence.current += 1;
    try {
      const response = await requestJSON(auth, `/saved-trips/${id}`, { method: 'DELETE', signal: request.controller.signal });
      if (!isCurrent(request)) return;
      if (response !== null) throw new Error('Invalid delete response.');
      setList((old) => ({ ...old, trips: old.trips.filter((trip) => trip.id !== id), loading: false }));
      setDeleteId(null); setActionSuccess('Trip deleted.');
      // The planner must stop updating a trip that no longer exists.
      if (openedRef.current?.id === id) onOpened?.(null);
      returnFocus.current = true;
    } catch (error) {
      if (isCurrent(request)) {
        setList((old) => ({ ...old, loading: false }));
        setActionError(failureMessage(error, 'Deletion could not be confirmed. Retry deleting this trip or refresh My Trips.'));
      }
    } finally {
      finishRequest(request);
      if (isCurrent(request)) { actionLock.current = false; setAction(null); }
    }
  };

  // Hide all prior-owner labels and messages on the account-transition render itself.
  if (!scope || list.scope !== scope) return null;
  const activeAction = action?.scope === scope ? action : null;

  return (
    <>
    <section className="saving-card" hidden={!tripsVisible}
      id={activeView === 'all' ? undefined : 'planner-panel-trips'}
      role={activeView === 'all' ? undefined : 'tabpanel'}
      aria-labelledby={activeView === 'all' ? undefined : 'planner-tab-trips'}
      aria-label={activeView === 'all' ? 'My trips' : undefined}>
        {viewing ? children : <>
        <div className="list-heading">
          <h2>My trips{activeList.trips.length ? ` (${activeList.trips.length})` : ''}</h2>
          <button ref={refreshButton} type="button" className="text-button" disabled={activeList.loading || !!activeAction}
            onClick={() => void fetchList()}>{activeList.loading ? 'Loading…' : activeList.error ? 'Retry' : 'Refresh'}</button>
        </div>
        {activeList.loading && !activeList.trips.length && <p className="saving-note" role="status">Loading saved trips…</p>}
        {activeList.error && <p className="saving-error" role="alert">{activeList.error}</p>}
        {activeList.loaded && !activeList.loading && activeList.trips.length === 0 && !activeList.error
          && <p className="saving-note">No saved trips yet. Calculate a route while signed in and it is saved here.</p>}
        <ul className="saving-list">
          {activeList.trips.map((trip) => (
            <li key={trip.id} className="saving-item location-item">
              <div className="location-item-main">
                <div className="location-item-text">
                  <InlineEdit value={trip.title} label={`Name of trip ${trip.title}`} className="inline-edit-title"
                    onCommit={(next) => renameTrip(trip, next)} />
                  <span className="location-item-address">{trip.driver_count} {trip.driver_count === 1 ? 'driver' : 'drivers'} · {trip.passenger_count} {trip.passenger_count === 1 ? 'passenger' : 'passengers'} · {tripDate(trip)}</span>
                </div>
                {deleteId !== trip.id && <div className="location-item-actions">
                  <button type="button" className="text-button" disabled={!!activeAction}
                    aria-label={`Open ${trip.title}`} onClick={() => void loadTrip(trip.id)}>
                    {activeAction?.id === trip.id && activeAction.kind === 'load' ? 'Opening…' : 'Open'}
                  </button>
                  <button type="button" className="icon-button delete-icon-button" disabled={!!activeAction}
                    aria-label={`Delete ${trip.title}`} title="Delete" onClick={() => setDeleteId(trip.id)}>
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  </button>
                </div>}
              </div>
              {deleteId === trip.id && <div className="location-delete-confirm">
                <p className="saving-note">Delete “{trip.title}”? This cannot be undone.</p>
                <div className="saving-actions">
                  <button type="button" className="destructive-button" autoFocus disabled={!!activeAction}
                    aria-label={`Confirm delete ${trip.title}`} onClick={() => void removeTrip(trip.id)}>
                    {activeAction?.id === trip.id && activeAction.kind === 'delete' ? 'Deleting…' : 'Delete'}
                  </button>
                  <button type="button" className="secondary-button" disabled={!!activeAction} onClick={() => {
                    returnFocus.current = true; setDeleteId(null);
                  }}>Keep trip</button>
                </div>
              </div>}
            </li>
          ))}
        </ul>
        {activeList.cursor && <div className="saving-actions">
          <button type="button" className="secondary-button" disabled={activeList.loading || !!activeAction}
            onClick={() => void fetchList(true)}>Load more trips</button>
        </div>}
        {actionError && <p className="saving-error" role="alert">{actionError}</p>}
        {actionSuccess && <p className="saving-success" role="status">{actionSuccess}</p>}
        </>}
    </section>
    </>
  );
}
