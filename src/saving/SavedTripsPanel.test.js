import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SavedTripsPanel, { canonicalSnapshot, readTrip } from './SavedTripsPanel';
import createTripWriter from './tripWriter';

beforeAll(() => {
  global.TextEncoder = TextEncoder;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
});
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-06T12:00:00Z';
const point = stop_id => ({ stop_id, label: '', source: { kind: 'google_places', place_id: stop_id } });
const snapshot = () => ({ schema_version: 1, inputs: { drivers: [{ ...point('driver'), capacity: 2 }], passengers: [point('pickup')], destination: point('end') }, routes: [{ driver_id: 'driver', stop_ids: ['driver', 'pickup', 'end'] }] });
const summary = (id = ID, title = 'Team trip') => ({ id, title, created_at: stamp, schema_version: 1, driver_count: 1, passenger_count: 1 });
const detail = (id = ID, title = 'Team trip', saved = snapshot()) => ({ trip: { id, title, created_at: stamp, snapshot: saved } });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const empty = () => response({ trips: [], next_cursor: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const authFor = (protectedRequest = jest.fn(async () => empty()), id = 'google:a', generation = 1) => ({ status: 'authenticated', profile: { id }, generation, protectedRequest });
async function renderPanel(auth, props = {}) {
  // Renames go through the account's trip writer, as in the app.
  const view = render(<SavedTripsPanel auth={auth} writer={createTripWriter(() => auth)} onView={jest.fn()} {...props} />);
  await waitFor(() => expect(screen.queryByText('Loading saved trips…')).not.toBeInTheDocument());
  return view;
}
// fireEvent's synchronous act does not flush requestJSON's awaited transport/JSON updates.
// Removing this async boundary causes timing failures and unwrapped update warnings.
// eslint-disable-next-line testing-library/no-unnecessary-act
async function click(name) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
// Keyboard and blur commits start async chains; async act settles them like clicks.
async function settle(fire) { await act(async () => { fire(); }); }


const LOCATION = '33333333-3333-4333-8333-333333333333';
const listed = (...rows) => response({ trips: rows.length ? rows : [summary()], next_cursor: null });

it('opens a trip read-only with validated detail and the revision token captured before the request', async () => {
  const pending = deferred(); const events = [];
  const transport = jest.fn(path => {
    if (path === '/saved-trips?limit=20') return Promise.resolve(listed());
    events.push('request'); return pending.promise;
  });
  const begin = jest.fn(() => { events.push('begin'); return 'revision-at-click'; });
  const view = jest.fn(async () => {}); const end = jest.fn();
  await renderPanel(authFor(transport), { onBeginLoad: begin, onView: view, onEndLoad: end });
  fireEvent.click(screen.getByRole('button', { name: 'Open Team trip' }));
  expect(screen.getByRole('button', { name: 'Open Team trip' })).toHaveTextContent('Opening…');
  expect(events).toEqual(['begin', 'request']); expect(view).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(response(detail())); });
  expect(view).toHaveBeenCalledWith({ id: ID, title: 'Team trip', created_at: stamp, snapshot: snapshot() }, 'revision-at-click');
  expect(end).toHaveBeenCalledWith('revision-at-click');
});
it('a trip view that cannot resolve its places reports it and leaves the list usable', async () => {
  const transport = jest.fn(async path => path === '/saved-trips?limit=20' ? listed() : response(detail()));
  await renderPanel(authFor(transport), { onView: jest.fn(async () => { throw new Error('Places timed out'); }) });
  await click('Open Team trip');
  expect(screen.getByRole('alert')).toHaveTextContent('This trip could not be loaded');
  expect(screen.getByRole('button', { name: 'Open Team trip' })).toBeEnabled();
});
it.each(['wrong-id', 'coordinates', 'duplicate-pickup', 'bad-date', 'bad-location-id', 'destination-person', 'long-person',
  'bad-arrive-by', 'arrive-by-on-a-stop'])(
  'never opens invalid detail %s', async kind => {
    const body = detail();
    const saved = body.trip.snapshot;
    if (kind === 'wrong-id') body.trip.id = OTHER_ID;
    if (kind === 'coordinates') saved.inputs.passengers[0].coordinates = { lat: 1, lng: 2 };
    if (kind === 'duplicate-pickup') saved.routes[0].stop_ids.splice(1, 0, 'pickup');
    if (kind === 'bad-date') body.trip.created_at = 'not-a-date';
    if (kind === 'bad-location-id') saved.inputs.passengers[0].location_id = 'saved-home';
    if (kind === 'destination-person') saved.inputs.destination.person = 'Sam';
    if (kind === 'long-person') saved.inputs.drivers[0].person = 'x'.repeat(81);
    if (kind === 'bad-arrive-by') saved.inputs.arrive_by = '2026-02-30T10:00';
    if (kind === 'arrive-by-on-a-stop') saved.inputs.drivers[0].arrive_by = '2026-10-30T19:00';
    const transport = jest.fn(async path => path === '/saved-trips?limit=20' ? listed() : response(body));
    const view = jest.fn(); await renderPanel(authFor(transport), { onView: view }); await click('Open Team trip');
    expect(view).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  });
it.each(['id\u0085', 'id\u001c', 'id​', 'bad id'])('never opens a trip whose place reference %s has control or whitespace', async place_id => {
  const body = detail(); body.trip.snapshot.inputs.passengers[0].source.place_id = place_id;
  const transport = jest.fn(async path => path === '/saved-trips?limit=20' ? listed() : response(body));
  const view = jest.fn(); await renderPanel(authFor(transport), { onView: view }); await click('Open Team trip');
  expect(view).not.toHaveBeenCalled();
});
it('accepts saved-location links and person names on stops, and nothing else new', () => {
  const linked = snapshot();
  linked.inputs.drivers[0] = { ...linked.inputs.drivers[0], location_id: LOCATION, person: 'Sam' };
  linked.inputs.passengers[0].person = 'Mia and Alex';
  linked.inputs.destination.location_id = LOCATION;
  expect(canonicalSnapshot(linked)).toEqual(linked);
  const extra = snapshot(); extra.inputs.drivers[0].name = 'Sam';
  expect(() => canonicalSnapshot(extra)).toThrow();
  const composed = snapshot(); composed.inputs.drivers[0].person = ' Zoë ';
  expect(canonicalSnapshot(composed).inputs.drivers[0].person).toBe('Zoë');
});
it('requires confirmation before deletion and removes only a confirmed 204', async () => {
  const transport = jest.fn(async (path, options) => options.method === 'DELETE' ? response(null, 204) : listed());
  await renderPanel(authFor(transport)); await click('Delete Team trip');
  expect(transport.mock.calls.filter(([, options]) => options.method === 'DELETE')).toHaveLength(0);
  await click('Keep trip'); expect(screen.getByText('Team trip')).toBeVisible();
  await click('Delete Team trip'); await click('Confirm delete Team trip');
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument(); expect(screen.getByText('Trip deleted.')).toBeVisible();
});
it('retains a record when delete acknowledgement is invalid', async () => {
  const transport = jest.fn(async (path, options) => options.method === 'DELETE' ? response({ unexpected: true }) : listed());
  await renderPanel(authFor(transport)); await click('Delete Team trip'); await click('Confirm delete Team trip');
  expect(screen.getByText('Team trip')).toBeVisible(); expect(screen.getByRole('alert')).toHaveTextContent('Deletion could not be confirmed');
});
it('deduplicates overlapping list pages and rejects a repeated pagination cursor', async () => {
  const transport = jest.fn().mockResolvedValueOnce(response({ trips: [summary()], next_cursor: 'page-2' }))
    .mockResolvedValueOnce(response({ trips: [summary(), summary(OTHER_ID, 'Second trip')], next_cursor: 'page-3' }))
    .mockResolvedValueOnce(response({ trips: [], next_cursor: 'page-3' }));
  await renderPanel(authFor(transport)); await click('Load more trips');
  expect(screen.getAllByText('Team trip')).toHaveLength(1); expect(screen.getByText('Second trip')).toBeVisible();
  expect(transport.mock.calls[1][0]).toBe('/saved-trips?limit=20&cursor=page-2');
  await click('Load more trips'); expect(screen.getByRole('alert')).toHaveTextContent('My Trips could not be loaded');
  expect(screen.getByText('Second trip')).toBeVisible();
});
it('rejects duplicate IDs within a server page', async () => {
  const transport = jest.fn(async () => response({ trips: [summary(), summary()], next_cursor: null }));
  await renderPanel(authFor(transport));
  expect(screen.getByRole('alert')).toHaveTextContent('My Trips could not be loaded');
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('hides prior-owner labels immediately and ignores the old owner list response', async () => {
  const pending = deferred(); const oldTransport = jest.fn(() => pending.promise);
  const a = authFor(oldTransport); const b = authFor(jest.fn(async () => listed(summary(OTHER_ID, 'Account B trip'))), 'google:b', 2);
  const view = render(<SavedTripsPanel auth={a} onView={jest.fn()} />);
  const signal = oldTransport.mock.calls[0][1].signal;
  view.rerender(<SavedTripsPanel auth={b} onView={jest.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(listed()); });
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument(); expect(screen.getByText('Account B trip')).toBeVisible();
});
it.each(['owner-change', 'unmount'])('aborts a stale open on %s while completing parent token cleanup', async kind => {
  const pending = deferred();
  const transport = jest.fn(path => path === '/saved-trips?limit=20' ? Promise.resolve(listed()) : pending.promise);
  const onView = jest.fn(); const end = jest.fn(); const begin = jest.fn(() => 'captured');
  const view = await renderPanel(authFor(transport), { onView, onBeginLoad: begin, onEndLoad: end });
  fireEvent.click(screen.getByRole('button', { name: 'Open Team trip' }));
  const signal = transport.mock.calls[1][1].signal;
  if (kind === 'unmount') view.unmount();
  else view.rerender(<SavedTripsPanel auth={authFor(undefined, 'google:b', 2)} onView={onView} onEndLoad={end} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response(detail())); });
  expect(onView).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledWith('captured');
});
it.each(['owner-change', 'unmount'])('never reports a stale deletion after %s', async kind => {
  const pending = deferred();
  const transport = jest.fn((path, options) => options.method === 'DELETE' ? pending.promise : Promise.resolve(listed()));
  const view = await renderPanel(authFor(transport));
  await click('Delete Team trip'); fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Team trip' }));
  const signal = transport.mock.calls.find(([, options]) => options.method === 'DELETE')[1].signal;
  if (kind === 'unmount') view.unmount();
  else view.rerender(<SavedTripsPanel auth={authFor(undefined, 'google:b', 2)} onView={jest.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response(null, 204)); });
  expect(screen.queryByText('Trip deleted.')).not.toBeInTheDocument();
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('a trip saved elsewhere marks the list stale, and it is fetched again only once My trips is shown', async () => {
  const transport = jest.fn(async () => listed());
  const auth = authFor(transport);
  const view = await renderPanel(auth, { activeView: 'plan' });
  expect(transport).not.toHaveBeenCalled();
  view.rerender(<SavedTripsPanel auth={auth} onView={jest.fn()} activeView="trips" />);
  expect(await screen.findByText('Team trip')).toBeVisible();
  expect(transport).toHaveBeenCalledTimes(1);
  view.rerender(<SavedTripsPanel auth={auth} onView={jest.fn()} activeView="plan" listVersion={1} />);
  expect(transport).toHaveBeenCalledTimes(1);
  transport.mockImplementation(async () => listed(summary(), summary(OTHER_ID, 'Trip to BCD Tofu, Oct 29')));
  view.rerender(<SavedTripsPanel auth={auth} onView={jest.fn()} activeView="trips" listVersion={1} />);
  expect(await screen.findByText('Trip to BCD Tofu, Oct 29')).toBeVisible();
  expect(transport).toHaveBeenCalledTimes(2);
});
it('an open trip view takes the place of the list until it is closed', async () => {
  const auth = authFor(jest.fn(async () => listed()));
  const view = await renderPanel(auth, { activeView: 'trips' });
  view.rerender(<SavedTripsPanel auth={auth} onView={jest.fn()} activeView="trips" viewing><p>Trip view</p></SavedTripsPanel>);
  expect(screen.getByText('Trip view')).toBeVisible();
  expect(screen.queryByRole('heading', { name: /My trips/ })).not.toBeInTheDocument();
  view.rerender(<SavedTripsPanel auth={auth} onView={jest.fn()} activeView="trips" />);
  expect(screen.getByText('Team trip')).toBeVisible();
});
it('an empty list says trips save themselves when a route is calculated', async () => {
  await renderPanel(authFor());
  expect(screen.getByText('No saved trips yet. Calculate a route while signed in and it is saved here.')).toBeVisible();
});
it('a late refresh cannot resurrect a confirmed deleted record', async () => {
  const pending = deferred(); let lists = 0;
  const transport = jest.fn((path, options) => {
    if (options.method === 'DELETE') return Promise.resolve(response(null, 204));
    lists += 1;
    return lists === 1 ? Promise.resolve(listed()) : pending.promise;
  });
  await renderPanel(authFor(transport));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await click('Delete Team trip'); await click('Confirm delete Team trip');
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
  await act(async () => { pending.resolve(listed()); });
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('same owner with a new authentication generation cannot receive prior-generation work', async () => {
  const pending = deferred(); const transport = jest.fn(() => pending.promise);
  const view = render(<SavedTripsPanel auth={authFor(transport)} onView={jest.fn()} />);
  const signal = transport.mock.calls[0][1].signal;
  view.rerender(<SavedTripsPanel auth={authFor(undefined, 'google:a', 2)} onView={jest.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(listed()); });
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('My trips rows show an editable title, a count and date line, Open, and a delete icon', async () => {
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'PATCH') return response(detail(ID, JSON.parse(options.body).title));
    return listed(summary(), { ...summary(OTHER_ID, 'Big trip'), driver_count: 2, passenger_count: 5 });
  });
  const onOpened = jest.fn();
  await renderPanel(authFor(transport), { openedTrip: { id: ID, title: 'Team trip', opened: true }, onOpened });
  expect(screen.getByText(/^1 driver · 1 passenger · \S/)).toBeVisible();
  expect(screen.getByText(/^2 drivers · 5 passengers · \S/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Open Big trip' })).toHaveTextContent(/^Open$/);
  expect(screen.getByRole('button', { name: 'Delete Big trip' })).toBeVisible();
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Name of trip Team trip/ }));
  const editor = screen.getByRole('textbox', { name: 'Name of trip Team trip' });
  fireEvent.change(editor, { target: { value: ' Renamed trip ' } });
  await settle(() => fireEvent.keyDown(editor, { key: 'Enter' }));
  const patches = transport.mock.calls.filter(([, options]) => options.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(patches[0][0]).toBe(`/saved-trips/${ID}`);
  expect(JSON.parse(patches[0][1].body)).toEqual({ title: 'Renamed trip' });
  expect(screen.getByRole('button', { name: /^Name of trip Renamed trip/ })).toBeVisible();
  expect(screen.getByText('Renamed to “Renamed trip”.')).toBeVisible();
  // The planner editing this trip keeps editing it, under its new name.
  expect(onOpened).toHaveBeenCalledWith({ id: ID, title: 'Renamed trip', opened: true });
});
it('Refresh reloads My trips quietly while rows are shown; loading text appears only for an empty list', async () => {
  const first = deferred(), later = deferred();
  const transport = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(later.promise);
  render(<SavedTripsPanel auth={authFor(transport)} onView={jest.fn()} />);
  expect(screen.getByText('Loading saved trips…')).toBeVisible();
  await act(async () => { first.resolve(listed()); });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  expect(screen.queryByText('Loading saved trips…')).not.toBeInTheDocument();
  expect(screen.getByText('Team trip')).toBeVisible();
  await act(async () => { later.resolve(listed(summary(), summary(OTHER_ID, 'Second trip'))); });
  expect(screen.getByText('Second trip')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'My trips (2)' })).toBeVisible();
});

// The real protectedRequest rejects an aborted request with AbortError, as this transport does.
const abortable = (method) => jest.fn((path, options) => options.method === method
  ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Authentication changed.', 'AbortError'))))
  : Promise.resolve(listed()));

test('a rename interrupted by an owner change shows no failure to the next owner', async () => {
  const transport = abortable('PATCH');
  const view = await renderPanel(authFor(transport));
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Name of trip Team trip/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name of trip Team trip' }), { target: { value: 'Renamed trip' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name of trip Team trip' }), { key: 'Enter' });
  expect(transport.mock.calls.some(([, options]) => options.method === 'PATCH')).toBe(true);
  view.rerender(<SavedTripsPanel auth={authFor(jest.fn(async () => empty()), 'google:b', 2)} onView={jest.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('deleting the trip the planner is editing stops the planner editing it', async () => {
  const transport = jest.fn(async (path, options) => options.method === 'DELETE' ? response(null, 204) : listed());
  const onOpened = jest.fn();
  await renderPanel(authFor(transport), { openedTrip: { id: ID, title: 'Team trip', opened: true }, onOpened });
  await click('Delete Team trip'); await click('Confirm delete Team trip');
  expect(onOpened).toHaveBeenLastCalledWith(null);
});

test('a rename that lands after another trip opened leaves the newly opened trip alone', async () => {
  const rename = deferred();
  const transport = jest.fn(async (path, options) => {
    if (path === '/saved-trips?limit=20') return listed(summary(), summary(OTHER_ID, 'Other trip'));
    if (options.method === 'PATCH') return rename.promise;
    return response(path.endsWith(OTHER_ID) ? detail(OTHER_ID, 'Other trip') : detail());
  });
  const auth = authFor(transport), onOpened = jest.fn();
  const view = await renderPanel(auth, { onOpened, openedTrip: { id: ID, title: 'Team trip', opened: true } });
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Name of trip Team trip/ }));
  const editor = screen.getByRole('textbox', { name: 'Name of trip Team trip' });
  fireEvent.change(editor, { target: { value: 'New name' } });
  fireEvent.keyDown(editor, { key: 'Enter' });
  view.rerender(<SavedTripsPanel auth={auth} onView={jest.fn()} onOpened={onOpened} openedTrip={{ id: OTHER_ID, title: 'Other trip', opened: true }} />);
  await act(async () => { rename.resolve(response(detail(ID, 'New name'))); });
  expect(onOpened).not.toHaveBeenCalled();
});

it('a trip with an arrive-by is listed by that full date; others by their last edit, or their save before edits were dated', async () => {
  const timed = { ...summary(OTHER_ID, 'Friday dinner'), arrive_by: '2026-10-30T19:00', updated_at: '2026-10-20T12:00:00Z' };
  const edited = { ...summary(LOCATION, 'Beach day'), updated_at: '2026-10-20T12:00:00Z' };
  await renderPanel(authFor(jest.fn(async () => listed(summary(), timed, edited))));
  const full = new Date(2026, 9, 30).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const day = (value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  expect(screen.getByText(`1 driver · 1 passenger · arrive ${full}`)).toBeVisible();
  expect(screen.getByText(`1 driver · 1 passenger · last edited ${day('2026-10-20T12:00:00Z')}`)).toBeVisible();
  expect(screen.getByText(`1 driver · 1 passenger · last edited ${day(stamp)}`)).toBeVisible();
});
it.each([null, '', '2026-10-06 12:00:00Z', '2026-10-05T12:00:00Z', 3])('never lists or opens a trip whose last edit %s is malformed or before its save', async (bad) => {
  await renderPanel(authFor(jest.fn(async () => listed({ ...summary(), updated_at: bad }))));
  expect(screen.getByRole('alert')).toHaveTextContent('My Trips could not be loaded');
  expect(() => readTrip({ trip: { ...detail().trip, updated_at: bad } }, ID)).toThrow('Invalid saved trip response.');
});
it('reads a trip with or without its last edit time', () => {
  expect(readTrip(detail(), ID)).not.toHaveProperty('updated_at');
  expect(readTrip({ trip: { ...detail().trip, updated_at: stamp } }, ID).updated_at).toBe(stamp);
  expect(() => readTrip({ trip: { ...detail().trip, edited_at: stamp } }, ID)).toThrow();
});
it.each([null, '', '2026-02-30T10:00', 3])('never lists a trip summary with a malformed arrive-by %s', async (bad) => {
  await renderPanel(authFor(jest.fn(async () => listed({ ...summary(), arrive_by: bad }))));
  expect(screen.getByRole('alert')).toHaveTextContent('My Trips could not be loaded');
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('opens a trip whose snapshot carries an arrive-by', async () => {
  const body = detail(); body.trip.snapshot.inputs.arrive_by = '2026-10-30T19:00';
  const onView = jest.fn(async () => {});
  await renderPanel(authFor(jest.fn(async path => path === '/saved-trips?limit=20' ? listed() : response(body))), { onView });
  await click('Open Team trip');
  expect(onView.mock.calls[0][0].snapshot.inputs.arrive_by).toBe('2026-10-30T19:00');
});
