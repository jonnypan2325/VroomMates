import { canonicalText, newId } from './api';
import { hasCoordinates, hasPlaceSource } from './places';

export const newPoint = () => ({
  stop_id: newId(), address: '', label: '', coordinates: { lat: null, lng: null }, source: null,
});
export const newDriver = () => ({ ...newPoint(), capacity: 1 });
export const newPassengerPickup = () => {
  const point = newPoint();
  return { ...point, count: 1, occurrenceIds: [point.stop_id] };
};

export function resizePickup(point, count) {
  const occurrenceIds = [...(point.occurrenceIds || [point.stop_id])];
  if (Number.isSafeInteger(count) && count >= 1 && count <= 12) {
    while (occurrenceIds.length < count) occurrenceIds.push(newId());
  }
  return { count, occurrenceIds };
}

/** The API and saved snapshots still describe individual people, never UI groups. */
export function expandPassengerPickups(rows) {
  if (rows.some((row) => !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 12)) {
    throw new Error('Enter a whole number from 1 to 12 for passengers at each pickup.');
  }
  if (rows.reduce((total, row) => total + row.count, 0) > 12) {
    throw new Error('Plan for at most 12 passengers in total, including people sharing a pickup.');
  }
  const expanded = rows.flatMap(({ count, occurrenceIds, ...point }) => {
    if (!Array.isArray(occurrenceIds) || occurrenceIds.length < count) throw new Error('This pickup is incomplete. Re-enter its passenger count.');
    return occurrenceIds.slice(0, count).map((stop_id) => ({ ...point, stop_id }));
  });
  if (new Set(expanded.map((point) => point.stop_id)).size !== expanded.length) {
    throw new Error('Pickup identities overlap. Reload the trip before calculating.');
  }
  return expanded;
}

/** Only editable rows are grouped; the restored frozen result retains its assignments. */
export function groupPassengerPickups(people) {
  const groups = new Map();
  for (const point of people) {
    const key = JSON.stringify([point.source?.kind, point.source?.place_id, point.label || '']);
    const group = groups.get(key);
    if (group) { group.count += 1; group.occurrenceIds.push(point.stop_id); }
    else groups.set(key, { ...point, count: 1, occurrenceIds: [point.stop_id] });
  }
  return [...groups.values()];
}

export const freezeInputs = (drivers, passengers, destination) =>
  JSON.parse(JSON.stringify({ drivers, passengers, destination }));

const coordinateKey = (value) => JSON.stringify([value.lat, value.lng]);
const equalCoordinates = (left, right) => left.lat === right.lat && left.lng === right.lng;

function reference(point, driver = false) {
  if (!hasPlaceSource(point.source)) throw new Error('Choose a Google suggestion for every stop before saving.');
  return { stop_id: point.stop_id, label: canonicalText(point.label || '', 1000, 1000, true),
    source: { kind: 'google_places', place_id: point.source.place_id },
    ...(driver ? { capacity: point.capacity } : {}) };
}

/** Match only interior pickups; coincident endpoints still consume passenger occurrences. */
export function makeResult(inputs, routes) {
  if (!Array.isArray(routes) || routes.length !== inputs.drivers.length) throw new Error('The route result is incomplete.');
  const points = [...inputs.drivers, ...inputs.passengers, inputs.destination];
  if (new Set(points.map((point) => point.stop_id)).size !== points.length ||
      !points.every((point) => hasCoordinates(point.coordinates))) throw new Error('The route inputs are incomplete.');
  const remaining = new Map();
  inputs.passengers.forEach((point) => {
    const key = coordinateKey(point.coordinates);
    remaining.set(key, [...(remaining.get(key) || []), point.stop_id]);
  });
  const assignments = routes.map((route, index) => {
    const driver = inputs.drivers[index];
    if (!Array.isArray(route) || route.length < 2 || !route.every(hasCoordinates) ||
        !equalCoordinates(route[0], driver.coordinates) ||
        !equalCoordinates(route[route.length - 1], inputs.destination.coordinates) ||
        route.length - 2 > driver.capacity) throw new Error('The route result does not match these inputs.');
    const pickups = route.slice(1, -1).map((coordinates) => {
      const queue = remaining.get(coordinateKey(coordinates));
      if (!queue?.length) throw new Error('The route result contains an unexpected stop.');
      return queue.shift();
    });
    return { driver_id: driver.stop_id, stop_ids: [driver.stop_id, ...pickups, inputs.destination.stop_id] };
  });
  if (Array.from(remaining.values()).some((queue) => queue.length)) throw new Error('The route result is missing a passenger.');
  let snapshot = null;
  let saveError = '';
  try {
    snapshot = { schema_version: 1, inputs: {
      drivers: inputs.drivers.map((point) => reference(point, true)),
      passengers: inputs.passengers.map((point) => reference(point)),
      destination: reference(inputs.destination),
    }, routes: assignments };
  } catch (error) { saveError = error.message; }
  return { id: newId(), inputs, coordinates: routes.map((route) => route.map((point) => ({ lat: point.lat, lng: point.lng }))),
    snapshot, saveError };
}

export async function reopenSnapshot(snapshot, lookup) {
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.inputs?.drivers) ||
      !Array.isArray(snapshot.inputs?.passengers) || !Array.isArray(snapshot.routes)) {
    throw new Error('This saved route format is unavailable.');
  }
  const original = [...snapshot.inputs.drivers, ...snapshot.inputs.passengers, snapshot.inputs.destination];
  const unique = new Map();
  for (const point of original) {
    if (!point || !hasPlaceSource(point.source) || typeof point.stop_id !== 'string' || unique.has(point.stop_id)) {
      throw new Error('This saved route is incomplete.');
    }
    unique.set(point.stop_id, point);
  }
  const details = new Map();
  original.forEach((point) => {
    if (!details.has(point.source.place_id)) details.set(point.source.place_id, lookup(point.source.place_id));
  });
  await Promise.all(details.values());
  const hydrated = new Map();
  for (const point of original) {
    hydrated.set(point.stop_id, { ...point, ...await details.get(point.source.place_id),
      label: point.label || '', source: { ...point.source } });
  }
  const inputs = {
    drivers: snapshot.inputs.drivers.map((point) => hydrated.get(point.stop_id)),
    passengers: snapshot.inputs.passengers.map((point) => hydrated.get(point.stop_id)),
    destination: hydrated.get(snapshot.inputs.destination.stop_id),
  };
  if (snapshot.routes.length !== inputs.drivers.length) throw new Error('This saved route assignment is incomplete.');
  const passengerIds = new Set(inputs.passengers.map((point) => point.stop_id));
  const used = new Set();
  const routes = snapshot.routes.map((route, index) => {
    const driver = inputs.drivers[index];
    const ids = route.stop_ids;
    if (route.driver_id !== driver.stop_id || !Array.isArray(ids) || ids.length < 2 ||
        ids[0] !== driver.stop_id || ids[ids.length - 1] !== inputs.destination.stop_id ||
        !Number.isSafeInteger(driver.capacity) || driver.capacity < 1 || ids.length - 2 > driver.capacity) {
      throw new Error('This saved route assignment is incomplete.');
    }
    ids.slice(1, -1).forEach((id) => {
      if (!passengerIds.has(id) || used.has(id)) throw new Error('This saved route repeats or omits a passenger.');
      used.add(id);
    });
    return ids.map((id) => {
      const point = hydrated.get(id);
      if (!point || !hasCoordinates(point.coordinates)) throw new Error('A saved stop is unavailable.');
      return { ...point.coordinates };
    });
  });
  if (used.size !== passengerIds.size) throw new Error('This saved route omits a passenger.');
  // Preserve the stored occurrence assignment even when fresh coordinates become coincident.
  return { id: newId(), inputs, coordinates: routes, snapshot: JSON.parse(JSON.stringify(snapshot)), saveError: '' };
}
