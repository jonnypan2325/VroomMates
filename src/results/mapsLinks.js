// A Google Maps directions link takes at most 9 stops between its start and its end.
export const MAX_WAYPOINTS = 9;

const place = (step) => step.point.address || `${step.coordinates.lat},${step.coordinates.lng}`;
const placeId = (step) => step.point.source?.place_id || '';

function directionsUrl(steps) {
  const origin = steps[0];
  const destination = steps[steps.length - 1];
  const waypoints = steps.slice(1, -1);
  const params = new URLSearchParams({ api: '1', origin: place(origin), destination: place(destination), travelmode: 'driving' });
  if (placeId(origin)) params.set('origin_place_id', placeId(origin));
  if (placeId(destination)) params.set('destination_place_id', placeId(destination));
  if (waypoints.length) {
    params.set('waypoints', waypoints.map(place).join('|'));
    // Place IDs only help when every waypoint has one; a partial list would be matched to the wrong stops.
    if (waypoints.every(placeId)) params.set('waypoint_place_ids', waypoints.map(placeId).join('|'));
  }
  return 'https://www.google.com/maps/dir/?' + params.toString();
}

/**
 * Links for one driver's steps. A longer route is split into parts that meet at a pickup,
 * so each part opens in Google Maps and the next one starts where it ended.
 */
export function mapsLinks(steps) {
  const parts = [];
  let start = 0;
  while (start < steps.length - 1) {
    const end = Math.min(start + MAX_WAYPOINTS + 1, steps.length - 1);
    parts.push({ from: steps[start], to: steps[end], url: directionsUrl(steps.slice(start, end + 1)) });
    start = end;
  }
  return parts;
}

export function partLabel(part) {
  const name = (step) => step.kind === 'start' ? 'start' : step.kind === 'destination' ? 'destination' : 'pickup ' + step.number;
  return `${name(part.from)} to ${name(part.to)}`;
}
