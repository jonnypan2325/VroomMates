import { useEffect, useState } from 'react';
import { googleLogout, useGoogleLogin } from '@react-oauth/google';
import axios from 'axios';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo';

/** Handles Google sign-in and exposes the signed-in user's profile. */
export default function useGoogleProfile() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);

  const login = useGoogleLogin({
    onSuccess: setSession,
    onError: (error) => console.error('Google login failed:', error),
  });

  useEffect(() => {
    if (!session) return undefined;

    let cancelled = false;
    axios
      // The Bearer header authenticates on its own; keep the token out of the URL.
      .get(USERINFO_URL, {
        headers: { Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' },
      })
      .then((response) => {
        if (!cancelled) setProfile(response.data);
      })
      .catch((error) => console.error('Could not load Google profile:', error));

    return () => {
      cancelled = true;
    };
  }, [session]);

  const logOut = () => {
    googleLogout();
    setSession(null);
    setProfile(null);
  };

  return { profile, login, logOut };
}
