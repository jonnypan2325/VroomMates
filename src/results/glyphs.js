/**
 * The car, wheels and flag drawn for a route's start and destination, on a 24-unit grid. The steps
 * list and the map markers both draw these, so they always match; no map code depends on them.
 */
export const GLYPHS = {
  car: 'M5.5 13.5h13M7 13.5l1.4-4.1A1.5 1.5 0 0 1 9.8 8.4h4.4a1.5 1.5 0 0 1 1.4 1l1.4 4.1M6 13.5h12a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1h-.5M6.5 18H6a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1M8.5 18h7',
  wheels: [[8, 18], [16, 18]],
  flag: 'M8 19V5.5M8 6c2.5-1.2 4.5 1.2 8 0v6.5c-3.5 1.2-5.5-1.2-8 0',
};
