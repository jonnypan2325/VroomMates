import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { googleLogout, useGoogleLogin, useGoogleOAuth } from '@react-oauth/google';
import GoogleIdentitySession from '../auth/GoogleIdentitySession';

/** Only a verified server response makes this tab authenticated. */
export default function useGoogleProfile() {
  const [session] = useState(() => new GoogleIdentitySession({
    apiUrl: process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000',
    onLogout: googleLogout,
  }));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => () => session.clear(), [session]);
  // A popup's result belongs to the generation that opened it; later ones are ignored.
  const opened = useRef(null);
  // Until Google's script loads, a sign-in click would silently do nothing.
  const { scriptLoadedSuccessfully } = useGoogleOAuth();
  const requestCode = useGoogleLogin({
    flow: 'auth-code',
    // Logging out here leaves the Google session, so always offer the account chooser.
    select_account: true,
    onSuccess: (response) => session.acceptCode(response, opened.current),
    onError: () => session.rejectGoogle(opened.current),
    onNonOAuthError: () => session.rejectGoogle(opened.current),
  });
  return {
    ...state,
    signInReady: scriptLoadedSuccessfully,
    signIn: () => {
      opened.current = session.getSnapshot().generation;
      requestCode();
    },
    logOut: session.logout,
    cancel: session.logout,
    retry: session.retry,
    protectedRequest: session.request,
  };
}
