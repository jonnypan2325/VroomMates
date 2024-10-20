import './App.css';
import React, { useState, useEffect } from 'react';
import LocationInput from './LocationInput';

function App() {
  const [routeData, setRouteData] = useState(null);

  useEffect(() => {
    const initMap = () => {
      const map = new window.google.maps.Map(document.getElementById('map'), {
        center: { lat: 37.784, lng: -122.403 },
        zoom: 14,
      });

      const infoWindow = new window.google.maps.InfoWindow();

      const locationButton = document.createElement('button');
      locationButton.textContent = 'Pan to Current Location';
      locationButton.classList.add('custom-map-control-button');
      map.controls[window.google.maps.ControlPosition.TOP_CENTER].push(locationButton);

      locationButton.addEventListener('click', () => {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const pos = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              };
              map.setCenter(pos);
            },
            () => {
              handleLocationError(true, infoWindow, map.getCenter(), map);
            }
          );
        } else {
          handleLocationError(false, infoWindow, map.getCenter(), map);
        }
      });
    };

    const handleLocationError = (browserHasGeolocation, infoWindow, pos, map) => {
      infoWindow.setPosition(pos);
      infoWindow.setContent(
        browserHasGeolocation
          ? 'Error: The Geolocation service failed.'
          : "Error: Your browser doesn't support geolocation."
      );
      infoWindow.open(map);
    };

    if (window.google) {
      initMap();
    } else {
      window.onload = initMap;
    }
  }, []);

  return (
    <div style={{ display: 'flex' }}>
      <div style={{ width: '30%', padding: '20px' }}>
        <h1>VroomMates</h1>
        <p>Enter locations for drivers, passengers, and destination:</p>

        {/* Location Input Component */}
        <LocationInput setRouteData={setRouteData} />

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
