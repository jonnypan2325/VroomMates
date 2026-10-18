import React from 'react';
import { act, fireEvent, render, screen, renderHook } from '@testing-library/react';
import { googleLogout } from '@react-oauth/google';
import GoogleAccount from './GoogleAccount';
import useGoogleProfile from '../hooks/useGoogleProfile';

// Like the installed hook, callbacks are read from the latest render, so a popup
// result arriving late reaches the current options rather than a stale copy.
const mockGoogle = { options: null, popups: 0, ready: true };
jest.mock('@react-oauth/google', () => ({
  googleLogout: jest.fn(),
  useGoogleOAuth: () => ({ scriptLoadedSuccessfully: mockGoogle.ready }),
  useGoogleLogin: (options) => {
    mockGoogle.options = options;
    return () => { mockGoogle.popups += 1; };
  },
}));

const NOW = 1900000000000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const exchanged = (credential = 'synthetic-proof-a') => reply(200, { status: 'success', credential });
const successResponse = (name = 'Fixture', expiry = NOW / 1000 + 3600, subject = 'synthetic-fixture') =>
  reply(200, { status: 'success', user: { id: `google:${subject}`, ...(name ? { given_name: name } : {}) }, expires_at: expiry });
function AccountHarness() { return <GoogleAccount auth={useGoogleProfile()} />; }
let originalFetch;
beforeEach(() => {
  jest.useFakeTimers('modern');
  jest.setSystemTime(NOW);
  originalFetch = global.fetch;
  global.fetch = jest.fn();
  mockGoogle.options = null;
  mockGoogle.popups = 0;
  mockGoogle.ready = true;
  googleLogout.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});
const popupReturns = async (result = { code: '4/synthetic-code' }) => {
  await act(async () => { await mockGoogle.options.onSuccess(result); });
};
const signIn = async (verify = successResponse(), credential = 'synthetic-proof-a') => {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
  global.fetch.mockResolvedValueOnce(exchanged(credential)).mockResolvedValueOnce(verify);
  await popupReturns();
};

it('opens the Google code popup and only greets after server verification', async () => {
  render(<AccountHarness />);
  expect(screen.getByText('Sign in to save your routes and locations.')).toBeVisible();
  expect(mockGoogle.options.flow).toBe('auth-code');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
  expect(mockGoogle.popups).toBe(1);
  expect(global.fetch).not.toHaveBeenCalled();
  const pending = deferred();
  global.fetch.mockResolvedValueOnce(exchanged()).mockReturnValueOnce(pending.promise);
  let signing;
  act(() => { signing = mockGoogle.options.onSuccess({ code: '4/synthetic-code' }); });
  await act(async () => { for (let tick = 0; tick < 5; tick += 1) await Promise.resolve(); });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/auth\/google-code$/);
  expect(screen.getByRole('status')).toHaveTextContent('Verifying your sign-in');
  expect(screen.getByRole('region', { name: 'Google account' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(screen.queryByText('Hello, Fixture')).not.toBeInTheDocument();
  await act(async () => { pending.resolve(successResponse()); await signing; });
  expect(screen.getByText('Hello, Fixture')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Log out' })).toBeVisible();
  expect(screen.getByText('Signed in for this tab. Refreshing requires sign-in again.')).toBeVisible();
});

it('keeps sign-in disabled until the Google script has loaded', () => {
  mockGoogle.ready = false;
  const { rerender } = render(<AccountHarness />);
  expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
  mockGoogle.ready = true;
  rerender(<AccountHarness />);
  expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
});

it('a closed popup reports an incomplete sign-in without calling the backend', async () => {
  render(<AccountHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
  act(() => { mockGoogle.options.onNonOAuthError({ type: 'popup_closed' }); });
  expect(screen.getByRole('alert')).toHaveTextContent('Sign-in was not completed');
  expect(global.fetch).not.toHaveBeenCalled();
});

it('shows an accessible invalid-proof error without a greeting or retry', async () => {
  render(<AccountHarness />);
  await signIn(reply(401));
  expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed');
  expect(screen.queryByText('Hello, Fixture')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry verification' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

it('an exchange outage asks for a fresh sign-in because codes are single-use', async () => {
  render(<AccountHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
  global.fetch.mockResolvedValueOnce(reply(503));
  await popupReturns();
  expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
  expect(screen.queryByRole('button', { name: 'Retry verification' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

it('temporary verification outage shows explicit retry and preserves the reviewed no-Cancel UI', async () => {
  render(<AccountHarness />);
  await signIn(reply(503));
  expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  global.fetch.mockResolvedValueOnce(successResponse());
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry verification' })); });
  expect(screen.getByText('Hello, Fixture')).toBeVisible();
  expect(global.fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer synthetic-proof-a');
});

it('optional name falls back to a verified-account greeting; a popup result after logout is ignored', async () => {
  render(<AccountHarness />);
  await signIn(successResponse(null));
  expect(screen.getByText('Signed in with Google')).toBeVisible();
  expect(screen.queryByText(/Hello, undefined/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  expect(googleLogout).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Sign in to save your routes and locations.')).toBeVisible();
  const calls = global.fetch.mock.calls.length;
  await popupReturns({ code: '4/late-old-code' });
  act(() => { mockGoogle.options.onError({ error: 'access_denied' }); });
  expect(global.fetch).toHaveBeenCalledTimes(calls);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('a late popup result from A cannot replace or reject newly verified B', async () => {
  render(<AccountHarness />);
  await signIn();
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  await signIn(successResponse('Second account', NOW / 1000 + 3600, 'synthetic-account-b'), 'synthetic-proof-b');
  const calls = global.fetch.mock.calls.length;
  await popupReturns({ code: '4/late-a-code' });
  act(() => { mockGoogle.options.onNonOAuthError({ type: 'popup_closed' }); });
  expect(global.fetch).toHaveBeenCalledTimes(calls);
  expect(screen.getByText('Hello, Second account')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('expiry clears greeting and offers sign-in again', async () => {
  render(<AccountHarness />);
  await signIn(successResponse('Fixture', NOW / 1000 + 1));
  act(() => { jest.advanceTimersByTime(1000); });
  expect(screen.queryByText('Hello, Fixture')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('sign-in expired');
  expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

it('a popup result for an unmounted hook cannot restore sign-in', async () => {
  const pending = deferred();
  global.fetch.mockReturnValueOnce(pending.promise);
  const { result, unmount } = renderHook(() => useGoogleProfile());
  act(() => { result.current.signIn(); });
  const onSuccess = mockGoogle.options.onSuccess;
  let signing;
  act(() => { signing = onSuccess({ code: '4/synthetic-code' }); });
  const signal = global.fetch.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  pending.resolve(exchanged());
  await signing;
  await onSuccess({ code: '4/late-old-code' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it('fresh hook after unmount starts anonymous and leaves no expiry timer', async () => {
  const { result, unmount } = renderHook(() => useGoogleProfile());
  act(() => { result.current.signIn(); });
  global.fetch.mockResolvedValueOnce(exchanged()).mockResolvedValueOnce(successResponse());
  await popupReturns();
  expect(result.current.profile.id).toBe('google:synthetic-fixture');
  expect(jest.getTimerCount()).toBe(1);
  unmount();
  expect(jest.getTimerCount()).toBe(0);
  const fresh = renderHook(() => useGoogleProfile());
  expect(fresh.result.current).toMatchObject({ status: 'anonymous', profile: null });
});

it('StrictMode effect remount does not authenticate or call the backend automatically', async () => {
  render(<React.StrictMode><AccountHarness /></React.StrictMode>);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockGoogle.popups).toBe(0);
  await signIn();
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Hello, Fixture')).toBeVisible();
});
