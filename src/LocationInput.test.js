import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocationInput from './LocationInput';
import { resolvePlace } from './saving/places';

jest.mock('./saving/places', () => ({ ...jest.requireActual('./saving/places'), resolvePlace: jest.fn() }));
const mockHome = { id: '44444444-4444-4444-8444-444444444444', label: 'Home', source: { kind: 'google_places', place_id: 'home' } };
const mockSaved = { locations: [mockHome], loading: false, error: null, save: jest.fn(), remove: jest.fn(), edit: jest.fn() };
jest.mock('./saving/useSavedLocations', () => () => ({
  locations: mockSaved.locations, loading: mockSaved.loading, error: mockSaved.error, refresh: jest.fn().mockResolvedValue(),
  save: (...args) => mockSaved.save(...args), remove: (...args) => mockSaved.remove(...args), edit: (...args) => mockSaved.edit(...args),
}));
// My trips stands in as two buttons: one opens a trip into the planner, one shows the fixture trip read-only.
const mockTrip = { current: null };
jest.mock('./saving/SavedTripsPanel', () => {
  const actual = jest.requireActual('./saving/SavedTripsPanel');
  function TripBoundary({ openedTrip, onOpened, onView, onBeginLoad, onEndLoad, viewing, children }) {
    const view = async () => {
      const token = onBeginLoad();
      try { await onView(mockTrip.current, token); } finally { onEndLoad(token); }
    };
    return <><button type="button" onClick={() => onOpened({ id: 'fixture-trip', title: 'Friday dinner', opened: true })}>Fixture opens trip</button>
      <button type="button" onClick={() => { view().catch(() => {}); }}>Fixture views trip</button>
      <output data-testid="opened-trip">{openedTrip ? openedTrip.title : ''}</output>
      {viewing && children}</>;
  }
  return { __esModule: true, ...actual, default: TripBoundary };
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
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const STAMP = '2026-10-29T12:00:00Z';
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// Saved trips in memory, answering like the API; `fail` rejects that many writes with 503.
function tripServer() {
  const server = { trips: new Map(), writes: [], fail: 0 };
  server.protectedRequest = jest.fn(async (path, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const id = path.split('?')[0].split('/')[2];
    if (method !== 'GET') server.writes.push({ method, id: id || body.id, body });
    if (method !== 'GET' && server.fail > 0) { server.fail -= 1; return reply(503, { error: { code: 'STORE_UNAVAILABLE' } }); }
    if (method === 'POST') {
      const trip = { id: body.id, title: body.title, created_at: STAMP, snapshot: body.snapshot };
      server.trips.set(trip.id, trip);
      return reply(201, { trip });
    }
    const trip = server.trips.get(id);
    if (method === 'PATCH') {
      if (!trip) return reply(404, { error: { code: 'NOT_FOUND' } });
      Object.assign(trip, body.title ? { title: body.title } : {}, body.snapshot ? { snapshot: body.snapshot } : {});
      return reply(200, { trip });
    }
    if (id) return trip ? reply(200, { trip }) : reply(404, { error: { code: 'NOT_FOUND' } });
    return reply(200, { trips: [], next_cursor: null });
  });
  return server;
}
let auth, server, map, directionsCallbacks;
beforeEach(() => {
  global.fetch = jest.fn();
  Element.prototype.scrollTo = jest.fn();
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  server = tripServer();
  auth = { status: 'authenticated', generation: 1, profile: { id: 'fixture-a' }, protectedRequest: server.protectedRequest };
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
function show(props = {}) { return render(<LocationInput auth={auth} map={map} {...props} />); }
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
const saved = () => screen.findByText('Saved as', { exact: false });
// After a save the status line settles on "Saved as"; waiting for it keeps later updates inside the test.
async function settled() {
  await waitFor(() => expect(screen.queryByText('Saving…')).not.toBeInTheDocument());
  expect(screen.getByText('Saved as', { exact: false })).toBeInTheDocument();
}
const lastWrite = () => server.writes[server.writes.length - 1];
// A lone driver's card header is plain text, not a button.
const cardName = () => screen.getByText((_, element) => element.classList?.contains('driver-card-name'));
// Google answers a directions request with one leg per stop after the first.
const directions = (...minutes) => ({ routes: [{ legs: minutes.map((value) => ({ duration: { value: value * 60 } })), overview_path: [] }] });
async function rename(button, field, text) {
  fireEvent.doubleClick(screen.getByRole('button', { name: button }));
  const input = screen.getByRole('textbox', { name: field });
  fireEvent.change(input, { target: { value: text } });
  await settle(() => fireEvent.keyDown(input, { key: 'Enter' }));
}

test('a pickup count sends individual people, and the route saves once and stays after edits', async () => {
  show(); fillTrip(); fetch.mockResolvedValue(responseFor(3)); calculate();
  await screen.findByRole('heading', {name:'Your route'});
  expect(JSON.parse(fetch.mock.calls[0][1].body).passengers).toEqual(Array(3).fill({lat:4,lng:4}));
  await saved();
  expect(server.writes).toHaveLength(1);
  const { snapshot } = server.writes[0].body;
  expect(snapshot.inputs.passengers).toHaveLength(3);
  expect(new Set(snapshot.inputs.passengers.map(p => p.stop_id)).size).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain('coordinates');
  fill('Passengers at pickup 1', '1'); fill('Pickup 1 location', 'Changed');
  expect(server.writes).toHaveLength(1);
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
  view.rerender(<LocationInput auth={{...auth,profile:{id:'fixture-b'},generation:2}} map={map}/>);
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(1);
  expect(screen.queryByText(/nickname: Home/)).not.toBeInTheDocument();
});

test('late map callback cannot replace drive times for a newer calculation', async () => {
  show(); fillTrip(2); fetch.mockResolvedValue(responseFor(2)); calculate();
  await screen.findByRole('heading',{name:'Your route'});
  await saved();
  await waitFor(() => expect(directionsCallbacks).toHaveLength(1));
  fill('Passengers at pickup 1','1'); fetch.mockResolvedValue(responseFor(1)); calculate();
  await waitFor(() => expect(directionsCallbacks).toHaveLength(2));
  await act(async () => directionsCallbacks[1](directions(1, 1),'OK'));
  await act(async () => directionsCallbacks[0](directions(10, 10, 10),'OK'));
  expect(screen.getByText(/1 of 2 seats/)).toHaveTextContent('2 min drive');
  expect(screen.queryByText(/30 min drive/)).not.toBeInTheDocument();
  await waitFor(() => expect(server.writes).toHaveLength(2));
  await settled();
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
  await saved();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.getByText('Planner cleared.')).toHaveAttribute('role', 'status');
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('');
  expect(screen.getByLabelText('Driver 1 passenger seats')).toHaveValue(4);
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(1);
  expect(screen.getByLabelText('Destination')).toHaveValue('');
  expect(screen.queryByRole('heading', { name: 'Your route' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('Origin');
  expect(screen.getByLabelText('Passengers at pickup 1')).toHaveValue(3);
  expect(screen.getByRole('heading', { name: 'Your route' })).toBeInTheDocument();
  expect(screen.getByText('Saved as', { exact: false })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  fill('Destination', 'Another destination');
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  expect(screen.queryByText('Planner cleared.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Driver 1 location')).toHaveValue('');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(server.writes).toHaveLength(1);
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
  view.rerender(<LocationInput auth={{ ...auth, profile: { id: 'fixture-b' }, generation: 2 }} map={map} />);
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  expect(screen.queryByText('Planner cleared.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Pickup 1 location')).toHaveValue('');
});

test('rows picked from My locations follow its later rename, move and deletion, but not a loading list', async () => {
  resolvePlace.mockResolvedValue({ address: 'Old home address', coordinates: { lat: 1, lng: 1 }, place_name: '',
    source: mockHome.source });
  const view = show();
  const again = () => view.rerender(<LocationInput auth={auth} map={map} />);
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

test('a saved trip keeps the nickname, place reference and saved-location link, never the landmark name', async () => {
  resolvePlace.mockResolvedValue({ address: 'Home address', coordinates: { lat: 1, lng: 1 }, place_name: 'Synthetic Landmark',
    source: mockHome.source });
  show();
  await useSaved('Driver 1 location');
  fill('Pickup 1 location', 'Pickup'); fill('Destination', 'Destination');
  fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  const snapshot = JSON.stringify(server.writes[0].body.snapshot);
  expect(server.writes[0].body.snapshot.inputs.drivers[0]).toEqual(expect.objectContaining({ label: 'Home', source: mockHome.source,
    location_id: mockHome.id }));
  expect(snapshot).not.toContain('Synthetic Landmark');
  expect(snapshot).not.toContain('saved_id');
});

test('a failed list refresh still passes on a confirmed rename, but never unlinks a row', async () => {
  resolvePlace.mockResolvedValue({ address: 'Home address', coordinates: { lat: 1, lng: 1 }, place_name: '', source: mockHome.source });
  const view = show();
  const again = () => view.rerender(<LocationInput auth={auth} map={map} />);
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
  await act(async () => { view.rerender(<LocationInput auth={auth} map={map} />); });
  await waitFor(() => expect(screen.getByLabelText('Driver 1 location')).toHaveValue('New home address'));
  expect(screen.queryByRole('heading', { name: 'Your route' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('A saved place in this route moved');
});

test('an optimizer error page that is not JSON shows a service message, not a parser error', async () => {
  show(); fillTrip(1);
  fetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token '<'"); } });
  calculate();
  expect(await screen.findByRole('alert')).toHaveTextContent('The route optimizer is unavailable. Please retry.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('Unexpected token');
});

test('a saved place that moves clears a route through it even when its new place cannot be looked up', async () => {
  resolvePlace.mockResolvedValue({ address: 'Home address', coordinates: { lat: 1, lng: 1 }, place_name: '', source: mockHome.source });
  const view = show();
  await useSaved('Driver 1 location');
  fill('Pickup 1 location', 'Pickup'); fill('Destination', 'Destination');
  fetch.mockResolvedValue(responseFor(1)); calculate();
  await screen.findByRole('heading', { name: 'Your route' });
  resolvePlace.mockRejectedValue(new Error('Places timed out'));
  mockSaved.locations = [{ ...mockHome, source: { kind: 'google_places', place_id: 'new-home' } }];
  await act(async () => { view.rerender(<LocationInput auth={auth} map={map} />); });
  expect(screen.queryByRole('heading', { name: 'Your route' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('A saved place in this route moved');
});

test('calculating saves the trip, a later calculation updates it, and Start over begins a new one', async () => {
  show(); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  expect(server.writes[0]).toMatchObject({ method: 'POST', body: { title: expect.stringMatching(/^Trip to Destination, \S/) } });
  expect(screen.getByRole('button', { name: /^Trip name: Trip to Destination/ })).toBeInTheDocument();
  calculate();
  await waitFor(() => expect(server.writes).toHaveLength(2));
  await settled();
  expect(server.writes[1]).toMatchObject({ method: 'PATCH', id: server.writes[0].id });
  expect(server.trips.size).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  fillTrip(1); calculate();
  await waitFor(() => expect(server.writes).toHaveLength(3));
  await settled();
  expect(server.writes[2].method).toBe('POST');
  expect(server.trips.size).toBe(2);
});

test('signed out, a calculated route offers sign-in and saves nothing', async () => {
  const signIn = jest.fn();
  show({ auth: { status: 'anonymous', generation: 1, signIn, signInReady: true } });
  fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in to save this trip' }));
  expect(signIn).toHaveBeenCalled();
  expect(server.protectedRequest).not.toHaveBeenCalled();
});

test('a first save that fails says so, keeps the route, and Retry saves it under the same ID', async () => {
  server.fail = 1;
  show(); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  expect(await screen.findByText('It is not in My trips yet.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Your route' })).toBeInTheDocument();
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  await saved();
  expect(server.writes.map((write) => write.method)).toEqual(['POST', 'POST']);
  expect(server.writes[1].id).toBe(server.writes[0].id);
  expect(server.trips.size).toBe(1);
});

test('names typed on the route are saved with the trip and kept through Recalculate, without new directions', async () => {
  show(); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  const requests = directionsCallbacks.length;
  await rename(/^Who is at the start: none, showing Origin/, 'Who is at the start', 'Sam');
  await waitFor(() => expect(lastWrite().body.snapshot.inputs.drivers[0].person).toBe('Sam'));
  await settled();
  expect(cardName()).toHaveTextContent('Sam from Origin');
  await rename(/^Destination name: none/, 'Destination name', 'Dinner');
  await waitFor(() => expect(lastWrite().body.snapshot.inputs.destination.label).toBe('Dinner'));
  await settled();
  expect(directionsCallbacks).toHaveLength(requests);
  const writes = server.writes.length;
  calculate();
  await waitFor(() => expect(server.writes.length).toBe(writes + 1));
  expect(lastWrite()).toMatchObject({ method: 'PATCH' });
  expect(lastWrite().body.snapshot.inputs.drivers[0].person).toBe('Sam');
  expect(lastWrite().body.snapshot.inputs.destination.label).toBe('Dinner');
  await settled();
});

test('with no map yet drive times are loading, never unavailable; Maps without directions is unavailable', async () => {
  const view = show({ map: null }); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  expect(await screen.findByText('Loading drive times…')).toBeInTheDocument();
  expect(screen.queryByText('Directions are unavailable.')).not.toBeInTheDocument();
  await settled();
  view.unmount();
  window.google = { maps: {} };
  show(); fillTrip(1); calculate();
  await saved();
  expect(await screen.findByText('Directions are unavailable.')).toBeInTheDocument();
  await settled();
});

// A saved trip whose driver was picked from My locations, which has since moved.
const TRIP_ID = '55555555-5555-4555-8555-555555555555';
const PLACES = { home: 1, 'new-home': 2, mia: 4, bcd: 9 };
function savedTrip(arriveBy) {
  const source = (place_id) => ({ kind: 'google_places', place_id });
  const snapshot = { schema_version: 1, inputs: {
    drivers: [{ stop_id: 'd1', label: 'Home', source: source('home'), location_id: mockHome.id, capacity: 2 }],
    passengers: [{ stop_id: 'p1', label: '', source: source('mia') }],
    destination: { stop_id: 'end', label: 'BCD Tofu', source: source('bcd') }, ...(arriveBy ? { arrive_by: arriveBy } : {}) },
  routes: [{ driver_id: 'd1', stop_ids: ['d1', 'p1', 'end'] }] };
  mockTrip.current = { id: TRIP_ID, title: 'Friday dinner', created_at: STAMP, snapshot };
  server.trips.set(TRIP_ID, JSON.parse(JSON.stringify(mockTrip.current)));
  mockSaved.locations = [{ ...mockHome, source: source('new-home') }];
  resolvePlace.mockImplementation(async (_, placeId) => ({ address: placeId + ' address', place_name: '',
    source: source(placeId), coordinates: { lat: PLACES[placeId], lng: PLACES[placeId] } }));
}
async function viewTrip() {
  fireEvent.click(screen.getByRole('tab', { name: 'My trips' }));
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Fixture views trip' })));
  return screen.findByRole('heading', { name: 'Friday dinner' });
}

test('a saved trip opens read-only, follows its moved location, and names the stop that moved', async () => {
  savedTrip(); show();
  await viewTrip();
  expect(screen.getByText('Home has moved.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Recalculate' })).toBeInTheDocument();
  expect(screen.getByText('Moved')).toBeInTheDocument();
  expect(screen.getByText('new-home address')).toBeInTheDocument();
  expect(server.writes).toHaveLength(0);
});

test('a name typed in a saved trip saves to it straight away, keeping the stored place and link', async () => {
  savedTrip(); show();
  await viewTrip();
  await rename(/^Who is at pickup 1/, 'Who is at pickup 1', 'Mia');
  expect(lastWrite()).toMatchObject({ method: 'PATCH', id: TRIP_ID });
  const stored = server.trips.get(TRIP_ID).snapshot.inputs;
  expect(stored.passengers[0].person).toBe('Mia');
  expect(stored.drivers[0]).toMatchObject({ location_id: mockHome.id, source: { place_id: 'home' } });
  expect(screen.getByRole('button', { name: /^Who is at pickup 1: Mia/ })).toBeInTheDocument();
});

test('a name that cannot be saved in a saved trip says so and keeps the old name', async () => {
  savedTrip(); show();
  await viewTrip();
  server.fail = 1;
  await rename(/^Who is at pickup 1/, 'Who is at pickup 1', 'Mia');
  expect(screen.getByRole('alert')).toHaveTextContent('The name was not saved. Check your connection and try again.');
  expect(screen.getByRole('button', { name: /^Who is at pickup 1: none/ })).toBeInTheDocument();
  expect(server.trips.get(TRIP_ID).snapshot.inputs.passengers[0]).not.toHaveProperty('person');
});

test('a trip open in the planner saves names from its read-only view through the planner, showing a failure there', async () => {
  savedTrip(); show();
  await viewTrip();
  fireEvent.click(screen.getByRole('button', { name: 'Edit trip' }));
  expect(await screen.findByText('Editing', { exact: false })).toHaveTextContent('Editing Friday dinner');
  await viewTrip();
  server.fail = 1;
  await rename(/^Who is at the start/, 'Who is at the start', 'Jonathan');
  expect(await screen.findByText('Your latest changes are not in My trips yet.')).toBeInTheDocument();
  expect(server.trips.get(TRIP_ID).snapshot.inputs.drivers[0]).not.toHaveProperty('person');
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  await waitFor(() => expect(server.trips.get(TRIP_ID).snapshot.inputs.drivers[0].person).toBe('Jonathan'));
  expect(server.trips.size).toBe(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Plan trip' }));
  expect(cardName()).toHaveTextContent('Jonathan from Home');
});

const pad = (number) => String(number).padStart(2, '0');
const today = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };
const setTime = (value) => settle(() => fireEvent.change(screen.getByLabelText('Arrive by time'), { target: { value } }));

test('an arrive-by set on a calculated route starts on today, saves with the trip, and survives Recalculate and Undo', async () => {
  show(); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  expect(screen.getByLabelText('Arrive by date')).toHaveValue(today());
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('');
  expect(server.writes[0].body.snapshot.inputs).not.toHaveProperty('arrive_by');
  await setTime('23:30');
  await waitFor(() => expect(lastWrite().body.snapshot.inputs.arrive_by).toBe(`${today()}T23:30`));
  await settled();
  calculate();
  await waitFor(() => expect(server.writes).toHaveLength(3));
  await settled();
  expect(lastWrite()).toMatchObject({ method: 'PATCH' });
  expect(lastWrite().body.snapshot.inputs.arrive_by).toBe(`${today()}T23:30`);
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('23:30');
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('23:30');
});

test('a saved trip shows its arrive-by, saves a new time straight away, and keeps it in the planner', async () => {
  savedTrip('2099-10-30T19:00'); show();
  await viewTrip();
  expect(screen.getByLabelText('Arrive by date')).toHaveValue('2099-10-30');
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('19:00');
  await setTime('20:15');
  expect(lastWrite()).toMatchObject({ method: 'PATCH', id: TRIP_ID });
  expect(server.trips.get(TRIP_ID).snapshot.inputs.arrive_by).toBe('2099-10-30T20:15');
  fireEvent.click(screen.getByRole('button', { name: 'Edit trip' }));
  expect(await screen.findByText('Editing', { exact: false })).toBeInTheDocument();
  expect(screen.getByLabelText('Arrive by date')).toHaveValue('2099-10-30');
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('20:15');
});

test('a saved trip without an arrive-by opens without one, in the trip view and in the planner', async () => {
  savedTrip(); show();
  await viewTrip();
  expect(screen.getByLabelText('Arrive by date')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Edit trip' }));
  expect(await screen.findByText('Editing', { exact: false })).toBeInTheDocument();
  expect(screen.getByLabelText('Arrive by date')).toHaveValue('');
  expect(server.writes).toHaveLength(0);
});

test('an arrive-by that cannot be saved in a saved trip says so and keeps the saved time', async () => {
  savedTrip('2099-10-30T19:00'); show();
  await viewTrip();
  server.fail = 1;
  await setTime('20:15');
  expect(screen.getByRole('alert')).toHaveTextContent('The time was not saved. Check your connection and try again.');
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('19:00');
  expect(server.trips.get(TRIP_ID).snapshot.inputs.arrive_by).toBe('2099-10-30T19:00');
});

const dayOf = (value) => (typeof value === 'string' ? new Date(value) : value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const setDate = (value) => settle(() => fireEvent.change(screen.getByLabelText('Arrive by date'), { target: { value } }));

test('an automatic name follows the arrive-by date and the destination, and back to the calculation day, until renamed', async () => {
  show(); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  const calculated = `Trip to Destination, ${dayOf(new Date())}`;
  expect(server.writes[0].body.title).toBe(calculated);
  await setTime('18:45');
  await settled();
  await setDate('2099-11-06');
  await waitFor(() => expect(lastWrite().body).toMatchObject({ title: `Trip to Destination, ${dayOf(new Date(2099, 10, 6))}`,
    snapshot: { inputs: { arrive_by: '2099-11-06T18:45' } } }));
  await settled();
  expect(screen.getByRole('button', { name: /^Trip name: Trip to Destination, / })).toHaveTextContent(dayOf(new Date(2099, 10, 6)));
  await rename(/^Destination name/, 'Destination name', 'BCD');
  await waitFor(() => expect(lastWrite().body.title).toBe(`Trip to BCD, ${dayOf(new Date(2099, 10, 6))}`));
  await settled();
  await setDate('');
  await waitFor(() => expect(lastWrite().body.title).toBe(`Trip to BCD, ${dayOf(new Date())}`));
  await settled();
  await rename(/^Trip name/, 'Trip name', 'Dinner');
  await settled();
  // Clearing the date cleared the time too; a time alone starts on today.
  await setTime('09:30');
  await waitFor(() => expect(lastWrite().body.snapshot?.inputs.arrive_by).toBe(`${today()}T09:30`));
  expect(lastWrite().body).not.toHaveProperty('title');
  expect(server.trips.get(server.writes[0].id).title).toBe('Dinner');
});

test('Recalculate with a new destination renames an automatic trip in the same save', async () => {
  show(); fillTrip(1); fetch.mockResolvedValue(responseFor(1)); calculate();
  await saved();
  fill('Destination', 'Elsewhere'); calculate();
  await waitFor(() => expect(server.writes).toHaveLength(2));
  await settled();
  expect(lastWrite()).toMatchObject({ method: 'PATCH', body: { title: `Trip to Elsewhere, ${dayOf(new Date())}` } });
  expect(lastWrite().body.snapshot.inputs.destination.source.place_id).toBe('Destination');
});

test('a saved trip with an automatic name follows a new arrive-by in the same save, straight from the trip view', async () => {
  savedTrip('2099-10-30T19:00');
  mockTrip.current.title = `Trip to BCD Tofu, ${dayOf(STAMP)}`;
  server.trips.get(TRIP_ID).title = mockTrip.current.title;
  show();
  fireEvent.click(screen.getByRole('tab', { name: 'My trips' }));
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Fixture views trip' })));
  await setDate('2099-11-02');
  expect(lastWrite()).toMatchObject({ method: 'PATCH', id: TRIP_ID, body: { title: `Trip to BCD Tofu, ${dayOf(new Date(2099, 10, 2))}` } });
  expect(await screen.findByRole('heading', { name: `Trip to BCD Tofu, ${dayOf(new Date(2099, 10, 2))}` })).toBeInTheDocument();
});

test('a saved trip renames in place, straight away, shows when it was last edited, and keeps its name when a save fails', async () => {
  savedTrip(); show();
  await viewTrip();
  expect(screen.getByText(/· last edited /)).toHaveTextContent(`last edited ${dayOf(STAMP)}`);
  await rename(/^Trip name: Friday dinner/, 'Trip name', 'Dinner at BCD');
  expect(lastWrite()).toEqual({ method: 'PATCH', id: TRIP_ID, body: { title: 'Dinner at BCD' } });
  expect(screen.getByRole('heading', { name: 'Dinner at BCD' })).toBeInTheDocument();
  server.fail = 1;
  await rename(/^Trip name: Dinner at BCD/, 'Trip name', 'Dinner again');
  expect(screen.getByRole('alert')).toHaveTextContent('The name was not saved. Check your connection and try again.');
  expect(screen.getByRole('heading', { name: 'Dinner at BCD' })).toBeInTheDocument();
  expect(server.trips.get(TRIP_ID).title).toBe('Dinner at BCD');
});

test('renaming a trip the planner holds goes through its saves and shows in Editing and Saved as', async () => {
  savedTrip(); show();
  await viewTrip();
  fireEvent.click(screen.getByRole('button', { name: 'Edit trip' }));
  await screen.findByText('Editing', { exact: false });
  await viewTrip();
  await rename(/^Trip name: Friday dinner/, 'Trip name', 'Dinner at BCD');
  await waitFor(() => expect(server.trips.get(TRIP_ID).title).toBe('Dinner at BCD'));
  fireEvent.click(screen.getByRole('tab', { name: 'Plan trip' }));
  expect(screen.getByText('Editing', { exact: false })).toHaveTextContent('Editing Dinner at BCD');
  expect(screen.getByRole('button', { name: /^Trip name: Dinner at BCD/ })).toBeInTheDocument();
});

test('Edit a copy saves a copy with the same route, names and arrive-by, then edits only the copy', async () => {
  savedTrip('2099-10-30T19:00');
  mockTrip.current.snapshot.inputs.passengers[0].person = 'Mia';
  server.trips.get(TRIP_ID).snapshot.inputs.passengers[0].person = 'Mia';
  show();
  await viewTrip();
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' })));
  expect(await screen.findByText('Editing', { exact: false })).toHaveTextContent('Editing Copy of Friday dinner');
  const copy = server.writes[0];
  expect(copy).toMatchObject({ method: 'POST', body: { title: 'Copy of Friday dinner', snapshot: mockTrip.current.snapshot } });
  await setTime('20:15');
  await waitFor(() => expect(lastWrite()).toMatchObject({ method: 'PATCH', id: copy.id }));
  expect(lastWrite().body).not.toHaveProperty('title');
  expect(server.trips.get(TRIP_ID)).toEqual(mockTrip.current);
  expect(server.trips.get(copy.id).snapshot.inputs.arrive_by).toBe('2099-10-30T20:15');
});

test('a copy that cannot be saved says so, stays in the trip view, and a retry never makes two', async () => {
  savedTrip(); show();
  await viewTrip();
  server.fail = 1;
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' })));
  expect(screen.getByRole('alert')).toHaveTextContent('The copy was not saved. Check your connection and try again.');
  expect(screen.getByRole('heading', { name: 'Friday dinner' })).toBeInTheDocument();
  expect(server.trips.size).toBe(1);
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' })));
  expect(await screen.findByText('Editing', { exact: false })).toHaveTextContent('Editing Copy of Friday dinner');
  expect(server.writes.map((write) => write.id)).toEqual([server.writes[0].id, server.writes[0].id]);
  expect(server.trips.size).toBe(2);
});
