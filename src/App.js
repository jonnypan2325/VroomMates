import './App.css';
import React, { useEffect, useState } from 'react';
import LocationInput from './LocationInput';

function App() {
  // Use state to store map and directionsRenderer
  const [map, setMap] = useState(null);
  const [directionsRenderer, setDirectionsRenderer] = useState(null);

  useEffect(() => {
    const initMap = () => {
      // Initialize map with default location
      const mapInstance = new window.google.maps.Map(document.getElementById('map'), {
        center: { lat: 37.784, lng: -122.403 },
        zoom: 14,
      });

      const directionsRendererInstance = new window.google.maps.DirectionsRenderer();
      directionsRendererInstance.setMap(mapInstance); // Attach the directions renderer to the map

      // Store the map and directionsRenderer instances in state
      setMap(mapInstance);
      setDirectionsRenderer(directionsRendererInstance);

      // Create a button to pan to the user's current location
      const locationButton = document.createElement('button');
      locationButton.textContent = 'Pan to Current Location';
      locationButton.classList.add('custom-map-control-button');
      mapInstance.controls[window.google.maps.ControlPosition.TOP_CENTER].push(locationButton);

      locationButton.addEventListener('click', () => {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const pos = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              };
              mapInstance.setCenter(pos);
            },
            () => {
              handleLocationError(true, mapInstance.getCenter(), mapInstance);
            }
          );
        } else {
          handleLocationError(false, mapInstance.getCenter(), mapInstance);
        }
      });
    };

    const handleLocationError = (browserHasGeolocation, pos, mapInstance) => {
      const infoWindow = new window.google.maps.InfoWindow({
        position: pos,
      });
      infoWindow.setContent(
        browserHasGeolocation
          ? 'Error: The Geolocation service failed.'
          : "Error: Your browser doesn't support geolocation."
      );
      infoWindow.open(mapInstance);
    };
    
    // Initialize map when Google Maps is ready
    if (window.google) {
      initMap();
    } else {
      window.onload = initMap;
    }
  }, []); // Ensure this runs only once, when the component mounts

  return (
    <div style={{ display: 'flex' }}>
      <div style={{ width: '30%', padding: '20px' }}>
        <h1>VroomMates</h1>
        <p>Search for a location to get directions.</p>
        {/* Pass map and directionsRenderer to LocationInput */}
        <LocationInput map={map} directionsRenderer={directionsRenderer} />
      </div>
      <div id="map" style={{ height: '1000px', width: '70%' }}></div>
    </div>
  );
  return (
    <div style={{ display: 'flex' }}>
      <div style={{ width: '30%', padding: '20px' }}>
        <h1>VroomMates</h1>
        <p>Search for a location and get directions from your current location.</p>
        {/* Pass map and directionsRenderer to LocationInput */}
        <LocationInput map={map} directionsRenderer={directionsRenderer} />
      </div>
      <div id="map" style={{ height: '1000px', width: '70%' }}></div>
    </div>
  );
}

export default App;
