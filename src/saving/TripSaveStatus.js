import React, { useRef, useState } from 'react';
import InlineEdit from './InlineEdit';

const Check = () => <svg className="trip-status-mark" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
  <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** One line under the route heading: whether this route is saved, and its name, renamable in place. */
export default function TripSaveStatus({ save, auth }) {
  const [renameError, setRenameError] = useState('');
  // Retry and Save this trip give way to "Saving…", so focus stays on this line rather than falling to the page.
  const line = useRef(null);
  const act = (action) => () => { action(); line.current?.focus(); };
  return <div ref={line} tabIndex={-1} className="trip-status-line">
    <StatusContent save={save} auth={auth} act={act} renameError={renameError} setRenameError={setRenameError} />
  </div>;
}

function StatusContent({ save, auth, act, renameError, setRenameError }) {
  const { phase, trip } = save;
  const rename = async (next) => {
    setRenameError('');
    try { await save.rename(next); } catch (error) {
      setRenameError('The new name could not be saved. Please retry.');
      throw error;
    }
  };
  if (phase === 'idle') return null;
  if (phase === 'signed-out') {
    return <div className="trip-status">
      <button type="button" className="text-button trip-status-signin" disabled={!auth.signInReady}
        onClick={() => auth.signIn()}>Sign in to save this trip</button>
    </div>;
  }
  if (phase === 'unsavable') return <div className="trip-status"><p className="saving-note">{save.message}</p></div>;
  if (phase === 'error') {
    return <div className="trip-status" role="alert">
      <span className="trip-status-error">Not saved.</span>
      <span>{save.message || (trip ? 'Your latest changes are not in My trips yet.' : 'It is not in My trips yet.')}</span>
      <button type="button" className="text-button" onClick={act(save.retry)}>Retry</button>
    </div>;
  }
  if (phase === 'unsaved') {
    return <div className="trip-status">
      <span>Not saved.</span>
      <button type="button" className="text-button" onClick={act(save.saveAgain)}>Save this trip</button>
    </div>;
  }
  if (!trip) return <div className="trip-status" role="status"><span>Saving…</span></div>;
  return <>
    <div className="trip-status">
      {phase === 'saving' ? <span role="status">Saving…</span> : <Check />}
      <span className="trip-status-name">Saved as <InlineEdit value={trip.title} label="Trip name" onCommit={rename} /></span>
      {trip.opened && <button type="button" className="text-button" disabled={phase === 'saving'}
        onClick={save.saveAsNew}>Save as new trip</button>}
    </div>
    {renameError && <p className="saving-error" role="alert">{renameError}</p>}
  </>;
}
