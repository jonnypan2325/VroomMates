import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocationInput from './LocationInput';
import { resolvePlace } from './saving/places';

jest.mock('./saving/places', () => ({ ...jest.requireActual('./saving/places'), resolvePlace: jest.fn() }));
jest.mock('./saving/useSavedLocations', () => () => ({
  locations: [{ id: 'saved-home', label: 'Home', source: { kind: 'google_places', place_id: 'home' } }],
  loading: false, error: null, refresh: jest.fn().mockResolvedValue(),
}));
jest.mock('./saving/SavedTripsPanel', () => function TripBoundary({ snapshot }) {
  return <output data-testid="frozen-trip">{JSON.stringify(snapshot)}</output>;
});
jest.mock('./components/AddressInput', () => function AddressFixture({ label, value, onChange, action }) {
  const coordinate = label === 'Destination' ? 9 : label.startsWith('Driver') ? 1 : 4;
  return <div><input aria-label={label} value={value} onChange={(event) => onChange({
    address: event.target.value, label: '', source: { kind: 'google_places', place_id: label.replace(/\s/g, '-') },
    coordinates: { lat: coordinate, lng: coordinate },
  })} />{action}</div>;
});
beforeAll(() => {
  global.TextEncoder = TextEncoder;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
});
const auth = { status: 'authenticated', generation: 1, profile: { id: 'fixture-a' } };
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
let renderer, map, directionsCallbacks;
beforeEach(() => {
  global.fetch = jest.fn();
  Element.prototype.scrollTo = jest.fn();
  renderer = { set: jest.fn(), setDirections: jest.fn() };
  map = {};
  directionsCallbacks = [];
  window.google = { maps: { TravelMode: { DRIVING: 'DRIVING' }, DirectionsService: class {
    route(options, callback) { directionsCallbacks.push(callback); }
  } } };
  resolvePlace.mockReset();
});
afterEach(() => { delete global.fetch; delete window.google; });
function show(props = {}) { return render(<LocationInput auth={auth} map={map} directionsRenderer={renderer} {...props} />); }
function fill(label, value) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function fillTrip(count = 3) {
  fill('Driver 1 passenger seats', String(count));
  fill('Driver 1 location', 'Origin');
  fill('Pickup 1 location', 'Pickup');
  fill('Passengers at pickup 1', String(count));
  fill('Destination', 'Destination');
}
const responseFor = (count) => ({ ok: true, json: async () => ({ optimizedRoutes: [
  [{ lat: 1, lng: 1 }, ...Array.from({length: count}, () => ({lat: 4, lng: 4})), {lat: 9, lng: 9}],
] }) });
const calculate = () => fireEvent.click(screen.getByRole('button', { name: 'Calculate route', exact: true }));

test('a pickup count sends individual people and saving retains the calculated result after edits', async () => {
  show(); fillTrip(); fetch.mockResolvedValue(responseFor(3)); calculate();
  await screen.findByRole('heading', {name:'Your route'});
  expect(JSON.parse(fetch.mock.calls[0][1].body).passengers).toEqual(Array(3).fill({lat:4,lng:4}));
  const snapshot = JSON.parse(screen.getByTestId('frozen-trip').textContent);
  expect(snapshot.inputs.passengers).toHaveLength(3);
  expect(new Set(snapshot.inputs.passengers.map(p => p.stop_id)).size).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain('coordinates');
  fill('Passengers at pickup 1', '1'); fill('Pickup 1 location', 'Changed');
  expect(JSON.parse(screen.getByTestId('frozen-trip').textContent)).toEqual(snapshot);
  expect(screen.getByText('1 driver · 3 passengers')).toBeInTheDocument();
});

test('count edits abort a pending calculation and discard even an abort-ignoring reply', async () => {
  show(); fillTrip(); const pending = deferred(); fetch.mockReturnValue(pending.promise); calculate();
  const signal = fetch.mock.calls[0][1].signal;
  fill('Passengers at pickup 1', '2'); expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(responseFor(3)));
  expect(screen.queryByRole('heading',{name:'Your route'})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Calculate route',exact:true})).toBeEnabled();
});

test('over-limit total people and insufficient seats fail before any request', () => {
  show(); fillTrip(12); fireEvent.click(screen.getByRole('button',{name:'Add pickup'}));
  fill('Pickup 2 location','Other pickup'); calculate();
  expect(screen.getByRole('alert')).toHaveTextContent('at most 12 passengers in total');
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Remove pickup 2'}));
  fill('Driver 1 passenger seats','2'); calculate();
  expect(screen.getByRole('alert')).toHaveTextContent('enough passenger seats');
  expect(fetch).not.toHaveBeenCalled();
});

test('removal permits empty editing, preserves focus and blocks calculation until required rows exist', () => {
  show(); fireEvent.click(screen.getByRole('button',{name:'Remove Driver 1'}));
  expect(screen.getByRole('button',{name:'Add Driver'})).toHaveFocus(); calculate();
  expect(screen.getByRole('alert')).toHaveTextContent('Add at least one driver');
  fireEvent.click(screen.getByRole('button',{name:'Add Driver'}));
  fireEvent.click(screen.getByRole('button',{name:'Remove pickup 1'}));
  expect(screen.getByRole('button',{name:'Add pickup'})).toHaveFocus(); calculate();
  expect(screen.getByRole('alert')).toHaveTextContent('Add at least one passenger');
  expect(fetch).not.toHaveBeenCalled();
});

test('section picker fills an empty pickup preserving its count, then appends count one', async () => {
  show(); fill('Passengers at pickup 1','3');
  resolvePlace.mockResolvedValue({ address:'Home address',source:{kind:'google_places',place_id:'home'},coordinates:{lat:2,lng:2} });
  const select = () => fireEvent.change(screen.getByRole('combobox',{name:'Select from saved locations for passengers'}),{target:{value:'saved-home'}});
  select(); await waitFor(() => expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('Home address'));
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(3);
  select(); await waitFor(() => expect(screen.getByLabelText('Pickup 2 location')).toHaveValue('Home address'));
  expect(screen.getByLabelText('Passengers at pickup 2')).toHaveValue(1);
});

test('editing a count supersedes a saved-place lookup without replacing typed state', async () => {
  show(); const pending = deferred(); resolvePlace.mockReturnValue(pending.promise);
  fireEvent.change(screen.getByRole('combobox',{name:'Select from saved locations for passengers'}),{target:{value:'saved-home'}});
  fill('Passengers at pickup 1','4');
  await act(async () => pending.resolve({address:'Old lookup',source:{kind:'google_places',place_id:'home'},coordinates:{lat:2,lng:2}}));
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(4);
});

test('account change clears private saved-place form data and grouped counts', async () => {
  const view=show(); resolvePlace.mockResolvedValue({address:'Private home',source:{kind:'google_places',place_id:'home'},coordinates:{lat:2,lng:2}});
  fireEvent.change(screen.getByRole('combobox',{name:'Select from saved locations for passengers'}),{target:{value:'saved-home'}});
  await waitFor(() => expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('Private home'));
  fill('Passengers at pickup 1','3');
  view.rerender(<LocationInput auth={{...auth,profile:{id:'fixture-b'},generation:2}} map={map} directionsRenderer={renderer}/>);
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(1);
});

test('late map callback cannot replace directions for a newer calculation', async () => {
  show(); fillTrip(2); fetch.mockResolvedValue(responseFor(2)); calculate();
  await screen.findByRole('heading',{name:'Your route'});
  expect(directionsCallbacks).toHaveLength(1);
  fill('Passengers at pickup 1','1'); fetch.mockResolvedValue(responseFor(1)); calculate();
  await waitFor(() => expect(directionsCallbacks).toHaveLength(2));
  act(() => directionsCallbacks[1]({route:'new'},'OK'));
  act(() => directionsCallbacks[0]({route:'old'},'OK'));
  expect(renderer.setDirections.mock.calls).toEqual([[{route:'new'}]]);
});
