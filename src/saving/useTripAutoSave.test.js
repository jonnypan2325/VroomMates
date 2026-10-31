import { useState } from 'react';
import { TextEncoder } from 'util';
import { act, renderHook } from '@testing-library/react';
import createTripWriter from './tripWriter';
import useTripAutoSave from './useTripAutoSave';
import { followTitle, titleFacts, titleFromFacts } from './tripTitles';

const automaticTitle = (route, now) => titleFromFacts(titleFacts(route), now);

beforeAll(() => { global.TextEncoder = TextEncoder; });

const day = (year, month, date) => new Date(year, month - 1, date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const CREATED = '2026-10-29T12:00:00Z';
const SAVED_DAY = new Date(CREATED).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const facts = (place, arriveBy = '') => ({ place, arriveBy });
const result = (destination, arriveBy) => ({ inputs: { destination, ...(arriveBy ? { arrive_by: arriveBy } : {}) } });

it('names a trip by its destination and the arrive-by date, or the day it was calculated', () => {
  expect(automaticTitle(result({ label: 'BCD Tofu' }), new Date(2026, 9, 29))).toBe(`Trip to BCD Tofu, ${day(2026, 10, 29)}`);
  expect(automaticTitle(result({ label: '', place_name: 'BCD Tofu House' }, '2026-11-06T18:45'), new Date(2026, 9, 29)))
    .toBe(`Trip to BCD Tofu House, ${day(2026, 11, 6)}`);
  expect(titleFacts(result({ label: '', address: '2700 Alton Pkwy, Irvine' }, 'not a time'))).toEqual(facts('2700 Alton Pkwy'));
});

it('an automatic title follows a new, changed or cleared arrive-by date', () => {
  const saved = `Trip to BCD, ${SAVED_DAY}`;
  const set = followTitle(saved, facts('BCD'), facts('BCD', '2026-11-06T18:45'), CREATED);
  expect(set).toBe(`Trip to BCD, ${day(2026, 11, 6)}`);
  const changed = followTitle(set, facts('BCD', '2026-11-06T18:45'), facts('BCD', '2026-11-07T09:00'), CREATED);
  expect(changed).toBe(`Trip to BCD, ${day(2026, 11, 7)}`);
  expect(followTitle(changed, facts('BCD', '2026-11-07T09:00'), facts('BCD'), CREATED)).toBe(saved);
});

it('a title the person chose, or a copy, never follows', () => {
  expect(followTitle('Friday dinner', facts('BCD'), facts('BCD', '2026-11-06T18:45'), CREATED)).toBe('Friday dinner');
  const copy = `Copy of Trip to BCD, ${SAVED_DAY}`;
  expect(followTitle(copy, facts('BCD'), facts('BCD', '2026-11-06T18:45'), CREATED)).toBe(copy);
});

it('an automatic title follows a renamed or recalculated destination, keeping its date', () => {
  expect(followTitle(`Trip to BCD, ${SAVED_DAY}`, facts('BCD'), facts('BCD Tofu'), CREATED)).toBe(`Trip to BCD Tofu, ${SAVED_DAY}`);
  expect(followTitle(`Trip to BCD, ${day(2026, 11, 6)}`, facts('BCD', '2026-11-06T18:45'), facts('UCI', '2026-11-06T18:45'), CREATED))
    .toBe(`Trip to UCI, ${day(2026, 11, 6)}`);
  // Without a save date, clearing the arrive-by leaves the title rather than guessing a day.
  expect(followTitle(`Trip to BCD, ${day(2026, 11, 6)}`, facts('BCD', '2026-11-06T18:45'), facts('BCD'), undefined))
    .toBe(`Trip to BCD, ${day(2026, 11, 6)}`);
});

// Saves through the hook and the account's writer, against an API in memory whose replies can be held back.
const TRIP_A = '11111111-1111-4111-8111-111111111111';
const TRIP_B = '22222222-2222-4222-8222-222222222222';
const point = (stop_id) => ({ stop_id, label: '', source: { kind: 'google_places', place_id: stop_id } });
const snapshotFor = (pickup = 'pickup', arriveBy) => ({ schema_version: 1, inputs: { drivers: [{ ...point('driver'), capacity: 2 }],
  passengers: [point(pickup)], destination: { ...point('end'), label: 'BCD' }, ...(arriveBy ? { arrive_by: arriveBy } : {}) },
  routes: [{ driver_id: 'driver', stop_ids: ['driver', pickup, 'end'] }] });
let resultCount = 0;
const routeResult = (origin = 'calculated', pickup = 'pickup', arriveBy) => ({ id: 'result-' + (resultCount += 1), origin,
  inputs: { destination: { label: 'BCD' }, ...(arriveBy ? { arrive_by: arriveBy } : {}) }, snapshot: snapshotFor(pickup, arriveBy) });
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
function apiServer() {
  const server = { requests: [], trips: new Map(), held: [], hold: false, fail: [] };
  server.protectedRequest = jest.fn((path, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const id = path.split('/')[2] || body?.id;
    server.requests.push({ method, id, body });
    const answer = () => {
      if (method !== 'GET' && server.fail.length) return reply(server.fail.shift(), { error: { code: 'SYNTHETIC' } });
      if (method === 'POST') {
        server.trips.set(id, { id, title: body.title, created_at: CREATED, snapshot: body.snapshot });
        return reply(201, { trip: server.trips.get(id) });
      }
      const trip = server.trips.get(id);
      if (!trip) return reply(404, { error: { code: 'NOT_FOUND' } });
      if (method === 'PATCH') Object.assign(trip, body);
      return reply(200, { trip: JSON.parse(JSON.stringify(trip)) });
    };
    if (!server.hold) return Promise.resolve(answer());
    return new Promise((resolve) => server.held.push(() => resolve(answer())));
  });
  server.release = async () => { const next = server.held.shift(); await act(async () => { next(); }); };
  return server;
}
// The planner around the hook: it holds the working trip, which only the person's actions change.
function usePlanner({ writer, result, start }) {
  const [trip, setTrip] = useState(start || null);
  const save = useTripAutoSave({ writer, result, trip, onTrip: setTrip, onChanged: () => {} });
  return { save, trip, setTrip };
}
let server, writer;
beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
  server = apiServer();
  writer = createTripWriter(() => ({ protectedRequest: server.protectedRequest }));
});
const mount = (props) => renderHook((current) => usePlanner(current), { initialProps: { writer, ...props } });
const opened = (id, title = 'Friday dinner') => {
  server.trips.set(id, { id, title, created_at: CREATED, snapshot: snapshotFor() });
  writer.remember(JSON.parse(JSON.stringify(server.trips.get(id))));
  return { id, title, opened: true, created_at: CREATED, facts: facts('BCD') };
};
const settle = () => act(async () => {});
// Once the writer has nothing left to do, no route says "Saving…".
const idle = async (view) => { await settle(); expect(view.result.current.save.phase).not.toBe('saving'); };

it('a save that lands after Start over stays with its route: the next route is a new trip, and Undo gets it back', async () => {
  server.hold = true;
  const first = routeResult();
  const view = mount({ result: first });
  await settle();
  const held = view.result.current.trip;
  act(() => { view.result.current.setTrip(null); });
  view.rerender({ writer, result: null });
  await server.release();
  expect(view.result.current.trip).toBeNull();
  act(() => { view.result.current.setTrip(held); });
  view.rerender({ writer, result: first });
  expect(view.result.current.save).toMatchObject({ phase: 'saved', trip: { id: server.requests[0].id } });
  act(() => { view.result.current.setTrip(null); });
  server.hold = false;
  view.rerender({ writer, result: routeResult() });
  await idle(view);
  expect(server.requests.map((request) => request.method)).toEqual(['POST', 'POST']);
  expect(server.requests[1].id).not.toBe(server.requests[0].id);
});

it('a new trip whose save failed after Start over shows Not saved with a working Retry on Undo', async () => {
  server.hold = true;
  server.fail = [503];
  const first = routeResult();
  const view = mount({ result: first });
  await settle();
  const held = view.result.current.trip;
  act(() => { view.result.current.setTrip(null); });
  view.rerender({ writer, result: null });
  await server.release();
  act(() => { view.result.current.setTrip(held); });
  view.rerender({ writer, result: first });
  expect(view.result.current.save.phase).toBe('error');
  server.hold = false;
  await act(async () => { view.result.current.save.retry(); });
  await idle(view);
  expect(view.result.current.save.phase).toBe('saved');
  expect(server.trips.size).toBe(1);
});

it('a planner save waiting when another trip is opened still saves to its own trip, never the new one', async () => {
  const view = mount({ result: routeResult('reopened'), start: opened(TRIP_A) });
  act(() => { opened(TRIP_B, 'Beach day'); });
  server.hold = true;
  act(() => { view.result.current.save.saveEdits(routeResult('reopened', 'mia')); });
  act(() => { view.result.current.save.saveEdits(routeResult('reopened', 'uci')); });
  act(() => { view.result.current.setTrip({ id: TRIP_B, title: 'Beach day', opened: true, created_at: CREATED, facts: facts('BCD') }); });
  view.rerender({ writer, result: routeResult('reopened') });
  await server.release(); await server.release();
  expect(server.requests.map((request) => [request.method, request.id])).toEqual([['PATCH', TRIP_A], ['PATCH', TRIP_A]]);
  expect(server.trips.get(TRIP_A).snapshot.passengers?.[0]).toBeUndefined();
  expect(server.trips.get(TRIP_A).snapshot.inputs.passengers[0].stop_id).toBe('uci');
  expect(server.trips.get(TRIP_B).snapshot).toEqual(snapshotFor());
  expect(view.result.current.trip.id).toBe(TRIP_B);
});

it('deleting a trip while its save waits drops the save rather than bringing the trip back', async () => {
  const route = routeResult('reopened');
  const view = mount({ result: route, start: opened(TRIP_A) });
  server.hold = true;
  act(() => { view.result.current.save.saveEdits({ ...routeResult('reopened', 'mia'), id: route.id }); });
  act(() => { view.result.current.save.saveEdits({ ...routeResult('reopened', 'uci'), id: route.id }); });
  server.trips.delete(TRIP_A);
  act(() => { writer.forget(TRIP_A); view.result.current.setTrip(null); });
  await server.release();
  await idle(view);
  expect(server.requests.map((request) => request.method)).toEqual(['PATCH']);
  expect(server.trips.size).toBe(0);
  expect(view.result.current.save.phase).toBe('unsaved');
});

it('a trip deleted elsewhere lets go of the route, so Retry saves its latest version as a new trip', async () => {
  const view = mount({ result: routeResult('reopened'), start: opened(TRIP_A) });
  server.trips.delete(TRIP_A);
  const edited = routeResult('reopened', 'mia');
  act(() => { view.result.current.save.saveEdits(edited); });
  view.rerender({ writer, result: edited });
  await settle();
  expect(view.result.current.trip).toBeNull();
  expect(view.result.current.save.phase).toBe('error');
  await act(async () => { view.result.current.save.retry(); });
  await idle(view);
  expect(server.requests.map((request) => request.method)).toEqual(['PATCH', 'POST']);
  expect(server.trips.get(server.requests[1].id).snapshot).toEqual(edited.snapshot);
  expect(view.result.current.trip).toMatchObject({ id: server.requests[1].id });
});

it('a change the server refuses says it cannot be saved, without a Retry that sends it again', async () => {
  const edited = routeResult('reopened', 'mia');
  const view = mount({ result: edited, start: opened(TRIP_A) });
  server.fail = [400];
  act(() => { view.result.current.save.saveEdits(edited); });
  await idle(view);
  expect(view.result.current.save).toMatchObject({ phase: 'unsavable', message: expect.stringMatching(/cannot be saved/) });
  await act(async () => { view.result.current.save.retry(); });
  expect(server.requests).toHaveLength(1);
});

it('quick arrive-by changes waiting together still move an automatic name once, to the latest date', async () => {
  const route = routeResult('reopened');
  const start = opened(TRIP_A, automaticTitle(route, new Date(CREATED)));
  const view = mount({ result: route, start });
  server.hold = true;
  for (const date of ['2099-11-05', '2099-11-06', '2099-11-07']) {
    act(() => { view.result.current.save.saveEdits({ ...routeResult('reopened', 'pickup', `${date}T18:45`), id: route.id }); });
  }
  await server.release(); await server.release();
  await idle(view);
  expect(server.requests).toHaveLength(2);
  expect(server.trips.get(TRIP_A).title).toBe(`Trip to BCD, ${day(2099, 11, 7)}`);
  expect(view.result.current.save.trip.title).toBe(`Trip to BCD, ${day(2099, 11, 7)}`);
});

it('shows the name the trip has now, after a rename from anywhere', async () => {
  const view = mount({ result: routeResult('reopened'), start: opened(TRIP_A, 'Mine') });
  await act(async () => { await writer.update(TRIP_A, { title: 'Renamed in My trips' }); });
  expect(view.result.current.save.trip.title).toBe('Renamed in My trips');
  act(() => { view.result.current.save.saveEdits(routeResult('reopened', 'mia')); });
  await idle(view);
  expect(server.trips.get(TRIP_A).title).toBe('Renamed in My trips');
});
