import { canonicalText, newId } from './api';
import { hasCoordinates, hasPlaceSource } from './places';

const LOCATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARRIVE_BY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/;

/** Wall-clock date and time at the destination, as "2026-11-01T18:30": a real date from 2000 to 2100. */
export function validArriveBy(value) {
  const match = typeof value === 'string' && ARRIVE_BY.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  return year >= 2000 && year <= 2100 && date.getFullYear() === year && date.getMonth() === month - 1
    && date.getDate() === day && hour < 24 && minute < 60;
}

export const newPoint = () => ({
  stop_id: newId(), address: '', label: '', coordinates: { lat: null, lng: null }, source: null,
});
export const newDriver = () => ({ ...newPoint(), capacity: 4 });
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
    const key = JSON.stringify([point.source?.kind, point.source?.place_id, point.label || '', point.person || '']);
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

function reference(point, driver = false, person = true) {
  if (!hasPlaceSource(point.source)) throw new Error('Choose a Google suggestion for every stop before saving.');
  return { stop_id: point.stop_id, label: canonicalText(point.label || '', 1000, 1000, true),
    source: { kind: 'google_places', place_id: point.source.place_id },
    // A stop picked from My locations keeps that location's ID, so a reopened trip follows it.
    ...(LOCATION_ID.test(point.saved_id || '') ? { location_id: point.saved_id } : {}),
    ...(person && point.person ? { person: canonicalText(point.person, 80, 320) } : {}),
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
      destination: reference(inputs.destination, false, false),
      ...(validArriveBy(inputs.arrive_by) ? { arrive_by: inputs.arrive_by } : {}),
    }, routes: assignments };
  } catch (error) { saveError = error.message; }
  return { id: newId(), origin: 'calculated', inputs, assignments: assignments.map((route) => route.stop_ids),
    coordinates: routes.map((route) => route.map((point) => ({ lat: point.lat, lng: point.lng }))), snapshot, saveError };
}

/**
 * Resolves a saved trip with fresh place details. A stop linked to one of the owner's saved locations
 * takes that location's current place and name; `locations` is the owner's complete list, or null
 * while it is unknown. A link to a location that is not in the list (deleted, or never this owner's)
 * falls back to the place and label stored with the trip.
 */
export async function reopenSnapshot(snapshot, lookup, locations = null) {
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
  const saved = locations ? new Map(locations.map((row) => [row.id, row])) : null;
  // Stops whose saved location now points at another place; the stored route still visits the old one.
  const moved = [];
  const linked = original.map((point) => {
    const { location_id: locationId, ...stored } = point;
    if (!locationId) return { ...stored, label: point.label || '', saved_id: null };
    // Until the list is known, keep the link so the planner can still follow the location later.
    if (!saved) return { ...stored, label: point.label || '', saved_id: locationId };
    const row = saved.get(locationId);
    if (!row) return { ...stored, label: point.label || '', saved_id: null };
    if (row.source.place_id !== point.source.place_id) moved.push(point.stop_id);
    return { ...stored, label: row.label, source: { ...row.source }, saved_id: row.id };
  });
  const details = new Map();
  linked.forEach((point) => {
    if (!details.has(point.source.place_id)) details.set(point.source.place_id, lookup(point.source.place_id));
  });
  await Promise.all(details.values());
  const hydrated = new Map();
  for (const point of linked) {
    hydrated.set(point.stop_id, { ...point, ...await details.get(point.source.place_id),
      label: point.label, source: { ...point.source } });
  }
  const inputs = {
    drivers: snapshot.inputs.drivers.map((point) => hydrated.get(point.stop_id)),
    passengers: snapshot.inputs.passengers.map((point) => hydrated.get(point.stop_id)),
    destination: hydrated.get(snapshot.inputs.destination.stop_id),
    ...(snapshot.inputs.arrive_by ? { arrive_by: snapshot.inputs.arrive_by } : {}),
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
  return { id: newId(), origin: 'reopened', inputs, assignments: snapshot.routes.map((route) => [...route.stop_ids]),
    coordinates: routes, snapshot: JSON.parse(JSON.stringify(snapshot)), saveError: '', changed: moved.length > 0, moved };
}

// Naming who drives or rides, what this trip calls its destination, or when everyone arrives, never moves a stop.
const withArriveBy = (inputs, change) => {
  if (change.arriveBy === undefined) return inputs;
  const { arrive_by: previous, ...rest } = inputs;
  return change.arriveBy ? { ...rest, arrive_by: change.arriveBy } : rest;
};
const withPerson = (point, person) => {
  const { person: previous, ...rest } = point;
  return person ? { ...rest, person } : rest;
};

/** Planner rows and result stops; a pickup row matches through any of its people's stop IDs. */
export function renamePoints(points, change) {
  if (!change.stopIds) return points;
  const ids = new Set(change.stopIds);
  return points.map((point) => [point.stop_id, ...(point.occurrenceIds || [])].some((id) => ids.has(id))
    ? withPerson(point, change.person) : point);
}

/** A renamed destination keeps its place but no longer follows a saved location, whose own name is unchanged. */
export function renameDestination(point, change) {
  return change.destination === undefined ? point : { ...point, label: change.destination, saved_id: null };
}

export function renameInSnapshot(snapshot, change, place) {
  const { drivers, passengers, destination } = snapshot.inputs;
  let renamed = destination;
  if (change.destination !== undefined) {
    const { location_id: link, ...rest } = destination;
    // The place shown when renaming, which a reopened trip may have refreshed from the saved location.
    renamed = { ...rest, label: change.destination, source: { kind: 'google_places', place_id: place.place_id } };
  }
  return { ...snapshot, inputs: withArriveBy({ ...snapshot.inputs, drivers: renamePoints(drivers, change),
    passengers: renamePoints(passengers, change), destination: renamed }, change) };
}

/** The same route under new names: assignments and coordinates are kept, so the map draws it without asking again. */
export function renameInResult(result, change) {
  const { drivers, passengers, destination } = result.inputs;
  return { ...result, inputs: withArriveBy({ ...result.inputs, drivers: renamePoints(drivers, change),
    passengers: renamePoints(passengers, change), destination: renameDestination(destination, change) }, change),
  snapshot: result.snapshot && renameInSnapshot(result.snapshot, change, destination.source) };
}

/** A new arrive-by time as stored; empty clears it. */
export function arriveByChange(value) {
  if (value && !validArriveBy(value)) throw new Error('Choose a date and time between 2000 and 2100.');
  return { arriveBy: value || '' };
}

/** A typed name as stored: trimmed and composed; empty clears it. */
export function nameChange(target, text, result) {
  if (target.destination && result?.moved?.includes(result.inputs.destination.stop_id)) {
    throw new Error('This destination has moved. Recalculate before renaming it.');
  }
  const name = canonicalText(text, 80, 320, true);
  return target.destination ? { destination: name } : { stopIds: target.stopIds, person: name };
}
