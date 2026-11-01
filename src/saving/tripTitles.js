import { canonicalText } from './api';
import { validArriveBy } from './tripSnapshot';

// Place names come from Google as they are, and can hold invisible characters (a ZWNJ in Persian, a soft
// hyphen) that a saved title may not; they are left out, so every place still makes a valid title.
const visible = (text) => (text || '').replace(/\p{C}/gu, '').trim();
const shortPlace = (point) => visible(point.label) || visible(point.place_name) || visible((point.address || '').split(',')[0]) || 'destination';
// A long name is shortened until the title fits its 200-byte limit.
function fitted(name, write) {
  const encoder = new TextEncoder();
  let letters = Array.from(name);
  while (letters.length > 1 && encoder.encode(write(letters.join(''))).length > 200) letters = letters.slice(0, -1);
  return canonicalText(write(letters.join('')), 200, 200);
}
function titleOf(place, day) {
  const date = day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return fitted(place, (name) => `Trip to ${name}, ${date}`);
}
// An arrive-by time is the destination's wall clock, so its date is read without a time zone.
const arriveDay = (value) => new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));

/** What an automatic title is made from: the destination's short name and the arrive-by time, if any. */
export const titleFacts = (result) => ({ place: Array.from(shortPlace(result.inputs.destination)).slice(0, 80).join(''),
  arriveBy: validArriveBy(result.inputs.arrive_by) ? result.inputs.arrive_by : '' });

/** "Trip to BCD Tofu, Oct 22", dated by the arrive-by time when there is one: renamable, and within the 200-character limit. */
export const titleFromFacts = (facts, now = new Date()) => titleOf(facts.place, facts.arriveBy ? arriveDay(facts.arriveBy) : now);

/**
 * The title after a change from `before` to `after`. A title that is still automatic, for the old
 * destination on the day the trip was saved or its old arrive-by date, follows the change; one the
 * person chose, or a copy's, stays as it is.
 */
export function followTitle(title, before, after, createdAt) {
  const created = createdAt ? new Date(createdAt) : null;
  const days = [created, before.arriveBy && arriveDay(before.arriveBy)].filter(Boolean);
  if (!days.some((day) => titleOf(before.place, day) === title)) return title;
  const day = after.arriveBy ? arriveDay(after.arriveBy) : created;
  return day ? titleOf(after.place, day) : title;
}

export const copyTitle = (title) => fitted(title, (name) => `Copy of ${name}`);
