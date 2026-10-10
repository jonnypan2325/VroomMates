import { TextEncoder } from 'util';
import { expandPassengerPickups, freezeInputs, groupPassengerPickups, makeResult, newPassengerPickup, reopenSnapshot, resizePickup } from './tripSnapshot';

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
