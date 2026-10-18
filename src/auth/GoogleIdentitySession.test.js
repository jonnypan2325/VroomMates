import GoogleIdentitySession from './GoogleIdentitySession';

const NOW = 1900000000000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const proof = (account = 'a', changes = {}) => ({
  status: 'success', user: { id: `google:fixture-${account}`, given_name: account.toUpperCase() },
  expires_at: NOW / 1000 + 3600, ...changes,
});
const response = (status = 200, body = proof()) => ({
  status, ok: status >= 200 && status < 300, json: jest.fn().mockResolvedValue(body),
});
class FixtureHeaders {
  constructor(input = {}) {
    this.values = new Map(input instanceof FixtureHeaders ? input.values
      : Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
  }
  set(key, value) { this.values.set(key.toLowerCase(), value); }
  get(key) { return this.values.get(key.toLowerCase()) || null; }
}

let fetchImpl, session, logout, originalHeaders;
beforeEach(() => {
  jest.useFakeTimers('modern');
  jest.setSystemTime(NOW);
  originalHeaders = global.Headers;
  global.Headers = FixtureHeaders;
  fetchImpl = jest.fn();
  logout = jest.fn();
  session = new GoogleIdentitySession({ apiUrl: 'https://synthetic-api.example/', fetchImpl, onLogout: logout });
});
afterEach(() => {
  session.clear();
  global.Headers = originalHeaders;
  jest.useRealTimers();
});
const signIn = async (account = 'a', changes = {}) => {
  fetchImpl.mockResolvedValueOnce(response(200, proof(account, changes)));
  await session.acceptGoogle({ credential: `synthetic-proof-${account}` }, session.getSnapshot().generation);
};
const switchToB = async () => { session.logout(); await signIn('b'); };

it('authenticates only after the backend succeeds; sends proof only as explicit bearer', async () => {
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const storage = jest.spyOn(Storage.prototype, 'setItem');
  const signing = session.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
  expect(session.getSnapshot()).toMatchObject({ status: 'verifying', profile: null });
  expect(fetchImpl).toHaveBeenCalledWith('https://synthetic-api.example/auth/verify', expect.objectContaining({
    method: 'POST', credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-proof-a' },
  }));
  expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('body');
  expect(JSON.stringify(session.getSnapshot())).not.toContain('synthetic-proof-a');
  pending.resolve(response());
  await signing;
  expect(session.getSnapshot()).toMatchObject({ status: 'authenticated', profile: { id: 'google:fixture-a' } });
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});

it.each([401, 400])('backend rejection %s clears the candidate and requires fresh sign-in', async (status) => {
  fetchImpl.mockResolvedValueOnce(response(status));
  await session.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null, retryable: false });
  await session.retry();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(session.request('/auth/verify')).rejects.toThrow('Sign in required');
});

it.each(['503', 'network'])('temporary %s failure permits an explicit retry without false login', async (failure) => {
  if (failure === '503') fetchImpl.mockResolvedValueOnce(response(503));
  else fetchImpl.mockRejectedValueOnce(new Error('synthetic outage'));
  await session.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null, retryable: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  fetchImpl.mockResolvedValueOnce(response());
  await session.retry();
  expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-proof-a');
  expect(session.getSnapshot().status).toBe('authenticated');
});

it.each([
  { expires_at: NOW / 1000 }, { expires_at: '1900003600' }, { status: 'error' },
  { user: { id: 'client-supplied-owner' } }, { user: { id: 'google:' } },
])('rejects malformed or expired backend success without authentication (%j)', async (changes) => {
  await signIn('a', changes);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null, retryable: false });
});

it('handles optional name without falling back to unverified profile data', async () => {
  await signIn('a', { user: { id: 'google:fixture-a' } });
  expect(session.getSnapshot().profile).toEqual({ id: 'google:fixture-a' });
});

it('logout aborts verification, drops proof and ignores a retained Google callback', async () => {
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const signing = session.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
  const signal = fetchImpl.mock.calls[0][1].signal;
  session.logout();
  expect(signal.aborted).toBe(true);
  expect(logout).toHaveBeenCalledTimes(1);
  pending.resolve(response());
  await signing;
  await session.acceptGoogle({ credential: 'late-proof' }, 0);
  session.rejectGoogle(0);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(session.request('/auth/verify')).rejects.toThrow('Sign in required');
});

it.each(['success', '401', 'network'])('ignores late A verification %s after B signs in', async (outcome) => {
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const signing = session.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
  await switchToB();
  if (outcome === 'network') pending.reject(new Error('late synthetic failure'));
  else pending.resolve(response(outcome === '401' ? 401 : 200));
  await signing;
  expect(session.getSnapshot()).toMatchObject({ status: 'authenticated', profile: { id: 'google:fixture-b' }, error: '' });
});

it.each(['success', 'rejection'])('ignores late verification JSON %s after account switching', async (outcome) => {
  const body = deferred();
  const readingStarted = deferred();
  fetchImpl.mockResolvedValueOnce({ ok: true, status: 200, json: () => { readingStarted.resolve(); return body.promise; } });
  const signing = session.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
  await readingStarted.promise;
  await switchToB();
  if (outcome === 'success') body.resolve(proof('a'));
  else body.reject(new Error('late synthetic verification body failure'));
  await signing;
  expect(session.getSnapshot().profile.id).toBe('google:fixture-b');
});

it('expiry clears state and proof and aborts outstanding protected work', async () => {
  await signIn('a', { expires_at: NOW / 1000 + 1 });
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const request = session.request('/auth/verify');
  const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  const signal = fetchImpl.mock.calls[1][1].signal;
  jest.advanceTimersByTime(1000);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null });
  expect(signal.aborted).toBe(true);
  pending.resolve(response());
  await rejection;
});

it('checks expiry at dispatch even when the browser timer was delayed', async () => {
  await signIn('a', { expires_at: NOW / 1000 + 1 });
  jest.setSystemTime(NOW + 1000);
  await expect(session.request('/auth/verify')).rejects.toThrow('Sign in required');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().profile).toBeNull();
});

it.each(['success', '401', 'network'])('late protected A %s cannot affect signed-in B', async (outcome) => {
  await signIn();
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const request = session.request('/auth/verify');
  const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await switchToB();
  if (outcome === 'network') pending.reject(new Error('late failure'));
  else pending.resolve(response(outcome === '401' ? 401 : 200));
  await rejection;
  expect(session.getSnapshot()).toMatchObject({ profile: { id: 'google:fixture-b' }, error: '' });
});

it('current protected 401 clears authorization; current 503 keeps a valid session', async () => {
  await signIn();
  fetchImpl.mockResolvedValueOnce(response(503));
  expect((await session.request('/auth/verify')).status).toBe(503);
  expect(session.getSnapshot().status).toBe('authenticated');
  fetchImpl.mockResolvedValueOnce(response(401));
  expect((await session.request('/auth/verify')).status).toBe(401);
  expect(session.getSnapshot().profile).toBeNull();
});

it('binds proof at dispatch, overrides ambient credentials/header and honors caller abort', async () => {
  await signIn();
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const external = new AbortController();
  const request = session.request('/auth/verify', { credentials: 'include', headers: { Authorization: 'injected', 'X-Fixture': 'present' }, signal: external.signal });
  const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  const options = fetchImpl.mock.calls[1][1];
  expect(options.credentials).toBe('omit');
  expect(options.headers.get('Authorization')).toBe('Bearer synthetic-proof-a');
  expect(options.headers.get('X-Fixture')).toBe('present');
  external.abort();
  expect(options.signal.aborted).toBe(true);
  pending.resolve(response());
  await rejection;
  expect(session.getSnapshot().profile.id).toBe('google:fixture-a');
});

it.each(['success', 'rejection'])('body %s after B yields cancellation, including cloned responses', async (outcome) => {
  await signIn();
  const body = deferred();
  const raw = { ...response(), body: { fixtureRawStream: true }, json: () => body.promise };
  raw.clone = jest.fn(() => raw);
  fetchImpl.mockResolvedValueOnce(raw);
  const guarded = await session.request('/auth/verify');
  expect(guarded).not.toHaveProperty('body');
  expect(Object.isFrozen(guarded)).toBe(true);
  const clone = guarded.clone().clone();
  expect(clone).not.toHaveProperty('body');
  const reading = clone.json();
  const rejection = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  await switchToB();
  if (outcome === 'success') body.resolve({ fixture: 'account-a-body' });
  else body.reject(new Error('late account-a-body error'));
  await rejection;
  expect(() => guarded.clone()).toThrow('Authentication changed');
  await expect(guarded.json()).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.getSnapshot().profile.id).toBe('google:fixture-b');
});

it('preserves current-account body failures for explicit error handling', async () => {
  await signIn();
  const error = new Error('synthetic body failure');
  fetchImpl.mockResolvedValueOnce({ ...response(), json: () => Promise.reject(error) });
  const guarded = await session.request('/auth/verify');
  await expect(guarded.json()).rejects.toBe(error);
  expect(session.getSnapshot().profile.id).toBe('google:fixture-a');
});

it('fresh controller models refresh/new-tab sign-in and rejects off-API destinations', async () => {
  await signIn();
  const fresh = new GoogleIdentitySession({ apiUrl: 'https://synthetic-api.example', fetchImpl });
  expect(fresh.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null });
  for (const path of ['https://attacker.invalid', '//attacker.invalid']) {
    await expect(session.request(path)).rejects.toThrow('API-relative');
  }
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  fresh.clear();
});

it('default timers run unbound, as browsers require', async () => {
  jest.useRealTimers();
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  const browserLike = (real) => function timer(...args) {
    if (this !== undefined && this !== global) throw new TypeError('Illegal invocation');
    return real(...args);
  };
  global.setTimeout = browserLike(realSet);
  global.clearTimeout = browserLike(realClear);
  const browser = new GoogleIdentitySession({ apiUrl: 'https://synthetic-api.example', fetchImpl });
  try {
    fetchImpl.mockResolvedValueOnce(response(200, proof('a', { expires_at: Math.floor(Date.now() / 1000) + 3600 })));
    await browser.acceptGoogle({ credential: 'synthetic-proof-a' }, 0);
    expect(browser.getSnapshot()).toMatchObject({ status: 'authenticated' });
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
    browser.clear();
  }
});

const exchanged = (credential = 'synthetic-proof-a') => response(200, { status: 'success', credential });

it('exchanges a popup code, then verifies the returned ID token as before', async () => {
  fetchImpl.mockResolvedValueOnce(exchanged()).mockResolvedValueOnce(response());
  await session.acceptCode({ code: '4/synthetic-code' }, 0);
  expect(fetchImpl.mock.calls[0]).toEqual(['https://synthetic-api.example/auth/google-code', expect.objectContaining({
    method: 'POST', credentials: 'omit', cache: 'no-store', body: JSON.stringify({ code: '4/synthetic-code' }),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XmlHttpRequest' },
  })]);
  expect(fetchImpl.mock.calls[1][0]).toBe('https://synthetic-api.example/auth/verify');
  expect(fetchImpl.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer synthetic-proof-a' });
  expect(session.getSnapshot()).toMatchObject({ status: 'authenticated', profile: { id: 'google:fixture-a', given_name: 'A' } });
  expect(JSON.stringify(session.getSnapshot())).not.toContain('synthetic-proof-a');
});

it.each([
  ['a missing code', undefined, null, 'Sign-in failed. Please try again.'],
  ['a rejected code', '4/c', () => response(401), 'Sign-in failed. Please sign in again.'],
  ['a malformed exchange reply', '4/c', () => response(200, { status: 'success' }), 'Sign-in failed. Please sign in again.'],
  ['an exchange outage', '4/c', () => response(503), 'Sign-in is temporarily unavailable. Please try again.'],
  ['a network failure', '4/c', () => Promise.reject(new Error('synthetic')), 'Sign-in is temporarily unavailable. Please try again.'],
])('%s leaves the user signed out without verifying', async (_name, code, reply, message) => {
  if (reply) fetchImpl.mockImplementationOnce(reply);
  await session.acceptCode(code === undefined ? {} : { code }, 0);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', profile: null, error: message, retryable: false });
  expect(fetchImpl).toHaveBeenCalledTimes(reply ? 1 : 0);
});

it('a verification outage after the exchange can be retried with the exchanged token', async () => {
  fetchImpl.mockResolvedValueOnce(exchanged()).mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response());
  await session.acceptCode({ code: '4/c' }, 0);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', retryable: true });
  await session.retry();
  expect(fetchImpl.mock.calls[2][1].headers).toEqual({ Authorization: 'Bearer synthetic-proof-a' });
  expect(session.getSnapshot()).toMatchObject({ status: 'authenticated' });
});

it('logout during the exchange aborts it and ignores the late reply', async () => {
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const signing = session.acceptCode({ code: '4/c' }, 0);
  expect(session.getSnapshot()).toMatchObject({ status: 'verifying' });
  const signal = fetchImpl.mock.calls[0][1].signal;
  session.logout();
  expect(signal.aborted).toBe(true);
  pending.resolve(exchanged());
  await signing;
  await session.acceptCode({ code: '4/late' }, 0);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot()).toMatchObject({ status: 'anonymous', error: '' });
});

it('a late exchange for A cannot replace signed-in B', async () => {
  const pending = deferred();
  fetchImpl.mockReturnValueOnce(pending.promise);
  const signing = session.acceptCode({ code: '4/a' }, 0);
  await switchToB();
  pending.resolve(exchanged('synthetic-proof-a'));
  await signing;
  expect(session.getSnapshot()).toMatchObject({ status: 'authenticated', profile: { id: 'google:fixture-b' } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
