import React from 'react';
import { act, fireEvent, render, screen, renderHook } from '@testing-library/react';
import { googleLogout } from '@react-oauth/google';
import GoogleAccount from './GoogleAccount';
import useGoogleProfile from '../hooks/useGoogleProfile';

const mockGoogleMounts = [];
jest.mock('@react-oauth/google', () => {
  const React = require('react');
  return {
    googleLogout: jest.fn(),
    GoogleLogin: function FixtureGoogleLogin(props) {
      // Match the installed wrapper's mutable callback refs. Retained callbacks
      // remain callable after unmount, so keyed remounts are actually exercised.
      const success = React.useRef(props.onSuccess);
      const error = React.useRef(props.onError);
      success.current = props.onSuccess;
      error.current = props.onError;
      React.useEffect(() => {
        const mount = {
          success: (credential) => success.current(credential),
          error: () => error.current(), props, unmounted: false,
        };
        mockGoogleMounts.push(mount);
        return () => { mount.unmounted = true; };
      }, []);
      return React.createElement('button', { onClick: () => props.onSuccess({ credential: 'synthetic-proof-a' }) }, 'Fixture Google sign-in');
    },
  };
});

const NOW = 1900000000000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const successResponse = (name = 'Fixture', expiry = NOW / 1000 + 3600, subject = 'synthetic-fixture') => ({
  ok: true, status: 200,
  json: async () => ({ status: 'success', user: { id: `google:${subject}`, ...(name ? { given_name: name } : {}) }, expires_at: expiry }),
});
function AccountHarness() { return <GoogleAccount auth={useGoogleProfile()} />; }
let originalFetch;
beforeEach(() => {
  jest.useFakeTimers('modern');
  jest.setSystemTime(NOW);
  originalFetch = global.fetch;
  global.fetch = jest.fn();
  mockGoogleMounts.length = 0;
  googleLogout.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});
const latestGoogle = () => mockGoogleMounts[mockGoogleMounts.length - 1];
const signIn = async (response = successResponse()) => {
  global.fetch.mockResolvedValueOnce(response);
  await act(async () => { await latestGoogle().success({ credential: 'synthetic-proof-a' }); });
};

it('shows requested anonymous note and only greets after server verification', async () => {
  const pending = deferred();
  global.fetch.mockReturnValueOnce(pending.promise);
  render(<AccountHarness />);
  expect(screen.getByText('Sign in to save your routes and locations.')).toBeVisible();
  expect(latestGoogle().props).toMatchObject({ useOneTap: false, auto_select: false });
  fireEvent.click(screen.getByRole('button', { name: 'Fixture Google sign-in' }));
  expect(screen.getByRole('status')).toHaveTextContent('Verifying your sign-in');
  expect(screen.getByRole('region', { name: 'Google account' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(screen.queryByText('Hello, Fixture')).not.toBeInTheDocument();
  await act(async () => { pending.resolve(successResponse()); await pending.promise; });
  expect(screen.getByText('Hello, Fixture')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Log out' })).toBeVisible();
  expect(screen.getByText('Signed in for this tab. Refreshing requires sign-in again.')).toBeVisible();
});

it('shows an accessible invalid-proof error without a greeting or retry', async () => {
  render(<AccountHarness />);
  await signIn({ ok: false, status: 401 });
  expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed');
  expect(screen.queryByText('Hello, Fixture')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry verification' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Fixture Google sign-in' })).toBeVisible();
});

it('temporary outage shows explicit retry and preserves the reviewed no-Cancel UI', async () => {
  render(<AccountHarness />);
  await signIn({ ok: false, status: 503 });
  expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  global.fetch.mockResolvedValueOnce(successResponse());
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry verification' })); });
  expect(screen.getByText('Hello, Fixture')).toBeVisible();
  expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-proof-a');
});

it('optional name falls back to a verified-account greeting and logout remounts GIS', async () => {
  render(<AccountHarness />);
  const originalGoogle = latestGoogle();
  await signIn(successResponse(null));
  expect(screen.getByText('Signed in with Google')).toBeVisible();
  expect(screen.queryByText(/Hello, undefined/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  expect(googleLogout).toHaveBeenCalledTimes(1);
  expect(originalGoogle.unmounted).toBe(true);
  expect(latestGoogle()).not.toBe(originalGoogle);
  expect(screen.getByText('Sign in to save your routes and locations.')).toBeVisible();
  const calls = global.fetch.mock.calls.length;
  await act(async () => { await originalGoogle.success({ credential: 'late-old-proof' }); originalGoogle.error(); });
  expect(global.fetch).toHaveBeenCalledTimes(calls);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('retained Google A callbacks cannot replace or reject newly verified B', async () => {
  render(<AccountHarness />);
  const oldGoogle = latestGoogle();
  await signIn();
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  await signIn(successResponse('Second account', NOW / 1000 + 3600, 'synthetic-account-b'));
  const calls = global.fetch.mock.calls.length;
  await act(async () => { await oldGoogle.success({ credential: 'late-a-proof' }); oldGoogle.error(); });
  expect(global.fetch).toHaveBeenCalledTimes(calls);
  expect(screen.getByText('Hello, Second account')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('expiry clears greeting and remounts explicit Google sign-in', async () => {
  render(<AccountHarness />);
  await signIn(successResponse('Fixture', NOW / 1000 + 1));
  act(() => { jest.advanceTimersByTime(1000); });
  expect(screen.queryByText('Hello, Fixture')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('sign-in expired');
  expect(screen.getByRole('button', { name: 'Fixture Google sign-in' })).toBeVisible();
});

it('a retained callback from unmounted hook cannot restore sign-in', async () => {
  const pending = deferred();
  global.fetch.mockReturnValueOnce(pending.promise);
  const { result, unmount } = renderHook(() => useGoogleProfile());
  const oldCallback = result.current.onGoogleSuccess;
  let signing;
  act(() => { signing = oldCallback({ credential: 'synthetic-proof-a' }); });
  const signal = global.fetch.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  pending.resolve(successResponse());
  await signing;
  await oldCallback({ credential: 'late-old-proof' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it('fresh hook after unmount starts anonymous and leaves no expiry timer', async () => {
  const { result, unmount } = renderHook(() => useGoogleProfile());
  global.fetch.mockResolvedValueOnce(successResponse());
  await act(async () => { await result.current.onGoogleSuccess({ credential: 'synthetic-proof-a' }); });
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
  await signIn();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Hello, Fixture')).toBeVisible();
});
