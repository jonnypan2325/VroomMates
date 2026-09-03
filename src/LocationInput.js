import React, { useCallback, useEffect, useState } from 'react';
import AddressInput from './components/AddressInput';

const API_BASE_URL = process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000';
const ROUTE_OPTIMIZER_URL = `${API_BASE_URL}/routeoptimizer/`;

const emptyCoordinates = () => ({ lat: null, lng: null });
const newDriver = () => ({ address: '', capacity: 0, coordinates: emptyCoordinates() });
const newPassenger = () => ({ address: '', coordinates: emptyCoordinates() });

const hasCoordinates = ({ lat, lng }) => lat != null && lng != null;

/** Returns a new list with `patch` merged into the item at `index`. */
const updateAt = (list, index, patch) =>
  list.map((item, i) => (i === index ? { ...item, ...patch } : item));

function LocationInput({ map, directionsRenderer, setRouteData }) {
  const [driverData, setDriverData] = useState([newDriver()]);
  const [passengerLocs, setPassengerLocs] = useState([newPassenger()]);
  const [destination, setDestination] = useState(newPassenger());
  const [optimizedRoutes, setOptimizedRoutes] = useState([]);
  const [selectedDriver, setSelectedDriver] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  const displayRoutesForDriver = useCallback(
    (route) => {
      const [driver, ...stops] = route;
      const finalStop = stops[stops.length - 1];
      if (!driver || !finalStop || !directionsRenderer) return;

      const waypoints = stops.slice(0, -1).map((stop) => ({
        location: new window.google.maps.LatLng(stop.lat, stop.lng),
        stopover: true,
      }));

      const directionsService = new window.google.maps.DirectionsService();
      directionsService.route(
        {
          origin: new window.google.maps.LatLng(driver.lat, driver.lng),
          destination: new window.google.maps.LatLng(finalStop.lat, finalStop.lng),
          waypoints,
          travelMode: window.google.maps.TravelMode.DRIVING,
        },
        (response, status) => {
          if (status === 'OK') {
            directionsRenderer.setDirections(response);
          } else {
            console.error(`Directions request failed: ${status}`);
          }
        }
      );
    },
    [directionsRenderer]
  );

  useEffect(() => {
    const route = optimizedRoutes[selectedDriver];
    if (route) displayRoutesForDriver(route);
  }, [optimizedRoutes, selectedDriver, displayRoutesForDriver]);

  const handleDriverChange = useCallback(
    (index, patch) => setDriverData((prev) => updateAt(prev, index, patch)),
    []
  );

  const handlePassengerChange = useCallback(
    (index, patch) => setPassengerLocs((prev) => updateAt(prev, index, patch)),
    []
  );

  const handleCapacityChange = (index, rawValue) => {
    const capacity = Number.parseInt(rawValue, 10);
    handleDriverChange(index, { capacity: Number.isNaN(capacity) ? 0 : capacity });
  };

  const addDriver = () => setDriverData((prev) => [...prev, newDriver()]);
  const addPassenger = () => setPassengerLocs((prev) => [...prev, newPassenger()]);

  const requestOptimizedRoutes = async (drivers, passengers, destinationCoords) => {
    try {
      const response = await fetch(ROUTE_OPTIMIZER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drivers, passengers, destination: destinationCoords }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        const backendMessage = errorBody?.error || response.statusText || 'Unknown error';
        setErrorMessage(`The route optimizer rejected the request: ${backendMessage}`);
        return;
      }

      const result = await response.json();
      if (!result.optimizedRoutes?.length) {
        setErrorMessage('No optimized routes were returned. Please check your inputs and try again.');
        return;
      }

      setSelectedDriver(0);
      setOptimizedRoutes(result.optimizedRoutes);
    } catch (error) {
      console.error('Error sending coordinates to route optimizer:', error);
      setErrorMessage(
        'Could not reach the route optimizer service. Please make sure the backend is running and try again.'
      );
    }
  };

  const handleSubmit = () => {
    setErrorMessage('');

    const driverCoords = driverData.map((driver) => driver.coordinates);
    const passengerCoords = passengerLocs.map((passenger) => passenger.coordinates);

    const allComplete = [...driverCoords, ...passengerCoords, destination.coordinates].every(
      hasCoordinates
    );
    if (!allComplete) {
      setErrorMessage(
        'Please enter a valid address for every driver, passenger, and the destination before submitting.'
      );
      return;
    }

    const drivers = driverCoords.map((coordinates, index) => ({
      location: coordinates,
      capacity: driverData[index].capacity,
    }));

    return requestOptimizedRoutes(drivers, passengerCoords, destination.coordinates);
  };

  return (
    <div>
      <h3>Driver Locations and Capacities</h3>
      {driverData.map((driver, index) => (
        <div key={index} className="driver-input-group">
          <input
            type="number"
            inputMode="numeric"
            min="1"
            value={driver.capacity}
            aria-label={`Driver ${index + 1} capacity`}
            placeholder="Seats"
            onChange={(event) => handleCapacityChange(index, event.target.value)}
          />
          <AddressInput
            map={map}
            value={driver.address}
            label={`Driver ${index + 1} location`}
            placeholder={`Driver ${index + 1} location`}
            onChange={(patch) => handleDriverChange(index, patch)}
          />
        </div>
      ))}
      <button onClick={addDriver}>Add Driver</button>

      <h3>Passenger Locations</h3>
      {passengerLocs.map((passenger, index) => (
        <div key={index} className="passenger-input-group">
          <AddressInput
            map={map}
            value={passenger.address}
            label={`Passenger ${index + 1} location`}
            placeholder={`Passenger ${index + 1} location`}
            onChange={(patch) => handlePassengerChange(index, patch)}
          />
        </div>
      ))}
      <button onClick={addPassenger}>Add Passenger</button>

      <h3>Destination</h3>
      <AddressInput
        map={map}
        className="full-width-input"
        value={destination.address}
        label="Destination"
        placeholder="Destination"
        onChange={(patch) => setDestination((prev) => ({ ...prev, ...patch }))}
      />

      <button className="submit-btn" onClick={handleSubmit}>
        Submit All Locations
      </button>

      <h3>Driver View:</h3>
      <select
        className="full-width-input"
        aria-label="Driver view"
        value={selectedDriver}
        onChange={(event) => setSelectedDriver(Number.parseInt(event.target.value, 10))}
      >
        {driverData.map((_, index) => (
          <option key={index} value={index}>
            {index + 1}
          </option>
        ))}
      </select>

      {errorMessage && (
        <p className="error-message" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

export default LocationInput;
