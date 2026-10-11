import React, { useEffect, useRef, useState } from 'react';
import { hasCoordinates, hasPlaceSource } from '../saving/places';

const invalidPoint = () => ({ coordinates: { lat: null, lng: null }, source: null, label: '' });

/** Google search and an account's saved-place chooser share one address field. */
export default function AddressInput({ value, placeholder, label, map, onChange, className,
  disabled = false, savedLocations = [], onSavedSelect, action }) {
  const inputRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const live = useRef(true);
  const selection = useRef(0);
  const [choosing, setChoosing] = useState(false);
  const [savedError, setSavedError] = useState('');
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; selection.current += 1; };
  }, []);
  useEffect(() => {
    const input = inputRef.current;
    if (!map || !input || !window.google?.maps?.places?.Autocomplete) return undefined;
    let active = true;
    const autocomplete = new window.google.maps.places.Autocomplete(input, {
      fields: ['place_id', 'formatted_address', 'geometry.location'],
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
      onChangeRef.current({ address: place.formatted_address, coordinates, source, label: '' });
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
  const picker = !!onSavedSelect && savedLocations.length > 0;
  return <div className="address-field" aria-busy={choosing}>
    <div className={'address-input-wrap' + (picker ? ' has-saved-places' : '') + (action ? ' has-address-action' : '')}>
      <input ref={inputRef} type="text" className={className} value={value} disabled={disabled}
        aria-label={label} placeholder={placeholder} autoComplete="off"
        onChange={(event) => {
          selection.current += 1; setChoosing(false); setSavedError('');
          onChangeRef.current({ address: event.target.value, ...invalidPoint() });
        }} />
      {action && <div className="address-action">{action}</div>}
      {picker && <select className="address-saved-chooser" value="" disabled={disabled || choosing}
        aria-label={'Choose saved location for ' + label}
        onChange={(event) => void chooseSaved(event.target.value)}>
        <option value="">{choosing ? 'Loading…' : 'Saved'}</option>
        {savedLocations.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select>}
    </div>
    {savedError && <p className="saving-error" role="alert">{savedError}</p>}
  </div>;
}
