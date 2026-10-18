/* global globalThis */
export class SavedApiError extends Error {
  constructor(status, code, message, existingId = null) {
    super(message);
    this.name = 'SavedApiError';
    this.status = status;
    this.code = code;
    this.existingId = existingId;
  }
}

export async function requestJSON(auth, path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await auth.protectedRequest(path, {
      method, signal,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new SavedApiError(0, 'NETWORK', 'Could not reach saved data. Please retry.');
  }
  if (response.status === 204) return null;
  let data;
  try { data = await response.json(); } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (response.ok) throw new SavedApiError(503, 'INVALID_RESPONSE', 'The save could not be confirmed. Please check and retry.');
    data = null;
  }
  if (!response.ok) {
    const detail = data?.error;
    throw new SavedApiError(response.status, detail?.code || data?.code || 'REQUEST_FAILED',
      typeof detail?.message === 'string' ? detail.message : 'Saved data is unavailable. Please retry.',
      detail?.existing_location_id || data?.existing_location_id || null);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SavedApiError(503, 'INVALID_RESPONSE', 'The response could not be confirmed. Please retry.');
  }
  return data;
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('This browser cannot create a secure save identifier.');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return value.slice(0, 8) + '-' + value.slice(8, 12) + '-' + value.slice(12, 16) + '-' +
    value.slice(16, 20) + '-' + value.slice(20);
}

export function canonicalText(value, maxPoints, maxBytes, allowEmpty = false) {
  if (typeof value !== 'string' || /\p{C}/u.test(value)) throw new Error('Use a label without hidden or control characters.');
  // Python str.strip whitespace, rather than JS trim's additional BOM behavior.
  const cleaned = value.normalize('NFC').replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
  if ((!cleaned && !allowEmpty) || Array.from(cleaned).length > maxPoints ||
      new TextEncoder().encode(cleaned).length > maxBytes) {
    throw new Error('Enter a shorter, nonempty name.');
  }
  return cleaned;
}

export function sameData(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left).sort();
  const other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((key, index) =>
    key === other[index] && sameData(left[key], right[key]));
}
