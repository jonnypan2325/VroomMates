import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TextEncoder } from 'util';
import AddressInput from './AddressInput';

global.TextEncoder = TextEncoder;
const source = { kind: 'google_places', place_id: 'synthetic-home' };
const rows = [{ id: 'home', label: 'Home', source }, { id: 'work', label: 'Work', source: { ...source, place_id: 'synthetic-work' } }];
const point = { address: 'Synthetic resolved address', source, coordinates: { lat: 35, lng: -120 }, label: 'Earlier label' };
const place = (changes = {}) => ({ place_id: source.place_id, formatted_address: point.address,
  geometry: { location: { lat: () => 35, lng: () => -120 } }, ...changes });
const invalid = { coordinates: { lat: null, lng: null }, source: null, label: '' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let instances;
beforeEach(() => {
  instances = [];
  window.google = { maps: { places: { Autocomplete: jest.fn(function FixtureAutocomplete(input, options) {
    this.input = input; this.options = options; this.place = place();
    this.bindTo = jest.fn(); this.getPlace = () => this.place;
    this.remove = jest.fn();
    this.addListener = jest.fn((name, callback) => { this.event = name; this.callback = callback; return { remove: this.remove }; });
    instances.push(this);
  }) }, event: { clearInstanceListeners: jest.fn() } } };
});
afterEach(() => { delete window.google; });
function Harness({ onPatch = () => {}, ...props }) {
  const [value, setValue] = useState(point.address);
  return <AddressInput value={value} label="Pickup" onChange={(patch) => { onPatch(patch); if (patch.address !== undefined) setValue(patch.address); }} {...props} />;
}
const autocompleteSelect = (instance = instances[0]) => act(() => { instance.callback(); });
const savedSelect = (id) => fireEvent.change(screen.getByRole('combobox', { name: 'Choose saved location for Pickup' }), { target: { value: id } });

it('typing replaces a previously resolved point with text and clears source, coordinates and saved label', () => {
  let current = point;
  const onPatch = jest.fn((patch) => { current = { ...current, ...patch }; });
  render(<Harness onPatch={onPatch} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Pickup' }), { target: { value: 'Unresolved new address' } });
  expect(onPatch).toHaveBeenCalledWith({ address: 'Unresolved new address', ...invalid });
  expect(current).toEqual({ address: 'Unresolved new address', ...invalid });
  expect(screen.getByRole('textbox')).toHaveValue('Unresolved new address');
});

it('a valid suggestion emits only fresh address, coordinates and place reference and uses current onChange', () => {
  const first = jest.fn(), latest = jest.fn(), map = {};
  const { rerender } = render(<AddressInput map={map} value="Draft" label="Pickup" onChange={first} />);
  expect(instances[0].options.fields).toEqual(['place_id', 'formatted_address', 'geometry.location']);
  expect(instances[0].bindTo).toHaveBeenCalledWith('bounds', map);
  expect(instances[0].event).toBe('place_changed');
  rerender(<AddressInput map={map} value="Draft" label="Pickup" onChange={latest} />);
  autocompleteSelect();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith({ address: point.address, coordinates: point.coordinates, source, label: '' });
  expect(instances).toHaveLength(1);
});

it.each([
  ['missing geometry', { geometry: undefined }],
  ['out of range latitude', { geometry: { location: { lat: () => 91, lng: () => 0 } } }],
  ['nonfinite longitude', { geometry: { location: { lat: () => 0, lng: () => NaN } } }],
  ['invalid place ID', { place_id: 'contains whitespace' }],
  ['absent formatted address', { formatted_address: undefined }],
])('rejects %s and clears resolved metadata while retaining typed text', (_, changes) => {
  const onPatch = jest.fn();
  render(<Harness map={{}} onPatch={onPatch} />);
  instances[0].place = place(changes);
  autocompleteSelect();
  expect(onPatch).toHaveBeenCalledWith(invalid);
  expect(screen.getByRole('textbox')).toHaveValue(point.address);
});

it('map replacement and unmount remove provider listeners and retained old callbacks cannot apply', () => {
  const onChange = jest.fn(), firstMap = {}, secondMap = {};
  const { rerender, unmount } = render(<AddressInput map={firstMap} value="Draft" label="Pickup" onChange={onChange} />);
  const old = instances[0];
  rerender(<AddressInput map={secondMap} value="Draft" label="Pickup" onChange={onChange} />);
  expect(old.remove).toHaveBeenCalledTimes(1);
  expect(window.google.maps.event.clearInstanceListeners).toHaveBeenCalledWith(old);
  autocompleteSelect(old);
  expect(onChange).not.toHaveBeenCalled();
  const current = instances[1];
  autocompleteSelect(current);
  expect(onChange).toHaveBeenCalledTimes(1);
  const clear = window.google.maps.event.clearInstanceListeners;
  unmount();
  expect(current.remove).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledWith(current);
  autocompleteSelect(old); autocompleteSelect(current);
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('disabled fields block both retained autocomplete selection and saved-location selection', () => {
  const onChange = jest.fn(), onSavedSelect = jest.fn(), map = {};
  const { rerender } = render(<AddressInput map={map} value="Draft" label="Pickup" onChange={onChange} savedLocations={rows} onSavedSelect={onSavedSelect} />);
  rerender(<AddressInput disabled map={map} value="Draft" label="Pickup" onChange={onChange} savedLocations={rows} onSavedSelect={onSavedSelect} />);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('combobox')).toBeDisabled();
  autocompleteSelect(); savedSelect('home');
  expect(onChange).not.toHaveBeenCalled();
  expect(onSavedSelect).not.toHaveBeenCalled();
});

it('an obsolete saved-location failure cannot overwrite the loading state of a newer selection after typing', async () => {
  const old = deferred(), current = deferred();
  const onSavedSelect = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  render(<Harness savedLocations={rows} onSavedSelect={onSavedSelect} />);
  savedSelect('home');
  expect(screen.getByRole('combobox')).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New draft' } });
  expect(screen.getByRole('combobox')).not.toBeDisabled();
  savedSelect('work');
  await act(async () => { old.reject(new Error('Old synthetic failure')); await old.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByRole('textbox')).toHaveValue('New draft');
  await act(async () => { current.resolve(); await current.promise; });
  expect(screen.getByRole('combobox')).not.toBeDisabled();
  expect(onSavedSelect).toHaveBeenNthCalledWith(2, rows[1]);
});

it('a fresh provider suggestion supersedes an in-flight saved lookup and suppresses its late error', async () => {
  const pending = deferred(), onPatch = jest.fn();
  render(<Harness map={{}} onPatch={onPatch} savedLocations={rows} onSavedSelect={() => pending.promise} />);
  savedSelect('work');
  autocompleteSelect();
  expect(onPatch).toHaveBeenCalledWith({ address: point.address, source, coordinates: point.coordinates, label: '' });
  await act(async () => { pending.reject(new Error('Old lookup')); await pending.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox')).not.toBeDisabled();
});

it('unmount discards pending saved lookup errors and AbortError is silent while mounted', async () => {
  const pending = deferred();
  const onSavedSelect = jest.fn().mockRejectedValueOnce(new DOMException('Selection changed', 'AbortError')).mockReturnValueOnce(pending.promise);
  const { unmount } = render(<Harness savedLocations={rows} onSavedSelect={onSavedSelect} />);
  await act(async () => { savedSelect('home'); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox')).not.toBeDisabled();
  savedSelect('work'); unmount();
  await act(async () => { pending.reject(new Error('Late unmounted lookup')); await pending.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
