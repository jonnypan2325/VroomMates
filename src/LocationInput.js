import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import AddressInput from './components/AddressInput';
import SavedTripsPanel from './saving/SavedTripsPanel';
import useSavedLocations from './saving/useSavedLocations';
import { SavedLocationControls, SavedLocationsPanel, SectionSavedPicker } from './saving/SavedLocationControls';
import { freezeInputs, makeResult, newDriver, newPoint, newPassengerPickup, resizePickup, expandPassengerPickups, groupPassengerPickups, reopenSnapshot } from './saving/tripSnapshot';
import { hasCoordinates, resolvePlace } from './saving/places';
import './saving/Saving.css';

const API_BASE_URL = (process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');

function AccountBoundary({ auth, children }) {
  const saved = useSavedLocations(auth);
  return children(saved);
}

export default function LocationInput({ map, directionsRenderer, auth, accountControls }) {
  const [drivers, setDrivers] = useState(() => [newDriver()]);
  const [passengers, setPassengers] = useState(() => [newPassengerPickup()]);
  const [destination, setDestination] = useState(newPoint);
  const [result, setResult] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState('plan');
  const scrollPane = useRef(null);
  const addDriverButton = useRef(null);
  const addPassengerButton = useRef(null);
  const viewButtons = useRef({});
  const [mapError, setMapError] = useState('');
  const [mapBusy, setMapBusy] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const revision = useRef(0);
  const operation = useRef(0);
  const controllers = useRef(new Set());
  const mounted = useRef(true);
  const privateOwner = useRef(null);
  const directionsEpoch = useRef(0);
  const authKey = auth.status === 'authenticated' ? auth.profile.id + ':' + auth.generation : 'anonymous:' + auth.generation;
  const latest = useRef({ authKey, map, directionsRenderer });
  latest.current = { authKey, map, directionsRenderer, resultId: result?.id, selectedDriver, mapAttempt, activeView };
  const previousLifetime = useRef({ authKey, map, directionsRenderer });
  const privateStale = privateOwner.current && privateOwner.current !== authKey;

  const invalidate = useCallback(() => {
    revision.current += 1;
    operation.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setBusy(false);
  }, []);

  useLayoutEffect(() => {
    const previous = previousLifetime.current;
    if (previous.authKey !== authKey || previous.map !== map || previous.directionsRenderer !== directionsRenderer) {
      previousLifetime.current = { authKey, map, directionsRenderer };
      invalidate();
      previous.directionsRenderer?.set('directions', null);
      directionsEpoch.current += 1;
      directionsRenderer?.set('directions', null);
      setError('');
      setMapError('');
      if (previous.authKey !== authKey) setActiveView('plan');
      if (privateOwner.current && privateOwner.current !== authKey) {
        privateOwner.current = null;
        setDrivers([newDriver()]);
        setPassengers([newPassengerPickup()]);
        setDestination(newPoint());
        setResult(null);
        setSelectedDriver(0);
      }
    }
  }, [authKey, map, directionsRenderer, invalidate]);

  useEffect(() => {
    mounted.current = true;
    const pendingControllers = controllers.current;
    return () => {
      mounted.current = false;
      operation.current += 1;
      directionsEpoch.current += 1;
      pendingControllers.forEach((controller) => controller.abort());
      pendingControllers.clear();
      directionsRenderer?.set('directions', null);
    };
  }, [directionsRenderer]);

  useEffect(() => {
    const route = result?.coordinates[selectedDriver];
    const epoch = ++directionsEpoch.current;
    directionsRenderer?.set('directions', null);
    setMapError('');
    setMapBusy(false);
    if (!route || privateStale) return undefined;
    if (!map || !directionsRenderer || !window.google?.maps?.DirectionsService) {
      setMapError('Maps is not ready. Retry when the map has loaded.');
      return undefined;
    }
    const owner = authKey;
    const renderer = directionsRenderer;
    let finished = false;
    const isCurrent = () => mounted.current && epoch === directionsEpoch.current &&
      latest.current.authKey === owner && latest.current.directionsRenderer === renderer &&
      latest.current.map === map && latest.current.resultId === result.id &&
      latest.current.selectedDriver === selectedDriver && latest.current.mapAttempt === mapAttempt;
    setMapBusy(true);
    const timer = setTimeout(() => {
      if (!isCurrent() || finished) return;
      finished = true;
      setMapBusy(false);
      setMapError('Map directions timed out. Your route is still loaded. Please retry.');
    }, 8000);
    try {
      const service = new window.google.maps.DirectionsService();
      service.route({
        origin: route[0], destination: route[route.length - 1],
        waypoints: route.slice(1, -1).map((location) => ({ location, stopover: true })),
        travelMode: window.google.maps.TravelMode.DRIVING,
      }, (response, status) => {
        if (!isCurrent() || finished) return;
        finished = true;
        clearTimeout(timer);
        setMapBusy(false);
        if (status === 'OK') renderer.setDirections(response);
        else setMapError('Map directions are unavailable. Your route is still loaded. Please retry.');
      });
    } catch {
      finished = true;
      clearTimeout(timer);
      setMapBusy(false);
      setMapError('Map directions are unavailable. Your route assignments are unchanged.');
    }
    return () => { finished = true; clearTimeout(timer); directionsEpoch.current += 1; };
  }, [result, selectedDriver, map, directionsRenderer, authKey, privateStale, mapAttempt]);

  const edit = (setter, id, patch) => {
    invalidate();
    setError('');
    setter((list) => list.map((point) => point.stop_id === id ? { ...point, ...patch } : point));
  };
  const removePoint = (setter, id, addButton) => {
    invalidate(); setError('');
    setter((list) => list.filter((point) => point.stop_id !== id));
    addButton.current?.focus();
  };
  const editDestination = (patch) => {
    invalidate(); setError('');
    setDestination((point) => ({ ...point, ...patch }));
  };

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
    const inputs = freezeInputs(drivers, expanded, destination);
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
      const body = await response.json();
      if (!current(captured)) return;
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The route could not be calculated. Please check your inputs.');
      const frozen = makeResult(inputs, body.optimizedRoutes);
      setResult(frozen);
      setSelectedDriver(0);
    } catch (failure) {
      if (current(captured) && failure.name !== 'AbortError') setError(failure.message || 'Could not reach the route optimizer. Please retry.');
    } finally {
      controllers.current.delete(controller);
      if (current(captured)) setBusy(false);
    }
  };

  const beginLoad = () => {
    invalidate(); setError('');
    const captured = token();
    setBusy(true);
    return captured;
  };
  const endLoad = (captured) => { if (captured && current(captured)) setBusy(false); };
  const loadTrip = async (snapshot, captured) => {
    if (!captured || !current(captured)) throw abortError();
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    try {
      const restored = await reopenSnapshot(snapshot,
        (placeId) => resolvePlace(map, placeId, { signal: controller.signal }));
      if (!current(captured)) throw abortError();
      privateOwner.current = captured.owner;
      setDrivers(restored.inputs.drivers);
      setPassengers(groupPassengerPickups(restored.inputs.passengers));
      setDestination(restored.inputs.destination);
      setResult(restored);
      setSelectedDriver(0);
      if (latest.current.activeView === 'trips') {
        setActiveView('plan');
        viewButtons.current.plan?.focus();
      }
    } finally {
      controllers.current.delete(controller);
      if (current(captured)) setBusy(false);
    }
  };

  const selectPlace = async (record, point, setter, isDestination = false, append = false) => {
    invalidate(); setError('');
    const captured = token();
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const details = await resolvePlace(map, record.source.place_id, { signal: controller.signal });
      if (!current(captured)) throw abortError();
      privateOwner.current = captured.owner;
      const patch = { ...details, label: record.label };
      if (isDestination) setter((old) => old.stop_id === point.stop_id ? { ...old, ...patch } : old);
      else setter((list) => append ? [...list, { ...point, ...patch }]
        : list.map((old) => old.stop_id === point.stop_id ? { ...old, ...patch } : old));
    } finally { controllers.current.delete(controller); }
  };

  useLayoutEffect(() => {
    scrollPane.current?.scrollTo({ top: 0 });
  }, [activeView]);

  const navigate = (view, focus = false) => {
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

  // Hide private form/result during the account-transition render; layout reset precedes paint.
  if (privateStale) return null;
  return (
    <AccountBoundary key={authKey} auth={auth}>
      {(saved) => (
        <div className="planner">
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
          {accountControls && <div className="planner-account">{accountControls}</div>}
          <div id="planner-panel-plan" role="tabpanel" aria-labelledby="planner-tab-plan" hidden={activeView !== 'plan'}>
          <div className="driver-section-heading">
            <h3>Drivers</h3>
            {auth.status === 'authenticated' && <SectionSavedPicker section="drivers" saved={saved} onSelect={(record) => {
              const empty = drivers.find((point) => !point.address.trim() && !point.source);
              return selectPlace(record, empty || newDriver(), setDrivers, false, !empty);
            }} />}
          </div>
          <p id="driver-seats-help" className="saving-note quantity-help">Available seats for passengers, excluding the driver.</p>
          {drivers.map((point, index) => (
            <div className="planner-location" key={point.stop_id}>
              <SavedLocationControls showPicker={false} auth={auth} point={point} saved={saved}
                fieldLabel={'Driver ' + (index + 1)} onSelect={(record) => selectPlace(record, point, setDrivers)}
                renderAddress={(action) => <div className="driver-input-group">
                  <label className="planner-quantity-field">
                    <span>Passenger seats</span>
                    <input type="number" min="1" inputMode="numeric" value={point.capacity}
                      aria-label={'Driver ' + (index + 1) + ' passenger seats'} aria-describedby="driver-seats-help"
                      onChange={(event) => edit(setDrivers, point.stop_id, { capacity: Number(event.target.value) })} />
                  </label>
                  <AddressInput map={map} value={point.address} label={'Driver ' + (index + 1) + ' location'}
                    placeholder={'Driver ' + (index + 1) + ' location'} action={action}
                    onChange={(patch) => edit(setDrivers, point.stop_id, patch)} />
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

          <div className="driver-section-heading">
            <h3>Passenger pickups</h3>
            {auth.status === 'authenticated' && <SectionSavedPicker section="passengers" saved={saved} onSelect={(record) => {
              const empty = passengers.find((point) => !point.address.trim() && !point.source);
              return selectPlace(record, empty || newPassengerPickup(), setPassengers, false, !empty);
            }} />}
          </div>
          <p className="saving-note quantity-help">Enter the number of people at each pickup. They may ride in different cars.</p>
          {passengers.map((point, index) => (
            <div className="planner-location" key={point.stop_id}>
              <SavedLocationControls showPicker={false} auth={auth} point={point} saved={saved}
                fieldLabel={'Pickup ' + (index + 1)} onSelect={(record) => selectPlace(record, point, setPassengers)}
                renderAddress={(action) => <div className="passenger-input-group">
                  <label className="planner-quantity-field">
                    <span>Passengers</span>
                    <input type="number" min="1" max="12" step="1" inputMode="numeric" value={point.count}
                      aria-label={'Passengers at pickup ' + (index + 1)}
                      onChange={(event) => edit(setPassengers, point.stop_id,
                        resizePickup(point, event.target.value === '' ? '' : Number(event.target.value)))} />
                  </label>
                  <AddressInput map={map} value={point.address} label={'Pickup ' + (index + 1) + ' location'}
                    placeholder={'Pickup ' + (index + 1) + ' location'} action={action}
                    onChange={(patch) => edit(setPassengers, point.stop_id, patch)} />
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

          <h3>Destination</h3>
          <AddressInput map={map} className="full-width-input" value={destination.address}
            label="Destination" placeholder="Destination" onChange={editDestination}
            savedLocations={saved.locations} onSavedSelect={(record) => selectPlace(record, destination, setDestination, true)} />
          <SavedLocationControls showPicker={false} auth={auth} point={destination} saved={saved} fieldLabel="Destination"
            onSelect={(record) => selectPlace(record, destination, setDestination, true)} />
          <button type="button" className="submit-btn" disabled={busy} onClick={submit}>
            {busy ? 'Loading route…' : 'Calculate route'}
          </button>
          {error && <p role="alert" className="saving-error">{error}</p>}

          {result && (
            <section className="route-summary">
              <h3>Your route</h3>
              <p className="saving-note">{result.inputs.drivers.length} driver{result.inputs.drivers.length === 1 ? '' : 's'} · {result.inputs.passengers.length} passenger{result.inputs.passengers.length === 1 ? '' : 's'}</p>
              <label htmlFor="driver-view">Driver view</label>
              <select id="driver-view" value={selectedDriver} onChange={(event) => setSelectedDriver(Number(event.target.value))}>
                {result.inputs.drivers.map((driver, index) => (
                  <option key={driver.stop_id} value={index}>{driver.label || 'Driver ' + (index + 1)}</option>
                ))}
              </select>
              <p className="saving-note">This route uses the locations from your last calculation or saved route.</p>
              {result.saveError && <p className="saving-note">{result.saveError}</p>}
              {mapBusy && <p role="status" className="saving-note">Loading map directions…</p>}
              {mapError && <div className="saving-error" role="alert">
                <p>{mapError}</p>
                <button type="button" className="secondary-button" disabled={mapBusy}
                  onClick={() => setMapAttempt((attempt) => attempt + 1)}>Retry map directions</button>
              </div>}
            </section>
          )}
          </div>
          <SavedTripsPanel auth={auth} activeView={activeView} snapshot={result?.snapshot || null} routeAvailable={!!result}
            onBeginLoad={beginLoad} onEndLoad={endLoad} onLoad={loadTrip} />
          <div id="planner-panel-locations" role="tabpanel" aria-labelledby="planner-tab-locations" hidden={activeView !== 'locations'}>
            <SavedLocationsPanel auth={auth} saved={saved} map={map} activeView={activeView} />
          </div>
          </div>
        </div>
      )}
    </AccountBoundary>
  );
}
