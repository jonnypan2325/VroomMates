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
  remove: jest.fn().mockResolvedValue(undefined), ...overrides });
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
function selectAddress() { act(() => { autocomplete.callback(); }); }

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
  await click('Confirm delete');
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
  await click('Close form'); await click('Add location');
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
  await click('Delete saved location Home'); await click('Confirm delete');
  expect(screen.getByRole('alert')).toBeVisible();
  await click('Retry delete');
  expect(saved.remove).toHaveBeenNthCalledWith(2, ID);
  expect(screen.getByText('Home deleted.')).toBeVisible();
});

it('inline save retries failure, preserves the label and clears account-owned messages on logout', async () => {
  const saved = fixtures({ save: jest.fn().mockRejectedValueOnce(new SavedApiError(409, 'LABEL_EXISTS', 'Duplicate')).mockResolvedValueOnce(row) });
  const { rerender } = render(<SavedLocationControls auth={auth} saved={saved} point={point} onSelect={jest.fn()} fieldLabel="Driver" />);
  await click('Save location for Driver');
  fireEvent.change(screen.getByRole('textbox', { name: 'Your label for Driver' }), { target: { value: 'Home' } });
  await click('Save location');
  expect(screen.getByRole('alert')).toHaveTextContent('That label is already saved');
  expect(screen.getByRole('textbox', { name: 'Your label for Driver' })).toHaveValue('Home');
  await click('Retry saving location');
  expect(screen.getByText('Home saved.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Location saved' })).toBeDisabled();
  rerender(<SavedLocationControls auth={{ status: 'anonymous', generation: 2 }} saved={saved} point={point} onSelect={jest.fn()} fieldLabel="Driver" />);
  expect(screen.queryByText('Home saved.')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
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
  function Harness() { const [value, setValue] = useState('Draft address'); return <AddressInput value={value} label="Pickup address" onChange={(patch) => setValue(patch.address)} savedLocations={[row]} onSavedSelect={onSelect} />; }
  render(<Harness />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: ID } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose it again to retry');
  expect(screen.getByRole('textbox')).toHaveValue('Draft address');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: ID } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed draft' } });
  await act(async () => { pending.reject(new Error('Late failure')); await pending.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('Changed draft');
  expect(screen.getByRole('combobox')).not.toBeDisabled();
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
