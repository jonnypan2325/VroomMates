import React from 'react';
import { TextEncoder } from 'util';
import { act, fireEvent, render } from '@testing-library/react';
import LocationInput from '../LocationInput';
import { resolvePlace } from './places';
import { titleFacts, titleFromFacts } from './tripTitles';

// Random sequences of what a person does, run through the real planner, trip view, My trips, autosave and
// trip writer, against a server that answers late, out of order, lost, refused or garbled. What each person
// meant is written down when they act, never read from a request, and each seed checks after it settles that
// the saved trips hold it. A failure names its seed so it can be replayed.
// What stands in: Google (places, directions, the optimizer), the place fields, the drawn results and the
// in-place editors, all at the props the real ones are given. SEEDS=500 runs more sequences locally;
// TRACE=<seed> prints that sequence.
const SEEDS = Number(process.env.SEEDS || 60);
const FIRST = Number(process.env.FIRST || 1);
const TRACE = Number(process.env.TRACE || 0);
const STEPS = 70;
const START = Date.now();
// COVER=1 counts what the sequences reached, to show the actions below really happen.
const cover = {};
const reach = (what) => { cover[what] = (cover[what] || 0) + 1; };

const mockSeen = { save: null, hook: null, route: null, edits: new Map() };
jest.mock('./places', () => ({ ...jest.requireActual('./places'), resolvePlace: jest.fn() }));
jest.mock('./useSavedLocations', () => () => ({ locations: [], loading: false, error: null, refresh: async () => {},
  save: async () => {}, remove: async () => {}, edit: async () => {} }));
jest.mock('./useTripAutoSave', () => {
  const real = jest.requireActual('./useTripAutoSave').default;
  return { __esModule: true, default: (args) => {
    const save = real(args);
    mockSeen.hook = args;
    mockSeen.save = save;
    return { ...save, hold: (...held) => { mockSeen.onReplace?.(); return save.hold(...held); } };
  } };
});
jest.mock('../components/AddressInput', () => function AddressFixture({ label, value, onChange }) {
  return <input aria-label={label} value={value} onChange={(event) => onChange(mockPlace(event.target.value))} />;
});
jest.mock('../results/useRouteMap', () => () => ({ routes: [], legs: [], status: 'ready' }));
jest.mock('../results/RouteResults', () => function RouteFixture(props) {
  const { useEffect } = require('react');
  mockSeen.route = props;
  useEffect(() => () => { if (mockSeen.route?.result === props.result) mockSeen.route = null; });
  return <div>{props.children}</div>;
});
jest.mock('./InlineEdit', () => function EditFixture({ label, value, onCommit }) {
  const { useEffect } = require('react');
  mockSeen.edits.set(label, onCommit);
  useEffect(() => () => { mockSeen.edits.delete(label); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <span>{value}</span>;
});

// Places: `address` is what the fixture field holds, and its ID is what the place lookup answers for.
const PLACES = ['Origin Road', 'Pickup Lane', 'BCD Tofu', 'UCI Campus', 'Karaj‌ Bazaar', 'A'.repeat(120), '中'.repeat(90)];
const coordinate = (name) => {
  const at = PLACES.indexOf(name);
  return { lat: at + 1, lng: at + 1 };
};
const placeId = (name) => 'place-' + PLACES.indexOf(name);
const nameOf = (id) => PLACES[Number(id.slice('place-'.length))];
const mockPlace = (name) => ({ address: name, label: '', source: { kind: 'google_places', place_id: placeId(name) },
  coordinates: coordinate(name) });

beforeAll(() => {
  global.TextEncoder = TextEncoder;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
  Element.prototype.scrollTo = () => {};
});

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fields a person can change, as stored in a trip or shown in a route.
const routeFields = (inputs) => {
  const fields = { arrive: inputs.arrive_by || '', dest: inputs.destination.label || '', place: inputs.destination.source.place_id };
  [...inputs.drivers, ...inputs.passengers].forEach((point) => { fields['person:' + point.stop_id] = point.person || ''; });
  return fields;
};
const tripFields = (trip) => ({ title: trip.title, ...routeFields(trip.snapshot.inputs) });

function makeServer(rand, faultRate, log) {
  const server = { trips: new Map(), waiting: [], replies: [], deleted: new Map(), faults: new Map(), base: new Map(),
    created: new Map(), editedSomewhere: new Set(), heldBack: new Set(), failedNew: new Set(), retries: new Map(), seq: 0, requests: 0, calm: false, clock: 0, problems: [], posted: [], opened: null, deletedHere: null };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  // A reply says what the server held when it answered, however late it arrives.
  const reply = (status, body) => {
    const frozen = copy(body ?? null);
    return { ok: status >= 200 && status < 300, status, json: async () => frozen };
  };
  // Two edits can land on the same instant.
  const stamp = () => {
    if (rand() < 0.6) server.clock += 1;
    return new Date(START + server.clock * 1000).toISOString();
  };
  const summary = (trip) => ({ id: trip.id, title: trip.title, created_at: trip.created_at, updated_at: trip.updated_at, schema_version: 1,
    driver_count: trip.snapshot.inputs.drivers.length, passenger_count: trip.snapshot.inputs.passengers.length,
    ...(trip.snapshot.inputs.arrive_by ? { arrive_by: trip.snapshot.inputs.arrive_by } : {}) });
  // A failed request only makes optional what it carried: a route, a name, or a new trip's whole content.
  const noteFault = ({ method, id, body }) => {
    if (!id || method === 'DELETE') return;
    // A failed read fails only a write waiting on it: after a lost reply, or a new trip's Retry checking its ID.
    if (method === 'GET' && !mockSeen.hook?.writer?.uncertain(id) && !server.failedNew.has(id)) return;
    const fault = server.faults.get(id) || { route: -1, title: -1 };
    if (method !== 'PATCH' || body.snapshot) fault.route = server.seq;
    if (method !== 'PATCH' || body.title) fault.title = server.seq;
    server.faults.set(id, fault);
    if (method === 'POST') server.failedNew.add(id);
    if (server.failedNew.has(id)) server.heldBack.add(id);
  };
  server.faultAt = (id, field) => server.faults.get(id)?.[field === 'title' ? 'title' : 'route'] ?? -1;
  server.allFailed = (id, seq) => server.faults.set(id, { route: seq, title: seq });

  const apply = ({ method, id, body, list }) => {
    if (list) return reply(200, { trips: [...server.trips.values()].slice(-20).map(summary), next_cursor: null });
    if (method === 'GET') return server.trips.has(id) ? reply(200, { trip: server.trips.get(id) }) : reply(404, { error: { code: 'NOT_FOUND' } });
    if (method === 'DELETE') {
      if (!server.trips.delete(id)) return reply(404, { error: { code: 'NOT_FOUND' } });
      server.markDeleted(id);
      return reply(204);
    }
    if (method === 'POST') {
      const deleted = server.deleted.get(id);
      // A trip deleted here never comes back; one deleted elsewhere only through a Retry made after it.
      if (deleted === true || (deleted !== undefined && (server.retries.get(id) || 0) <= deleted)) {
        server.problems.push(`trip ${id} was deleted and then saved again under the same ID without a Retry`);
      }
      const existing = server.trips.get(id);
      if (existing) {
        const same = existing.title === body.title && JSON.stringify(existing.snapshot) === JSON.stringify(body.snapshot);
        return same ? reply(201, { trip: existing }) : reply(409, { error: { code: 'TRIP_CONFLICT' } });
      }
      const created = stamp();
      const trip = { id, title: body.title, created_at: created, updated_at: created, snapshot: body.snapshot };
      server.trips.set(id, trip);
      server.base.set(id, tripFields(trip));
      server.posted.push({ id, title: body.title });
      return reply(201, { trip });
    }
    const trip = server.trips.get(id);
    if (!trip) return reply(404, { error: { code: 'NOT_FOUND' } });
    Object.assign(trip, body, { updated_at: stamp() });
    return reply(200, { trip });
  };

  // The server acts on one request; its reply is still on the way.
  const process_ = (entry) => {
    const { request } = entry;
    const roll = server.calm ? 1 : rand() / (faultRate || 1e-9);
    const write = request.method !== 'GET';
    const fail = (status, code) => { entry.outcome = status; entry.answer = () => entry.resolve(reply(status, { error: { code } })); };
    if (roll < 0.08) { entry.outcome = 'never arrived'; entry.answer = () => entry.reject(new TypeError('Network failure')); }
    else if (roll < 0.14) fail(503, 'STORE_UNAVAILABLE');
    else if (roll < 0.17) fail(500, 'SERVER_ERROR');
    // A real 401 signs the person out before its reply is read, cancelling everything still on its way.
    else if (roll < 0.18) { entry.outcome = 401; entry.answer = () => { entry.reject(new DOMException('Authentication changed.', 'AbortError')); server.expire(); }; }
    else if (request.method === 'PATCH' && roll < 0.24) fail(400, 'INVALID');
    else if (request.method === 'PATCH' && roll < 0.26) fail(409, 'TRIP_CHANGED');
    else if (request.method === 'PATCH' && roll < 0.28) fail(413, 'TOO_LARGE');
    else if (request.method === 'POST' && roll < 0.24) fail(409, 'TRIP_CONFLICT');
    else if (request.method === 'POST' && roll < 0.26) fail(400, 'INVALID');
    else {
      const answer = apply(request);
      reach(`server ${request.method} ${answer.status}`);
      log(`server ${request.method} ${request.id?.slice(0, 4) || 'list'} -> ${answer.status} ${JSON.stringify(request.body?.title || '')}`);
      if (write && roll < 0.4) { entry.outcome = 'lost'; entry.answer = () => entry.reject(new TypeError('Reply lost')); }
      else if (write && roll < 0.44) { entry.outcome = 'empty'; entry.answer = () => entry.resolve(reply(200, {})); }
      else if (write && roll < 0.47) { entry.outcome = 'garbled'; entry.answer = () => entry.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('Bad JSON'); } }); }
      // A reply that disagrees with what was sent. A field not sent can only be another device's edit, so it is not mangled.
      else if (request.method === 'PATCH' && answer.status === 200 && roll < 0.49) {
        entry.outcome = 'other content';
        const trip = server.trips.get(request.id);
        const other = reply(200, { trip: request.body.title ? { ...trip, title: 'Something else' }
          : { ...trip, snapshot: { ...trip.snapshot, inputs: { ...trip.snapshot.inputs, arrive_by: '2099-01-01T00:00' } } } });
        entry.answer = () => entry.resolve(other);
      }
      else {
        entry.answer = () => {
          if (request.method === 'DELETE') server.deleted.set(request.id, true);
          entry.resolve(answer);
        };
      }
    }
    server.replies.push(entry);
  };
  server.protectedRequest = (path, options = {}) => {
    server.requests += 1;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const [route] = path.split('?');
    const id = route.split('/')[2] || (method === 'POST' ? body?.id : undefined);
    if (method === 'GET' && id && options.signal) server.opened = id;
    return new Promise((resolve, reject) => {
      server.waiting.push({ request: { method, id, body, list: method === 'GET' && !id }, resolve, reject, signal: options.signal });
    });
  };
  server.process = process_;
  server.busy = () => server.waiting.length + server.replies.length;
  server.retry = (id) => { server.retries.set(id, (server.retries.get(id) || 0) + 1); server.heldBack.delete(id); };
  // A Retry still on its way when a trip is deleted cannot know: only a save with no Retry behind it is a fault.
  server.markDeleted = (id) => {
    const inFlight = mockSeen.hook?.writer?.queued(id) || [...server.waiting, ...server.replies].some((entry) => entry.request.id === id);
    server.deleted.set(id, (server.retries.get(id) || 0) - (inFlight ? 1 : 0));
  };
  // One thing happens: a waiting request reaches the server, or a reply comes back. Either can overtake the rest.
  server.advance = () => {
    const stages = [server.waiting, server.replies].filter((list) => list.length);
    const stage = stages[Math.floor(rand() * stages.length)];
    const [entry] = stage.splice(Math.floor(rand() * stage.length), 1);
    if (stage === server.waiting) { process_(entry); return; }
    log(`reply to ${entry.request.method} ${entry.request.id?.slice(0, 4) || 'list'} ${entry.outcome || ''}`);
    // The app learns of a failure when its reply arrives; edits queued until then fail with it.
    if (entry.outcome) noteFault(entry.request);
    if (entry.signal?.aborted) entry.reject(new DOMException('Aborted', 'AbortError')); else entry.answer();
  };
  server.elsewhere = (id, fields) => {
    const trip = server.trips.get(id);
    if (!trip) return;
    server.editedSomewhere.add(id);
    if (fields.title) trip.title = fields.title;
    if (fields.person) {
      trip.snapshot.inputs.passengers = trip.snapshot.inputs.passengers.map((point) => {
        if (point.stop_id !== fields.person.id) return point;
        const { person, ...rest } = point;
        return fields.person.name ? { ...rest, person: fields.person.name } : rest;
      });
    }
    trip.updated_at = stamp();
  };
  return server;
}

async function runSequence(seed) {
  const rand = random(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const faultRate = pick([0, 0, 0.5, 1, 2]);
  const lookupFail = pick([0, 0.1]);
  const log = (line) => { if (seed === TRACE) console.log(line); }; // eslint-disable-line no-console
  const server = makeServer(rand, faultRate, log);
  const { problems } = server;
  let seq = 0;

  // Google: lookups and the optimizer answer when released, and a cancelled one stops at once.
  const lookups = [];
  resolvePlace.mockReset();
  resolvePlace.mockImplementation((map, id, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    const name = nameOf(id);
    lookups.push(() => (rand() < lookupFail ? reject(new Error('Location lookup timed out. Please retry.'))
      : resolve({ address: name, coordinates: coordinate(name), place_name: '', source: { kind: 'google_places', place_id: id } })));
  }));
  const optimizer = [];
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    const { drivers, passengers, destination } = JSON.parse(options.body);
    optimizer.push(() => resolve({ ok: true, status: 200, json: async () => ({ optimizedRoutes: [[drivers[0].location, ...passengers, destination]] }) }));
  });
  const release = (list) => { list.splice(Math.floor(rand() * list.length), 1)[0](); };

  // What the person meant, in order, by trip and field. `status` is confirmed once shown as saved, failed once
  // shown as not saved, and open until then; a change made elsewhere is simply true.
  const meant = new Map();
  const intend = (id, field, value, by = 'here') => {
    if (!meant.has(id)) meant.set(id, new Map());
    const fields = meant.get(id);
    if (!fields.has(field)) fields.set(field, []);
    // A new trip whose save failed keeps later changes for its Retry: nothing carries them until then.
    const entry = { value, seq, by, status: by !== 'here' ? 'confirmed' : server.heldBack.has(id) ? 'failed' : 'open' };
    fields.get(field).push(entry);
    return entry;
  };
  const eachOpen = (id, visit) => meant.get(id)?.forEach((list) => list.filter((entry) => entry.status === 'open').forEach(visit));

  let auth = { status: 'authenticated', generation: 1, profile: { id: 'account' }, protectedRequest: server.protectedRequest };
  const map = {};
  mockSeen.edits.clear();
  mockSeen.route = null;
  const screen = render(<LocationInput auth={auth} map={map} />);
  const { container } = screen;
  const visible = (element) => !element.closest('[hidden]');
  const buttons = () => [...container.querySelectorAll('button')].filter(visible);
  const byText = (text) => buttons().find((element) => element.textContent.trim() === text);
  const byLabel = (prefix) => buttons().filter((element) => (element.getAttribute('aria-label') || '').startsWith(prefix));
  const press = (element) => { if (element && !element.disabled) { reach('press ' + (element.getAttribute('aria-label')?.split(' ').slice(0, 2).join(' ') || element.textContent.trim())); fireEvent.click(element); return true; } return false; };
  // My trips has a Retry of its own, for the list.
  const saveRetry = () => [...container.querySelectorAll('.trip-status-line button')].filter(visible).find((element) => element.textContent.trim() === 'Retry');
  const held = () => mockSeen.hook?.trip?.id || null;
  const tab = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const viewOpen = () => Boolean(container.querySelector('.trip-view'));
  const planRoute = () => (tab() === 'Plan trip' ? mockSeen.route : null);
  // What the person can see the save say, read from the status line itself.
  const shownPhase = () => {
    const line = [...container.querySelectorAll('.trip-status-line')].find(visible);
    if (!line) return null;
    if (line.querySelector('.trip-status-error')) return 'error';
    if (line.textContent.includes('Save this trip')) return 'unsaved';
    if (line.textContent.includes('Saving…')) return 'saving';
    if (line.textContent.includes('Saved as')) return 'saved';
    return line.querySelector('.saving-note') ? 'unsavable' : null;
  };
  // A trip loading into the planner cannot be changed from its view, as `inert` keeps a person out.
  const locked = () => {
    if (!container.querySelector('[inert]')) return false;
    reach('edit kept out during a load');
    return true;
  };
  const setField = (label, value) => {
    const input = container.querySelector(`[aria-label="${label}"]`);
    if (input) fireEvent.change(input, { target: { value } });
  };
  let viewed = null;
  let copyAttempt = null;
  // Edits in a trip view that failed, until the screen is seen to say so.
  const untold = [];
  const seenResults = new Set();
  // Edit trip is waiting, and going back should end that wait at once.
  let editing = false;
  let freed = false;
  let copying = false;
  let retriedFrom = null;
  const seeded = new Set();
  // Save as new trip names its trip the same way, but only Edit a copy promises not to repeat itself.
  const savedAsNew = new Set();
  const replaced = new Set();
  const offshoot = (id) => savedAsNew.has(id) || replaced.has(id) || Boolean(server.base.get(id)?.title.startsWith('Copy of'));
  let asNew = false;
  let lastHeld = null;
  let lastLoad = null;
  // Told to replace the planner's route, by the question asked over a route that failed to save.
  let replacing = false;
  const copiesSince = (from) => server.posted.slice(from).filter((row) => row.title.startsWith('Copy of') && !savedAsNew.has(row.id)).map((row) => row.id);

  // A change through a route on screen: in the planner it counts as saved once the planner says so; in a
  // trip the planner does not hold, the edit's own answer says.
  const editRoute = (field, value, change) => {
    const id = viewOpen() ? viewed : held();
    const tracked = viewOpen() && id !== held();
    const entry = id ? intend(id, field, value) : null;
    if (entry) entry.place = routeFields(mockSeen.route.result.inputs).place;
    const { generation } = auth;
    log(`edit ${id?.slice(0, 4)} ${field} = ${JSON.stringify(value)}`);
    Promise.resolve().then(change).then(() => { if (entry && tracked) entry.status = 'confirmed'; },
      () => { if (entry) entry.status = 'failed'; if (tracked) untold.push({ id, generation }); });
  };
  const namesOn = (route) => [...route.result.inputs.drivers, ...route.result.inputs.passengers];
  const renameTitle = (label, id, text) => {
    const commit = mockSeen.edits.get(label);
    const { writer } = mockSeen.hook;
    if (!commit || !writer) return false;
    // A row in My trips carries no ID on screen, so the trip it speaks for is read from the call it makes.
    const { update } = writer;
    let target = id;
    writer.update = (...args) => { target = args[0]; return update(...args); };
    const result = (async () => commit(text))();
    writer.update = update;
    if (!target) { result.catch(() => {}); return false; }
    const entry = intend(target, 'title', text);
    log(`rename ${target.slice(0, 4)} ${text}`);
    // My trips says so itself, beside the row.
    const inView = viewOpen() && label === 'Trip name';
    const { generation } = auth;
    result.then(() => { entry.status = 'confirmed'; }, () => { entry.status = 'failed'; if (inView) untold.push({ id: target, generation }); });
    return true;
  };

  const calculate = () => {
    if (!container.querySelector('[aria-label="Driver 1 location"]')?.value) {
      setField('Driver 1 location', PLACES[0]);
      setField('Driver 1 passenger seats', '2');
      setField('Pickup 1 location', PLACES[1]);
      setField('Passengers at pickup 1', '2');
    }
    if (rand() < 0.7 || !container.querySelector('[aria-label="Destination"]')?.value) setField('Destination', pick(PLACES.slice(2)));
    return press(byText('Calculate route'));
  };
  const someTrip = () => pick([...server.trips.keys()]);
  const actions = {
    calculate() { if (tab() === 'Plan trip') return calculate(); return press(byText('Plan trip')); },
    personHere() {
      const route = mockSeen.route;
      if (!route || (!viewOpen() && !planRoute()) || locked()) return false;
      const point = pick(namesOn(route));
      const name = pick(['', 'Mia', 'Alex', 'Sam']);
      editRoute('person:' + point.stop_id, name, () => route.onRename({ stopIds: [point.stop_id] }, name));
      return true;
    },
    arriveHere() {
      const route = mockSeen.route;
      if (!route || (!viewOpen() && !planRoute()) || locked()) return false;
      const value = pick(['', '2099-11-05T18:45', '2099-11-06T19:00']);
      editRoute('arrive', value, () => route.onArriveBy(value));
      return true;
    },
    destinationHere() {
      const route = mockSeen.route;
      if (!route || (!viewOpen() && !planRoute()) || locked()) return false;
      const value = pick(['Dinner spot', 'The usual', '']);
      editRoute('dest', value, () => route.onRename({ destination: true }, value));
      return true;
    },
    titleHere() { return !locked() && renameTitle('Trip name', viewOpen() ? viewed : held(), `Named ${seq}`); },
    myTrips() { return tab() !== 'My trips' && press(byText('My trips')); },
    refresh() { return press(byText('Refresh')); },
    open() {
      const open = pick(byLabel('Open '));
      // The trip whose save failed is the one a person goes to look at.
      const title = mockSeen.save?.trip?.title;
      const failed = mockSeen.save?.phase === 'error' && title && byLabel('Open ' + title)[0];
      if (failed) {
        log(`open ${failed.getAttribute('aria-label')}`);
        return press(failed);
      }
      log(`open ${open?.getAttribute('aria-label')}`);
      return press(open);
    },
    titleInList() {
      const labels = [...mockSeen.edits.keys()].filter((label) => label.startsWith('Name of trip '));
      return renameTitle(pick(labels), null, `Listed ${seq}`);
    },
    remove() {
      const row = pick(byLabel('Delete '));
      if (byLabel('Confirm delete ').length) return false;
      return Boolean(row) && press(row);
    },
    confirmRemove() {
      const confirm = byLabel('Confirm delete ')[0];
      log(`delete ${confirm?.getAttribute('aria-label')}`);
      return press(confirm);
    },
    back() {
      if (!viewOpen()) return false;
      freed = editing;
      if (editing) reach('back during edit trip');
      if (copying) reach('back during a copy');
      return press(container.querySelector('.trip-view-back'));
    },
    editTrip() {
      if (!viewOpen() || !byText('Edit trip') || byText('Edit trip').disabled) return false;
      log(`edit trip ${viewed?.slice(0, 4)}`);
      if (mockSeen.save?.phase === 'error' && viewed === held()) reach('edit trip after a failed save');
      if (viewed) eachOpen(viewed, (entry) => { if (server.faultAt(viewed, 'route') >= entry.seq) entry.status = 'failed'; });
      lastLoad = 'edit';
      editing = press(byText('Edit trip'));
      return editing;
    },
    editCopy() {
      if (!viewOpen() || !byText('Edit a copy') || byText('Edit a copy').disabled) return false;
      log(`edit a copy of ${viewed?.slice(0, 4)}`);
      const again = copyAttempt?.failed && copyAttempt.source === viewed;
      // Pressing it asks for that copy, even one saved by an earlier press and deleted elsewhere since.
      if (again) { reach('copy retried'); copiesSince(copyAttempt.first).forEach(server.retry); }
      copyAttempt = { source: viewed, from: server.posted.length, first: again ? copyAttempt.first : server.posted.length, seq, failed: false,
        made: again ? copiesSince(copyAttempt.from) : [] };
      editing = false;
      lastLoad = 'copy';
      copying = press(byText('Edit a copy'));
      return copying;
    },
    answerRetry() {
      if (byText('Replace it') && byText('Save this trip')) return press(byText('Save this trip'));
      if (!byText('Retry save')) return false;
      server.retry(held());
      return press(byText('Retry save'));
    },
    answerReplace() {
      if (!byText('Replace it')) return false;
      replacing = true;
      editing = lastLoad === 'edit';
      copying = lastLoad === 'copy';
      if (held()) eachOpen(held(), (entry) => { entry.status = 'failed'; });
      return press(byText('Replace it'));
    },
    answerCancel() { return press(byText('Cancel')); },
    startOver() { return press(byText('Start over')); },
    undo() { return press(byText('Undo')); },
    retry() {
      if (!saveRetry() || locked()) return false;
      server.retry(held());
      retriedFrom = held();
      return press(saveRetry());
    },
    saveAgain() { return press(byText('Save this trip')); },
    saveAsNew() { asNew = press(byText('Save as new trip')); return asNew; },
    elsewhere() {
      const id = someTrip();
      if (!id || rand() > 0.3) return false;
      if (rand() < 0.5) {
        const title = `From the phone ${seq}`;
        server.elsewhere(id, { title });
        intend(id, 'title', title, 'elsewhere');
      } else {
        const point = pick(server.trips.get(id).snapshot.inputs.passengers);
        const name = pick(['Dad', '']);
        server.elsewhere(id, { person: { id: point.stop_id, name } });
        intend(id, 'person:' + point.stop_id, name, 'elsewhere');
      }
      log(`elsewhere ${id.slice(0, 4)}`);
      return true;
    },
    deleteElsewhere() {
      const id = someTrip();
      if (!id || rand() > 0.1) return false;
      server.trips.delete(id);
      server.markDeleted(id);
      // Its names went with it: a Retry that saves the trip again has only what the planner holds.
      meant.get(id)?.delete('title');
      log(`deleted elsewhere ${id.slice(0, 4)}`);
      return true;
    },
    account() {
      if (rand() > 0.03) return false;
      log('account changes');
      // What is already sent still lands, before anything the next sign-in sends: nothing cancels a write,
      // so a late one could otherwise land after a newer one, as from a second device.
      while (server.waiting.length) server.process(server.waiting.shift());
      changeAuth({ ...auth, generation: auth.generation + 1 });
      return true;
    },
    signIn() {
      if (auth.status === 'authenticated') return false;
      log('signs in again');
      changeAuth({ status: 'authenticated', generation: auth.generation + 1, profile: { id: 'account' }, protectedRequest: server.protectedRequest });
      return true;
    },
  };
  function changeAuth(next) {
    auth = next;
    meant.forEach((fields, id) => server.allFailed(id, seq));
    screen.rerender(<LocationInput auth={auth} map={map} />);
    viewed = null;
  }
  server.expire = () => {
    log('sign-in expires');
    reach('sign-in expired');
    while (server.waiting.length) server.process(server.waiting.shift());
    server.replies.splice(0).forEach((entry) => entry.reject(new DOMException('Authentication changed.', 'AbortError')));
    changeAuth({ status: 'anonymous', generation: auth.generation + 1, profile: null, protectedRequest: async () => { throw new Error('Sign in required.'); } });
  };
  // A copy opens holding what its trip held when Edit a copy was last pressed, however many presses it took.
  const checkCopy = (id, planned) => {
    const source = copyAttempt && server.trips.get(copyAttempt.source);
    if (!source || copyAttempt.checked || !copiesSince(copyAttempt.first).includes(id)) return;
    copyAttempt.checked = true;
    const changed = [...(meant.get(source.id)?.values() || [])].flat().some((entry) => entry.seq >= copyAttempt.seq);
    if (changed || server.editedSomewhere.has(source.id) || server.faultAt(source.id, 'route') >= copyAttempt.seq) return;
    reach('copy compared with its trip');
    const made = routeFields(planned.inputs);
    Object.entries(routeFields(source.snapshot.inputs)).forEach(([field, value]) => {
      if (value !== made[field]) problems.push(`the copy ${id.slice(0, 4)} has ${field} as ${JSON.stringify(made[field])}, and its trip has ${JSON.stringify(value)}`);
    });
  };
  // A route not saved, or that cannot be, is replaced only when the person says so; one that landed anyway has nothing to lose.
  mockSeen.onReplace = () => {
    const told = replacing;
    replacing = false;
    // The planner's status line is not on screen under a trip view, so this reads what it last rendered.
    const failed = ['error', 'unsavable', 'unsaved'].includes(mockSeen.save?.phase);
    // The trip as the server last confirmed it, whatever has happened to it elsewhere since.
    const confirmed = mockSeen.hook.writer?.known(held());
    const landed = confirmed && mockSeen.hook.result && JSON.stringify(routeFields(confirmed.snapshot.inputs)) === JSON.stringify(routeFields(mockSeen.hook.result.inputs));
    if (failed && !landed && !told) problems.push(`a route showing ${mockSeen.save.phase} was replaced without asking`);
    if (failed && told) reach(`replaced a route showing ${mockSeen.save.phase} when told to`);
  };
  // Saved trips are what this tests, so getting to one, and acting on it, come up more often.
  const names = [...Object.keys(actions), 'open', 'open', 'open', 'myTrips', 'retry', 'retry', 'confirmRemove', 'confirmRemove', 'confirmRemove'];
  const here = ['personHere', 'personHere', 'arriveHere', 'arriveHere', 'destinationHere', 'titleHere', 'titleHere'];
  const inTrip = [...here, 'editTrip', 'editTrip', 'editTrip', 'editTrip', 'editCopy', 'editCopy', 'editCopy', 'back'];
  // A failed save sends a person to the trip, to edit it or copy it, before or instead of pressing Retry.
  const afterFailure = ['myTrips', 'myTrips', 'myTrips', 'open', 'open', 'open', 'open', 'editTrip', 'editTrip', 'editTrip', 'editTrip', 'editCopy'];
  const answers = ['answerRetry', 'answerRetry', 'answerReplace', 'answerReplace', 'answerCancel'];
  const choices = () => {
    if (byText('Replace it')) return [...names, ...answers, ...answers, ...answers, ...answers];
    if (auth.status !== 'authenticated') return [...names, 'signIn', 'signIn', 'signIn', 'signIn', 'signIn', 'signIn', 'signIn', 'signIn'];
    if (mockSeen.save?.phase === 'error' && held() && (!viewOpen() || viewed === held())) return [...names, ...afterFailure, ...afterFailure, ...afterFailure, ...afterFailure];
    if (['unsavable', 'unsaved'].includes(mockSeen.save?.phase)) return [...names, ...afterFailure, ...afterFailure];
    return viewOpen() ? [...names, ...inTrip, ...inTrip, ...inTrip] : planRoute() ? [...names, ...here, ...here] : names;
  };

  // What the screen said after each step decides how far each change got.
  const observe = () => {
    if (!viewOpen()) { viewed = null; editing = false; } else if (!viewed) viewed = server.opened;
    const calculateButton = container.querySelector('.submit-btn');
    const loadingCopy = copying;
    if (!calculateButton?.disabled) { copying = false; editing = false; }
    if (freed && !viewOpen() && calculateButton?.disabled) problems.push('going back left the planner busy');
    freed = false;
    const { hook } = mockSeen;
    const id = held();
    if (retriedFrom && id !== retriedFrom && server.trips.has(retriedFrom)) problems.push(`Retry saved ${retriedFrom.slice(0, 4)} again as a second trip`);
    retriedFrom = null;
    if (asNew) { savedAsNew.add(id); asNew = false; }
    // A trip saved in place of one deleted elsewhere starts afresh with the same stops.
    if (id && id !== lastHeld) {
      if (lastHeld && !server.trips.has(lastHeld)) replaced.add(id);
      lastHeld = id;
    }
    const planned = hook?.result;
    const phase = shownPhase();
    if (phase) reach('phase ' + phase);
    if (viewOpen()) reach('view open');
    if (byText('Replace it')) reach('asked before replacing a route');
    // A failed edit shows in its view; one that failed once the view had gone says so above the tabs. A trip
    // deleted, or an account left, has nothing to report.
    untold.splice(0).forEach(({ id: trip, generation }) => {
      if ((viewOpen() && viewed === trip) || !server.trips.has(trip) || generation !== auth.generation) return;
      if (container.textContent.includes('The change to ')) reach('a failed edit said so after its view closed');
      else problems.push(`an edit to ${trip.slice(0, 4)} failed and nobody was told`);
    });
    // Who saw a read arrive late: a writer in use keeps a newer copy, and a read that ties a save loses to it.
    if (hook?.writer && !hook.writer.watched) {
      hook.writer.watched = true;
      const { remember } = hook.writer;
      hook.writer.remember = (trip) => {
        const before = hook.writer.known(trip.id);
        const kept = remember(trip);
        if (before && kept === before && before.updated_at > trip.updated_at) reach('a stale read overtook a save');
        if (before && kept === before && before.updated_at === trip.updated_at && before.title !== trip.title) reach('a read tied a save and lost');
        if (before && kept === trip && before.updated_at === trip.updated_at) reach('timestamp tie');
        return kept;
      };
    }
    if (planned?.origin === 'calculated' && planned.snapshot && !seenResults.has(planned.id)) {
      seenResults.add(planned.id);
      log(`calculated route for ${id?.slice(0, 4)}: ${planned.id.slice(0, 4)} ${routeFields(planned.inputs).place}`);
      if (id) {
        const fields = routeFields(planned.inputs);
        meant.get(id)?.forEach((list, field) => { if (field !== 'title' && !(field in fields)) fields[field] = ''; });
        Object.entries(fields).forEach(([field, value]) => intend(id, field, value));
      }
    }
    // However a trip came to be held (a copy, Save as new, a Retry of a route let go), it should hold what is shown.
    if (id && planned?.snapshot && !seeded.has(id)) {
      seeded.add(id);
      if (loadingCopy) checkCopy(id, planned);
      // What a trip was loaded with is no one's change, so it replaces nothing made elsewhere.
      Object.entries(routeFields(planned.inputs)).forEach(([field, value]) => { intend(id, field, value).loaded = true; });
    }
    // Saved speaks for what has not failed since: a trip loaded again shows Saved without carrying a refused edit.
    // A value that failed and is shown as saved after all, by a Retry, is required again.
    if (id && phase === 'saved') {
      const shown = routeFields(planned.inputs);
      meant.get(id)?.forEach((list, field) => {
        list.filter((entry) => entry.status === 'open' && server.faultAt(id, field) < entry.seq).forEach((entry) => { entry.status = 'confirmed'; });
        const last = list[list.length - 1];
        if (last.status === 'failed' && field !== 'title' && last.value === shown[field]) last.status = 'confirmed';
      });
    }
    if (id && (phase === 'error' || phase === 'unsavable')) eachOpen(id, (entry) => { entry.status = 'failed'; });
    if (phase === 'saved' && id) checkSaved(id);
    checkView();
    if (copyAttempt && container.textContent.includes('The copy was not saved')) copyAttempt.failed = true;
    // A press that failed but left a copy on the server: the next press uses that copy.
    if (copyAttempt?.made.length && copiesSince(copyAttempt.from).some((row) => !copyAttempt.made.includes(row))) {
      problems.push('a second press of Edit a copy after a failure made a second copy');
    }
  };
  // Nothing is on its way for this trip, here or at the server.
  const quiet = (id) => !mockSeen.hook.writer?.queued(id) && ![...server.waiting, ...server.replies].some((entry) => entry.request.id === id);
  const elsewhereWon = (trip, field) => {
    const list = meant.get(trip)?.get(field) || [];
    const anchor = [...list].reverse().find((entry) => !entry.loaded && (entry.status === 'confirmed' || (entry.status === 'open' && server.faultAt(trip, field) < entry.seq)));
    return anchor?.by === 'elsewhere';
  };
  const sawElsewhere = (trip, field) => (meant.get(trip)?.get(field) || []).some((entry) => entry.by === 'elsewhere');
  // A change elsewhere nothing confirmed here has replaced: the trip here is not told of it.
  const elsewhereStands = (trip, field) => {
    const list = meant.get(trip)?.get(field) || [];
    const last = list.map((entry) => entry.by).lastIndexOf('elsewhere');
    return last >= 0 && !list.slice(last + 1).some((entry) => entry.status === 'confirmed' && !entry.loaded);
  };
  // A route shown as saved is the route on the server, and its name is the server's.
  function checkSaved(id) {
    const { hook, save } = mockSeen;
    if (!hook.result || !server.trips.has(id) || !quiet(id)) return;
    // After a lost reply only what that write carried is unknown.
    const unsure = (field) => elsewhereStands(id, field) || (hook.writer?.uncertain(id) && server.faultAt(id, field) >= 0);
    const stored = tripFields(server.trips.get(id));
    const shown = routeFields(hook.result.inputs);
    Object.keys(shown).filter((field) => !unsure(field)).forEach((field) => {
      if (shown[field] !== (stored[field] ?? '')) problems.push(`Saved, but ${field} shows ${JSON.stringify(shown[field])} and the server has ${JSON.stringify(stored[field])}`);
    });
    if (!unsure('title') && save.trip?.title !== stored.title) problems.push(`Saved as ${JSON.stringify(save.trip?.title)}, but the server has ${JSON.stringify(stored.title)}`);
  }
  // An open trip shows what the server has, unless a failure there is on screen or a reply was lost.
  function checkView() {
    const route = mockSeen.route;
    if (!viewOpen() || !viewed || !route || !server.trips.has(viewed) || !quiet(viewed)) return;
    if (container.querySelector('.trip-view [role="alert"], .trip-view .trip-status-line, .trip-view .saving-error') || server.faultAt(viewed, 'route') >= 0) return;
    reach('trip view checked');
    const stored = tripFields(server.trips.get(viewed));
    const shown = routeFields(route.result.inputs);
    Object.keys(shown).filter((field) => !sawElsewhere(viewed, field) && field !== 'place').forEach((field) => {
      if (shown[field] !== (stored[field] ?? '')) problems.push(`the open trip shows ${field} as ${JSON.stringify(shown[field])}, and the server has ${JSON.stringify(stored[field])}`);
    });
  }
  const step = async (work) => {
    seq += 1;
    server.seq = seq;
    await act(async () => { work(); });
    observe();
  };

  // Everything still on its way comes back, with no more actions.
  const settle = async () => {
    for (let round = 0; round < 800 && (server.busy() || lookups.length || optimizer.length); round += 1) {
      // eslint-disable-next-line no-await-in-loop
      await step(() => {
        if (server.busy()) server.advance();
        if (lookups.length) release(lookups);
        if (optimizer.length) release(optimizer);
      });
    }
    // A reply's last consequences take more than one turn of the event loop.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    observe();
  };

  // A person who sees Not saved goes to that trip and carries on from it: the path that showed an old
  // route's Retry saving over what the planner now shows.
  const revisit = async () => {
    reach('went back to a failed trip');
    await step(() => { actions.myTrips(); });
    await settle();
    await step(() => { actions.open(); });
    await settle();
    const refused = ['unsavable', 'unsaved'].includes(mockSeen.save?.phase);
    if (!viewOpen() || (viewed !== held() && !refused)) return;
    reach('opened a failed trip');
    await step(() => { if (rand() < 0.75) actions.editTrip(); else actions.editCopy(); });
    await settle();
  };

  let actionsDone = 0;
  try {
    // Most sequences start from a saved trip, open in My trips or held in the planner; the rest start empty.
    const start = rand();
    if (start < 0.8) {
      await step(() => { calculate(); });
      await settle();
    }
    if (start < 0.55) {
      await step(() => { actions.myTrips(); });
      await settle();
      await step(() => { actions.open(); });
      await settle();
    }
    for (let index = 0; index < STEPS; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (((mockSeen.save?.phase === 'error' && held()) || ['unsavable', 'unsaved'].includes(mockSeen.save?.phase)) && rand() < 0.2) await revisit();
      const roll = rand();
      // eslint-disable-next-line no-await-in-loop
      await step(() => {
        if (server.busy() && roll < 0.4) server.advance();
        else if (lookups.length && roll < 0.5) release(lookups);
        else if (optimizer.length && roll < 0.6) release(optimizer);
        else {
          // Anything can come up; what is not on screen right now gives way to what is.
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const name = pick(choices());
            if (actions[name]()) { log(`step ${index}: ${name} trip=${held()?.slice(0, 4)} view=${viewed?.slice(0, 4)} phase=${mockSeen.save?.phase}`); reach('did ' + name); actionsDone += 1; break; }
          }
        }
      });
    }
    await settle();
    // The person sees Not saved and presses Retry, and this time nothing goes wrong.
    server.calm = true;
    await step(() => { press(byText('Plan trip')); });
    for (let round = 0; round < 3 && shownPhase() === 'error'; round += 1) {
      server.retry(held());
      // eslint-disable-next-line no-await-in-loop
      await step(() => { press(saveRetry()); });
      await settle(); // eslint-disable-line no-await-in-loop
    }
    await step(() => {});

    const { hook } = mockSeen;
    const phase = shownPhase();
    if (server.busy()) problems.push('requests still waiting after settling');
    if (phase === 'saving') problems.push('the planner still says Saving… with nothing left to do');
    if (phase === 'error') problems.push('Retry was pressed with nothing failing, and it still says Not saved');
    if (container.querySelector('.submit-btn')?.disabled) problems.push('the planner is still busy with nothing left to do');
    if (hook.writer?.queued() > 0) problems.push(`the writer kept ${hook.writer.queued()} queues after settling`);
    if (server.requests > actionsDone * 8 + 60) problems.push(`${server.requests} requests for ${actionsDone} actions`);

    // Each trip holds what its person last meant: the last change confirmed, or anything tried since that
    // failed where the failure was shown. A change on another device is true until something meant replaces it.
    server.trips.forEach((stored, trip) => {
      const actual = tripFields(stored);
      meant.get(trip)?.forEach((list, field) => {
        const allowed = new Set();
        let anchored = false;
        for (let at = list.length - 1; at >= 0 && !anchored; at -= 1) {
          const entry = list[at];
          // A destination's name only applies while the trip still goes to the place it was given for.
          if (field === 'dest' && entry.place && entry.place !== actual.place) continue; // eslint-disable-line no-continue
          allowed.add(entry.value);
          anchored = entry.status === 'confirmed' || (entry.status === 'open' && server.faultAt(trip, field) < entry.seq);
        }
        if (!anchored) allowed.add(server.base.get(trip)?.[field]);
        // Later-write-wins between devices, by decision: a trip open here is not told of an edit on the other one.
        if (elsewhereWon(trip, field)) { list.forEach((entry) => allowed.add(entry.value)); allowed.add(server.base.get(trip)?.[field]); }
        if (field === 'title' && !anchored && !list.some((entry) => entry.status === 'confirmed')) return; // An automatic title, checked below.
        if (field === 'title' && elsewhereWon(trip, field)) return; // A follow from the older title is that same case.
        if (!allowed.has(actual[field] ?? '') && !allowed.has(actual[field])) {
          problems.push(`${trip.slice(0, 4)} ${field} is ${JSON.stringify(actual[field])}, but was meant to be ${JSON.stringify([...allowed])}`);
          log(`meant ${field}: ${JSON.stringify(list)} faults at ${server.faults.get(trip)}`);
        }
      });
    });
    // What the writer remembers is what the server has.
    if (hook.writer) {
      server.trips.forEach((stored, trip) => {
        const known = hook.writer.known(trip);
        if (!known || hook.writer.uncertain(trip)) return;
        const remembered = tripFields(known);
        const actual = tripFields(stored);
        Object.keys({ ...remembered, ...actual }).filter((field) => !sawElsewhere(trip, field))
          .forEach((field) => { if ((remembered[field] ?? '') !== (actual[field] ?? '')) problems.push(`the writer remembers ${field} of ${trip.slice(0, 4)} as ${JSON.stringify(remembered[field])}, the server has ${JSON.stringify(actual[field])}`); });
      });
    }
    // One planning session is one trip, however its saves went; only a copy or Save as new makes another.
    const sessions = new Map();
    server.trips.forEach((stored, trip) => {
      if (offshoot(trip)) return;
      const session = stored.snapshot.inputs.drivers[0].stop_id;
      if (sessions.has(session)) problems.push(`${trip.slice(0, 4)} and ${sessions.get(session).slice(0, 4)} are the same route saved twice`);
      sessions.set(session, trip);
    });
    // An automatic name says where and when the trip is, and a copy's stays as it was made.
    server.trips.forEach((stored, trip) => {
      if (meant.get(trip)?.get('title')?.length || server.faultAt(trip, 'title') >= 0) return;
      const base = server.base.get(trip)?.title;
      if (base?.startsWith('Copy of')) { if (stored.title !== base) problems.push(`the copy ${trip.slice(0, 4)} changed name to ${stored.title}`); return; }
      const { destination, arrive_by: arriveBy } = stored.snapshot.inputs;
      const expected = titleFromFacts(titleFacts({ inputs: { destination: { ...destination, address: nameOf(destination.source.place_id) }, arrive_by: arriveBy } }), new Date(stored.created_at));
      if (stored.title !== expected) problems.push(`the automatic name of ${trip.slice(0, 4)} is ${JSON.stringify(stored.title)}, not ${JSON.stringify(expected)}`);
    });
  } catch (error) {
    problems.push(`crashed: ${error.message}`);
  }
  screen.unmount();
  delete global.fetch;
  return problems;
}

it(`keeps saved trips as meant across ${SEEDS} random sequences of edits, failures and late replies`, async () => {
  const failures = [];
  for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
    // eslint-disable-next-line no-await-in-loop
    const problems = await runSequence(seed);
    if (problems.length) failures.push(`seed ${seed}: ${[...new Set(problems)].join('; ')}`);
  }
  // eslint-disable-next-line no-console
  if (process.env.COVER) console.log(JSON.stringify(cover, null, 1));
  expect(failures).toEqual([]);
  // A run that never reached these would pass without testing them.
  if (SEEDS >= 60) {
    ['did editTrip', 'did editCopy', 'did back', 'did confirmRemove', 'did retry', 'did personHere', 'did titleHere', 'did titleInList', 'did elsewhere',
      'did account', 'did saveAsNew', 'server DELETE 204', 'server PATCH 200', 'phase error', 'edit trip after a failed save', 'opened a failed trip',
      'back during edit trip', 'back during a copy', 'edit kept out during a load', 'trip view checked', 'sign-in expired',
      ...(SEEDS >= 1000 ? ['copy retried', 'copy compared with its trip', 'phase unsavable', 'asked before replacing a route', 'replaced a route showing error when told to', 'replaced a route showing unsavable when told to', 'replaced a route showing unsaved when told to',
        'a failed edit said so after its view closed',
        'did answerRetry', 'did answerReplace', 'did answerCancel', 'a stale read overtook a save', 'a read tied a save and lost', 'timestamp tie'] : [])]
      .forEach((what) => expect([what, cover[what] > 0]).toEqual([what, true]));
  }
}, Math.max(60000, SEEDS * 500));
