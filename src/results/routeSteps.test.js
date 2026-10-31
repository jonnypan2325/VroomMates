import { DRIVER_COLORS, arrivalTimes, clockMinutes, driverInk, driverName, driverSteps, formatClock, formatDuration, peopleText,
  seatsUsed, stepName, stepPerson, stopDetail, stopName } from './routeSteps';

const point = (stop_id, place_id, extra = {}) => ({ stop_id, label: '', address: `${stop_id} Street, Irvine, CA`,
  coordinates: { lat: 1, lng: 1 }, source: { kind: 'google_places', place_id }, ...extra });
const result = (passengers, order) => ({
  inputs: { drivers: [{ ...point('d1', 'home', { label: 'Home' }), capacity: 4 }], passengers, destination: point('end', 'bcd') },
  assignments: [['d1', ...order, 'end']],
});

it('names a stop by its label, then its landmark, then the street part of the address', () => {
  expect(stopName({ label: 'Home', place_name: 'Tower', address: '1 Main St, Irvine' })).toBe('Home');
  expect(stopName({ label: '', place_name: 'Tower', address: '1 Main St, Irvine' })).toBe('Tower');
  expect(stopName({ label: '', address: '1 Main St, Irvine' })).toBe('1 Main St');
  expect(stopDetail({ label: 'Home', address: '1 Main St, Irvine' })).toBe('1 Main St, Irvine');
  expect(stopDetail({ label: '', address: '' })).toBe('');
});

it('makes people waiting one after another at one place a single numbered pickup', () => {
  const riders = [point('p1', 'mia', { label: "Mia's" }), point('p2', 'mia', { label: "Mia's" }), point('p3', 'uci'), point('p4', 'mia', { label: "Mia's" })];
  const steps = driverSteps(result(riders, ['p1', 'p2', 'p3', 'p4']), 0);
  expect(steps.map((step) => [step.kind, step.number, step.people])).toEqual([
    ['start', undefined, undefined], ['pickup', 1, 2], ['pickup', 2, 1], ['pickup', 3, 1], ['destination', undefined, undefined]]);
  expect(steps[1].points.map((row) => row.stop_id)).toEqual(['p1', 'p2']);
  expect(seatsUsed(result(riders, ['p1', 'p2', 'p3', 'p4']), 0)).toBe(4);
});

it('shows each person once at a shared pickup and falls back to the place when nobody is named', () => {
  const riders = [point('p1', 'mia', { person: 'Mia' }), point('p2', 'mia', { person: 'Alex' }), point('p3', 'mia', { person: 'Mia' })];
  const [, pickup, destination] = driverSteps(result(riders, ['p1', 'p2', 'p3']), 0);
  expect(stepPerson(pickup)).toMatch(/^Mia,? and Alex$/);
  expect(stepName(destination)).toBe('end Street');
  const [, unnamed] = driverSteps(result([point('p1', 'uci')], ['p1']), 0);
  expect(stepPerson(unnamed)).toBe('');
  expect(stepName(unnamed)).toBe('p1 Street');
});

it('names a driver by person, then by place, never by number', () => {
  const trip = result([point('p1', 'uci')], ['p1']);
  expect(driverName(trip, 0)).toBe('Home');
  trip.inputs.drivers[0].person = 'Sam';
  expect(driverName(trip, 0)).toBe('Sam');
  trip.inputs.drivers[0] = { ...point('d1', 'x', { place_name: 'Tustin Market' }), capacity: 4 };
  expect(driverName(trip, 0)).toBe('Tustin Market');
});

it('works back from an arrive-by time, rounding down so no estimate is late', () => {
  expect(clockMinutes('19:00')).toBe(1140);
  expect(clockMinutes('')).toBeNull();
  expect(clockMinutes('7pm')).toBeNull();
  // 10 min, 5 min 30 s, then 20 min into a 19:00 arrival: 35.5 min in all, so leaving at 18:24.
  expect(arrivalTimes(1140, [600, 330, 1200])).toEqual([1104, 1114, 1120, 1140]);
  expect(arrivalTimes(1140, [600, null])).toBeNull();
  expect(arrivalTimes(null, [600])).toBeNull();
  expect(arrivalTimes(1140, undefined)).toBeNull();
  // Leaving before midnight for an early arrival wraps to the evening before.
  expect(formatClock(-15)).toBe(formatClock(24 * 60 - 15));
});

it('formats durations and head counts the way the cards show them', () => {
  expect(formatDuration(30)).toBe('1 min');
  expect(formatDuration(37 * 60)).toBe('37 min');
  expect(formatDuration(105 * 60)).toBe('1 h 45 min');
  expect(formatDuration(120 * 60)).toBe('2 h');
  expect(formatDuration(NaN)).toBe('');
  expect(peopleText(1)).toBe('1 person');
  expect(peopleText(3)).toBe('3 people');
});

it('gives every driver colour readable numbers: white where it is 4.5:1, dark ink on the orange', () => {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  DRIVER_COLORS.forEach((color, index) => {
    const ink = driverInk(index) === '#fff' ? '#ffffff' : driverInk(index);
    expect(contrast(color, ink)).toBeGreaterThanOrEqual(4.5);
  });
});
