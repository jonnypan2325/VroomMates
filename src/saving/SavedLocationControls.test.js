import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextEncoder } from 'util';
import { webcrypto } from 'crypto';
import { SavedLocationControls, SavedLocationsPanel, SectionSavedPicker } from './SavedLocationControls';
import useSavedLocations from './useSavedLocations';
import AddressInput from '../components/AddressInput';
import { SavedApiError } from './api';

global.TextEncoder = TextEncoder;
Object.defineProperty(global, 'crypto', { configurable: true, value: webcrypto });
const ID = '00000000-0000-4000-8000-000000000001';
const source = { kind: 'google_places', place_id: 'synthetic-place' };
const row = { id: ID, label: 'Home', source, schema_version: 1, resolution_required: true,
  created_at: '2026-10-06T12:00:00Z', updated_at: '2026-10-06T12:00:00Z' };
const point = { address: 'Synthetic address', source, coordinates: { lat: 35, lng: -120 } };
const auth = { status: 'authenticated', profile: { id: 'google:synthetic-a' }, generation: 1 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (data, status = 200) => ({ status, ok: status < 400, json: async () => data });
const list = (...locations) => response({ status: 'success', locations });
const fixtures = (overrides = {}) => ({ locations: [row], loading: false, error: null,
  refresh: jest.fn().mockResolvedValue(undefined), save: jest.fn().mockResolvedValue(row),
  remove: jest.fn().mockResolvedValue(undefined), edit: jest.fn(async (id, label, chosen) => ({ ...row, label, source: chosen })), ...overrides });
let autocomplete;
const map = {};
beforeEach(() => {
  window.google = { maps: { places: { Autocomplete: function SyntheticAutocomplete() {
    this.bindTo = jest.fn();
    this.addListener = (_, callback) => { autocomplete = { callback, instance: this }; return { remove: jest.fn() }; };
    this.getPlace = () => ({ place_id: source.place_id, formatted_address: point.address,
      geometry: { location: { lat: () => point.coordinates.lat, lng: () => point.coordinates.lng } } });
  } }, event: { clearInstanceListeners: jest.fn() } } };
});
afterEach(() => { delete window.google; });
// Clicks start async save/delete chains; async act settles those updates before assertions.
// eslint-disable-next-line testing-library/no-unnecessary-act
async function click(name) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
// Keyboard and blur commits start async chains; async act settles them like clicks.
async function settle(fire) { await act(async () => { fire(); }); }
function selectAddress() { act(() => { autocomplete.callback(); }); }
// jsdom has no PointerEvent, so the pointer type InlineEdit reads is set on a plain event.
function pointerDown(element, pointerType) {
  const event = new MouseEvent('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => { element.dispatchEvent(event); });
}
// Place details for My locations rows; a lookup without a scripted reply stays pending.
let placeReplies;
function placesService() {
  placeReplies = {};
  window.google.maps.places.PlacesService = function SyntheticPlacesService() {
    this.getDetails = ({ placeId }, callback) => { placeReplies[placeId] = callback; };
  };
}
const found = (address) => [{ formatted_address: address, geometry: { location: { lat: () => 35, lng: () => -120 } } }, 'OK'];

it('entering My locations automatically loads once per entry without a render loop or manual Refresh', async () => {
  const request = jest.fn().mockResolvedValue(list(row));
  function Harness({ activeView }) { const saved = useSavedLocations({ ...auth, protectedRequest: request }); return <SavedLocationsPanel auth={auth} saved={saved} activeView={activeView} />; }
  const { rerender } = render(<Harness activeView="plan" />);
  expect(await screen.findByText('Home')).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
  rerender(<Harness activeView="locations" />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'My locations' })).toHaveAttribute('aria-busy', 'false'));
  expect(screen.getByText('Home')).toBeVisible();
  expect(request).toHaveBeenCalledTimes(2);
  rerender(<Harness activeView="locations" />);
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: /Refresh locations/ })).not.toBeInTheDocument();
  rerender(<Harness activeView="plan" />);
  rerender(<Harness activeView="locations" />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'My locations' })).toHaveAttribute('aria-busy', 'false'));
  expect(request).toHaveBeenCalledTimes(3);
});

it('real hook and creation form refetch confirmed add/delete while preserving success through list outages', async () => {
  let stored = [], outage = false;
  const request = jest.fn(async (_, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      stored = [{ ...row, ...body }]; outage = true;
      return response({ status: 'success', location: stored[0] });
    }
    if (options.method === 'DELETE') { stored = []; return response(null, 204); }
    return outage ? response({ error: { code: 'STORE_UNAVAILABLE', message: 'Synthetic outage' } }, 503) : list(...stored);
  });
  function Harness() { const saved = useSavedLocations({ ...auth, protectedRequest: request }); return <SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />; }
  render(<Harness />);
  expect(await screen.findByText(/No saved locations yet/)).toBeVisible();
  const initialLoads = request.mock.calls.filter(([, options]) => options.method === 'GET').length;
  await click('Add location');
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Home' } });
  selectAddress();
  await click('Save location');
  expect(screen.getByText('Home saved.')).toBeVisible();
  expect(request.mock.calls.filter(([, options]) => options.method === 'GET')).toHaveLength(initialLoads + 1);
  expect(screen.getByText('Home')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry loading locations' })).toBeVisible();
  const saveCall = request.mock.calls.find(([, options]) => options.method === 'POST');
  expect(Object.keys(JSON.parse(saveCall[1].body)).sort()).toEqual(['id', 'label', 'source']);
  await click('Delete saved location Home');
  expect(request.mock.calls.filter(([, options]) => options.method === 'DELETE')).toHaveLength(0);
  expect(screen.getByText('Delete “Home” from your saved locations?')).toBeVisible();
  await click('Delete');
  expect(screen.getByText('Home deleted.')).toBeVisible();
  expect(screen.queryByText('Home')).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([, options]) => options.method === 'GET')).toHaveLength(initialLoads + 2);
  outage = false;
  await click('Retry loading locations');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('create form keeps its draft through hide/show and close/open, then clears private draft on account switch', async () => {
  const saved = fixtures({ locations: [] });
  const { rerender } = render(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  await click('Add location');
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Friend pickup' } });
  selectAddress();
  rerender(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="plan" />);
  rerender(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Friend pickup');
  expect(screen.getByRole('textbox', { name: 'New location address' })).toHaveValue(point.address);
  expect(screen.getByRole('button', { name: 'Add location' })).toHaveAttribute('aria-expanded', 'true');
  await click('Add location');
  expect(screen.getByRole('button', { name: 'Add location' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('textbox', { name: 'Label' })).not.toBeInTheDocument();
  await click('Add location');
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Friend pickup');
  rerender(<SavedLocationsPanel auth={{ ...auth, profile: { id: 'google:synthetic-b' }, generation: 2 }} saved={saved} map={map} activeView="locations" />);
  await click('Add location');
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'New location address' })).toHaveValue('');
});

it('reconciling an earlier save preserves a different new-location draft', async () => {
  const error = Object.assign(new SavedApiError(503, 'UNRESOLVED_SAVE', 'Synthetic unresolved'), { retryLabel: 'Home', retrySource: source });
  const saved = fixtures({ error });
  render(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  await click('Add location');
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'New pickup' } });
  selectAddress();
  await click('New location: check and retry earlier save');
  expect(saved.save).toHaveBeenCalledWith('Home', source);
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('New pickup');
  expect(screen.getByRole('textbox', { name: 'New location address' })).toHaveValue(point.address);
  expect(screen.getByText('Earlier save confirmed. Your new location draft is unchanged.')).toBeVisible();
});

it('delete failure keeps confirmation and exposes retry, Keep location cancels without a mutation', async () => {
  const saved = fixtures({ remove: jest.fn().mockRejectedValueOnce(new SavedApiError(503, 'STORE_UNAVAILABLE', 'Synthetic outage')).mockResolvedValueOnce(undefined) });
  render(<SavedLocationsPanel auth={auth} saved={saved} activeView="locations" />);
  await click('Delete saved location Home'); await click('Keep location');
  expect(saved.remove).not.toHaveBeenCalled();
  await click('Delete saved location Home'); await click('Delete');
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Keep location' })).toBeVisible();
  await click('Retry delete');
  expect(saved.remove).toHaveBeenNthCalledWith(2, ID);
  expect(screen.getByText('Home deleted.')).toBeVisible();
});

it('inline save retries failure, preserves the label and clears account-owned messages on logout', async () => {
  const saved = fixtures({ save: jest.fn().mockRejectedValueOnce(new SavedApiError(409, 'LABEL_EXISTS', 'Duplicate')).mockResolvedValueOnce(row) });
  const onSaved = jest.fn();
  // The planner names the row from onSaved; the saved mark needs that nickname.
  function Harness({ account }) {
    const [current, setCurrent] = useState(point);
    return <SavedLocationControls auth={account} saved={saved} point={current} onSelect={jest.fn()} fieldLabel="Driver"
      onSaved={(confirmed) => { onSaved(confirmed); setCurrent((old) => ({ ...old, label: confirmed.label })); }} />;
  }
  const { rerender } = render(<Harness account={auth} />);
  await click('Save location for Driver');
  expect(screen.getByRole('textbox', { name: 'Your label for Driver' })).toHaveAttribute('placeholder', 'Name this place, e.g. Home');
  fireEvent.change(screen.getByRole('textbox', { name: 'Your label for Driver' }), { target: { value: 'Home' } });
  await click('Save location');
  expect(screen.getByRole('alert')).toHaveTextContent('That label is already saved');
  expect(screen.getByRole('textbox', { name: 'Your label for Driver' })).toHaveValue('Home');
  expect(onSaved).not.toHaveBeenCalled();
  await click('Retry saving location');
  expect(saved.save).toHaveBeenNthCalledWith(2, 'Home', source);
  expect(screen.getByText('Home saved.')).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalledWith(row);
  expect(screen.queryByRole('textbox', { name: 'Your label for Driver' })).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Driver is saved as Home' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save location for Driver' })).not.toBeInTheDocument();
  rerender(<Harness account={{ status: 'anonymous', generation: 2 }} />);
  expect(screen.queryByText('Home saved.')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('the in-field Save toggle appears only for a Google place and Escape closes its form', async () => {
  const saved = fixtures({ locations: [] });
  const unplaced = { address: 'Typed only', source: null, coordinates: { lat: null, lng: null } };
  const { rerender } = render(<SavedLocationControls auth={auth} saved={saved} point={unplaced} onSelect={jest.fn()} fieldLabel="Pickup 1"
    renderAddress={(action) => <div data-testid="field">{action}</div>} />);
  expect(screen.getByTestId('field')).toBeEmptyDOMElement();
  rerender(<SavedLocationControls auth={auth} saved={saved} point={point} onSelect={jest.fn()} fieldLabel="Pickup 1"
    renderAddress={(action) => <div data-testid="field">{action}</div>} />);
  const toggle = screen.getByRole('button', { name: 'Save location for Pickup 1' });
  expect(toggle).toHaveTextContent('Save');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await click('Save location for Pickup 1');
  expect(screen.getByRole('button', { name: 'Hide save form for Pickup 1' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('textbox', { name: 'Your label for Pickup 1' })).toHaveFocus();
  expect(screen.queryByText('Create label before saving')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your label for Pickup 1' }), { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'Your label for Pickup 1' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save location for Pickup 1' })).toHaveFocus();
  expect(saved.save).not.toHaveBeenCalled();
});

it('an edit supersedes pending inline selection without exposing stale completion or losing save draft', async () => {
  const pending = deferred();
  const saved = fixtures(); const onSelect = jest.fn().mockReturnValue(pending.promise);
  const { rerender } = render(<SavedLocationControls auth={auth} saved={saved} point={point} onSelect={onSelect} fieldLabel="Pickup" />);
  await click('Save location for Pickup');
  fireEvent.change(screen.getByRole('textbox', { name: 'Your label for Pickup' }), { target: { value: 'Pickup label' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved location for Pickup' }), { target: { value: ID } });
  expect(screen.getByRole('combobox')).toBeDisabled();
  const edited = { address: 'New draft address', source: null, coordinates: { lat: null, lng: null } };
  rerender(<SavedLocationControls auth={auth} saved={saved} point={edited} onSelect={onSelect} fieldLabel="Pickup" />);
  await act(async () => { pending.resolve(); await pending.promise; });
  expect(screen.queryByText('Home selected.')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Your label for Pickup' })).toHaveValue('Pickup label');
  expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled();
});

it('shared section picker retries a lookup without altering the independent create draft', async () => {
  const saved = fixtures(); const onSelect = jest.fn().mockRejectedValueOnce(new Error('Synthetic lookup outage')).mockResolvedValueOnce(undefined);
  render(<><SectionSavedPicker saved={saved} onSelect={onSelect} section="Drivers" /><SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" /></>);
  await click('Add location');
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Unfinished pickup' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Select from saved locations for Drivers' }), { target: { value: ID } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Select it again to retry');
  fireEvent.change(screen.getByRole('combobox', { name: 'Select from saved locations for Drivers' }), { target: { value: ID } });
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select from saved locations for Drivers' })).not.toBeDisabled());
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith(row);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Unfinished pickup');
});

it('address chooser retains editable text after lookup failure and ignores late failure after typing', async () => {
  const pending = deferred();
  const onSelect = jest.fn().mockRejectedValueOnce(new Error('Synthetic outage')).mockReturnValueOnce(pending.promise);
  function Harness() { const [value, setValue] = useState('Ho'); return <AddressInput value={value} label="Pickup address" onChange={(patch) => setValue(patch.address)} savedLocations={[row]} onSavedSelect={onSelect} />; }
  render(<Harness />);
  const field = () => screen.getByRole('combobox', { name: 'Pickup address' });
  act(() => { field().focus(); });
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Home' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose it again to retry');
  expect(field()).toHaveValue('Ho');
  expect(field()).toBeEnabled();
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Home' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Loading saved place…');
  fireEvent.change(field(), { target: { value: 'Changed draft' } });
  await act(async () => { pending.reject(new Error('Late failure')); await pending.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(field()).toHaveValue('Changed draft');
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it('a pending create cannot expose success after logout or repopulate a different account draft', async () => {
  const pending = deferred(); const saved = fixtures({ locations: [], save: jest.fn().mockReturnValueOnce(pending.promise) });
  const { rerender } = render(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  await click('Add location');
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Home' } }); selectAddress();
  fireEvent.click(screen.getByRole('button', { name: 'Save location' }));
  rerender(<SavedLocationsPanel auth={{ status: 'anonymous', generation: 2 }} saved={saved} map={map} activeView="locations" />);
  expect(screen.queryByRole('region', { name: 'My locations' })).not.toBeInTheDocument();
  const next = { ...auth, profile: { id: 'google:synthetic-b' }, generation: 3 };
  rerender(<SavedLocationsPanel auth={next} saved={saved} map={map} activeView="locations" />);
  await click('Add location');
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Second account draft' } });
  await act(async () => { pending.resolve(row); await pending.promise; });
  expect(screen.queryByText('Home saved.')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Second account draft');
});

it('My locations rows show the label over the current address looked up from the place ID, kept in memory only', async () => {
  placesService();
  const work = { ...row, id: '00000000-0000-4000-8000-000000000002', label: 'Work', source: { kind: 'google_places', place_id: 'synthetic-work' } };
  const saved = fixtures({ locations: [row, work] });
  render(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  expect(screen.getByRole('button', { name: 'Name of saved location Home: Home. Press Enter to edit' })).toBeVisible();
  expect(screen.getAllByText('Looking up address…')).toHaveLength(2);
  await act(async () => { placeReplies['synthetic-place'](...found('1 Synthetic Home Road')); });
  expect(screen.getByRole('button', { name: 'Address of Home: 1 Synthetic Home Road. Press Enter to edit' })).toBeVisible();
  await act(async () => { placeReplies['synthetic-work'](null, 'NOT_FOUND'); });
  expect(screen.getByRole('button', { name: /^Address of Work: Address unavailable\. Double-click to choose it again\./ })).toBeVisible();
  expect(saved.edit).not.toHaveBeenCalled();
  expect(saved.save).not.toHaveBeenCalled();
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
});

it('a label edits in place: double-click or keyboard opens it, Enter or blur saves through edit, Escape reverts', async () => {
  const saved = fixtures();
  render(<SavedLocationsPanel auth={auth} saved={saved} activeView="locations" />);
  const name = () => screen.getByRole('button', { name: /^Name of saved location Home/ });
  const editor = () => screen.getByRole('textbox', { name: 'Name of saved location Home' });
  pointerDown(name(), 'mouse'); fireEvent.click(name(), { detail: 1 });
  expect(screen.queryByRole('textbox', { name: 'Name of saved location Home' })).not.toBeInTheDocument();
  fireEvent.doubleClick(name());
  expect(editor()).toHaveFocus();
  expect(editor()).toHaveValue('Home');
  fireEvent.change(editor(), { target: { value: 'Reverted name' } });
  fireEvent.keyDown(editor(), { key: 'Escape' });
  expect(name()).toHaveTextContent('Home');
  expect(saved.edit).not.toHaveBeenCalled();
  fireEvent.click(name());
  fireEvent.change(editor(), { target: { value: 'Home base' } });
  await settle(() => fireEvent.keyDown(editor(), { key: 'Enter' }));
  expect(saved.edit).toHaveBeenCalledWith(ID, 'Home base', source);
  expect(screen.getByText('Renamed to Home base.')).toBeVisible();
  pointerDown(name(), 'touch'); fireEvent.click(name(), { detail: 1 });
  fireEvent.change(editor(), { target: { value: 'Family home' } });
  await settle(() => fireEvent.blur(editor()));
  expect(saved.edit).toHaveBeenLastCalledWith(ID, 'Family home', source);
  expect(saved.edit).toHaveBeenCalledTimes(2);
});

it('a rejected rename keeps the old label and reports the failure on that row', async () => {
  const saved = fixtures({ edit: jest.fn().mockRejectedValue(new SavedApiError(409, 'LABEL_EXISTS', 'Duplicate')) });
  render(<SavedLocationsPanel auth={auth} saved={saved} activeView="locations" />);
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Name of saved location Home/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name of saved location Home' }), { target: { value: 'Work' } });
  await settle(() => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name of saved location Home' }), { key: 'Enter' }));
  expect(screen.getByRole('alert')).toHaveTextContent('That label is already saved');
  expect(screen.getByRole('button', { name: /^Name of saved location Home/ })).toHaveTextContent('Home');
  expect(screen.queryByText(/Renamed to/)).not.toBeInTheDocument();
});

it('an address edit commits only a chosen Google suggestion and sends only its place reference', async () => {
  placesService();
  const saved = fixtures();
  render(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  await act(async () => { placeReplies['synthetic-place'](...found('1 Synthetic Home Road')); });
  const address = () => screen.getByRole('button', { name: /^Address of Home/ });
  fireEvent.doubleClick(address());
  const editor = screen.getByRole('textbox', { name: 'New address for Home' });
  expect(editor).toHaveValue('1 Synthetic Home Road');
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(address()).toHaveTextContent('1 Synthetic Home Road');
  fireEvent.doubleClick(address());
  fireEvent.change(screen.getByRole('textbox', { name: 'New address for Home' }), { target: { value: '2 Synthetic Typed Lane' } });
  expect(saved.edit).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'New address for Home' })).toBeInTheDocument();
  autocomplete.instance.getPlace = () => ({ place_id: 'synthetic-new-place', formatted_address: '3 Synthetic Chosen Way',
    geometry: { location: { lat: () => 36, lng: () => -121 } } });
  await act(async () => { autocomplete.callback(); });
  expect(saved.edit).toHaveBeenCalledTimes(1);
  expect(saved.edit.mock.calls[0]).toEqual([ID, 'Home', { kind: 'google_places', place_id: 'synthetic-new-place' }]);
  expect(JSON.stringify(saved.edit.mock.calls[0])).not.toMatch(/Synthetic Chosen Way|36|-121/);
  expect(screen.getByText('Home address updated.')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'New address for Home' })).not.toBeInTheDocument();
});

it('a failed address lookup is retried the next time My locations is shown', async () => {
  placesService();
  const saved = fixtures();
  const view = render(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  await act(async () => { placeReplies['synthetic-place'](null, 'UNKNOWN_ERROR'); });
  expect(screen.getByRole('button', { name: /^Address of Home: Address unavailable\./ })).toBeVisible();
  delete placeReplies['synthetic-place'];
  view.rerender(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="plan" />);
  view.rerender(<SavedLocationsPanel auth={auth} saved={saved} map={map} activeView="locations" />);
  expect(placeReplies['synthetic-place']).toEqual(expect.any(Function));
  await act(async () => { placeReplies['synthetic-place'](...found('1 Synthetic Home Road')); });
  expect(screen.getByRole('button', { name: 'Address of Home: 1 Synthetic Home Road. Press Enter to edit' })).toBeVisible();
});

it('editing a location deleted elsewhere says it was deleted, not that saving is unavailable', async () => {
  const saved = fixtures({ edit: jest.fn().mockRejectedValue(new SavedApiError(404, 'LOCATION_NOT_FOUND', 'Saved item was not found.')) });
  render(<SavedLocationsPanel auth={auth} saved={saved} activeView="locations" />);
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Name of saved location Home/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name of saved location Home' }), { target: { value: 'Work' } });
  await settle(() => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name of saved location Home' }), { key: 'Enter' }));
  expect(screen.getByRole('alert')).toHaveTextContent('This location was already deleted. Refresh your locations.');
});
