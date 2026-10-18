import React from 'react';
import './GoogleAccount.css';

export default function GoogleAccount({ auth }) {
  const { profile, status, error, retryable, signIn, signInReady, logOut, retry } = auth;
  return (
    <section className="google-account" aria-label="Google account" aria-busy={status === 'verifying'}>
      {status === 'authenticated' ? (
        <div className="account-row">
          <p className="account-greeting">{profile.given_name ? `Hello, ${profile.given_name}` : 'Signed in with Google'}</p>
          <button className="google-btn google-logout-btn" onClick={logOut}>Log out</button>
        </div>
      ) : status === 'verifying' ? (
        <div className="account-row">
          <p className="account-greeting" role="status">Verifying your sign-in…</p>
        </div>
      ) : (
        <div className="google-signin">
          <button className="google-btn google-signin-btn" onClick={signIn} disabled={!signInReady}>Sign in with Google</button>
          {retryable && <div className="account-row google-retry-actions">
            <button className="google-btn" onClick={retry}>Retry verification</button>
          </div>}
        </div>
      )}
      {error && <p className="account-error" role="alert">{error}</p>}
      <p className="account-note">{status === 'authenticated'
        ? 'Signed in for this tab. Refreshing requires sign-in again.'
        : 'Sign in to save your routes and locations.'}</p>
    </section>
  );
}
