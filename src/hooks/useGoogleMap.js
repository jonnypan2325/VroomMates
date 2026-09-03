import { useEffect, useState } from 'react';

const DEFAULT_CENTER = { lat: 37.784, lng: -122.403 };
const DEFAULT_ZOOM = 14;

const MAP_OPTIONS = {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  // Trim the controls that crowd a small map, and let one finger pan it.
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: false,
  gestureHandling: 'greedy',
};

/** Adds the "pan to current location" control to the top of the map. */
function addCurrentLocationControl(map) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Pan to Current Location';
  button.classList.add('custom-map-control-button');

  button.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showInfoWindow(map, "Error: Your browser doesn't support geolocation.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => map.setCenter({ lat: coords.latitude, lng: coords.longitude }),
      () => showInfoWindow(map, 'Error: The Geolocation service failed.')
    );
  });

  map.controls[window.google.maps.ControlPosition.TOP_CENTER].push(button);
}

function showInfoWindow(map, message) {
  const infoWindow = new window.google.maps.InfoWindow({ position: map.getCenter() });
  infoWindow.setContent(message);
  infoWindow.open(map);
}

/**
 * Creates the Google Map once the Maps script has loaded, and returns it along
 * with the DirectionsRenderer attached to it. The script tag in index.html is
 * `async defer`, so it may not be ready when this first runs; deferred scripts
 * always execute before 'load', which makes that a safe fallback signal.
 */
export default function useGoogleMap(containerId) {
  const [map, setMap] = useState(null);
  const [directionsRenderer, setDirectionsRenderer] = useState(null);

  useEffect(() => {
    const initMap = () => {
      const container = document.getElementById(containerId);
      if (!container || !window.google) return;

      const mapInstance = new window.google.maps.Map(container, MAP_OPTIONS);
      const renderer = new window.google.maps.DirectionsRenderer();
      renderer.setMap(mapInstance);
      addCurrentLocationControl(mapInstance);

      setMap(mapInstance);
      setDirectionsRenderer(renderer);
    };

    if (window.google) {
      initMap();
      return undefined;
    }

    // addEventListener rather than window.onload, which would clobber other handlers.
    window.addEventListener('load', initMap, { once: true });
    return () => window.removeEventListener('load', initMap);
  }, [containerId]);

  return { map, directionsRenderer };
}
