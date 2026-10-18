import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasCoordinates, hasPlaceSource, landmarkName } from '../saving/places';

// Typing replaces the place, so its saved-location link and landmark name go with it.
const invalidPoint = () => ({ coordinates: { lat: null, lng: null }, source: null, label: '', place_name: '', saved_id: null });

/** Google search and an account's saved-place chooser share one address field. */
export default function AddressInput({ value, placeholder, label, map, onChange, className,
  disabled = false, savedLocations = [], onSavedSelect, action, nickname = '', placeName = '', onBlur, autoFocus = false }) {
  const inputRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const live = useRef(true);
  const selection = useRef(0);
  const [choosing, setChoosing] = useState(false);
  const [savedError, setSavedError] = useState('');
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState(null);
  // A named place shows its nickname over the address until the user chooses to edit it.
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(null);
  const namedButton = useRef(null);
  const detailsId = useId();
  // A nickname wins; otherwise a landmark's own name leads, with the street address below.
  const title = nickname || placeName;
  const named = Boolean(title && value && !editing);
  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);
  useEffect(() => {
    if (!details) return undefined;
    const close = () => setDetails(null);
    const outside = (event) => {
      if (!event.target.closest?.('.address-details') && !namedButton.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [details]);
  useEffect(() => { if (!named) setDetails(null); }, [named]);
  const openDetails = () => {
    const rect = namedButton.current?.getBoundingClientRect();
    if (rect) setDetails({ left: rect.left, top: rect.bottom + 4, width: rect.width });
  };
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; selection.current += 1; };
  }, []);
  useEffect(() => {
    const input = inputRef.current;
    if (!map || !input || !window.google?.maps?.places?.Autocomplete) return undefined;
    let active = true;
    const autocomplete = new window.google.maps.places.Autocomplete(input, {
      fields: ['place_id', 'name', 'formatted_address', 'geometry.location'],
    });
    autocomplete.bindTo('bounds', map);
    const listener = autocomplete.addListener('place_changed', () => {
      if (!active || input.disabled) return;
      selection.current += 1;
      setChoosing(false); setSavedError('');
      const place = autocomplete.getPlace();
      const location = place.geometry?.location;
      const coordinates = location ? { lat: location.lat(), lng: location.lng() } : null;
      const source = { kind: 'google_places', place_id: place.place_id };
      if (!hasCoordinates(coordinates) || !hasPlaceSource(source) || typeof place.formatted_address !== 'string') {
        onChangeRef.current(invalidPoint());
        return;
      }
      onChangeRef.current({ address: place.formatted_address, coordinates, source, label: '', saved_id: null,
        place_name: landmarkName(place.name, place.formatted_address) });
    });
    return () => {
      active = false;
      listener.remove();
      window.google.maps.event.clearInstanceListeners(autocomplete);
    };
  }, [map]);

  const chooseSaved = async (id) => {
    const row = savedLocations.find((item) => item.id === id);
    if (!row || !onSavedSelect || disabled) return;
    const operation = ++selection.current;
    setChoosing(true); setSavedError('');
    try {
      await onSavedSelect(row);
      if (!live.current || selection.current !== operation) return;
      if (inputRef.current?.getClientRects().length) inputRef.current.focus();
    } catch (error) {
      if (live.current && selection.current === operation && error.name !== 'AbortError') {
        setSavedError('This saved location could not be loaded. Choose it again to retry.');
      }
    } finally {
      if (live.current && selection.current === operation) setChoosing(false);
    }
  };
  // Saved places lead the suggestions while the field is empty or the text matches a nickname;
  // once it does not, Google's address suggestions take over.
  const query = value.trim().toLocaleLowerCase();
  const matches = onSavedSelect && focused && !named && !disabled && !choosing
    ? savedLocations.filter((row) => !query || row.label.toLocaleLowerCase().includes(query)).slice(0, 8) : [];
  const listOpen = matches.length > 0;
  useLayoutEffect(() => {
    if (!listOpen) return undefined;
    const place = () => {
      const rect = inputRef.current?.parentElement?.getBoundingClientRect();
      if (rect) setBox({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    };
    place();
    document.body.classList.add('saved-suggestions-open');
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.body.classList.remove('saved-suggestions-open');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [listOpen]);
  useEffect(() => { setActive(-1); }, [query, listOpen]);
  const keyDown = (event) => {
    if (!listOpen) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => (index + 1) % matches.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => (index <= 0 ? matches.length : index) - 1); }
    else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); void chooseSaved(matches[active].id); }
    else if (event.key === 'Escape') { event.preventDefault(); setFocused(false); }
  };
  return <div className="address-field" aria-busy={choosing}>
    <div className={'address-input-wrap' + (action ? ' has-address-action' : '')}>
      {named && <button type="button" ref={namedButton} className="address-named" disabled={disabled}
        aria-label={label + ': ' + title + ', ' + value} aria-expanded={Boolean(details)}
        aria-controls={details ? detailsId : undefined} onClick={() => (details ? setDetails(null) : openDetails())}>
        <span className="address-named-label">{title}</span>
        <span className="address-named-address">{value}</span>
      </button>}
      <input ref={inputRef} type="text" className={className} value={value} disabled={disabled} hidden={named}
        aria-label={label} placeholder={placeholder} autoComplete="off" autoFocus={autoFocus} title={value || undefined}
        role={onSavedSelect ? 'combobox' : undefined} aria-autocomplete={onSavedSelect ? 'list' : undefined}
        aria-expanded={onSavedSelect ? listOpen : undefined} aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen && active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setFocused(true)} onKeyDown={keyDown}
        onBlur={() => { setFocused(false); setEditing(false); onBlur?.(); }}
        onChange={(event) => {
          selection.current += 1; setChoosing(false); setSavedError('');
          onChangeRef.current({ address: event.target.value, ...invalidPoint() });
        }} />
      {choosing && <span className="address-loading" role="status">Loading saved place…</span>}
      {action && <div className="address-action">{action}</div>}
    </div>
    {details && createPortal(<div id={detailsId} className="address-details" role="dialog" aria-label={'Details for ' + label}
      style={{ left: details.left, top: details.top, width: details.width }}
      onKeyDown={(event) => { if (event.key === 'Escape') { setDetails(null); namedButton.current?.focus(); } }}>
      <p className="address-details-title">{title}</p>
      <p className="address-details-address">{value}</p>
      <button type="button" className="text-button" autoFocus
        onClick={() => { setDetails(null); setEditing(true); }}>Change address</button>
    </div>, document.body)}
    {listOpen && box && createPortal(<ul id={listId} role="listbox" aria-label={'Saved places for ' + label}
      className="saved-suggestions" style={{ left: box.left, top: box.top, width: box.width }}>
      <li className="saved-suggestions-heading" role="presentation">Saved places</li>
      {matches.map((row, index) => <li key={row.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
        className={index === active ? 'is-active' : undefined} onMouseEnter={() => setActive(index)}
        onMouseDown={(event) => { event.preventDefault(); void chooseSaved(row.id); }}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 14 14"><path d="M3.5 1.75h7a.75.75 0 0 1 .75.75v10l-4.25-2.6-4.25 2.6v-10a.75.75 0 0 1 .75-.75Z" fill="currentColor" /></svg>
        <span>{row.label}</span>
      </li>)}
    </ul>, document.body)}

    {savedError && <p className="saving-error" role="alert">{savedError}</p>}
  </div>;
}
