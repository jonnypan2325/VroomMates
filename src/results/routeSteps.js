import { ROUTE_STYLE } from './routeStyle';

// Driver colours, chosen to stay apart from each other, from the purple app chrome and from the grey of unselected routes.
export const DRIVER_COLORS = ['#2f6fd6', '#d9731a', '#2c834b', '#c2378b', '#117e87', '#8a5a2b', '#c8382f', '#5a4fcf'];
export const MUTED_COLOR = '#b4b0bd';
const INK = '#1f2430';

export const driverColor = (index) => DRIVER_COLORS[index % DRIVER_COLORS.length];
/** Numbers on a driver's marks: white keeps 4.5:1 on every colour but the orange, which takes dark ink. */
export const driverInk = (index) => driverColor(index) === '#d9731a' ? INK : '#fff';

/** The drivers most recently chosen, latest first, after choosing `index`. */
export const viewedFirst = (order, index) => [index, ...order.filter((item) => item !== index)];

/**
 * Map layers for each route when all are shown: routes never chosen keep driver order at the bottom,
 * then the chosen ones, the latest on top. Each route takes two layers, its white edge and its line.
 */
export function routeLayers(count, order) {
  const viewed = order.filter((index) => index < count);
  const stack = [...Array.from({ length: count }, (_, index) => index).filter((index) => !viewed.includes(index)), ...viewed.reverse()];
  const layers = Array(count);
  stack.forEach((index, position) => { layers[index] = ROUTE_STYLE.layers.base + ROUTE_STYLE.layers.perRoute * position; });
  return layers;
}

/** The nickname when there is one, then a landmark's name, then the street part of the address. */
export function stopName(point) {
  return point.label || point.place_name || (point.address || '').split(',')[0].trim();
}

export function stopDetail(point) {
  const name = stopName(point);
  return point.address && point.address !== name ? point.address : '';
}

const names = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' });

/** Who is at a step: one person's name, or everyone named at a shared pickup ("Mia and Alex"). */
export function stepPerson(step) {
  return names.format([...new Set(step.points.map((point) => point.person).filter(Boolean))]);
}

const samePlace = (left, right) => left.source?.place_id && left.source.place_id === right.source?.place_id
  && (left.label || '') === (right.label || '');

/**
 * One driver's visiting order as steps. People waiting at the same place one after another are one
 * pickup with a head count, so the numbers on the map count stops, not people.
 */
export function driverSteps(result, index) {
  const byId = new Map([...result.inputs.drivers, ...result.inputs.passengers, result.inputs.destination]
    .map((point) => [point.stop_id, point]));
  const ids = result.assignments[index];
  const driver = byId.get(ids[0]);
  const pickups = [];
  ids.slice(1, -1).forEach((id) => {
    const point = byId.get(id);
    const last = pickups[pickups.length - 1];
    if (last && samePlace(last.point, point)) { last.people += 1; last.points.push(point); }
    else pickups.push({ kind: 'pickup', point, points: [point], people: 1, coordinates: { ...point.coordinates } });
  });
  pickups.forEach((step, position) => { step.number = position + 1; });
  const destination = result.inputs.destination;
  return [{ kind: 'start', point: driver, points: [driver], coordinates: { ...driver.coordinates } }, ...pickups,
    { kind: 'destination', point: destination, points: [], coordinates: { ...destination.coordinates } }];
}

export function seatsUsed(result, index) {
  return result.assignments[index].length - 2;
}

export function driverName(result, index) {
  const driver = result.inputs.drivers[index];
  return driver.person || stopName(driver);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "18:45" from a time field, as minutes after midnight; null when unset or malformed. */
export function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function formatClock(minutes) {
  const day = 24 * 60;
  const time = new Date(2000, 0, 1, 0, ((Math.floor(minutes) % day) + day) % day);
  return time.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The arrive-by date during a trip: weekday, month and day, without the year, as "Fri, Oct 30". */
export function formatTripDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** A clock time on the arrive-by date; one that falls on an earlier day says which, as "Thu 11:50 PM". */
export function formatTripClock(minutes, date) {
  const days = Math.floor(minutes / (24 * 60));
  if (!days || !date) return formatClock(minutes);
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(year, month - 1, day + days).toLocaleDateString(undefined, { weekday: 'short' });
  return `${weekday} ${formatClock(minutes)}`;
}

/**
 * Working back from the time everyone should arrive: when each stop is reached, in minutes after
 * midnight, rounded down so the estimate is never late. Null when a drive time is missing.
 */
export function arrivalTimes(arriveBy, legs) {
  if (arriveBy === null || !legs || !legs.every(Number.isFinite)) return null;
  let remaining = 0;
  const times = [arriveBy];
  for (let index = legs.length - 1; index >= 0; index -= 1) {
    remaining += legs[index];
    times.unshift(Math.floor(arriveBy - remaining / 60));
  }
  return times;
}

export const peopleText = (count) => count === 1 ? '1 person' : count + ' people';
