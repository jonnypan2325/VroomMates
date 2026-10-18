import React, { useEffect, useId, useRef, useState } from 'react';
import './GoogleAccount.css';

const GoogleMark = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
</svg>;

/** Header account circle: a Google sign-in circle when signed out, the user's initial when signed in. */
export default function GoogleAccount({ auth }) {
  const { profile, status, signIn, signInReady, logOut } = auth;
  const panelId = useId();
  const wrapper = useRef(null);
  const trigger = useRef(null);
  const closeTimer = useRef(null);
  const [open, setOpen] = useState(false);
  // A click pins the panel open; hover and keyboard focus only preview it.
  const pinned = useRef(false);
  // Focus from a pointer press is followed by its click; only keyboard focus previews the panel.
  const lastInput = useRef('keyboard');
  const returningFocus = useRef(false);
  useEffect(() => {
    const pointer = () => { lastInput.current = 'pointer'; };
    const keyboard = () => { lastInput.current = 'keyboard'; };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
    };
  }, []);
  const signedIn = status === 'authenticated';

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => { if (!signedIn) { pinned.current = false; setOpen(false); } }, [signedIn]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!wrapper.current?.contains(event.target)) { pinned.current = false; setOpen(false); }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  // A short delay lets the pointer cross the gap between the circle and the panel.
  const hide = () => {
    clearTimeout(closeTimer.current);
    if (!pinned.current) closeTimer.current = setTimeout(() => setOpen(false), 160);
  };
  const close = () => { clearTimeout(closeTimer.current); pinned.current = false; setOpen(false); };

  if (status === 'verifying') {
    return <div className="account-circle account-verifying" role="status" aria-label="Verifying your sign-in">
      <span className="account-spinner" aria-hidden="true" />
    </div>;
  }
  if (!signedIn) {
    return <div className="account-signin">
      <span className="account-signin-hint" aria-hidden="true">Sign in to save</span>
      <button type="button" className="account-circle account-google" onClick={signIn} disabled={!signInReady}
        aria-label="Sign in with Google" title="Sign in with Google"><GoogleMark /></button>
    </div>;
  }

  const name = profile.given_name || '';
  return <div className="account-menu" ref={wrapper}
    onPointerEnter={(event) => { if (event.pointerType === 'mouse') show(); }}
    onPointerLeave={(event) => { if (event.pointerType === 'mouse') hide(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        close();
        // Focus handed back after closing must not reopen the panel.
        returningFocus.current = true;
        trigger.current?.focus();
        returningFocus.current = false;
      }
    }}
    onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget) && !pinned.current) close(); }}>
    <button type="button" ref={trigger} className="account-circle" aria-expanded={open} aria-controls={panelId}
      aria-label={name ? `Account: ${name}` : 'Account'}
      onFocus={() => { if (lastInput.current === 'keyboard' && !returningFocus.current) show(); }}
      onClick={() => {
        if (open && pinned.current) close();
        else { clearTimeout(closeTimer.current); pinned.current = true; setOpen(true); }
      }}>
      {name ? name.charAt(0).toUpperCase() : <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="7" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.75 16.5c1.2-2.7 3.4-4 6.25-4s5.05 1.3 6.25 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>}
    </button>
    <div id={panelId} className="account-panel" hidden={!open}>
      <p className="account-greeting">{name ? `Hello, ${name}` : 'Signed in with Google'}</p>
      <p className="account-note">Signed in for this tab. Refreshing requires sign-in again.</p>
      <button type="button" className="secondary-button account-logout" onClick={logOut}>Log out</button>
    </div>
  </div>;
}

/** Sign-in errors and retry, shown under the header rather than inside the circle. */
export function GoogleAccountNotice({ auth }) {
  const { error, retryable, retry, status } = auth;
  if (!error && !(retryable && status !== 'verifying')) return null;
  return <div className="account-notice" role="alert">
    {error && <p>{error}</p>}
    {retryable && <button type="button" className="secondary-button" onClick={retry}>Retry verification</button>}
  </div>;
}
