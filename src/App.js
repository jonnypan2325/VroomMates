import React, { useState } from 'react';
import LocationInput from './LocationInput';

function App() {
  const [coordinates, setCoordinates] = useState(null);

  return (
    <div className="App">
      <h1>Find Coordinates and Optimize Route</h1>

      {/* LocationInput will take user input and return coordinates */}
      <LocationInput setCoordinates={setCoordinates} />

      {/* Display coordinates once they are received */}
      {coordinates && (
        <div>
          <h3>Coordinates:</h3>
          <p>Latitude: {coordinates.lat}</p>
          <p>Longitude: {coordinates.lng}</p>
        </div>
      )}
    </div>
  );
}

export default App;