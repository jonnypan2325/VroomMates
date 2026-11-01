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
const saved = (title = auto('BCD'), id = TRIP) => {
  server.trips.set(id, { id, title, created_at: CREATED, snapshot: snapshot() });
  writer.remember(JSON.parse(JSON.stringify(server.trips.get(id))));
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
  expect((await running).error).toMatchObject({ kind: 'dropped' });
  const OTHER = '33333333-3333-4333-8333-333333333333';
  saved(auto('BCD'), OTHER);
  const late = settle(writer.update(OTHER, { title: 'Late' }));
  const never = settle(writer.update(OTHER, { title: 'Never' }));
  writer.close();
  await server.release();
  expect((await late).error).toMatchObject({ kind: 'dropped' });
  expect((await never).error).toMatchObject({ kind: 'dropped' });
  expect(server.requests.filter((request) => request.body?.title === 'Never')).toHaveLength(0);
  expect(writer.known(OTHER).title).not.toBe('Late');
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
  expect((await failing).error.kind).toBe('failed');
  // The unclear failure is followed by a read of the trip, which the wait includes.
  expect(drained).toBe(false);
  await server.release();
  await done;
  expect(server.requests.map((request) => request.method)).toEqual(['PATCH', 'GET']);
});

it('checks a new trip\'s ID after an unclear failure, and never sends it twice', async () => {
  server.fail = [503];
  const body = { id: TRIP, title: 'Copy of Friday dinner', snapshot: snapshot('Mia'), facts: facts('BCD') };
  const { error } = await settle(writer.create(body));
  expect(error.kind).toBe('failed');
  // The first reply was lost, and the trip was saved after all.
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

it('saves a route under its old name when a new one cannot be made, and refuses a name that is not valid', async () => {
  saved();
  await writer.update(TRIP, { snapshot: arriving('2099-11-06T18:45'),
    follow: { before: facts('BCD'), after: facts('B‌CD', '2099-11-06T18:45') } });
  expect(server.trips.get(TRIP)).toMatchObject({ title: auto('BCD'), snapshot: { inputs: { arrive_by: '2099-11-06T18:45' } } });
  expect((await settle(writer.update(TRIP, { title: 'Friday​dinner' }))).error).toMatchObject({ kind: 'refused', retry: null });
  expect((await settle(writer.create({ id: '22222222-2222-4222-8222-222222222222', title: 'x­', snapshot: snapshot() })))
    .error).toMatchObject({ kind: 'refused' });
  expect(server.requests.filter((request) => request.method !== 'GET')).toHaveLength(1);
});

it('lets go of a deleted trip completely, even when a write to it was already on its way', async () => {
  saved();
  server.hold = true;
  const landing = settle(writer.update(TRIP, { title: 'Landing late' }));
  writer.forget(TRIP);
  await server.release();
  expect((await landing).error).toMatchObject({ kind: 'dropped' });
  expect(writer.known(TRIP)).toBeUndefined();
  saved();
  writer.forget(TRIP);
  server.trips.delete(TRIP);
  const gone = settle(writer.update(TRIP, { title: 'After the delete' }));
  await flush();
  expect((await gone).error).toMatchObject({ kind: 'dropped', retry: null });
  expect(server.held).toHaveLength(0);
});

it('keeps the newer copy of a trip read again, so writes never build on an older one', async () => {
  saved();
  const later = { ...JSON.parse(JSON.stringify(server.trips.get(TRIP))), title: 'Edited elsewhere', updated_at: '2026-10-30T09:00:00Z',
    snapshot: named('Mia')(snapshot()) };
  server.trips.set(TRIP, JSON.parse(JSON.stringify(later)));
  writer.remember(later);
  expect(writer.known(TRIP).title).toBe('Edited elsewhere');
  writer.remember({ ...later, title: 'Older copy', updated_at: '2026-10-29T13:00:00Z' });
  expect(writer.known(TRIP).title).toBe('Edited elsewhere');
  // A read with the same edit time is the server's word, so it wins.
  writer.remember({ ...later, title: 'Read now' });
  expect(writer.known(TRIP).title).toBe('Read now');
  await writer.update(TRIP, { snapshot: arriving('2099-11-06T18:45') });
  expect(server.trips.get(TRIP).snapshot.inputs).toMatchObject({ arrive_by: '2099-11-06T18:45', passengers: [{ person: 'Mia' }] });
});

it('reads a trip again after a write whose reply was lost, so the next write keeps what that one saved', async () => {
  saved();
  // The server saves the arrive-by time, but its reply never arrives.
  const lost = server.protectedRequest;
  server.protectedRequest = jest.fn(async (path, options) => { await lost(path, options); throw new TypeError('Reply lost'); });
  expect((await settle(writer.update(TRIP, { snapshot: arriving('2099-11-06T18:45') }))).error.kind).toBe('failed');
  server.protectedRequest = lost;
  await writer.update(TRIP, { snapshot: named('Mia') });
  expect(server.trips.get(TRIP).snapshot.inputs).toMatchObject({ arrive_by: '2099-11-06T18:45', passengers: [{ person: 'Mia' }] });
});

it('reads a trip again on its own after a lost reply, so what it shows catches up with the server', async () => {
  saved();
  const lost = server.protectedRequest;
  server.protectedRequest = jest.fn(async (path, options) => {
    const answer = await lost(path, options);
    if (options?.method === 'PATCH') throw new TypeError('Reply lost');
    return answer;
  });
  expect((await settle(writer.update(TRIP, { title: 'Listed' }))).error.kind).toBe('failed');
  await act(async () => { await writer.drain(TRIP); });
  expect(writer.known(TRIP).title).toBe('Listed');
  expect(writer.uncertain(TRIP)).toBe(false);
});

it('never saves again a new trip deleted while its retry was checking for it', async () => {
  server.fail = [503];
  const { error } = await settle(writer.create({ id: TRIP, title: auto('BCD'), snapshot: snapshot(), facts: facts('BCD') }));
  server.hold = true;
  const retried = settle(error.retry());
  await flush();
  writer.forget(TRIP);
  server.hold = false;
  await server.release();
  expect((await retried).error).toMatchObject({ kind: 'dropped' });
  expect(server.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
});

it('an automatic name keeps following after a lost reply whose save changed it', async () => {
  saved(auto('BCD'));
  const lost = jest.fn();
  const answer = server.protectedRequest.getMockImplementation();
  // The server saves the new name; its reply never arrives.
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); lost(); throw new TypeError('Reply lost'); });
  await expect(writer.update(TRIP, { snapshot: snapshot('Mia'), follow: { before: facts('BCD'), after: facts('UCI') } })).rejects.toMatchObject({ kind: 'failed' });
  await flush();
  expect(lost).toHaveBeenCalled();
  expect(writer.known(TRIP).title).toBe(auto('UCI'));
  // The planner, not told, still says the name came from BCD.
  await writer.update(TRIP, { snapshot: snapshot('Sam'), follow: { before: facts('BCD'), after: facts('Irvine') } });
  expect(server.trips.get(TRIP).title).toBe(auto('Irvine'));
});

it('a new trip whose reply was lost, opened again, takes later saves', async () => {
  const answer = server.protectedRequest.getMockImplementation();
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); throw new TypeError('Reply lost'); });
  await expect(writer.create({ id: TRIP, title: auto('BCD'), snapshot: snapshot() })).rejects.toMatchObject({ kind: 'failed' });
  writer.remember(JSON.parse(JSON.stringify(server.trips.get(TRIP))));
  await writer.update(TRIP, { snapshot: snapshot('Mia') });
  expect(server.trips.get(TRIP).snapshot.inputs.passengers[0].person).toBe('Mia');
});

it('a read that ties a save from here is older than it, so it never undoes that save', async () => {
  saved('Before');
  const read = JSON.parse(JSON.stringify(server.trips.get(TRIP)));
  await writer.update(TRIP, { title: 'After' });
  writer.remember(read);
  expect(writer.known(TRIP).title).toBe('After');
});

it('settled reads a trip whose last reply was lost, and fails if that read fails too', async () => {
  saved(auto('BCD'));
  const answer = server.protectedRequest.getMockImplementation();
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); throw new TypeError('Reply lost'); });
  server.protectedRequest.mockImplementationOnce(async () => { throw new TypeError('Offline'); });
  await expect(writer.update(TRIP, { title: 'Landed' })).rejects.toMatchObject({ kind: 'failed' });
  await flush();
  expect(writer.uncertain(TRIP)).toBe(true);
  server.protectedRequest.mockImplementationOnce(async () => { throw new TypeError('Offline'); });
  await expect(writer.settled(TRIP)).rejects.toMatchObject({ kind: 'failed' });
  await writer.settled(TRIP);
  expect(writer.known(TRIP).title).toBe('Landed');
  expect(writer.uncertain(TRIP)).toBe(false);
});

it('a Retry of a new trip that fails again, once the trip has been read, holds nothing back', async () => {
  const answer = server.protectedRequest.getMockImplementation();
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); throw new TypeError('Reply lost'); });
  const lost = await writer.create({ id: TRIP, title: auto('BCD'), snapshot: snapshot() }).catch((error) => error);
  writer.remember(JSON.parse(JSON.stringify(server.trips.get(TRIP))));
  server.protectedRequest.mockImplementationOnce(async () => { throw new TypeError('Offline'); });
  await expect(lost.retry()).rejects.toMatchObject({ kind: 'failed' });
  await writer.update(TRIP, { snapshot: snapshot('Mia') });
  expect(server.trips.get(TRIP).snapshot.inputs.passengers[0].person).toBe('Mia');
});

it('a Retry that finds its own ID adopts the trip as saved, whatever it holds now', async () => {
  const answer = server.protectedRequest.getMockImplementation();
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); throw new TypeError('Reply lost'); });
  const lost = await writer.create({ id: TRIP, title: auto('BCD'), snapshot: snapshot(), facts: facts('BCD') }).catch((error) => error);
  server.trips.get(TRIP).title = 'Renamed on the phone';
  await expect(lost.retry()).resolves.toMatchObject({ title: 'Renamed on the phone' });
  expect(writer.known(TRIP).title).toBe('Renamed on the phone');
  // The facts were for the title sent, so they say nothing about this one.
  await writer.update(TRIP, { snapshot: snapshot('Mia'), follow: { before: facts('BCD'), after: facts('UCI') } });
  expect(server.trips.get(TRIP).title).toBe('Renamed on the phone');
});

it('a new trip told its ID is taken reads it, and adopts it; a conflict with nothing there stays a conflict', async () => {
  server.trips.set(TRIP, { id: TRIP, title: 'Already here', created_at: CREATED, snapshot: snapshot() });
  server.fail = [409];
  await expect(writer.create({ id: TRIP, title: auto('BCD'), snapshot: snapshot() })).resolves.toMatchObject({ title: 'Already here' });
  const other = '22222222-2222-4222-8222-222222222222';
  server.fail = [409];
  await expect(writer.create({ id: other, title: auto('BCD'), snapshot: snapshot() })).rejects.toMatchObject({ kind: 'conflict' });
});

it('runs a delete in its turn: a save on its way lands first, and what waits behind it is let go', async () => {
  server.hold = true;
  const created = writer.create({ id: TRIP, title: 'Friday', snapshot: snapshot() });
  const sends = [];
  const removed = writer.remove(TRIP, async () => { sends.push(server.trips.has(TRIP)); server.trips.delete(TRIP); });
  const later = settle(writer.update(TRIP, { title: 'Too late' }));
  await Promise.resolve();
  expect(sends).toEqual([]);
  await server.release();
  await created;
  await removed;
  expect(sends).toEqual([true]);
  expect((await later).error).toMatchObject({ kind: 'dropped' });
  expect(server.requests.map((request) => request.method)).toEqual(['POST']);
  expect(writer.known(TRIP)).toBeUndefined();
  await expect(writer.update(TRIP, { title: 'After' })).rejects.toMatchObject({ kind: 'dropped' });
});

it('keeps a trip whose delete failed, and goes on with what waits behind it', async () => {
  await writer.create({ id: TRIP, title: 'Friday', snapshot: snapshot() });
  await expect(writer.remove(TRIP, async () => { throw new Error('No reply'); })).rejects.toThrow('No reply');
  expect(writer.known(TRIP)).toMatchObject({ title: 'Friday' });
  await expect(writer.update(TRIP, { title: 'Still here' })).resolves.toMatchObject({ title: 'Still here' });
  expect(server.trips.get(TRIP).title).toBe('Still here');
});

it('forgets a lost reply along with its trip', async () => {
  saved(auto('BCD'));
  const answer = server.protectedRequest.getMockImplementation();
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); throw new TypeError('Reply lost'); });
  server.protectedRequest.mockImplementationOnce(async () => { throw new TypeError('Offline'); });
  await writer.update(TRIP, { title: 'Landed' }).catch(() => {});
  await flush();
  expect(writer.uncertain(TRIP)).toBe(true);
  writer.forget(TRIP);
  expect(writer.uncertain(TRIP)).toBe(false);
});

it('reads nothing once closed', async () => {
  saved(auto('BCD'));
  const answer = server.protectedRequest.getMockImplementation();
  server.protectedRequest.mockImplementationOnce(async (path, options) => { await answer(path, options); throw new TypeError('Reply lost'); });
  server.protectedRequest.mockImplementationOnce(async () => { throw new TypeError('Offline'); });
  await writer.update(TRIP, { title: 'Landed' }).catch(() => {});
  await flush();
  writer.close();
  server.requests.length = 0;
  await writer.settled(TRIP).catch(() => {});
  await flush();
  expect(server.requests).toHaveLength(0);
});

