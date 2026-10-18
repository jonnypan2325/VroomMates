import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocationInput from './LocationInput';
import { resolvePlace } from './saving/places';

jest.mock('./saving/places', () => ({ ...jest.requireActual('./saving/places'), resolvePlace: jest.fn() }));
const mockHome = { id: 'saved-home', label: 'Home', source: { kind: 'google_places', place_id: 'home' } };
const mockSaved = { locations: [mockHome], loading: false, error: null, save: jest.fn(), remove: jest.fn(), edit: jest.fn() };
jest.mock('./saving/useSavedLocations', () => () => ({
  locations: mockSaved.locations, loading: mockSaved.loading, error: mockSaved.error, refresh: jest.fn().mockResolvedValue(),
  save: (...args) => mockSaved.save(...args), remove: (...args) => mockSaved.remove(...args), edit: (...args) => mockSaved.edit(...args),
}));
jest.mock('./saving/SavedTripsPanel', () => function TripBoundary({ snapshot, openedTrip, onOpened }) {
  return <><output data-testid="frozen-trip">{JSON.stringify(snapshot)}</output>
    <button type="button" onClick={() => onOpened({ id: 'fixture-trip', title: 'Friday dinner' })}>Fixture opens trip</button>
    <output data-testid="opened-trip">{openedTrip ? openedTrip.title : ''}</output></>;
});
// Saved choices stand in for the field's own suggestion list; the nickname shows what a named row displays.
jest.mock('./components/AddressInput', () => function AddressFixture({ label, value, nickname, onChange, action, savedLocations = [], onSavedSelect }) {
  const coordinate = label === 'Destination' ? 9 : label.startsWith('Driver') ? 1 : 4;
  return <div><input aria-label={label} value={value} onChange={(event) => onChange({
    address: event.target.value, label: '', source: { kind: 'google_places', place_id: label.replace(/\s/g, '-') },
    coordinates: { lat: coordinate, lng: coordinate },
  })} />{nickname && <span>{label} nickname: {nickname}</span>}
    {onSavedSelect && savedLocations.map((row) => <button type="button" key={row.id}
      onClick={() => { onSavedSelect(row).catch(() => {}); }}>Use {row.label} for {label}</button>)}
    {action}</div>;
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
  mockSaved.locations = [mockHome];
  mockSaved.loading = false;
  mockSaved.error = null;
  mockSaved.save.mockReset(); mockSaved.remove.mockReset(); mockSaved.edit.mockReset();
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
const calculateButton = () => screen.getByRole('button', { name: 'Calculate route', exact: true });
const calculate = () => fireEvent.click(calculateButton());
// A saved choice starts an async place lookup; async act settles it before assertions.
async function settle(fire) { await act(async () => { fire(); }); }
const useSaved = (field) => settle(() => fireEvent.click(screen.getByRole('button', { name: `Use Home for ${field}` })));

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
  expect(screen.getByRole('heading', { name: 'Your route' })).toBeInTheDocument();
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
  expect(screen.getByRole('button',{name:'Add Driver'})).toHaveFocus();
  expect(calculateButton()).toHaveAttribute('aria-disabled', 'true');
  expect(calculateButton()).toHaveAccessibleDescription('Add a driver.');
  calculate();
  fireEvent.click(screen.getByRole('button',{name:'Add Driver'}));
  fireEvent.click(screen.getByRole('button',{name:'Remove pickup 1'}));
  expect(screen.getByRole('button',{name:'Add pickup'})).toHaveFocus();
  expect(calculateButton()).toHaveAccessibleDescription('Add a pickup.');
  calculate();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading',{name:'Your route'})).not.toBeInTheDocument();
});

test('a saved place chosen in a pickup field fills that row, keeps its count and shows the nickname', async () => {
  show(); fill('Passengers at pickup 1','3');
  resolvePlace.mockResolvedValue({ address:'Home address',source:{kind:'google_places',place_id:'home'},coordinates:{lat:2,lng:2} });
  await useSaved('Pickup 1 location');
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('Home address');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(3);
  expect(screen.getByText('Pickup 1 location nickname: Home')).toBeInTheDocument();
  expect(resolvePlace).toHaveBeenCalledWith(map, 'home', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.click(screen.getByRole('button',{name:'Add pickup'}));
  expect(screen.getByLabelText('Pickup 2 location')).toHaveValue('');
  expect(screen.getByLabelText('Passengers at pickup 2')).toHaveValue(1);
});

test('editing a count supersedes a saved-place lookup without replacing typed state', async () => {
  show(); const pending = deferred(); resolvePlace.mockReturnValue(pending.promise);
  fireEvent.click(screen.getByRole('button',{name:'Use Home for Pickup 1 location'}));
  fill('Passengers at pickup 1','4');
  await act(async () => pending.resolve({address:'Old lookup',source:{kind:'google_places',place_id:'home'},coordinates:{lat:2,lng:2}}));
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(4);
  expect(screen.queryByText(/nickname: Home/)).not.toBeInTheDocument();
});

test('account change clears private saved-place form data and grouped counts', async () => {
  const view=show(); resolvePlace.mockResolvedValue({address:'Private home',source:{kind:'google_places',place_id:'home'},coordinates:{lat:2,lng:2}});
  await useSaved('Pickup 1 location');
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('Private home');
  fill('Passengers at pickup 1','3');
  view.rerender(<LocationInput auth={{...auth,profile:{id:'fixture-b'},generation:2}} map={map} directionsRenderer={renderer}/>);
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(1);
  expect(screen.queryByText(/nickname: Home/)).not.toBeInTheDocument();
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

test('rows put the address first, then the count, then remove, and new drivers start with four seats', () => {
  show();
  const address = screen.getByLabelText('Driver 1 location'), seats = screen.getByLabelText('Driver 1 passenger seats');
  const remove = screen.getByRole('button', { name: 'Remove Driver 1' });
  expect(address.compareDocumentPosition(seats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(seats.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(seats).toHaveValue(4);
  fireEvent.click(screen.getByRole('button', { name: 'Add Driver' }));
  expect(screen.getByLabelText('Driver 2 passenger seats')).toHaveValue(4);
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(1);
  expect(screen.getByText('Seats')).toBeInTheDocument();
  expect(screen.getByText('People')).toBeInTheDocument();
});

test('section headings show a check only while every row in them has a chosen place', () => {
  show();
  const heading = (name) => screen.getByRole('heading', { name: new RegExp('^' + name) });
  expect(heading('Drivers')).not.toHaveTextContent('(complete)');
  fill('Driver 1 location', 'Origin');
  expect(heading('Drivers')).toHaveAccessibleName('Drivers (complete)');
  fireEvent.click(screen.getByRole('button', { name: 'Add Driver' }));
  expect(heading('Drivers')).toHaveAccessibleName('Drivers');
  fill('Pickup 1 location', 'Pickup'); fill('Destination', 'Destination');
  expect(heading('Passenger pickups')).toHaveAccessibleName('Passenger pickups (complete)');
  expect(heading('Destination')).toHaveAccessibleName('Destination (complete)');
});

test('Calculate stays focusable while places are missing, names them and leads to the first empty field', () => {
  show();
  expect(calculateButton()).toBeEnabled();
  expect(calculateButton()).toHaveAttribute('aria-disabled', 'true');
  expect(calculateButton()).toHaveAccessibleDescription('Missing: Driver 1, Pickup 1, destination.');
  fill('Driver 1 location', 'Origin');
  expect(screen.getByText('Missing: Pickup 1, destination.')).toBeInTheDocument();
  calculate();
  expect(screen.getByLabelText('Pickup 1 location')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Add Driver' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Driver' }));
  expect(screen.getByText('Missing places for 4 stops.')).toBeInTheDocument();
  fill('Driver 2 location', 'Second'); fill('Driver 3 location', 'Third');
  fill('Pickup 1 location', 'Pickup'); fill('Destination', 'Destination');
  expect(calculateButton()).not.toHaveAttribute('aria-disabled');
  expect(screen.queryByText(/^Missing/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

test('Start over clears fields and route but no saved data, and Undo restores them until the next edit', async () => {
  show(); fillTrip(); fetch.mockResolvedValue(responseFor(3)); calculate();
  await screen.findByRole('heading', { name: 'Your route' });
  const snapshot = screen.getByTestId('frozen-trip').textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.getByText('Planner cleared.')).toHaveAttribute('role', 'status');
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Driver 1 passenger seats')).toHaveValue(4);
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(1);
  expect(screen.getByLabelText('Destination')).toHaveValue('');
  expect(screen.queryByRole('heading', { name: 'Your route' })).not.toBeInTheDocument();
  expect(screen.getByTestId('frozen-trip')).toHaveTextContent('null');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('Origin');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(3);
  expect(screen.getByRole('heading', { name: 'Your route' })).toBeInTheDocument();
  expect(screen.getByTestId('frozen-trip').textContent).toBe(snapshot);
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  fill('Destination', 'Another destination');
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  expect(screen.queryByText('Planner cleared.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(mockSaved.save).not.toHaveBeenCalled();
  expect(mockSaved.remove).not.toHaveBeenCalled();
  expect(mockSaved.edit).not.toHaveBeenCalled();
});

test('an opened trip moves Start over into its Editing bar, and Undo reopens the trip', () => {
  show(); fill('Driver 1 location', 'Origin');
  fireEvent.click(screen.getByRole('button', { name: 'Fixture opens trip' }));
  expect(screen.getByText('Editing')).toHaveTextContent('Editing Friday dinner');
  expect(screen.getAllByRole('button', { name: 'Start over' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.queryByText(/^Editing/)).not.toBeInTheDocument();
  expect(screen.getByTestId('opened-trip')).toHaveTextContent('');
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByTestId('opened-trip')).toHaveTextContent('Friday dinner');
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('Origin');
});

test('a confirmed in-field save names the row and turns its Save toggle into a saved mark', async () => {
  show();
  expect(screen.queryByRole('button', { name: 'Save location for Driver 1' })).not.toBeInTheDocument();
  fill('Driver 1 location', 'Origin');
  const row = { id: 'saved-car', label: 'Car park', source: { kind: 'google_places', place_id: 'Driver-1-location' } };
  mockSaved.save.mockImplementation(async () => { mockSaved.locations = [mockHome, row]; return row; });
  fireEvent.click(screen.getByRole('button', { name: 'Save location for Driver 1' }));
  expect(screen.getByRole('button', { name: 'Hide save form for Driver 1' })).toHaveAttribute('aria-expanded', 'true');
  const label = screen.getByRole('textbox', { name: 'Your label for Driver 1' });
  expect(label).toHaveAttribute('placeholder', 'Name this place, e.g. Home');
  expect(screen.queryByText('Create label before saving')).not.toBeInTheDocument();
  fireEvent.change(label, { target: { value: 'Car park' } });
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Save location' })));
  expect(mockSaved.save).toHaveBeenCalledWith('Car park', row.source);
  expect(screen.queryByRole('textbox', { name: 'Your label for Driver 1' })).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Driver 1 is saved as Car park' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /save form for Driver 1|Save location for Driver 1/ })).not.toBeInTheDocument();
  expect(screen.getByText('Driver 1 location nickname: Car park')).toBeInTheDocument();
});

test('a save confirmed after the row was edited does not name the edited row', async () => {
  show(); fill('Driver 1 location', 'Origin');
  const pending = deferred();
  mockSaved.save.mockReturnValue(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Save location for Driver 1' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Your label for Driver 1' }), { target: { value: 'Car park' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save location' }));
  fill('Driver 1 location', 'Somewhere else');
  const row = { id: 'saved-car', label: 'Car park', source: { kind: 'google_places', place_id: 'Driver-1-location' } };
  await act(async () => { mockSaved.locations = [mockHome, row]; pending.resolve(row); });
  expect(screen.queryByText(/nickname: Car park/)).not.toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /is saved as/ })).not.toBeInTheDocument();
});

test('an account change ends the chance to undo Start over, so private fields cannot return', async () => {
  const view = show();
  resolvePlace.mockResolvedValue({ address: 'Private home', source: { kind: 'google_places', place_id: 'home' }, coordinates: { lat: 2, lng: 2 } });
  await useSaved('Pickup 1 location');
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  view.rerender(<LocationInput auth={{ ...auth, profile: { id: 'fixture-b' }, generation: 2 }} map={map} directionsRenderer={renderer} />);
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  expect(screen.queryByText('Planner cleared.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
});

test('rows picked from My locations follow its later rename, move and deletion, but not a loading list', async () => {
  resolvePlace.mockResolvedValue({ address: 'Old home address', coordinates: { lat: 1, lng: 1 }, place_name: '',
    source: mockHome.source });
  const view = show();
  const again = () => view.rerender(<LocationInput auth={auth} map={map} directionsRenderer={renderer} />);
  await useSaved('Driver 1 location');
  expect(screen.getByText('Driver 1 location nickname: Home')).toBeInTheDocument();
  mockSaved.locations = [{ ...mockHome, label: 'Home base' }];
  again();
  expect(await screen.findByText('Driver 1 location nickname: Home base')).toBeInTheDocument();
  const moved = { kind: 'google_places', place_id: 'new-home' };
  resolvePlace.mockResolvedValue({ address: 'New home address', coordinates: { lat: 2, lng: 2 }, place_name: '', source: moved });
  mockSaved.locations = [{ ...mockHome, label: 'Home base', source: moved }];
  await act(async () => { again(); });
  await waitFor(() => expect(screen.getByLabelText('Driver 1 location')).toHaveValue('New home address'));
  expect(resolvePlace).toHaveBeenLastCalledWith(map, 'new-home', expect.anything());
  expect(screen.getByText('Driver 1 location nickname: Home base')).toBeInTheDocument();
  mockSaved.loading = true; mockSaved.locations = [];
  again();
  expect(screen.getByText('Driver 1 location nickname: Home base')).toBeInTheDocument();
  mockSaved.loading = false; mockSaved.locations = [];
  again();
  await waitFor(() => expect(screen.queryByText(/Driver 1 location nickname/)).not.toBeInTheDocument());
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('New home address');
});

test('a saved trip keeps only the nickname and place reference, never the landmark name or saved-location link', async () => {
  resolvePlace.mockResolvedValue({ address: 'Home address', coordinates: { lat: 1, lng: 1 }, place_name: 'Synthetic Landmark',
    source: mockHome.source });
  show();
  await useSaved('Driver 1 location');
  fill('Pickup 1 location', 'Pickup'); fill('Destination', 'Destination');
  fetch.mockResolvedValue(responseFor(1)); calculate();
  await screen.findByRole('heading', { name: 'Your route' });
  const snapshot = screen.getByTestId('frozen-trip').textContent;
  expect(JSON.parse(snapshot).inputs.drivers[0]).toEqual(expect.objectContaining({ label: 'Home', source: mockHome.source }));
  expect(snapshot).not.toContain('Synthetic Landmark');
  expect(snapshot).not.toContain('saved_id');
  expect(snapshot).not.toContain('saved-home');
});

test('a failed list refresh still passes on a confirmed rename, but never unlinks a row', async () => {
  resolvePlace.mockResolvedValue({ address: 'Home address', coordinates: { lat: 1, lng: 1 }, place_name: '', source: mockHome.source });
  const view = show();
  const again = () => view.rerender(<LocationInput auth={auth} map={map} directionsRenderer={renderer} />);
  await useSaved('Driver 1 location');
  mockSaved.error = 'My locations could not be refreshed.';
  mockSaved.locations = [{ ...mockHome, label: 'Home base' }];
  again();
  expect(await screen.findByText('Driver 1 location nickname: Home base')).toBeInTheDocument();
  mockSaved.locations = [];
  again();
  expect(screen.getByText('Driver 1 location nickname: Home base')).toBeInTheDocument();
});

test('a saved place that moves clears a calculated route through it, so it is calculated again', async () => {
  resolvePlace.mockResolvedValue({ address: 'Home address', coordinates: { lat: 1, lng: 1 }, place_name: '', source: mockHome.source });
  const view = show();
  await useSaved('Driver 1 location');
  fill('Pickup 1 location', 'Pickup'); fill('Destination', 'Destination');
  fetch.mockResolvedValue(responseFor(1)); calculate();
  await screen.findByRole('heading', { name: 'Your route' });
  const moved = { kind: 'google_places', place_id: 'new-home' };
  resolvePlace.mockResolvedValue({ address: 'New home address', coordinates: { lat: 2, lng: 2 }, place_name: '', source: moved });
  mockSaved.locations = [{ ...mockHome, source: moved }];
  await act(async () => { view.rerender(<LocationInput auth={auth} map={map} directionsRenderer={renderer} />); });
  await waitFor(() => expect(screen.getByLabelText('Driver 1 location')).toHaveValue('New home address'));
  expect(screen.queryByRole('heading', { name: 'Your route' })).not.toBeInTheDocument();
  expect(screen.getByTestId('frozen-trip')).toHaveTextContent('null');
  expect(screen.getByRole('alert')).toHaveTextContent('A saved place in this route moved');
});

test('an optimizer error page that is not JSON shows a service message, not a parser error', async () => {
  show(); fillTrip(1);
  fetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token '<'"); } });
  calculate();
  expect(await screen.findByRole('alert')).toHaveTextContent('The route optimizer is unavailable. Please retry.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('Unexpected token');
});
