import './App.css';
import React, { useEffect } from 'react';
import LocationInput from './LocationInput';

function App() {
  useEffect(() => {
    const initMap = () => {
      // Initialize map with default location
      const map = new window.google.maps.Map(document.getElementById('map'), {
        center: { lat: 37.784, lng: -122.403 },
        zoom: 14,
      });

      const infoWindow = new window.google.maps.InfoWindow();

      // Create a button to pan to the user's current location
      const locationButton = document.createElement('button');
      locationButton.textContent = 'Pan to Current Location';
      locationButton.classList.add('custom-map-control-button');
      map.controls[window.google.maps.ControlPosition.TOP_CENTER].push(locationButton);

      locationButton.addEventListener('click', () => {
        // Try HTML5 geolocation
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const pos = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              };

              infoWindow.setPosition(pos);
              infoWindow.setContent('Location found.');
              infoWindow.open(map);
              map.setCenter(pos);
            },
            () => {
              handleLocationError(true, infoWindow, map.getCenter(), map);
            }
          );
        } else {
          // Browser doesn't support Geolocation
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

  // const [coordinates, setCoordinates] = useState(null);
  
  return (
    <div style={{ display: 'flex' }}>
      <div style={{ width: '30%', padding: '20px' }}>
        <h1>VroomMates</h1>
        <p>Some content on the left side of the screen.</p>
      </div>
      <div id="map" style={{ height: '1000px', width: '70%' }}></div>
    </div>
  );
}

export default App;