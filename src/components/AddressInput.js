import React, { useEffect, useRef } from 'react';

/**
 * A text field backed by Google Places Autocomplete.
 *
 * Owning the element by ref (rather than looking it up by id from a parent
 * effect) means the Autocomplete instance is created once per input when the
 * map becomes available, instead of being rebuilt on every keystroke.
 *
 * Picking a suggestion reports both the formatted address and its coordinates;
 * typing by hand reports only the address, leaving the last known coordinates
 * in place for the parent to validate.
 */
export default function AddressInput({ value, placeholder, label, map, onChange, className }) {
  const inputRef = useRef(null);

  // Held in a ref so a new callback identity doesn't rebind the Autocomplete.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const input = inputRef.current;
    if (!map || !input || !window.google?.maps?.places) return undefined;

    const autocomplete = new window.google.maps.places.Autocomplete(input, {
      fields: ['formatted_address', 'geometry.location'],
    });
    autocomplete.bindTo('bounds', map);

    const listener = autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry?.location) return;

      onChangeRef.current({
        address: place.formatted_address,
        coordinates: {
          lat: place.geometry.location.lat(),
          lng: place.geometry.location.lng(),
        },
      });
    });

    return () => {
      listener.remove();
      window.google.maps.event.clearInstanceListeners(autocomplete);
    };
  }, [map]);

  return (
    <input
      ref={inputRef}
      type="text"
      className={className}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      autoComplete="off"
      onChange={(event) => onChangeRef.current({ address: event.target.value })}
    />
  );
}
