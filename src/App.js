import './App.css';
import React, { useEffect } from 'react';

function App() {
  useEffect(() => {
    const initMap = () => {
      new window.google.maps.Map(document.getElementById('map'), {
        center: { lat: -34.397, lng: 150.644 },
        zoom: 8,
      });
    };

    if (window.google) {
      initMap();
    } else {
      window.onload = initMap;
    }
  }, []);
  return (
    <div>
      <h1>Google Map</h1>
      <div id="map" style={{ height: '400px', width: '100%' }}></div>
    </div>
  );
}

export default App;