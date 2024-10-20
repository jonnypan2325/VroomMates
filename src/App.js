import './App.css';
import React, { useState, useEffect } from 'react';
import LocationInput from './LocationInput';

function App() {
  const [map, setMap] = useState(null); // State for the Google Map instance
  const [directionsRenderer, setDirectionsRenderer] = useState(null); // State for DirectionsRenderer instance
  const [routeData, setRouteData] = useState(null); // State for route data

  useEffect(() => {
    const initMap = () => {
      const mapInstance = new window.google.maps.Map(document.getElementById('map'), {
        center: { lat: 37.784, lng: -122.403 },
        zoom: 14,
      });

      const directionsRendererInstance = new window.google.maps.DirectionsRenderer();
      directionsRendererInstance.setMap(mapInstance); // Attach the directions renderer to the map

      // Store the map and directionsRenderer instances in state
      setMap(mapInstance);
      setDirectionsRenderer(directionsRendererInstance);

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
          //handleLocationError(false, infoWindow, mapInstance.getCenter(), mapInstance);
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
        <p>Enter locations for drivers, passengers, and destination:</p>

        {/* Location Input Component */}
        <LocationInput map={map} directionsRenderer={directionsRenderer} setRouteData={setRouteData} />

        {/* Display route data */}
        {routeData && (
          <div>
            <h3>Optimized Route Data</h3>
            <pre>{JSON.stringify(routeData, null, 2)}</pre>
          </div>
        )}
      </div>

      {/* Google Map */}
      <div id="map" style={{ height: '1000px', width: '70%' }}></div>
    </div>
  );
}

export default App;
