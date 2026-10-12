import React, { useEffect, useId, useRef, useState } from 'react';
import { canonicalText, sameData } from './api';
import AddressInput from '../components/AddressInput';

function ownerKey(auth) {
  return auth?.status === 'authenticated' && auth.profile?.id
    ? JSON.stringify([auth.profile.id, auth.generation]) : null;
}

function useOwnerScope(auth) {
  const key = ownerKey(auth);
  const ref = useRef(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, alive: false, operation: 0 };
  const scope = ref.current;
  useEffect(() => {
    scope.alive = true;
    return () => { scope.alive = false; scope.operation += 1; };
  }, [scope]);
  return { key, scope, current: (operation) => Boolean(key && scope.alive
    && ref.current === scope && (operation === undefined || operation === scope.operation)) };
}

function messageFor(error) {
  switch (error?.code) {
    case 'LABEL_EXISTS': return 'That label is already saved. Choose it from your saved locations, or use a different label.';
    case 'LOCATION_LIMIT': return 'You have 100 saved locations. Delete one in My Locations, then try again.';
    case 'LOCATION_EXISTS': return 'This save conflicts with stored data. Refresh your locations before trying again.';
    case 'UNRESOLVED_SAVE': return 'An earlier save is unconfirmed. Check and retry it before saving another location.';
    case 'SAVE_IN_PROGRESS': return 'Another location save is in progress. Please wait.';
    case 'INVALID_LOCATION': return 'Use a label of 1–80 characters and choose a location from the address suggestions.';
    case 'INVALID_RESPONSE': return 'The response could not be confirmed. Please retry.';
    default: return 'Saved locations are temporarily unavailable. Please retry.';
  }
}

function SaveFailure({ error, busy, onRetry, prefix }) {
  if (!error) return null;
  return <div className="saving-error" role="alert">
    <p>{messageFor(error)}</p>
    {error.retrySource && <>
      <p>Earlier label: <strong>{error.retryLabel}</strong></p>
      <button type="button" className="secondary-button" disabled={busy} onClick={onRetry}
        aria-label={`${prefix}: check and retry earlier save`}>Check and retry earlier save</button>
    </>}
  </div>;
}

function pointFingerprint(point) {
  return JSON.stringify([point?.address ?? '', point?.source?.kind ?? null,
    point?.source?.place_id ?? null, point?.coordinates?.lat ?? null, point?.coordinates?.lng ?? null]);
}

function resolvedSelection(point, selection) {
  return Boolean(selection && sameData(point?.source, selection.source)
    && Number.isFinite(point?.coordinates?.lat) && Math.abs(point.coordinates.lat) <= 90
    && Number.isFinite(point?.coordinates?.lng) && Math.abs(point.coordinates.lng) <= 180);
}

export function SavedLocationControls({ auth, point, saved, onSelect, fieldLabel = 'Location', showPicker = true, renderAddress }) {
  const { key, scope, current } = useOwnerScope(auth);
  const id = useId();
  const labelInput = useRef(null);
  const disclosure = useRef(null);
  const selectInput = useRef(null);
  const fingerprint = pointFingerprint(point);
  const fieldRef = useRef(null);
  if (!fieldRef.current || fieldRef.current.key !== key) {
    fieldRef.current = { key, fingerprint, revision: 0, selection: null, matchingTransition: false };
  }
  const field = fieldRef.current;
  if (field.fingerprint !== fingerprint) {
    // The selected lookup may apply its own source/geometry once. All other edits supersede it.
    const matching = !field.selection?.applied && resolvedSelection(point, field.selection);
    field.fingerprint = fingerprint;
    field.revision += 1;
    field.matchingTransition = matching;
    if (matching) field.selection.applied = true;
    else { scope.operation += 1; field.selection = null; }
  }
  const [state, setState] = useState({ key, fieldRevision: 0, open: false, label: '', selectedId: '', busy: false,
    error: null, selectError: '', success: '', confirmed: null });
  const owned = state.key === key ? state : { open: false, label: '', selectedId: '', busy: false,
    error: null, selectError: '', success: '', confirmed: null };
  // Filter on this render, before effects or an old lookup completion can expose stale messages.
  const view = state.key === key && state.fieldRevision === field.revision ? owned : { ...owned,
    selectedId: field.matchingTransition ? field.selection?.id || '' : '',
    busy: field.matchingTransition ? owned.busy : false, selectError: '',
    success: field.matchingTransition && field.selection?.completed ? `${field.selection.label} selected.` : '' };
  const change = (next) => {
    if (!current()) return;
    setState((previous) => ({ ...(previous.key === key && previous.fieldRevision === field.revision
      ? previous : view), key, fieldRevision: field.revision, ...next }));
  };
  useEffect(() => {
    if (view.open && key) labelInput.current?.focus();
  }, [key, view.open]);
  if (!key) return renderAddress ? renderAddress(null) : null;

  const source = point?.source?.kind === 'google_places' && point.source.place_id ? point.source : null;
  let canonicalLabel = '';
  try { canonicalLabel = canonicalText(view.label, 80, 320); } catch (_) { /* Inline submit validation. */ }
  const alreadySaved = Boolean(view.confirmed && sameData(view.confirmed, { label: canonicalLabel, source }));
  const retryError = saved.error?.retrySource ? saved.error : null;
  const localError = view.error?.retrySource ? retryError : view.error;

  const saveLocation = async (retry = false) => {
    if (view.busy || !current()) return;
    const earlier = retry ? retryError : null;
    if (retry && !earlier) return;
    const operation = ++scope.operation;
    field.selection = null;
    change({ busy: true, error: null, selectError: '', success: '' });
    try {
      const row = await saved.save(earlier ? earlier.retryLabel : view.label,
        earlier ? earlier.retrySource : source);
      if (!current(operation)) return;
      change({ busy: false, error: null, success: `${row.label} saved.`,
        confirmed: { label: row.label, source: row.source } });
    } catch (error) {
      if (!current(operation)) return;
      change({ busy: false, error, success: '' });
    }
  };

  const selectLocation = async (selectedId) => {
    const operation = ++scope.operation;
    field.selection = null;
    change({ selectedId, busy: false, selectError: '', success: '' });
    if (!selectedId) return;
    const row = saved.locations.find((item) => item.id === selectedId);
    if (!row) return;
    const selection = { id: row.id, label: row.label, source: row.source, applied: false, completed: false };
    field.selection = selection;
    change({ busy: true, error: null });
    try {
      await onSelect(row);
      if (!current(operation) || field.selection !== selection) return;
      selection.completed = true;
      change({ busy: false, selectError: '', success: `${row.label} selected.` });
    } catch (error) {
      if (!current(operation) || field.selection !== selection) return;
      field.selection = null;
      if (error?.name === 'AbortError') {
        change({ busy: false, selectedId: '', selectError: '', success: '' });
        return;
      }
      change({ busy: false, selectError: 'This location could not be loaded. Check the address service and try again.', success: '' });
    }
  };

  const refresh = async () => {
    try { await saved.refresh(); } catch (_) { /* The shared hook exposes the protected list error. */ }
  };

  const saveButton = <button type="button" className="secondary-button" ref={disclosure} aria-expanded={view.open}
    aria-controls={view.open ? `${id}-save` : undefined} aria-label={`${view.open ? 'Close save form for' : 'Save location for'} ${fieldLabel}`}
    disabled={view.busy} onClick={() => change({ open: !view.open })}>
    {view.open ? 'Close' : 'Save location'}
  </button>;
  return <div className={renderAddress ? "location-saving inline-location-saving" : "location-saving"} aria-label={`${fieldLabel} saved locations`} aria-busy={view.busy}>
    {renderAddress && renderAddress(saveButton)}
    {!renderAddress && <div className="saving-row">
      {showPicker && (saved.locations.length > 0 || saved.loading || saved.error) && <>
        <label htmlFor={`${id}-select`}>Saved location for {fieldLabel}</label>
        <select id={`${id}-select`} ref={selectInput} value={view.selectedId}
          disabled={view.busy || saved.loading} onChange={(event) => selectLocation(event.target.value)}>
          <option value="">{saved.loading ? 'Loading saved locations…' : 'Choose a saved location'}</option>
          {saved.locations.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select>
      </>}
      {saveButton}
    </div>}
    {saved.error && !saved.error.retrySource && <div className="saving-error" role="alert">
      <p>{messageFor(saved.error)}</p>
      <button type="button" className="secondary-button" disabled={saved.loading || view.busy} onClick={refresh}>Retry loading locations</button>
    </div>}
    {view.selectError && <div className="saving-error" role="alert">
      <p>{view.selectError}</p>
      <button type="button" className="secondary-button" disabled={view.busy} onClick={() => selectLocation(view.selectedId)}>Retry selecting location</button>
    </div>}
    {view.open && <form id={`${id}-save`} onSubmit={(event) => { event.preventDefault(); saveLocation(); }}>
      <label htmlFor={`${id}-label`}>Your label for {fieldLabel}</label>
      <input id={`${id}-label`} ref={labelInput} type="text" value={view.label} disabled={view.busy}
        placeholder="e.g. Home or Pickup spot" aria-describedby={`${id}-help`}
        onChange={(event) => change({ label: event.target.value, error: null, success: '' })} />
      <p id={`${id}-help`} className="saving-note">Create label before saving</p>
      <div className="saving-actions">
        <button type="submit" disabled={view.busy || !source || !view.label.trim() || alreadySaved}>
          {view.busy ? 'Working…' : alreadySaved ? 'Location saved' : 'Save location'}
        </button>
      </div>
    </form>}
    <SaveFailure error={retryError || localError} busy={view.busy} prefix={fieldLabel}
      onRetry={() => saveLocation(true)} />
    {view.error && !view.error.retrySource && view.open && !alreadySaved && <button type="button"
      className="secondary-button" disabled={view.busy || !source || !view.label.trim()} onClick={() => saveLocation()}>Retry saving location</button>}
    {view.success && <p className="saving-success" role="status">{view.success}</p>}
  </div>;
}

function NewSavedLocationForm({ auth, saved, map, active, onCreated }) {
  const { key, scope, current } = useOwnerScope(auth);
  const id = useId();
  const labelInput = useRef(null);
  const lock = useRef(false);
  const empty = () => ({ key, label: '', point: { address: '', source: null,
    coordinates: { lat: null, lng: null } }, busy: false, error: null, success: '' });
  const [state, setState] = useState(empty);
  const view = state.key === key ? state : empty();
  const change = (next) => {
    if (current()) setState((old) => ({ ...(old.key === key ? old : empty()), key, ...next }));
  };
  useEffect(() => { lock.current = false; }, [scope]);
  useEffect(() => { if (active && key) labelInput.current?.focus(); }, [active, key]);
  if (!key) return null;
  let name = '';
  try { name = canonicalText(view.label, 80, 320); } catch (_) { /* Submit validates. */ }
  const alreadySaved = Boolean(name && view.point.source && saved.locations.some((row) =>
    row.label === name && sameData(row.source, view.point.source)));
  const retryError = saved.error?.retrySource ? saved.error : null;
  const error = retryError || (view.error?.retrySource ? null : view.error);
  const save = async (retry = false) => {
    if (lock.current || !current()) return;
    const earlier = retry ? retryError : null;
    if (retry && !earlier) return;
    lock.current = true;
    const operation = ++scope.operation;
    change({ busy: true, error: null, success: '' });
    try {
      const row = await saved.save(earlier ? earlier.retryLabel : view.label,
        earlier ? earlier.retrySource : view.point.source);
      if (!current(operation)) return;
      if (sameData({ label: name, source: view.point.source }, { label: row.label, source: row.source })) {
        change({ ...empty(), success: '' });
        onCreated(row);
      } else {
        change({ busy: false, error: null, success: 'Earlier save confirmed. Your new location draft is unchanged.' });
      }
    } catch (failure) {
      if (current(operation)) change({ busy: false, error: failure, success: '' });
    } finally {
      if (current(operation)) { lock.current = false; change({ busy: false }); }
    }
  };
  return <form className="new-location-form" hidden={!active} aria-label="Add saved location"
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h3>Add location</h3>
    <label htmlFor={id + '-label'}>Label</label>
    <input id={id + '-label'} ref={labelInput} type="text" value={view.label} disabled={view.busy}
      placeholder="e.g. Home or Friend's pickup"
      onChange={(event) => change({ label: event.target.value, error: null, success: '' })} />
    <label>Address</label>
    <AddressInput map={map} value={view.point.address} label="New location address"
      placeholder="Search for an address" disabled={view.busy}
      onChange={(patch) => { if (!lock.current) change({ point: { ...view.point, ...patch }, error: null, success: '' }); }} />
    <p className="saving-note">Create label before saving</p>
    <div className="saving-actions">
      <button type="submit" disabled={view.busy || !name || !view.point.source || alreadySaved}>
        {view.busy ? 'Saving…' : alreadySaved ? 'Location saved' : 'Save location'}
      </button>
    </div>
    <SaveFailure error={error} busy={view.busy} prefix="New location" onRetry={() => void save(true)} />
    {view.success && <p className="saving-success" role="status">{view.success}</p>}
  </form>;
}

export function SavedLocationsPanel({ auth, saved, map, activeView = 'all' }) {
  const { key, scope, current } = useOwnerScope(auth);
  const id = useId();
  const toggle = useRef(null);
  const addButton = useRef(null);
  const visiblePanel = useRef(false);
  const confirmButton = useRef(null);
  const [state, setState] = useState({ key, open: false, confirmId: null, busy: false,
    error: null, success: '', retryDeleteId: null, creating: false });
  const view = state.key === key ? state : { open: false, confirmId: null, busy: false,
    error: null, success: '', retryDeleteId: null, creating: false };
  const change = (next) => {
    if (!current()) return;
    setState((previous) => ({ ...(previous.key === key ? previous : view), key, ...next }));
  };
  const panelVisible = activeView === 'locations' || (activeView === 'all' && view.open);
  visiblePanel.current = panelVisible;
  const refreshLocations = saved.refresh;
  useEffect(() => {
    if (key && panelVisible) void refreshLocations().catch(() => {});
  }, [key, panelVisible, refreshLocations]);
  useEffect(() => { if (view.confirmId) confirmButton.current?.focus(); }, [view.confirmId]);
  if (!key) return null;

  const refresh = async () => {
    change({ error: null, success: '' });
    try { await saved.refresh(); }
    catch (_) { /* The shared list error clears on the next successful automatic load. */ }
  };
  const remove = async (row) => {
    if (view.busy || !current()) return;
    const operation = ++scope.operation;
    change({ busy: true, error: null, success: '' });
    try {
      await saved.remove(row.id);
      if (!current(operation)) return;
      change({ busy: false, confirmId: null, retryDeleteId: null, success: `${row.label} deleted.` });
      if (visiblePanel.current) addButton.current?.focus();
    } catch (error) {
      if (!current(operation)) return;
      change({ busy: false, error, retryDeleteId: row.id });
    }
  };
  const retryEarlier = async () => {
    const error = saved.error;
    if (!error?.retrySource || view.busy) return;
    const operation = ++scope.operation;
    change({ busy: true, error: null, success: '' });
    try {
      const row = await saved.save(error.retryLabel, error.retrySource);
      if (current(operation)) change({ busy: false, error: null, success: `${row.label} saved.` });
    } catch (failure) {
      if (current(operation)) change({ busy: false, error: failure });
    }
  };
  const error = view.error?.retrySource ? saved.error : view.error || saved.error;
  return <section className="location-saving" aria-label="My locations" aria-busy={view.busy || saved.loading}
    hidden={activeView !== 'all' && activeView !== 'locations'}>
    {activeView === 'all' ? <button type="button" className="secondary-button" ref={toggle} aria-expanded={view.open}
      aria-controls={`${id}-list`} onClick={() => change({ open: !view.open })}>
      My locations{saved.locations.length ? ` (${saved.locations.length})` : ''}
    </button> : <h2>My locations{saved.locations.length ? ` (${saved.locations.length})` : ''}</h2>}
    <div id={`${id}-list`} hidden={activeView === 'all' && !view.open}>
      <div className="saving-actions location-manager-actions">
        <button type="button" className={view.creating ? 'secondary-button' : ''} ref={addButton}
          aria-expanded={view.creating} onClick={() => change({ creating: !view.creating, success: '' })}>
          {view.creating ? 'Close form' : 'Add location'}
        </button>
      </div>
      <NewSavedLocationForm auth={auth} saved={saved} map={map} active={view.creating}
        onCreated={(row) => {
          if (!current()) return;
          change({ creating: false, error: null, success: row.label + ' saved.' });
          if (visiblePanel.current) addButton.current?.focus();
        }} />
      {saved.loading && <p className="saving-note" role="status">Loading your saved locations…</p>}
      {!saved.loading && !saved.locations.length && !error && <p className="saving-note">No saved locations yet. Add your first location.</p>}
      <SaveFailure error={view.creating && !view.error ? null : error} busy={view.busy} prefix="My Locations" onRetry={retryEarlier} />
      {error && !error.retrySource && !view.retryDeleteId && <button type="button" className="secondary-button"
        disabled={saved.loading || view.busy} onClick={refresh}>Retry loading locations</button>}
      <ul className="saving-list">
        {saved.locations.map((row) => <li key={row.id} className="saving-item">
          <div className="saving-row"><strong>{row.label}</strong>
            {view.confirmId !== row.id && <button type="button" className="destructive-button"
              disabled={view.busy} aria-label={`Delete saved location ${row.label}`} onClick={() => change({
                confirmId: row.id, error: null, success: '', retryDeleteId: null,
              })}>Delete</button>}
          </div>
          {view.confirmId === row.id && <div>
            <p className="saving-note">Delete “{row.label}” from your saved locations?</p>
            <div className="saving-actions">
              <button type="button" className="destructive-button" ref={confirmButton} disabled={view.busy}
                onClick={() => remove(row)}>{view.busy ? 'Deleting…' : view.retryDeleteId === row.id ? 'Retry delete' : 'Confirm delete'}</button>
              <button type="button" className="secondary-button" disabled={view.busy} onClick={() => {
                change({ confirmId: null, retryDeleteId: null, error: null }); if (visiblePanel.current) addButton.current?.focus();
              }}>Keep location</button>
            </div>
          </div>}
        </li>)}
      </ul>
      {view.success && <p className="saving-success" role="status">{view.success}</p>}
    </div>
  </section>;
}

export function SectionSavedPicker({ saved, onSelect, section }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current += 1; }; }, []);
  const choose = async (id) => {
    const row = saved.locations.find((item) => item.id === id);
    if (!row || busy) return;
    const attempt = ++sequence.current;
    setBusy(true); setError('');
    try { await onSelect(row); }
    catch (failure) {
      if (live.current && attempt === sequence.current && failure.name !== 'AbortError') {
        setError('This location could not be loaded. Select it again to retry.');
      }
    } finally { if (live.current && attempt === sequence.current) setBusy(false); }
  };
  return <div className="driver-saved-picker" aria-busy={busy}>
    <select value="" aria-label={`Select from saved locations for ${section}`}
      disabled={busy || saved.loading || !saved.locations.length} onChange={(event) => void choose(event.target.value)}>
      <option value="">{busy ? 'Loading location…' : 'Select from saved locations'}</option>
      {saved.locations.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
    </select>
    {error && <p className="saving-error" role="alert">{error}</p>}
  </div>;
}
