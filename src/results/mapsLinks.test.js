import { MAX_WAYPOINTS, mapsLinks, partLabel } from './mapsLinks';

const step = (kind, n, number) => ({ kind, number, coordinates: { lat: n, lng: -n },
  point: { address: `${n} Main St, Irvine`, source: { kind: 'google_places', place_id: `place-${n}` } } });
const route = (pickups) => [step('start', 0), ...Array.from({ length: pickups }, (_, i) => step('pickup', i + 1, i + 1)),
  step('destination', 99)];
const query = (url) => Object.fromEntries(new URL(url).searchParams);

it('opens a short route in one Google Maps link with every stop and its place ID', () => {
  const [part] = mapsLinks(route(2));
  expect(part.url.startsWith('https://www.google.com/maps/dir/?')).toBe(true);
  expect(query(part.url)).toEqual({ api: '1', origin: '0 Main St, Irvine', origin_place_id: 'place-0',
    destination: '99 Main St, Irvine', destination_place_id: 'place-99', travelmode: 'driving',
    waypoints: '1 Main St, Irvine|2 Main St, Irvine', waypoint_place_ids: 'place-1|place-2' });
  expect(partLabel(part)).toBe('start to destination');
});

it('leaves out waypoint place IDs unless every waypoint has one', () => {
  const steps = route(2);
  steps[1].point.source = null;
  expect(query(mapsLinks(steps)[0].url)).not.toHaveProperty('waypoint_place_ids');
});

it('splits a route past nine pickups into parts that meet at a pickup', () => {
  expect(mapsLinks(route(MAX_WAYPOINTS))).toHaveLength(1);
  const parts = mapsLinks(route(11));
  expect(parts).toHaveLength(2);
  expect(query(parts[0].url).waypoints.split('|')).toHaveLength(9);
  expect(parts[0].to).toBe(parts[1].from);
  expect(parts.map(partLabel)).toEqual(['start to pickup 10', 'pickup 10 to destination']);
  expect(query(parts[1].url).origin_place_id).toBe('place-10');
});

it('links a route with no pickups straight to the destination', () => {
  const [part] = mapsLinks(route(0));
  expect(query(part.url)).not.toHaveProperty('waypoints');
});
