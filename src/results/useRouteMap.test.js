import { act, renderHook } from '@testing-library/react';
import useRouteMap from './useRouteMap';
import { DRIVER_COLORS, MUTED_COLOR } from './routeSteps';

// Google Maps stands in as plain objects; each Polyline keeps its options while it is on the map.
let lines;
beforeEach(() => {
  lines = [];
  class Overlay { constructor(options) { this.options = options; if (options.map) lines.push(this); } addListener() {} setMap() { lines = lines.filter((line) => line !== this); } }
  window.google = { maps: {
    Polyline: class extends Overlay {}, Marker: class { constructor() { this.map = true; } addListener() {} setMap() {} },
    InfoWindow: class { close() {} }, LatLngBounds: class { extend() {} }, TravelMode: { DRIVING: 'DRIVING' },
    Size: class { constructor(width, height) { Object.assign(this, { width, height }); } },
    Point: class { constructor(x, y) { Object.assign(this, { x, y }); } },
    DirectionsService: class { route(_, callback) { callback({ routes: [{ legs: [{ duration: { value: 60 } }], overview_path: [{ lat: 1, lng: 1 }] }] }, 'OK'); } },
  } };
});
afterEach(() => { delete window.google; });
const place = (stop_id, lat) => ({ stop_id, label: stop_id, address: stop_id, coordinates: { lat, lng: lat }, source: { kind: 'google_places', place_id: stop_id } });
const route = (id) => ({ id, inputs: { drivers: ['a', 'b', 'c'].map((name, index) => ({ ...place(name, index), capacity: 2 })),
  passengers: [place('p', 5)], destination: place('end', 9) }, assignments: [['a', 'p', 'end'], ['b', 'end'], ['c', 'end']], coordinates: [] });
const map = { fitBounds() {} };
const first = route('r1');
// Lines from bottom to top, as [colour, width]; colours alone leave out the white edges.
const drawn = () => lines.map((line) => line.options).sort((x, y) => x.zIndex - y.zIndex).map((line) => [line.strokeColor, line.strokeWeight]);
const colours = () => drawn().map(([color]) => color).filter((color) => color !== '#fff');
async function show() {
  const view = renderHook(({ result, selected }) => useRouteMap(map, result, selected, 0), { initialProps: { result: first, selected: null } });
  await act(async () => {});
  return { rerender: (props) => act(async () => { view.rerender(props); }) };
}
const [BLUE, ORANGE, GREEN] = DRIVER_COLORS;

it('draws every route at one width on its own white edge, in driver order', async () => {
  await show();
  expect(drawn()).toEqual([['#fff', 10], [BLUE, 6], ['#fff', 10], [ORANGE, 6], ['#fff', 10], [GREEN, 6]]);
});

it('puts a chosen driver on top in colour over grey routes without an edge', async () => {
  const view = await show();
  await view.rerender({ result: first, selected: 1 });
  expect(drawn()).toEqual([[MUTED_COLOR, 4], [MUTED_COLOR, 4], ['#fff', 10], [ORANGE, 6]]);
});

it('shows all routes with the latest chosen on top, until the route changes', async () => {
  const view = await show();
  await view.rerender({ result: first, selected: 0 });
  await view.rerender({ result: first, selected: null });
  expect(colours()).toEqual([ORANGE, GREEN, BLUE]);
  await view.rerender({ result: first, selected: 2 });
  await view.rerender({ result: first, selected: null });
  expect(colours()).toEqual([ORANGE, BLUE, GREEN]);
  // A rename keeps the route and its order; a new calculation starts afresh.
  const renamed = { ...first, inputs: { ...first.inputs, destination: { ...place('end', 9), label: 'Dinner' } } };
  await view.rerender({ result: renamed, selected: null });
  expect(colours()).toEqual([ORANGE, BLUE, GREEN]);
  await view.rerender({ result: route('r2'), selected: null });
  expect(colours()).toEqual([BLUE, ORANGE, GREEN]);
});
