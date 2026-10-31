import { TextEncoder } from 'util';
import { arriveByChange, expandPassengerPickups, freezeInputs, groupPassengerPickups, makeResult, nameChange, newPassengerPickup,
  renameInResult, renameInSnapshot, renamePoints, reopenSnapshot, resizePickup, validArriveBy } from './tripSnapshot';

beforeAll(() => {
  global.TextEncoder = TextEncoder;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
});
const point = (stop_id, lat, place_id = stop_id, label = '') => ({ stop_id, label, address: 'Synthetic private address', coordinates: { lat, lng: 2 }, source: { kind: 'google_places', place_id } });
const fixture = () => ({ drivers: [{ ...point('d1', 1), capacity: 2 }, { ...point('d2', 2), capacity: 2 }], passengers: [point('p1', 3, 'shared', 'Team'), point('p2', 3, 'shared', 'Team')], destination: point('end', 4) });
const routesFor = (inputs) => [[inputs.drivers[0].coordinates, inputs.passengers[0].coordinates, inputs.destination.coordinates], [inputs.drivers[1].coordinates, inputs.passengers[1].coordinates, inputs.destination.coordinates]];

it('retains occurrence identities across shrink and regrowth and expands independent people', () => {
  let row = newPassengerPickup();
  row = { ...row, ...resizePickup(row, 3) };
  const original = [...row.occurrenceIds];
  row = { ...row, ...resizePickup(row, 1) };
  expect(expandPassengerPickups([row]).map(p => p.stop_id)).toEqual(original.slice(0, 1));
  row = { ...row, ...resizePickup(row, 4) };
  expect(row.occurrenceIds.slice(0, 3)).toEqual(original);
  const people = expandPassengerPickups([row]);
  expect(new Set(people.map(p => p.stop_id)).size).toBe(4);
  expect(people.every(p => !('count' in p) && !('occurrenceIds' in p))).toBe(true);
});

it.each([0, -1, 1.5, 13, NaN, Infinity, '2'])('rejects invalid pickup count %s', count => {
  expect(() => expandPassengerPickups([{ ...newPassengerPickup(), count }])).toThrow(/whole number/);
});
it('enforces the aggregate twelve-person bound even for individually valid rows', () => {
  const rows = [newPassengerPickup(), newPassengerPickup()].map(row => ({ ...row, ...resizePickup(row, 7) }));
  expect(() => expandPassengerPickups(rows)).toThrow(/at most 12/);
  rows[1] = { ...rows[1], ...resizePickup(rows[1], 5) };
  expect(expandPassengerPickups(rows)).toHaveLength(12);
});
it('rejects missing or overlapping occurrence identities', () => {
  expect(() => expandPassengerPickups([{ ...newPassengerPickup(), count: 2 }])).toThrow(/incomplete/);
  const row = newPassengerPickup();
  expect(() => expandPassengerPickups([row, row])).toThrow(/overlap/);
});
it('groups by place identity and label, retaining all stored occurrence identities', () => {
  const rows = [point('p1', 1, 'same', 'Team'), point('p2', 9, 'same', 'Team'), point('p3', 1, 'same', 'Other'), point('p4', 1, 'other', 'Team')];
  const grouped = groupPassengerPickups(rows);
  expect(grouped.map(row => row.count)).toEqual([2, 1, 1]);
  expect(expandPassengerPickups(grouped).map(row => row.stop_id)).toEqual(['p1', 'p2', 'p3', 'p4']);
});
it('freezes calculated inputs and emits only place references despite later form edits', () => {
  const form = fixture();
  const frozen = freezeInputs(form.drivers, form.passengers, form.destination);
  const result = makeResult(frozen, routesFor(frozen));
  const saved = JSON.stringify(result.snapshot);
  form.passengers[0].label = 'Edited'; form.passengers[0].coordinates.lat = 80;
  form.drivers[0].capacity = 10; form.destination.source.place_id = 'Changed';
  expect(JSON.stringify(result.snapshot)).toBe(saved);
  expect(result.inputs.passengers[0].label).toBe('Team');
  expect(result.inputs.passengers[0].coordinates.lat).toBe(3);
  result.snapshot.inputs.passengers.forEach(row => expect(Object.keys(row).sort()).toEqual(['label', 'source', 'stop_id']));
  expect(saved).not.toMatch(/coordinates|address|count|occurrenceIds/);
});
it('permits displaying a manual-coordinate result but explains why it cannot be saved', () => {
  const inputs = fixture(); inputs.passengers[0].source = null;
  const result = makeResult(inputs, routesFor(inputs));
  expect(result.snapshot).toBeNull(); expect(result.saveError).toMatch(/Google suggestion/);
  expect(result.coordinates).toHaveLength(2);
});
it('consumes interior passengers at coincident endpoints without losing occurrences', () => {
  const inputs = fixture(); inputs.passengers.forEach(p => { p.coordinates = { ...inputs.drivers[0].coordinates }; });
  const result = makeResult(inputs, routesFor(inputs));
  expect(result.snapshot.routes.map(row => row.stop_ids)).toEqual([['d1', 'p1', 'end'], ['d2', 'p2', 'end']]);
});
it.each(['missing', 'unexpected', 'endpoint', 'capacity'])('rejects invalid calculated routes: %s', kind => {
  const inputs = fixture(); const routes = routesFor(inputs);
  if (kind === 'missing') routes[0].splice(1, 1);
  if (kind === 'unexpected') routes[0][1] = { lat: 88, lng: 2 };
  if (kind === 'endpoint') routes[0][0] = { lat: 88, lng: 2 };
  if (kind === 'capacity') { routes[0].splice(1, 0, inputs.passengers[1].coordinates); inputs.drivers[0].capacity = 1; }
  expect(() => makeResult(inputs, routes)).toThrow();
});
it('reopens with one fresh lookup per place and preserves authoritative assignments at equal coordinates', async () => {
  const inputs = fixture(); const snapshot = makeResult(inputs, routesFor(inputs)).snapshot;
  snapshot.routes = [{ driver_id: 'd1', stop_ids: ['d1', 'p2', 'end'] }, { driver_id: 'd2', stop_ids: ['d2', 'p1', 'end'] }];
  const lookup = jest.fn(async () => ({ address: 'Fresh address', coordinates: { lat: 0, lng: 0 } }));
  const result = await reopenSnapshot(snapshot, lookup);
  expect(lookup.mock.calls.map(args => args[0])).toEqual(['d1', 'd2', 'shared', 'end']);
  expect(result.snapshot.routes).toEqual(snapshot.routes);
  expect(result.snapshot).not.toBe(snapshot);
  expect(result.inputs.passengers[0]).toMatchObject({ stop_id: 'p1', label: 'Team', address: 'Fresh address' });
  expect(groupPassengerPickups(result.inputs.passengers)[0].count).toBe(2);
  expect(result.snapshot.routes[0].stop_ids[1]).toBe('p2');
});
it.each(['duplicate', 'missing', 'invalid-coordinate', 'lookup-failure'])('rejects unsafe reopened result: %s', async kind => {
  const inputs = fixture(); const snapshot = makeResult(inputs, routesFor(inputs)).snapshot;
  if (kind === 'duplicate') snapshot.routes[1].stop_ids[1] = 'p1';
  if (kind === 'missing') snapshot.routes[1].stop_ids.splice(1, 1);
  const lookup = jest.fn(async () => {
    if (kind === 'lookup-failure') throw new Error('Unavailable');
    return { coordinates: { lat: kind === 'invalid-coordinate' ? 91 : 0, lng: 0 } };
  });
  await expect(reopenSnapshot(snapshot, lookup)).rejects.toThrow();
});

// Trips that follow My locations, and the names people give stops on one trip.
const HOME = '11111111-1111-4111-8111-111111111111';
const OFFICE = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const linkedResult = () => {
  const inputs = fixture();
  inputs.drivers[0].saved_id = HOME;
  inputs.passengers.forEach((row) => { row.saved_id = OFFICE; });
  inputs.destination.saved_id = 'not-a-uuid';
  return makeResult(inputs, routesFor(inputs));
};
// A plain function: the test setup resets jest.fn implementations before each test.
const fresh = async (placeId) => ({ address: 'Fresh ' + placeId, coordinates: { lat: 0, lng: 0 } });

it('saves the saved-location ID of a stop picked from My locations, never a malformed one', () => {
  const { snapshot } = linkedResult();
  expect(snapshot.inputs.drivers[0].location_id).toBe(HOME);
  expect(snapshot.inputs.passengers.map((row) => row.location_id)).toEqual([OFFICE, OFFICE]);
  expect(snapshot.inputs.destination).not.toHaveProperty('location_id');
  expect(snapshot.inputs.drivers[1]).not.toHaveProperty('location_id');
  expect(JSON.stringify(snapshot)).not.toContain('saved_id');
});

it('reopens linked stops against the owner\'s locations: moved, deleted, foreign, or list not loaded', async () => {
  const { snapshot } = linkedResult();
  const owner = [{ id: HOME, label: 'Home base', source: { kind: 'google_places', place_id: 'new-home' } },
    { id: OFFICE, label: 'Team', source: { kind: 'google_places', place_id: 'shared' } }];
  const moved = await reopenSnapshot(snapshot, fresh, owner);
  expect(moved.changed).toBe(true);
  expect(moved.moved).toEqual(['d1']);
  expect(moved.inputs.drivers[0]).toMatchObject({ label: 'Home base', saved_id: HOME, source: { place_id: 'new-home' }, address: 'Fresh new-home' });
  expect(moved.inputs.passengers[0]).toMatchObject({ saved_id: OFFICE, label: 'Team' });
  expect(moved.assignments).toEqual(snapshot.routes.map((route) => route.stop_ids));
  // Deleted, or never this owner's: the stored place and label, unlinked.
  const missing = await reopenSnapshot(snapshot, fresh, [{ id: GONE, label: 'Other', source: { kind: 'google_places', place_id: 'x' } }]);
  expect(missing.changed).toBe(false);
  expect(missing.inputs.drivers[0]).toMatchObject({ label: '', saved_id: null, source: { place_id: 'd1' } });
  expect(missing.inputs.passengers[0]).toMatchObject({ label: 'Team', saved_id: null });
  // Unknown list: the stored place, with the link kept for later.
  const unknown = await reopenSnapshot(snapshot, fresh, null);
  expect(unknown.changed).toBe(false);
  expect(unknown.inputs.drivers[0]).toMatchObject({ saved_id: HOME, source: { place_id: 'd1' } });
});

it('keeps person names through saving and reopening, even when a linked place is refreshed', async () => {
  const inputs = fixture();
  inputs.drivers[0].person = '  Sam ';
  inputs.drivers[0].saved_id = HOME;
  inputs.passengers.forEach((row) => { row.person = 'Mia and Alex'; });
  inputs.destination.person = 'Not a person';
  const { snapshot } = makeResult(inputs, routesFor(inputs));
  expect(snapshot.inputs.drivers[0].person).toBe('Sam');
  expect(snapshot.inputs.passengers.map((row) => row.person)).toEqual(['Mia and Alex', 'Mia and Alex']);
  expect(snapshot.inputs.destination).not.toHaveProperty('person');
  const reopened = await reopenSnapshot(snapshot, fresh,
    [{ id: HOME, label: 'Home base', source: { kind: 'google_places', place_id: 'new-home' } }]);
  expect(reopened.inputs.drivers[0]).toMatchObject({ person: 'Sam', label: 'Home base' });
});

it('groups planner pickups by person too, so differently named people at one place stay separate rows', () => {
  const rows = [point('p1', 1, 'same', 'Team'), point('p2', 1, 'same', 'Team'), point('p3', 1, 'same', 'Team')];
  rows[0].person = 'Mia'; rows[1].person = 'Mia'; rows[2].person = 'Alex';
  expect(groupPassengerPickups(rows).map((row) => [row.person, row.count])).toEqual([['Mia', 2], ['Alex', 1]]);
});

it('renames people without moving a stop, and clears a name with empty text', () => {
  const result = linkedResult();
  const named = renameInResult(result, nameChange({ stopIds: ['p1', 'p2'] }, ' Mia and Alex '));
  expect(named.id).toBe(result.id);
  expect(named.coordinates).toBe(result.coordinates);
  expect(named.assignments).toBe(result.assignments);
  expect(named.inputs.passengers.map((row) => row.person)).toEqual(['Mia and Alex', 'Mia and Alex']);
  expect(named.snapshot.inputs.passengers.map((row) => row.person)).toEqual(['Mia and Alex', 'Mia and Alex']);
  expect(named.snapshot.routes).toEqual(result.snapshot.routes);
  const cleared = renameInResult(named, nameChange({ stopIds: ['p1'] }, '   '));
  expect(cleared.inputs.passengers[0]).not.toHaveProperty('person');
  expect(cleared.snapshot.inputs.passengers[0]).not.toHaveProperty('person');
  expect(cleared.inputs.passengers[1].person).toBe('Mia and Alex');
});

it('renames planner rows through any of a pickup\'s people', () => {
  const row = { ...newPassengerPickup(), count: 2 };
  row.occurrenceIds = [row.stop_id, 'second'];
  const [renamed] = renamePoints([row], { stopIds: ['second'], person: 'Lee' });
  expect(renamed.person).toBe('Lee');
  expect(renamePoints([row], { destination: 'Dinner' })[0]).toBe(row);
});

it('renames only this trip\'s destination, unlinking it at the place shown', () => {
  const inputs = fixture(); inputs.destination.saved_id = HOME;
  const result = makeResult(inputs, routesFor(inputs));
  const shown = { ...result, inputs: { ...result.inputs, destination: { ...result.inputs.destination, source: { kind: 'google_places', place_id: 'shown' } } } };
  const renamed = renameInResult(shown, nameChange({ destination: true }, 'Dinner'));
  expect(renamed.inputs.destination).toMatchObject({ label: 'Dinner', saved_id: null });
  expect(renamed.snapshot.inputs.destination).toEqual({ stop_id: 'end', label: 'Dinner', source: { kind: 'google_places', place_id: 'shown' } });
});

it('refuses to rename a destination that has moved until the route is calculated again', () => {
  const result = { ...linkedResult(), moved: ['end'] };
  expect(() => nameChange({ destination: true }, 'Dinner', result)).toThrow('Recalculate before renaming');
  expect(nameChange({ stopIds: ['p1'] }, 'Mia', result)).toEqual({ stopIds: ['p1'], person: 'Mia' });
  expect(nameChange({ destination: true }, 'Dinner', { ...result, moved: ['d1'] })).toEqual({ destination: 'Dinner' });
  expect(() => nameChange({ stopIds: ['p1'] }, 'x'.repeat(81))).toThrow();
});

it('accepts an arrive-by only as a real local date and time from 2000 to 2100', () => {
  ['2000-01-01T00:00', '2100-12-31T23:59', '2028-02-29T12:00', '2026-10-30T19:00'].forEach((value) => expect(validArriveBy(value)).toBe(true));
  [undefined, null, '', 3, '2026-02-30T10:00', '2027-02-29T10:00', '2026-10-30T24:00', '2026-10-30T19:60', '2026-10-30T19:00:00',
    '2026-10-30T19:00Z', '2026-10-30 19:00', '2026-1-30T19:00', '1999-12-31T23:59', '2101-01-01T00:00', '2026-10-30']
    .forEach((value) => expect(validArriveBy(value)).toBe(false));
  expect(arriveByChange('2026-10-30T19:00')).toEqual({ arriveBy: '2026-10-30T19:00' });
  expect(arriveByChange('')).toEqual({ arriveBy: '' });
  expect(() => arriveByChange('2026-02-30T10:00')).toThrow();
});

it('saves the arrive-by with the route and brings it back on reopening', async () => {
  const inputs = { ...fixture(), arrive_by: '2026-10-30T19:00' };
  const { snapshot } = makeResult(inputs, routesFor(inputs));
  expect(snapshot.inputs.arrive_by).toBe('2026-10-30T19:00');
  const reopened = await reopenSnapshot(snapshot, fresh, null);
  expect(reopened.inputs.arrive_by).toBe('2026-10-30T19:00');
  const plain = makeResult(fixture(), routesFor(fixture())).snapshot;
  expect(plain.inputs).not.toHaveProperty('arrive_by');
  expect((await reopenSnapshot(plain, fresh, null)).inputs).not.toHaveProperty('arrive_by');
});

it('changes or clears the arrive-by on a route and its snapshot without moving a stop', () => {
  const result = makeResult(fixture(), routesFor(fixture()));
  const timed = renameInResult(result, arriveByChange('2026-10-30T19:00'));
  expect(timed.inputs.arrive_by).toBe('2026-10-30T19:00');
  expect(timed.snapshot.inputs.arrive_by).toBe('2026-10-30T19:00');
  expect(timed.coordinates).toBe(result.coordinates);
  expect(timed.snapshot.routes).toEqual(result.snapshot.routes);
  const cleared = renameInResult(timed, arriveByChange(''));
  expect(cleared.inputs).not.toHaveProperty('arrive_by');
  expect(cleared.snapshot.inputs).not.toHaveProperty('arrive_by');
  // A name change leaves the arrive-by alone.
  const named = renameInSnapshot(timed.snapshot, nameChange({ stopIds: ['p1'] }, 'Mia'), result.inputs.destination.source);
  expect(named.inputs.arrive_by).toBe('2026-10-30T19:00');
});
