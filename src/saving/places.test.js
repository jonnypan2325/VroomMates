import { TextEncoder } from 'util';
import { hasCoordinates, hasPlaceSource, resolvePlace } from './places';
beforeAll(() => { global.TextEncoder = TextEncoder; });
let callback, getDetails;
beforeEach(() => {
  jest.useFakeTimers();
  getDetails = jest.fn((request, cb) => { callback = cb; });
  window.google = { maps: { places: { PlacesService: function Service() { this.getDetails = getDetails; } } } };
});
afterEach(() => { delete window.google; jest.useRealTimers(); });
const details = () => ({ formatted_address: 'Fresh synthetic address', geometry: { location: { lat: () => 40, lng: () => -70 } } });
it('refreshes only requested place fields without rewriting the reference', async () => {
  const pending = resolvePlace({}, 'stored-id'); callback(details(), 'OK');
  await expect(pending).resolves.toEqual({ address: 'Fresh synthetic address', coordinates: { lat: 40, lng: -70 }, source: { kind: 'google_places', place_id: 'stored-id' } });
  expect(getDetails.mock.calls[0][0]).toEqual({ placeId: 'stored-id', fields: ['place_id', 'formatted_address', 'geometry.location'] });
  expect(jest.getTimerCount()).toBe(0);
});
it('aborts stale lookup and ignores its later callback', async () => {
  const controller = new AbortController(); const pending = resolvePlace({}, 'id', { signal: controller.signal });
  controller.abort(); callback(details(), 'OK');
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(jest.getTimerCount()).toBe(0);
});
it('does not start an already-aborted lookup', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(resolvePlace({}, 'id', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(getDetails).not.toHaveBeenCalled();
});
it('times out and cannot be revived by a delayed callback', async () => {
  const pending = resolvePlace({}, 'id');
  jest.advanceTimersByTime(8000); callback(details(), 'OK');
  await expect(pending).rejects.toThrow(/timed out/);
});
it.each(['ZERO_RESULTS', 'INVALID_COORDINATES', 'MISSING_ADDRESS'])('rejects invalid place details %s', async kind => {
  const pending = resolvePlace({}, 'id'); const value = details();
  if (kind === 'INVALID_COORDINATES') value.geometry.location.lat = () => 91;
  if (kind === 'MISSING_ADDRESS') delete value.formatted_address;
  callback(value, kind === 'ZERO_RESULTS' ? kind : 'OK');
  await expect(pending).rejects.toThrow(/could not be found/);
});
it('fails helpfully when Maps is absent', async () => {
  delete window.google;
  await expect(resolvePlace({}, 'id')).rejects.toThrow(/Maps is not ready/);
});
it('checks finite geographic bounds and reference identity', () => {
  expect(hasCoordinates({ lat: -90, lng: 180 })).toBe(true);
  [null, { lat: NaN, lng: 0 }, { lat: 0, lng: 181 }, { lat: '0', lng: 0 }].forEach(value => expect(hasCoordinates(value)).toBe(false));
  expect(hasPlaceSource({ kind: 'google_places', place_id: 'opaque-id' })).toBe(true);
  ['', 'bad id', 'id\u200b', 'x'.repeat(4097)].forEach(place_id => expect(hasPlaceSource({ kind: 'google_places', place_id })).toBe(false));
});
