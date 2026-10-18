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
function Harness({ onPatch = () => {}, initial = point.address, ...props }) {
  const [value, setValue] = useState(initial);
  return <AddressInput value={value} label="Pickup" onChange={(patch) => { onPatch(patch); if (patch.address !== undefined) setValue(patch.address); }} {...props} />;
}
const autocompleteSelect = (instance = instances[0]) => act(() => { instance.callback(); });
// With saved places the field is a combobox; its saved suggestions open while it has focus.
const field = () => screen.getByRole('combobox', { name: 'Pickup' });
const focusField = () => act(() => { field().focus(); });
// Options choose on mousedown so the field keeps focus, as in the browser.
const savedSelect = (name) => fireEvent.mouseDown(screen.getByRole('option', { name }));
const loading = () => screen.queryByRole('status');

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
  const { rerender } = render(<AddressInput map={map} value="" label="Pickup" onChange={onChange} savedLocations={rows} onSavedSelect={onSavedSelect} />);
  focusField();
  expect(screen.getByRole('listbox', { name: 'Saved places for Pickup' })).toBeInTheDocument();
  rerender(<AddressInput disabled map={map} value="" label="Pickup" onChange={onChange} savedLocations={rows} onSavedSelect={onSavedSelect} />);
  expect(field()).toBeDisabled();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.focus(field());
  fireEvent.keyDown(field(), { key: 'ArrowDown' }); fireEvent.keyDown(field(), { key: 'Enter' });
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  autocompleteSelect();
  expect(onChange).not.toHaveBeenCalled();
  expect(onSavedSelect).not.toHaveBeenCalled();
});

it('an obsolete saved-location failure cannot overwrite the loading state of a newer selection after typing', async () => {
  const old = deferred(), current = deferred();
  const onSavedSelect = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  render(<Harness initial="" savedLocations={rows} onSavedSelect={onSavedSelect} />);
  focusField(); savedSelect('Home');
  expect(loading()).toHaveTextContent('Loading saved place…');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.change(field(), { target: { value: 'Wo' } });
  expect(loading()).not.toBeInTheDocument();
  savedSelect('Work');
  await act(async () => { old.reject(new Error('Old synthetic failure')); await old.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(loading()).toHaveTextContent('Loading saved place…');
  expect(field()).toHaveValue('Wo');
  await act(async () => { current.resolve(); await current.promise; });
  expect(loading()).not.toBeInTheDocument();
  expect(onSavedSelect).toHaveBeenNthCalledWith(1, rows[0]);
  expect(onSavedSelect).toHaveBeenNthCalledWith(2, rows[1]);
});

it('a fresh provider suggestion supersedes an in-flight saved lookup and suppresses its late error', async () => {
  const pending = deferred(), onPatch = jest.fn();
  render(<Harness map={{}} initial="" onPatch={onPatch} savedLocations={rows} onSavedSelect={() => pending.promise} />);
  focusField(); savedSelect('Work');
  autocompleteSelect();
  expect(onPatch).toHaveBeenCalledWith({ address: point.address, source, coordinates: point.coordinates, label: '' });
  expect(loading()).not.toBeInTheDocument();
  await act(async () => { pending.reject(new Error('Old lookup')); await pending.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(loading()).not.toBeInTheDocument();
});

it('unmount discards pending saved lookup errors and AbortError is silent while mounted', async () => {
  const pending = deferred();
  const onSavedSelect = jest.fn().mockRejectedValueOnce(new DOMException('Selection changed', 'AbortError')).mockReturnValueOnce(pending.promise);
  const { unmount } = render(<Harness initial="" savedLocations={rows} onSavedSelect={onSavedSelect} />);
  focusField();
  await act(async () => { savedSelect('Home'); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(loading()).not.toBeInTheDocument();
  savedSelect('Work'); unmount();
  await act(async () => { pending.reject(new Error('Late unmounted lookup')); await pending.promise.catch(() => {}); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('saved places list in a body portal while the field is empty or matches a nickname, then give way to Google', () => {
  const { container } = render(<Harness initial="" savedLocations={rows} onSavedSelect={jest.fn()} />);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  focusField();
  const list = screen.getByRole('listbox', { name: 'Saved places for Pickup' });
  expect(container).not.toContainElement(list);
  expect(document.body).toContainElement(list);
  expect(list).toHaveTextContent(/^Saved places/);
  expect(field()).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Home', 'Work']);
  fireEvent.change(field(), { target: { value: 'ho' } });
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Home']);
  fireEvent.change(field(), { target: { value: '12 Synthetic Street' } });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(field()).toHaveAttribute('aria-expanded', 'false');
  fireEvent.change(field(), { target: { value: '' } });
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  act(() => { field().blur(); });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('without a saved-place handler the field is a plain textbox with no saved list', () => {
  render(<Harness initial="" savedLocations={rows} />);
  act(() => { screen.getByRole('textbox', { name: 'Pickup' }).focus(); });
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('arrow keys and Enter choose a saved place, and Escape closes the list', () => {
  const onSavedSelect = jest.fn(() => new Promise(() => {}));
  render(<Harness initial="" savedLocations={rows} onSavedSelect={onSavedSelect} />);
  focusField();
  fireEvent.keyDown(field(), { key: 'ArrowDown' });
  fireEvent.keyDown(field(), { key: 'ArrowDown' });
  const active = screen.getByRole('option', { name: 'Work' });
  expect(active).toHaveAttribute('aria-selected', 'true');
  expect(field()).toHaveAttribute('aria-activedescendant', active.id);
  fireEvent.keyDown(field(), { key: 'ArrowUp' });
  expect(screen.getByRole('option', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(field(), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(onSavedSelect).not.toHaveBeenCalled();
  act(() => { field().blur(); }); focusField();
  fireEvent.keyDown(field(), { key: 'ArrowDown' });
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(onSavedSelect).toHaveBeenCalledWith(rows[0]);
  expect(loading()).toHaveTextContent('Loading saved place…');
});

it('a named place shows its nickname over the address and clicking it returns to text editing', () => {
  render(<Harness nickname="Home" savedLocations={rows} onSavedSelect={jest.fn()} />);
  const named = screen.getByRole('button', { name: `Pickup: Home, ${point.address}. Change address` });
  expect(named).toHaveClass('address-named');
  expect(named).toHaveTextContent(`Home${point.address}`);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  fireEvent.click(named);
  expect(screen.queryByRole('button', { name: /Change address/ })).not.toBeInTheDocument();
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue(point.address);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  act(() => { field().blur(); });
  expect(screen.getByRole('button', { name: /Change address/ })).toBeInTheDocument();
});
