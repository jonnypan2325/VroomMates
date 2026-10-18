import { act, renderHook, waitFor } from '@testing-library/react';
import { TextEncoder } from 'util';
import { webcrypto } from 'crypto';
import useSavedLocations from './useSavedLocations';

global.TextEncoder = TextEncoder;
Object.defineProperty(global, 'crypto', { configurable: true, value: webcrypto });
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const source = { kind: 'google_places', place_id: 'synthetic-place' };
const row = (id = A, label = 'Home', selectedSource = source) => ({ id, label, source: selectedSource,
  schema_version: 1, resolution_required: true, created_at: '2026-10-06T12:00:00Z', updated_at: '2026-10-06T12:00:00Z' });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const list = (...locations) => response({ status: 'success', locations });
const record = (body) => response({ status: 'success', location: row(body.id, body.label, body.source) });
const failure = (status = 503) => response({ error: { code: 'STORE_UNAVAILABLE', message: 'Synthetic outage' } }, status);
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const owner = (protectedRequest, id = 'google:synthetic-a', generation = 1) => ({ status: 'authenticated', profile: { id }, generation, protectedRequest });
async function mount(request) {
  const auth = owner(request);
  const view = renderHook(({ account }) => useSavedLocations(account), { initialProps: { account: auth } });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return { ...view, auth };
}
async function invoke(action) { let value, error; await act(async () => { try { value = await action(); } catch (caught) { error = caught; } }); return { value, error }; }

it('loads private source-only records and keeps refresh stable across list state updates', async () => {
  const request = jest.fn().mockResolvedValue(list(row()));
  const { result } = await mount(request);
  const refresh = result.current.refresh;
  expect(result.current.locations).toEqual([row()]);
  await invoke(() => result.current.refresh());
  expect(result.current.refresh).toBe(refresh);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET' });
});

it('refetches after a confirmed save and preserves it when the list request fails', async () => {
  const request = jest.fn().mockResolvedValueOnce(list())
    .mockImplementationOnce(async (_, options) => record(JSON.parse(options.body)))
    .mockResolvedValueOnce(failure());
  const { result } = await mount(request);
  const { value, error } = await invoke(() => result.current.save(' Home ', source));
  expect(error).toBeUndefined();
  expect(value.label).toBe('Home');
  expect(result.current.locations).toEqual([value]);
  expect(result.current.error.code).toBe('STORE_UNAVAILABLE');
  const body = JSON.parse(request.mock.calls[1][1].body);
  expect(Object.keys(body).sort()).toEqual(['id', 'label', 'source']);
  expect(body.source).toEqual(source);
  expect(request.mock.calls[2][0]).toBe('/saved-locations');
});

it.each([204, 404])('confirmed deletion with %s removes the row despite a refetch outage', async (status) => {
  const request = jest.fn().mockResolvedValueOnce(list(row()))
    .mockResolvedValueOnce(response(null, status)).mockResolvedValueOnce(failure());
  const { result } = await mount(request);
  const { error } = await invoke(() => result.current.remove(A));
  expect(error).toBeUndefined();
  expect(result.current.locations).toEqual([]);
  expect(request.mock.calls[1]).toEqual([`/saved-locations/${A}`, expect.objectContaining({ method: 'DELETE' })]);
  expect(request).toHaveBeenCalledTimes(3);
  expect(result.current.error.code).toBe('STORE_UNAVAILABLE');
});

it.each([200, 202])('does not claim deletion for an unexpected %s response; explicit retry can succeed', async (status) => {
  const request = jest.fn().mockResolvedValueOnce(list(row()))
    .mockResolvedValueOnce(response({ status: 'success' }, status))
    .mockResolvedValueOnce(response(null, 204)).mockResolvedValueOnce(list());
  const { result } = await mount(request);
  expect((await invoke(() => result.current.remove(A))).error.code).toBe('INVALID_RESPONSE');
  expect(result.current.locations).toEqual([row()]);
  expect(request).toHaveBeenCalledTimes(2);
  expect((await invoke(() => result.current.remove(A))).error).toBeUndefined();
  expect(result.current.locations).toEqual([]);
});

it('latest list wins and an earlier failed list cannot replace successful state', async () => {
  const older = deferred(), newer = deferred();
  const request = jest.fn().mockResolvedValueOnce(list()).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const { result } = await mount(request);
  let first, second;
  act(() => { first = result.current.refresh().catch((error) => error); second = result.current.refresh(); });
  await act(async () => { newer.resolve(list(row(B, 'Work'))); await second; });
  await act(async () => { older.resolve(failure()); await first; });
  expect(result.current.locations).toEqual([row(B, 'Work')]);
  expect(result.current.error).toBeNull();
  expect(result.current.loading).toBe(false);
});

it('list started before mutation cannot resurrect a confirmed deleted row', async () => {
  const old = deferred(), fresh = deferred();
  const request = jest.fn().mockResolvedValueOnce(list(row())).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(response(null, 204)).mockReturnValueOnce(fresh.promise);
  const { result } = await mount(request);
  let loading;
  act(() => { loading = result.current.refresh(); });
  await invoke(() => result.current.remove(A));
  await act(async () => { old.resolve(list(row())); await loading; });
  expect(result.current.locations).toEqual([]);
  expect(result.current.loading).toBe(true);
  await act(async () => { fresh.resolve(list()); await fresh.promise; });
  expect(result.current.loading).toBe(false);
});

it('freezes an ambiguous save, blocks a different draft, then reconciles without a second POST', async () => {
  const request = jest.fn().mockResolvedValueOnce(list()).mockRejectedValueOnce(new Error('Synthetic disconnect'));
  const { result } = await mount(request);
  const first = await invoke(() => result.current.save('Home', source));
  expect(first.error).toMatchObject({ code: 'NETWORK', retryLabel: 'Home', retrySource: source });
  const body = JSON.parse(request.mock.calls[1][1].body);
  const changed = await invoke(() => result.current.save('Work', { ...source, place_id: 'different' }));
  expect(changed.error.code).toBe('UNRESOLVED_SAVE');
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValueOnce(record(body)).mockResolvedValueOnce(list(row(body.id)));
  expect((await invoke(() => result.current.save('Home', source))).value).toEqual(row(body.id));
  expect(request.mock.calls[2][0]).toBe(`/saved-locations/${body.id}`);
  expect(request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  expect(result.current.error).toBeNull();
});

it('retries a missing ambiguous record using the exact original ID and JSON body', async () => {
  const request = jest.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(failure())
    .mockResolvedValueOnce(failure(404)).mockImplementationOnce(async (_, options) => record(JSON.parse(options.body)))
    .mockImplementationOnce(async () => list());
  const { result } = await mount(request);
  await invoke(() => result.current.save('Home', source));
  expect((await invoke(() => result.current.save(' Home ', { ...source }))).error).toBeUndefined();
  expect(request.mock.calls[3][1].body).toBe(request.mock.calls[1][1].body);
  expect(request.mock.calls[2][1].method).toBe('GET');
});

it('a mismatching successful POST stays unresolved and a definite rejection permits a new body', async () => {
  const request = jest.fn().mockResolvedValueOnce(list())
    .mockImplementationOnce(async (_, options) => record({ ...JSON.parse(options.body), label: 'Wrong' }))
    .mockResolvedValueOnce(failure(404)).mockResolvedValueOnce(failure(409))
    .mockImplementationOnce(async (_, options) => record(JSON.parse(options.body))).mockResolvedValueOnce(list());
  const { result } = await mount(request);
  expect((await invoke(() => result.current.save('Home', source))).error).toMatchObject({ code: 'INVALID_RESPONSE', retryLabel: 'Home' });
  await invoke(() => result.current.save('Home', source));
  const next = await invoke(() => result.current.save('Work', source));
  expect(next.error).toBeUndefined();
  expect(JSON.parse(request.mock.calls[4][1].body).label).toBe('Work');
  expect(request.mock.calls[4][1].body).not.toBe(request.mock.calls[1][1].body);
});

it('rejects duplicate or provider-enriched list records and supports list retry', async () => {
  const request = jest.fn().mockResolvedValueOnce(list(row(), row())).mockResolvedValueOnce(list({ ...row(), address: 'private provider address' })).mockResolvedValueOnce(list(row()));
  const { result } = await mount(request);
  expect(result.current.error.code).toBe('INVALID_RESPONSE');
  expect((await invoke(() => result.current.refresh())).error.code).toBe('INVALID_RESPONSE');
  await invoke(() => result.current.refresh());
  expect(result.current.locations).toEqual([row()]);
  expect(result.current.error).toBeNull();
});

it('logout aborts old requests, clears private rows and rejects retained account callbacks', async () => {
  const pending = deferred();
  const request = jest.fn().mockResolvedValueOnce(list(row())).mockReturnValueOnce(pending.promise);
  const { result, rerender } = await mount(request);
  const oldSave = result.current.save;
  let loading;
  act(() => { loading = result.current.refresh().catch((error) => error); });
  rerender({ account: { status: 'anonymous', generation: 2 } });
  expect(result.current.locations).toEqual([]);
  expect(result.current.error).toBeNull();
  expect(request.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => { pending.resolve(list(row())); expect((await loading).name).toBe('AbortError'); });
  expect((await invoke(() => oldSave('Home', source))).error.name).toBe('AbortError');
  expect(request).toHaveBeenCalledTimes(2);
});

it('account and generation switches discard old writes and unresolved attempt metadata', async () => {
  const pending = deferred();
  const requestA = jest.fn().mockResolvedValueOnce(list()).mockReturnValueOnce(pending.promise);
  const requestB = jest.fn().mockResolvedValueOnce(list(row(B, 'Second')))
    .mockImplementationOnce(async (_, options) => record(JSON.parse(options.body))).mockResolvedValueOnce(list());
  const { result, rerender } = await mount(requestA);
  let saving;
  act(() => { saving = result.current.save('Home', source).catch((error) => error); });
  const oldBody = JSON.parse(requestA.mock.calls[1][1].body);
  rerender({ account: owner(requestB, 'google:synthetic-b', 2) });
  expect(result.current.locations).toEqual([]);
  await waitFor(() => expect(result.current.locations).toEqual([row(B, 'Second')]));
  await act(async () => { pending.resolve(record(oldBody)); expect((await saving).name).toBe('AbortError'); });
  expect(result.current.locations).toEqual([row(B, 'Second')]);
  expect((await invoke(() => result.current.save('Work', source))).error).toBeUndefined();
  rerender({ account: owner(jest.fn().mockResolvedValue(list()), 'google:synthetic-b', 3) });
  expect(result.current.locations).toEqual([]);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBeNull();
});

const edited = (changes) => response({ status: 'success', location: { ...row(), updated_at: '2026-10-07T09:30:00Z', ...changes } });

it('edit patches only the changed fields and accepts a record updated after creation', async () => {
  const moved = { kind: 'google_places', place_id: 'synthetic-moved' };
  const request = jest.fn().mockResolvedValueOnce(list(row()))
    .mockResolvedValueOnce(edited({ label: 'Home base' })).mockResolvedValueOnce(list(row(A, 'Home base')))
    .mockResolvedValueOnce(edited({ label: 'Home base', source: moved })).mockResolvedValueOnce(list(row(A, 'Home base', moved)));
  const { result } = await mount(request);
  const renamed = await invoke(() => result.current.edit(A, ' Home base ', source));
  expect(renamed.error).toBeUndefined();
  expect(renamed.value).toMatchObject({ id: A, label: 'Home base', updated_at: '2026-10-07T09:30:00Z' });
  expect(request.mock.calls[1][0]).toBe(`/saved-locations/${A}`);
  expect(request.mock.calls[1][1].method).toBe('PATCH');
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ label: 'Home base' });
  const relocated = await invoke(() => result.current.edit(A, 'Home base', moved));
  expect(relocated.error).toBeUndefined();
  expect(JSON.parse(request.mock.calls[3][1].body)).toEqual({ source: moved });
  expect(result.current.locations).toEqual([row(A, 'Home base', moved)]);
  const unchanged = await invoke(() => result.current.edit(A, 'Home base', moved));
  expect(unchanged.value).toEqual(row(A, 'Home base', moved));
  expect(request).toHaveBeenCalledTimes(5);
});

it.each([
  ['updated before it was created', { label: 'Home base', updated_at: '2026-10-05T12:00:00Z' }],
  ['a label other than the one sent', { label: 'Someone else' }],
  ['provider data in the record', { label: 'Home base', address: 'private provider address' }],
])('edit rejects a record %s and keeps the stored row', async (_, changes) => {
  const request = jest.fn().mockResolvedValueOnce(list(row())).mockResolvedValueOnce(edited(changes));
  const { result } = await mount(request);
  expect((await invoke(() => result.current.edit(A, 'Home base', source))).error.code).toBe('INVALID_RESPONSE');
  expect(result.current.locations).toEqual([row()]);
  expect(request).toHaveBeenCalledTimes(2);
});

it('edit validates before sending and an edit from a previous account is aborted without a request', async () => {
  const pending = deferred();
  const request = jest.fn().mockResolvedValueOnce(list(row())).mockReturnValueOnce(pending.promise);
  const { result, rerender } = await mount(request);
  expect((await invoke(() => result.current.edit(A, '', source))).error.code).toBe('INVALID_LOCATION');
  expect((await invoke(() => result.current.edit(A, 'Home', { ...source, address: 'provider text' }))).error.code).toBe('INVALID_LOCATION');
  expect((await invoke(() => result.current.edit('not-a-uuid', 'Home', source))).error.code).toBe('INVALID_LOCATION');
  expect(request).toHaveBeenCalledTimes(1);
  const oldEdit = result.current.edit;
  let editing;
  act(() => { editing = oldEdit(A, 'Home base', source).catch((error) => error); });
  const signal = request.mock.calls[1][1].signal;
  const requestB = jest.fn().mockResolvedValue(list(row(B, 'Second')));
  rerender({ account: owner(requestB, 'google:synthetic-b', 2) });
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(edited({ label: 'Home base' })); expect((await editing).name).toBe('AbortError'); });
  await waitFor(() => expect(result.current.locations).toEqual([row(B, 'Second')]));
  expect((await invoke(() => oldEdit(A, 'Again', source))).error.name).toBe('AbortError');
  expect(requestB.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});
