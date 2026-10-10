import { TextEncoder } from 'util';
import { canonicalText, newId, requestJSON, sameData, SavedApiError } from './api';
beforeAll(() => {
  global.TextEncoder = TextEncoder;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
});
const authWith = response => ({ protectedRequest: jest.fn(async () => response) });
it('passes JSON, method and abort signal through protected transport', async () => {
  const auth = authWith({ ok: true, status: 200, json: async () => ({ saved: true }) });
  const signal = new AbortController().signal;
  await expect(requestJSON(auth, '/saved-trips', { method: 'POST', body: { id: 'synthetic' }, signal })).resolves.toEqual({ saved: true });
  expect(auth.protectedRequest).toHaveBeenCalledWith('/saved-trips', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: '{"id":"synthetic"}' });
});
it('accepts a bodyless successful deletion', async () => {
  const json = jest.fn();
  await expect(requestJSON(authWith({ status: 204, ok: true, json }), '/saved-trips/id', { method: 'DELETE' })).resolves.toBeNull();
  expect(json).not.toHaveBeenCalled();
});
it.each([null, [], 'html', 10])('rejects invalid successful response body %s', async body => {
  await expect(requestJSON(authWith({ ok: true, status: 200, json: async () => body }), '/saved-trips')).rejects.toMatchObject({ status: 503, code: 'INVALID_RESPONSE' });
});
it('makes unreadable successful responses ambiguous, preserving parsed server errors', async () => {
  await expect(requestJSON(authWith({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }), '/saved-trips')).rejects.toMatchObject({ status: 503, code: 'INVALID_RESPONSE' });
  await expect(requestJSON(authWith({ ok: false, status: 409, json: async () => ({ error: { code: 'CONFLICT', message: 'exists', existing_location_id: 'prior' } }) }), '/saved-trips')).rejects.toMatchObject({ status: 409, code: 'CONFLICT', existingId: 'prior' });
});
it('preserves abort identity and maps transport failures to typed network errors', async () => {
  const abort = new DOMException('Stopped', 'AbortError');
  const auth = { protectedRequest: jest.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(new Error('offline')) };
  await expect(requestJSON(auth, '/saved-trips')).rejects.toBe(abort);
  await expect(requestJSON(auth, '/saved-trips')).rejects.toBeInstanceOf(SavedApiError);
});
it('normalizes Unicode names while enforcing bytes and rejecting hidden characters', () => {
  expect(canonicalText('  Cafe\u0301  ', 20, 20)).toBe('Café');
  expect(() => canonicalText('éé', 4, 3)).toThrow();
  expect(() => canonicalText('name\u200b', 30, 30)).toThrow();
  expect(canonicalText('', 1, 1, true)).toBe('');
});
it('creates distinct secure UUIDs and compares content without depending on object key order', () => {
  const ids = Array.from({ length: 20 }, newId);
  expect(new Set(ids).size).toBe(20);
  ids.forEach(id => expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  expect(sameData({ a: [{ x: 1, y: 2 }], b: null }, { b: null, a: [{ y: 2, x: 1 }] })).toBe(true);
  expect(sameData({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
});
