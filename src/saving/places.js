export const hasCoordinates = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng) &&
  point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;

export const hasPlaceSource = (source) => source?.kind === 'google_places' &&
  typeof source.place_id === 'string' && !!source.place_id &&
  !/[\s\p{C}]/u.test(source.place_id) && new TextEncoder().encode(source.place_id).length <= 4096;

/** A landmark's own name, when it says more than the start of its street address. */
export function landmarkName(name, address) {
  if (typeof name !== 'string' || !name.trim() || typeof address !== 'string') return '';
  return address.toLocaleLowerCase().startsWith(name.trim().toLocaleLowerCase()) ? '' : name.trim();
}

export function resolvePlace(map, placeId, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!map || !window.google?.maps?.places?.PlacesService) {
      reject(new Error('Maps is not ready. Please retry when the map has loaded.'));
      return;
    }
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => done(new DOMException('Selection changed.', 'AbortError'));
    const timer = setTimeout(() => done(new Error('Location lookup timed out. Please retry.')), 8000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      const service = new window.google.maps.places.PlacesService(map);
      service.getDetails({ placeId, fields: ['place_id', 'name', 'formatted_address', 'geometry.location'] },
        (place, status) => {
          if (finished) return;
          const location = place?.geometry?.location;
          const coordinates = location ? { lat: location.lat(), lng: location.lng() } : null;
          if (status !== 'OK' || !hasCoordinates(coordinates) || typeof place?.formatted_address !== 'string') {
            done(new Error('This saved location could not be found. Please retry or choose another place.'));
            return;
          }
          done(null, { address: place.formatted_address, coordinates, place_name: landmarkName(place.name, place.formatted_address),
            source: { kind: 'google_places', place_id: placeId } });
        });
    } catch {
      done(new Error('Location lookup is unavailable. Please retry.'));
    }
  });
}
