/**
 * How routes and their markers look on the map, in one place. Colours for each driver stay in
 * DRIVER_COLORS; this table holds the widths, the white edge, the stacking and the marker sizes.
 */
export const ROUTE_STYLE = {
  line: {
    // A shown route, and a route greyed out while another driver is chosen.
    width: 6, mutedWidth: 4, mutedOpacity: 0.75,
  },
  // The white edge under each coloured route: this much wider in all, so half of it shows on each side.
  casing: { color: '#fff', extraWidth: 4 },
  layers: {
    // Routes stack upward from `base`, two layers each (edge, then line); a chosen route sits above them all.
    base: 10, perRoute: 2, chosen: 100,
    // Markers stack separately from lines, the destination always on top.
    marker: 40, mutedMarker: 30, destination: 50,
  },
  // Square marker images, in CSS pixels: a driver's start and the destination, and a numbered pickup.
  markers: { large: 34, pickup: 28 },
  // Space kept around the routes when the map frames them.
  framePadding: 56,
};
