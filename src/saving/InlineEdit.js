import React, { useEffect, useRef, useState } from 'react';

/**
 * Text that edits in place: double-click on desktop, tap on touch, Enter from the keyboard.
 * Leaving the field or pressing Enter saves; Escape restores the previous text.
 */
export default function InlineEdit({ value, onCommit, label, className = '', maxLength, renderEditor }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const trigger = useRef(null);
  const pointer = useRef('mouse');
  const settled = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => {
    if (editing && !renderEditor) { input.current?.focus(); input.current?.select(); }
  }, [editing, renderEditor]);

  const start = () => { if (!busy) { settled.current = false; setEditing(true); } };
  const finish = (refocus) => {
    setEditing(false);
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const commit = async (next, refocus = false) => {
    if (settled.current) return;
    settled.current = true;
    if (next === undefined || next === value) { finish(refocus); return; }
    setBusy(true);
    finish(refocus);
    try { await onCommit(next); } catch (_) { /* The caller reports the failure and keeps the old value. */ }
    finally { if (live.current) setBusy(false); }
  };
  const cancel = () => { settled.current = true; setDraft(value); finish(true); };

  if (editing) {
    if (renderEditor) {
      return <span className={'inline-edit is-editing ' + className}>
        {renderEditor({ commit: (next) => void commit(next, true), cancel })}
      </span>;
    }
    return <input ref={input} className={'inline-edit-input ' + className} value={draft} maxLength={maxLength}
      aria-label={label} onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit(draft.trim() ? draft : undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); void commit(draft.trim() ? draft : undefined, true); }
        else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }} />;
  }
  return <button type="button" ref={trigger} className={'inline-edit ' + className + (busy ? ' is-busy' : '')}
    title="Double-click to edit" aria-label={`${label}: ${value}. Press Enter to edit`} aria-busy={busy}
    onPointerDown={(event) => { pointer.current = event.pointerType; }}
    onClick={(event) => { if (event.detail === 0 || pointer.current !== 'mouse') start(); }}
    onDoubleClick={start}>{value}</button>;
}
