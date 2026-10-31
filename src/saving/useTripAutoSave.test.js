import { TextEncoder } from 'util';
import { automaticTitle, followTitle, titleFacts } from './useTripAutoSave';

beforeAll(() => { global.TextEncoder = TextEncoder; });

const day = (year, month, date) => new Date(year, month - 1, date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const CREATED = '2026-10-29T12:00:00Z';
const SAVED_DAY = new Date(CREATED).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const facts = (place, arriveBy = '') => ({ place, arriveBy });
const result = (destination, arriveBy) => ({ inputs: { destination, ...(arriveBy ? { arrive_by: arriveBy } : {}) } });

it('names a trip by its destination and the arrive-by date, or the day it was calculated', () => {
  expect(automaticTitle(result({ label: 'BCD Tofu' }), new Date(2026, 9, 29))).toBe(`Trip to BCD Tofu, ${day(2026, 10, 29)}`);
  expect(automaticTitle(result({ label: '', place_name: 'BCD Tofu House' }, '2026-11-06T18:45'), new Date(2026, 9, 29)))
    .toBe(`Trip to BCD Tofu House, ${day(2026, 11, 6)}`);
  expect(titleFacts(result({ label: '', address: '2700 Alton Pkwy, Irvine' }, 'not a time'))).toEqual(facts('2700 Alton Pkwy'));
});

it('an automatic title follows a new, changed or cleared arrive-by date', () => {
  const saved = `Trip to BCD, ${SAVED_DAY}`;
  const set = followTitle(saved, facts('BCD'), facts('BCD', '2026-11-06T18:45'), CREATED);
  expect(set).toBe(`Trip to BCD, ${day(2026, 11, 6)}`);
  const changed = followTitle(set, facts('BCD', '2026-11-06T18:45'), facts('BCD', '2026-11-07T09:00'), CREATED);
  expect(changed).toBe(`Trip to BCD, ${day(2026, 11, 7)}`);
  expect(followTitle(changed, facts('BCD', '2026-11-07T09:00'), facts('BCD'), CREATED)).toBe(saved);
});

it('a title the person chose, or a copy, never follows', () => {
  expect(followTitle('Friday dinner', facts('BCD'), facts('BCD', '2026-11-06T18:45'), CREATED)).toBe('Friday dinner');
  const copy = `Copy of Trip to BCD, ${SAVED_DAY}`;
  expect(followTitle(copy, facts('BCD'), facts('BCD', '2026-11-06T18:45'), CREATED)).toBe(copy);
});

it('an automatic title follows a renamed or recalculated destination, keeping its date', () => {
  expect(followTitle(`Trip to BCD, ${SAVED_DAY}`, facts('BCD'), facts('BCD Tofu'), CREATED)).toBe(`Trip to BCD Tofu, ${SAVED_DAY}`);
  expect(followTitle(`Trip to BCD, ${day(2026, 11, 6)}`, facts('BCD', '2026-11-06T18:45'), facts('UCI', '2026-11-06T18:45'), CREATED))
    .toBe(`Trip to UCI, ${day(2026, 11, 6)}`);
  // Without a save date, clearing the arrive-by leaves the title rather than guessing a day.
  expect(followTitle(`Trip to BCD, ${day(2026, 11, 6)}`, facts('BCD', '2026-11-06T18:45'), facts('BCD'), undefined))
    .toBe(`Trip to BCD, ${day(2026, 11, 6)}`);
});
