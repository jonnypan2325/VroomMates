import { useEffect, useState, useSyncExternalStore } from 'react';
import { googleLogout } from '@react-oauth/google';
import GoogleIdentitySession from '../auth/GoogleIdentitySession';

/** Only a verified server response makes this tab authenticated. */
export default function useGoogleProfile() {
  const [session] = useState(() => new GoogleIdentitySession({
    apiUrl: process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000',
    onLogout: googleLogout,
  }));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => () => session.clear(), [session]);
  // GoogleLogin must be remounted on generation changes; its callback refs otherwise drift.
  const generation = state.generation;
  return {
    ...state,
    onGoogleSuccess: (response) => session.acceptGoogle(response, generation),
    onGoogleError: () => session.rejectGoogle(generation),
    logOut: session.logout,
    cancel: session.logout,
    retry: session.retry,
    protectedRequest: session.request,
  };
}
