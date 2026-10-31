import { TextEncoder } from 'util';
import { act } from '@testing-library/react';
import createTripWriter from './tripWriter';
import { titleFromFacts } from './tripTitles';

beforeAll(() => { global.TextEncoder = TextEncoder; });
const TRIP = '11111111-1111-4111-8111-111111111111';
const CREATED = '2026-10-29T12:00:00Z';
const SAVED_DAY = new Date(CREATED);
const point = (stop_id, extra = {}) => ({ stop_id, label: '', source: { kind: 'google_places', place_id: stop_id }, ...extra });
const snapshot = (person) => ({ schema_version: 1, inputs: { drivers: [{ ...point('driver'), capacity: 2 }],
  passengers: [point('pickup', person ? { person } : {})], destination: { ...point('end'), label: 'BCD' } },
  routes: [{ driver_id: 'driver', stop_ids: ['driver', 'pickup', 'end'] }] });
const facts = (place, arriveBy = '') => ({ place, arriveBy });
const auto = (place, arriveBy = '') => titleFromFacts(facts(place, arriveBy), SAVED_DAY);
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

// Saved trips in memory; `hold` keeps replies back until released, `fail` answers the next writes with those statuses.
function apiServer() {
  const server = { trips: new Map(), requests: [], held: [], hold: false, fail: [] };
  server.protectedRequest = jest.fn((path, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const id = path.split('/')[2] || body?.id;
    server.requests.push({ method, id, body });
    const answer = () => {
      if (method !== 'GET' && server.fail.length) return reply(server.fail.shift(), { error: { code: 'SYNTHETIC' } });
      if (method === 'POST') {
        if (!server.trips.has(id)) server.trips.set(id, { id, title: body.title, created_at: CREATED, snapshot: body.snapshot });
        return reply(201, { trip: server.trips.get(id) });
      }
      const trip = server.trips.get(id);
      if (!trip) return reply(404, { error: { code: 'NOT_FOUND' } });
      if (method === 'PATCH') Object.assign(trip, body);
      return reply(200, { trip: JSON.parse(JSON.stringify(trip)) });
    };
    return server.hold ? new Promise((resolve) => server.held.push(() => resolve(answer()))) : Promise.resolve(answer());
  });
  server.release = () => act(async () => { server.held.shift()(); });
  return server;
}
let server, writer;
const auth = () => ({ protectedRequest: server.protectedRequest });
beforeEach(() => { server = apiServer(); writer = createTripWriter(auth); });
const flush = () => act(async () => {});
const saved = (title = auto('BCD')) => {
  server.trips.set(TRIP, { id: TRIP, title, created_at: CREATED, snapshot: snapshot() });
  writer.remember(JSON.parse(JSON.stringify(server.trips.get(TRIP))));
};
const named = (person) => (current) => ({ ...current, inputs: { ...current.inputs,
  passengers: current.inputs.passengers.map((row) => ({ ...row, person })) } });
const arriving = (value) => (current) => ({ ...current, inputs: { ...current.inputs, arrive_by: value } });
const settle = (promise) => promise.then((trip) => ({ trip }), (error) => ({ error }));

it('runs one write to a trip at a time, each built on the trip the one before left', async () => {
  saved();
  server.hold = true;
  const first = writer.update(TRIP, { snapshot: named('Mia') });
  const second = writer.update(TRIP, { snapshot: arriving('2099-11-06T18:45') });
  await flush();
  expect(server.held).toHaveLength(1);
  await server.release();
  await server.release();
  await Promise.all([first, second]);
  expect(server.trips.get(TRIP).snapshot.inputs).toMatchObject({ arrive_by: '2099-11-06T18:45', passengers: [{ person: 'Mia' }] });
  expect(writer.known(TRIP).snapshot).toEqual(server.trips.get(TRIP).snapshot);
});

it('lets an automatic title follow its trip, but never over a rename, whichever is sent first', async () => {
  saved();
  await writer.update(TRIP, { snapshot: arriving('2099-11-06T18:45'), follow: { before: facts('BCD'), after: facts('BCD', '2099-11-06T18:45') } });
  expect(server.trips.get(TRIP).title).toBe(auto('BCD', '2099-11-06T18:45'));
  server.hold = true;
  const rename = writer.update(TRIP, { title: 'Friday dinner' });
  const route = writer.update(TRIP, { snapshot: arriving('2099-11-07T18:45'),
    follow: { before: facts('BCD', '2099-11-06T18:45'), after: facts('BCD', '2099-11-07T18:45') } });
  await server.release(); await server.release();
  await Promise.all([rename, route]);
  expect(server.requests.at(-1).body).not.toHaveProperty('title');
  expect(server.trips.get(TRIP).title).toBe('Friday dinner');
});

it('retries a failed write as the same change built afresh, so it cannot put back an old title', async () => {
  saved();
  server.fail = [503];
  const { error } = await settle(writer.update(TRIP, { snapshot: arriving('2099-11-06T18:45'),
    follow: { before: facts('BCD'), after: facts('BCD', '2099-11-06T18:45') } }));
  expect(error).toMatchObject({ kind: 'failed' });
  await writer.update(TRIP, { title: 'Renamed in My trips' });
  await error.retry();
  expect(server.requests.at(-1).body).toEqual({ snapshot: expect.objectContaining({ inputs: expect.objectContaining({ arrive_by: '2099-11-06T18:45' }) }) });
  expect(server.trips.get(TRIP).title).toBe('Renamed in My trips');
});

it('merges a newer planner route into one still waiting, keeping the oldest title facts so the name follows once', async () => {
  // Named by an earlier arrive-by, so only the oldest facts show the name is automatic.
  saved(auto('BCD', '2099-11-05T18:45'));
  server.hold = true;
  const running = writer.update(TRIP, { snapshot: named('Mia') });
  const first = writer.update(TRIP, { snapshot: snapshot(), follow: { before: facts('BCD', '2099-11-05T18:45'),
    after: facts('BCD', '2099-11-06T18:45') } }, { slot: 'planner' });
  const second = writer.update(TRIP, { snapshot: { ...snapshot(), inputs: { ...snapshot().inputs, arrive_by: '2099-11-07T18:45' } },
    follow: { before: facts('BCD', '2099-11-06T18:45'), after: facts('BCD', '2099-11-07T18:45') } }, { slot: 'planner' });
  expect(second).toBe(first);
  await server.release(); await server.release();
  await Promise.all([running, first]);
  expect(server.requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
  expect(server.trips.get(TRIP)).toMatchObject({ title: auto('BCD', '2099-11-07T18:45'), snapshot: { inputs: { arrive_by: '2099-11-07T18:45' } } });
});

it('ends every write with an outcome: refused, gone, dropped on delete, dropped on account change', async () => {
  saved();
  server.fail = [400];
  expect((await settle(writer.update(TRIP, { title: 'x' }))).error).toMatchObject({ kind: 'refused', retry: null });
  server.trips.delete(TRIP);
  expect((await settle(writer.update(TRIP, { title: 'y' }))).error).toMatchObject({ kind: 'detached' });
  expect(writer.known(TRIP)).toBeUndefined();
  saved();
  server.hold = true;
  const running = settle(writer.update(TRIP, { title: 'Running' }));
  const waiting = settle(writer.update(TRIP, { title: 'Waiting' }));
  writer.forget(TRIP);
  expect((await waiting).error).toMatchObject({ kind: 'dropped' });
  await server.release();
  expect((await running).trip.title).toBe('Running');
  saved();
  const late = settle(writer.update(TRIP, { title: 'Late' }));
  const never = settle(writer.update(TRIP, { title: 'Never' }));
  writer.close();
  await server.release();
  expect((await late).error).toMatchObject({ kind: 'dropped' });
  expect((await never).error).toMatchObject({ kind: 'dropped' });
  expect(server.requests.filter((request) => request.body?.title === 'Never')).toHaveLength(0);
  expect(writer.known(TRIP).title).not.toBe('Late');
});

it('waits for a trip\'s writes to finish, however they end', async () => {
  saved();
  await expect(writer.drain(TRIP)).resolves.toBeUndefined();
  server.hold = true;
  server.fail = [503];
  const failing = settle(writer.update(TRIP, { title: 'x' }));
  let drained = false;
  const done = writer.drain(TRIP).then(() => { drained = true; });
  await flush();
  expect(drained).toBe(false);
  await server.release();
  await done;
  expect((await failing).error.kind).toBe('failed');
});

it('checks a new trip\'s ID after an unclear failure, and accepts it only with the same content', async () => {
  server.fail = [503];
  const body = { id: TRIP, title: 'Copy of Friday dinner', snapshot: snapshot('Mia'), facts: facts('BCD') };
  const { error } = await settle(writer.create(body));
  expect(error.kind).toBe('failed');
  // The first reply was lost, but the trip was saved with other content.
  server.trips.set(TRIP, { id: TRIP, title: 'Something else', created_at: CREATED, snapshot: snapshot() });
  expect((await settle(error.retry())).error).toMatchObject({ kind: 'conflict' });
  server.trips.set(TRIP, { id: TRIP, title: body.title, created_at: CREATED, snapshot: snapshot('Mia') });
  const posts = server.requests.filter((request) => request.method === 'POST').length;
  await expect(error.retry()).resolves.toMatchObject({ id: TRIP, title: body.title });
  expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(posts);
});

it('drops changes to a new trip whose save failed, rather than sending them to a trip that does not exist', async () => {
  server.fail = [503];
  const create = settle(writer.create({ id: TRIP, title: auto('BCD'), snapshot: snapshot(), facts: facts('BCD') }));
  const edit = settle(writer.update(TRIP, { snapshot: snapshot('Mia') }));
  expect((await create).error.kind).toBe('failed');
  expect((await edit).error.kind).toBe('dropped');
  expect(server.requests.map((request) => request.method)).toEqual(['POST']);
});
