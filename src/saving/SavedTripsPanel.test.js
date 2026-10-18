import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SavedTripsPanel from './SavedTripsPanel';

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
  const view = render(<SavedTripsPanel auth={auth} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} {...props} />);
  await waitFor(() => expect(screen.queryByText('Loading saved trips…')).not.toBeInTheDocument());
  return view;
}
// The route name and save buttons sit behind the Save this route (or Save changes) disclosure.
const saveToggle = () => screen.getByRole('button', { name: /^(Save this route|Save changes)/ });
const openSave = () => { if (saveToggle().getAttribute('aria-expanded') !== 'true') fireEvent.click(saveToggle()); };
const nameRoute = name => { openSave(); fireEvent.change(screen.getByRole('textbox', { name: 'Route name' }), { target: { value: name } }); };
// fireEvent's synchronous act does not flush requestJSON's awaited transport/JSON updates.
// Removing this async boundary causes 12 timing failures and unwrapped update warnings.
// eslint-disable-next-line testing-library/no-unnecessary-act
async function click(name) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
// Keyboard and blur commits start async chains; async act settles them like clicks.
async function settle(fire) { await act(async () => { fire(); }); }

it('saves a source-only snapshot once and refreshes its list after confirmation', async () => {
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'POST') return response(detail(JSON.parse(options.body).id, 'Team trip', JSON.parse(options.body).snapshot), 201);
    return empty();
  });
  await renderPanel(authFor(transport)); nameRoute(' Team trip '); await click('Save route');
  expect(screen.getByText('Route saved. Find it in My trips.')).toBeVisible();
  expect(saveToggle()).toHaveAttribute('aria-expanded', 'false');
  openSave();
  expect(screen.getByRole('button', { name: 'Route saved' })).toBeDisabled();
  const posts = transport.mock.calls.filter(([, options]) => options.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0][1].body)).toMatchObject({ title: 'Team trip', snapshot: snapshot() });
  expect(posts[0][1].body).not.toMatch(/coordinates|address|count|occurrenceIds/);
  expect(transport.mock.calls.filter(([path]) => path === '/saved-trips?limit=20')).toHaveLength(2);
});
it('keeps an ambiguous write frozen across route changes and reconciles the same ID without reposting', async () => {
  let attempt;
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'POST') { attempt = JSON.parse(options.body); throw new Error('Response lost after commit'); }
    if (path === '/saved-trips?limit=20') return empty();
    return response(detail(attempt.id, attempt.title, attempt.snapshot));
  });
  const auth = authFor(transport); const view = await renderPanel(auth);
  nameRoute('Original route'); await click('Save route');
  expect(screen.getByRole('alert')).toHaveTextContent('Save status is unknown');
  expect(screen.getByRole('textbox', { name: 'Route name' })).toBeDisabled();
  const changed = snapshot(); changed.inputs.passengers[0].label = 'Form changed';
  view.rerender(<SavedTripsPanel auth={auth} snapshot={changed} routeAvailable onLoad={jest.fn()} />);
  await click('Check and retry save');
  expect(transport.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  expect(transport.mock.calls.some(([path]) => path === `/saved-trips/${attempt.id}`)).toBe(true);
  expect(attempt.snapshot.inputs.passengers[0].label).toBe('');
  expect(screen.getByText('Route saved. Find it in My trips.')).toBeVisible();
});
it('reposts the exact same intent after a reconciliation 404', async () => {
  const bodies = [];
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'POST') {
      bodies.push(options.body); if (bodies.length === 1) throw new Error('Network lost');
      const body = JSON.parse(options.body); return response(detail(body.id, body.title, body.snapshot));
    }
    if (path === '/saved-trips?limit=20') return empty();
    return response({ error: { code: 'NOT_FOUND' } }, 404);
  });
  await renderPanel(authFor(transport)); nameRoute('Team trip'); await click('Save route'); await click('Check and retry save');
  expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
  openSave(); expect(screen.getByRole('button', { name: 'Route saved' })).toBeDisabled();
});
it('rejects a reconciliation response containing another intent and allows a new save', async () => {
  let attempt;
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'POST') { attempt = JSON.parse(options.body); throw new Error('Unknown'); }
    if (path === '/saved-trips?limit=20') return empty();
    return response(detail(attempt.id, 'Different content', attempt.snapshot));
  });
  await renderPanel(authFor(transport)); nameRoute('Team trip'); await click('Save route'); await click('Check and retry save');
  expect(screen.getByRole('alert')).toHaveTextContent('conflicts with an existing trip');
  expect(screen.getByRole('textbox', { name: 'Route name' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Save route' })).toBeEnabled();
});
it('locks duplicate clicks while an in-flight write is unresolved', async () => {
  const pending = deferred();
  const transport = jest.fn((path, options) => options.method === 'POST' ? pending.promise : Promise.resolve(empty()));
  await renderPanel(authFor(transport)); nameRoute('Team trip');
  fireEvent.click(screen.getByRole('button', { name: 'Save route' }));
  fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
  expect(transport.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  const body = JSON.parse(transport.mock.calls.find(([, options]) => options.method === 'POST')[1].body);
  await act(async () => { pending.resolve(response(detail(body.id, body.title, body.snapshot))); });
});
it('loads only validated detail with the revision token captured before the network request', async () => {
  const pending = deferred(); const events = [];
  const transport = jest.fn(path => {
    if (path === '/saved-trips?limit=20') return Promise.resolve(response({ trips: [summary()], next_cursor: null }));
    events.push('request'); return pending.promise;
  });
  const begin = jest.fn(() => { events.push('begin'); return 'revision-at-click'; });
  const load = jest.fn(); const end = jest.fn();
  await renderPanel(authFor(transport), { onBeginLoad: begin, onLoad: load, onEndLoad: end });
  fireEvent.click(screen.getByRole('button', { name: 'Open Team trip' }));
  expect(events).toEqual(['begin', 'request']); expect(load).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(response(detail())); });
  expect(load).toHaveBeenCalledWith(snapshot(), 'revision-at-click');
  expect(end).toHaveBeenCalledWith('revision-at-click');
  expect(screen.getByText('Trip loaded with fresh place details.')).toBeVisible();
});
it.each(['wrong-id', 'coordinates', 'duplicate-pickup', 'bad-date'])('never applies invalid detail %s', async kind => {
  const body = detail();
  if (kind === 'wrong-id') body.trip.id = OTHER_ID;
  if (kind === 'coordinates') body.trip.snapshot.inputs.passengers[0].coordinates = { lat: 1, lng: 2 };
  if (kind === 'duplicate-pickup') body.trip.snapshot.routes[0].stop_ids.splice(1, 0, 'pickup');
  if (kind === 'bad-date') body.trip.created_at = 'not-a-date';
  const transport = jest.fn(async path => path === '/saved-trips?limit=20' ? response({ trips: [summary()], next_cursor: null }) : response(body));
  const load = jest.fn(); await renderPanel(authFor(transport), { onLoad: load }); await click('Open Team trip');
  expect(load).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
});
it('requires confirmation before deletion and removes only a confirmed 204', async () => {
  const transport = jest.fn(async (path, options) => options.method === 'DELETE' ? response(null, 204) : response({ trips: [summary()], next_cursor: null }));
  await renderPanel(authFor(transport)); await click('Delete Team trip');
  expect(transport.mock.calls.filter(([, options]) => options.method === 'DELETE')).toHaveLength(0);
  await click('Keep trip'); expect(screen.getByText('Team trip')).toBeVisible();
  await click('Delete Team trip'); await click('Confirm delete Team trip');
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument(); expect(screen.getByText('Trip deleted.')).toBeVisible();
});
it('retains a record when delete acknowledgement is invalid', async () => {
  const transport = jest.fn(async (path, options) => options.method === 'DELETE' ? response({ unexpected: true }) : response({ trips: [summary()], next_cursor: null }));
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
  const a = authFor(oldTransport); const b = authFor(jest.fn(async () => response({ trips: [summary(OTHER_ID, 'Account B trip')], next_cursor: null })), 'google:b', 2);
  const view = render(<SavedTripsPanel auth={a} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} />);
  const signal = oldTransport.mock.calls[0][1].signal;
  view.rerender(<SavedTripsPanel auth={b} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ trips: [summary()], next_cursor: null })); });
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument(); expect(screen.getByText('Account B trip')).toBeVisible();
});
it.each(['owner-change', 'unmount'])('aborts stale load on %s while completing parent token cleanup', async kind => {
  const pending = deferred();
  const transport = jest.fn(path => path === '/saved-trips?limit=20' ? Promise.resolve(response({ trips: [summary()], next_cursor: null })) : pending.promise);
  const load = jest.fn(); const end = jest.fn(); const begin = jest.fn(() => 'captured');
  const view = await renderPanel(authFor(transport), { onLoad: load, onBeginLoad: begin, onEndLoad: end });
  fireEvent.click(screen.getByRole('button', { name: 'Open Team trip' }));
  const signal = transport.mock.calls[1][1].signal;
  if (kind === 'unmount') view.unmount();
  else view.rerender(<SavedTripsPanel auth={authFor(undefined, 'google:b', 2)} onLoad={load} onEndLoad={end} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response(detail())); });
  expect(load).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledWith('captured');
});
it('aborts an unresolved save on owner change and never reconciles it under the new owner', async () => {
  const pending = deferred();
  const transport = jest.fn((path, options) => options.method === 'POST' ? pending.promise : Promise.resolve(empty()));
  const view = await renderPanel(authFor(transport)); nameRoute('Private A route');
  fireEvent.click(screen.getByRole('button', { name: 'Save route' }));
  const post = transport.mock.calls.find(([, options]) => options.method === 'POST');
  const body = JSON.parse(post[1].body); const bTransport = jest.fn(async () => empty());
  view.rerender(<SavedTripsPanel auth={authFor(bTransport, 'google:b', 2)} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} />);
  expect(post[1].signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response(detail(body.id, body.title, body.snapshot))); });
  expect(screen.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
  expect(screen.queryByText('Route saved. Find it in My trips.')).not.toBeInTheDocument();
  expect(bTransport.mock.calls.every(([path]) => path === '/saved-trips?limit=20')).toBe(true);
});

it.each(['id\u0085', 'id\u001c', 'id\u200b', 'bad id'])('rejects control or whitespace in a place reference %s before POST', async place_id => {
  const invalid = snapshot(); invalid.inputs.passengers[0].source.place_id = place_id;
  const transport = jest.fn(async () => empty());
  await renderPanel(authFor(transport), { snapshot: invalid }); nameRoute('Team trip'); await click('Save route');
  expect(screen.getByRole('alert')).toHaveTextContent('select Google places');
  expect(transport.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
});

it.each(['owner-change', 'unmount'])('never reports a stale deletion after %s', async kind => {
  const pending = deferred();
  const transport = jest.fn((path, options) => options.method === 'DELETE' ? pending.promise : Promise.resolve(response({ trips: [summary()], next_cursor: null })));
  const view = await renderPanel(authFor(transport));
  await click('Delete Team trip'); fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Team trip' }));
  const signal = transport.mock.calls.find(([, options]) => options.method === 'DELETE')[1].signal;
  if (kind === 'unmount') view.unmount();
  else view.rerender(<SavedTripsPanel auth={authFor(undefined, 'google:b', 2)} routeAvailable snapshot={snapshot()} onLoad={jest.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response(null, 204)); });
  expect(screen.queryByText('Trip deleted.')).not.toBeInTheDocument();
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('abort on unmount prevents an unresolved save from triggering a list refresh', async () => {
  const pending = deferred();
  const transport = jest.fn((path, options) => options.method === 'POST' ? pending.promise : Promise.resolve(empty()));
  const view = await renderPanel(authFor(transport)); nameRoute('Team trip');
  fireEvent.click(screen.getByRole('button', { name: 'Save route' }));
  const post = transport.mock.calls.find(([, options]) => options.method === 'POST');
  const body = JSON.parse(post[1].body); view.unmount();
  expect(post[1].signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response(detail(body.id, body.title, body.snapshot))); });
  expect(transport).toHaveBeenCalledTimes(2);
});
it('saving in Plan defers list refresh until My trips is visited', async () => {
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); return response(detail(body.id, body.title, body.snapshot)); }
    return response({ trips: [summary()], next_cursor: null });
  });
  const auth = authFor(transport);
  const view = await renderPanel(auth, { activeView: 'plan' });
  expect(transport).not.toHaveBeenCalled(); nameRoute('Team trip'); await click('Save route');
  expect(transport).toHaveBeenCalledTimes(1);
  view.rerender(<SavedTripsPanel auth={auth} activeView="trips" routeAvailable snapshot={snapshot()} onLoad={jest.fn()} />);
  expect(await screen.findByText('Team trip')).toBeVisible();
  expect(transport.mock.calls[1][0]).toBe('/saved-trips?limit=20');
});
it('a late refresh cannot resurrect a confirmed deleted record', async () => {
  const pending = deferred(); let lists = 0;
  const transport = jest.fn((path, options) => {
    if (options.method === 'DELETE') return Promise.resolve(response(null, 204));
    lists += 1;
    return lists === 1 ? Promise.resolve(response({ trips: [summary()], next_cursor: null })) : pending.promise;
  });
  await renderPanel(authFor(transport));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await click('Delete Team trip'); await click('Confirm delete Team trip');
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
  await act(async () => { pending.resolve(response({ trips: [summary()], next_cursor: null })); });
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});
it('same owner with a new authentication generation cannot receive prior-generation work', async () => {
  const pending = deferred(); const transport = jest.fn(() => pending.promise);
  const view = render(<SavedTripsPanel auth={authFor(transport)} onLoad={jest.fn()} />);
  const signal = transport.mock.calls[0][1].signal;
  view.rerender(<SavedTripsPanel auth={authFor(undefined, 'google:a', 2)} onLoad={jest.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(response({ trips: [summary()], next_cursor: null })); });
  expect(screen.queryByText('Team trip')).not.toBeInTheDocument();
});

it('Save this route is a disclosure that holds the route name and the save button', async () => {
  await renderPanel(authFor());
  expect(saveToggle()).toHaveTextContent('Save this route');
  expect(saveToggle()).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('textbox', { name: 'Route name' })).not.toBeInTheDocument();
  fireEvent.click(saveToggle());
  expect(saveToggle()).toHaveAttribute('aria-expanded', 'true');
  const form = screen.getByRole('region', { name: 'Save route' });
  expect(form).toContainElement(screen.getByRole('textbox', { name: 'Route name' }));
  expect(screen.getByRole('button', { name: 'Save route' })).toBeDisabled();
  fireEvent.click(saveToggle());
  expect(screen.queryByRole('textbox', { name: 'Route name' })).not.toBeInTheDocument();
});

it('an opened trip updates in place with PATCH, reports no changes, and can still be saved as a new trip', async () => {
  const changed = snapshot(); changed.inputs.drivers[0].capacity = 3;
  const transport = jest.fn(async (path, options) => {
    if (path === '/saved-trips?limit=20') return response({ trips: [summary()], next_cursor: null });
    const body = options.body && JSON.parse(options.body);
    if (options.method === 'PATCH') return response(detail(ID, body.title, body.snapshot));
    if (options.method === 'POST') return response(detail(body.id, body.title, body.snapshot), 201);
    return response(detail());
  });
  const auth = authFor(transport), onOpened = jest.fn(), load = jest.fn();
  const view = await renderPanel(auth, { onLoad: load, onOpened });
  await click('Open Team trip');
  expect(onOpened).toHaveBeenCalledWith({ id: ID, title: 'Team trip' });
  const props = { auth, routeAvailable: true, onLoad: load, onOpened, openedTrip: { id: ID, title: 'Team trip' } };
  view.rerender(<SavedTripsPanel {...props} snapshot={snapshot()} />);
  expect(saveToggle()).toHaveTextContent('Save changes');
  openSave();
  expect(screen.getByRole('textbox', { name: 'Route name' })).toHaveValue('Team trip');
  expect(screen.getByRole('button', { name: 'No changes to save' })).toBeDisabled();
  view.rerender(<SavedTripsPanel {...props} snapshot={changed} />);
  await click('Update “Team trip”');
  const patches = transport.mock.calls.filter(([, options]) => options.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(patches[0][0]).toBe(`/saved-trips/${ID}`);
  expect(JSON.parse(patches[0][1].body)).toEqual({ title: 'Team trip', snapshot: changed });
  expect(transport.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  expect(screen.getByText('Updated “Team trip”.')).toBeVisible();
  expect(saveToggle()).toHaveAttribute('aria-expanded', 'false');
  openSave();
  expect(screen.getByRole('button', { name: 'No changes to save' })).toBeDisabled();
  await click('Save as new trip');
  const posts = transport.mock.calls.filter(([, options]) => options.method === 'POST');
  expect(posts).toHaveLength(1);
  const created = JSON.parse(posts[0][1].body);
  expect(created.id).not.toBe(ID);
  expect(created).toMatchObject({ title: 'Team trip', snapshot: changed });
  expect(onOpened).toHaveBeenLastCalledWith({ id: created.id, title: 'Team trip' });
});

it('My trips rows show an editable title, a count and date line, Open, and a delete icon', async () => {
  const transport = jest.fn(async (path, options) => {
    if (options.method === 'PATCH') return response(detail(ID, JSON.parse(options.body).title));
    return response({ trips: [summary(), { ...summary(OTHER_ID, 'Big trip'), driver_count: 2, passenger_count: 5 }], next_cursor: null });
  });
  const onOpened = jest.fn();
  await renderPanel(authFor(transport), { openedTrip: { id: ID, title: 'Team trip' }, onOpened });
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
  expect(onOpened).toHaveBeenCalledWith({ id: ID, title: 'Renamed trip' });
});

it('Refresh reloads My trips quietly while rows are shown; loading text appears only for an empty list', async () => {
  const first = deferred(), later = deferred();
  const transport = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(later.promise);
  render(<SavedTripsPanel auth={authFor(transport)} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} />);
  expect(screen.getByText('Loading saved trips…')).toBeVisible();
  await act(async () => { first.resolve(response({ trips: [summary()], next_cursor: null })); });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  expect(screen.queryByText('Loading saved trips…')).not.toBeInTheDocument();
  expect(screen.getByText('Team trip')).toBeVisible();
  await act(async () => { later.resolve(response({ trips: [summary(), summary(OTHER_ID, 'Second trip')], next_cursor: null })); });
  expect(screen.getByText('Second trip')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'My trips (2)' })).toBeVisible();
});

// The real protectedRequest rejects an aborted request with AbortError, as this transport does.
const abortable = (method) => jest.fn((path, options) => options.method === method
  ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Authentication changed.', 'AbortError'))))
  : Promise.resolve(response({ trips: [summary()], next_cursor: null })));

test('an update interrupted by an owner change shows no failure to the next owner', async () => {
  const changed = snapshot(); changed.inputs.drivers[0].capacity = 3;
  const transport = abortable('PATCH');
  const view = await renderPanel(authFor(transport), { snapshot: changed, openedTrip: { id: ID, title: 'Team trip' } });
  nameRoute('Team trip');
  fireEvent.click(screen.getByRole('button', { name: 'Update “Team trip”' }));
  expect(transport.mock.calls.some(([, options]) => options.method === 'PATCH')).toBe(true);
  view.rerender(<SavedTripsPanel auth={authFor(jest.fn(async () => empty()), 'google:b', 2)} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a rename interrupted by an owner change shows no failure to the next owner', async () => {
  const transport = abortable('PATCH');
  const view = await renderPanel(authFor(transport));
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Name of trip Team trip/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name of trip Team trip' }), { target: { value: 'Renamed trip' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name of trip Team trip' }), { key: 'Enter' });
  expect(transport.mock.calls.some(([, options]) => options.method === 'PATCH')).toBe(true);
  view.rerender(<SavedTripsPanel auth={authFor(jest.fn(async () => empty()), 'google:b', 2)} snapshot={snapshot()} routeAvailable onLoad={jest.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
