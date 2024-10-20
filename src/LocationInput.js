import React, { useState } from 'react';

function LocationInput({ setCoordinates }) {
    const [driverData, setDriverData] = useState([{ location: '', capacity: 0 }]);  // Drivers with location and capacity
    const [passengerLocs, setPassengerLocs] = useState(['']);  // Passenger locations
    const [destination, setDestination] = useState('');  // Destination
    const [errorMessage, setErrorMessage] = useState('');  // Error message

    // Handle driver location change
    const handleDriverLocationChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].location = value;
        setDriverData(updatedDrivers);
    };

    // Handle driver capacity change
    const handleDriverCapacityChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].capacity = value;
        setDriverData(updatedDrivers);
    };

    // Add another driver input field
    const addDriverField = () => setDriverData([...driverData, { location: '', capacity: 0 }]);

    // Handle passenger location change
    const handlePassengerChange = (index, value) => {
        const updatedPassengers = [...passengerLocs];
        updatedPassengers[index] = value;
        setPassengerLocs(updatedPassengers);
    };

    // Add another passenger input field
    const addPassengerField = () => setPassengerLocs([...passengerLocs, '']);

    // Fetch coordinates for a given location using Google Maps API
    const fetchCoordinates = async (location) => {
        const apiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;


        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.status === 'OK') {
                const { lat, lng } = data.results[0].geometry.location;
                return { lat, lng };
            } else {
                console.error('Geocoding error:', data.status);
                setErrorMessage('Error fetching location data.');
                return null;
            }
        } catch (error) {
            console.error('Error fetching geocode:', error);
            setErrorMessage('Error fetching geocode data.');
            return null;
        }
    };

    // Submit all locations and send them to the backend route optimizer
    const handleLocationSubmit = async () => {
        try {
            // Fetch coordinates for drivers, passengers, and destination
            const driverCoords = await Promise.all(driverData.map(driver => fetchCoordinates(driver.location)));
            const passengerCoords = await Promise.all(passengerLocs.map(fetchCoordinates));
            const destCoords = await fetchCoordinates(destination);

            if (driverCoords && passengerCoords && destCoords) {
                sendCoordsToRouteOptimizer(driverCoords, passengerCoords, destCoords);
            }
        } catch (error) {
            console.error('Error processing locations:', error);
        }
    };

    // Send coordinates to Flask backend for route optimization
    const sendCoordsToRouteOptimizer = (driverCoords, passengerCoords, destCoords) => {
        const routeOptimizerURL = 'http://localhost:5000/routeoptimizer';  // Replace with your Flask API URL

        const driverDataWithCoords = driverCoords.map((coords, index) => ({
            location: coords,
            capacity: driverData[index].capacity,
        }));

        fetch(routeOptimizerURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                drivers: driverDataWithCoords,
                passengers: passengerCoords,
                destination: destCoords,
            }),
        })
            .then((response) => response.json())
            .then((data) => {
                console.log('Route optimization data:', data);
                setCoordinates(data);
            })
            .catch((error) => {
                console.error('Error sending coordinates to route optimizer:', error);
            });
    };

    return (
        <div>
            <h3>Driver Locations and Capacities</h3>
            {driverData.map((driver, index) => (
                <div key={index}>
                    <input
                        type="text"
                        value={driver.location}
                        onChange={(e) => handleDriverLocationChange(index, e.target.value)}
                        placeholder={`Enter driver ${index + 1} location`}
                    />
                    <input
                        type="number"
                        value={driver.capacity}
                        onChange={(e) => handleDriverCapacityChange(index, parseInt(e.target.value))}
                        placeholder={`Enter driver ${index + 1} capacity`}
                        min="1"
                    />
                </div>
            ))}
            <button onClick={addDriverField}>Add Driver</button>

            <h3>Passenger Locations</h3>
            {passengerLocs.map((passenger, index) => (
                <input
                    key={index}
                    type="text"
                    value={passenger}
                    onChange={(e) => handlePassengerChange(index, e.target.value)}
                    placeholder={`Enter passenger ${index + 1} location`}
                />
            ))}
            <button onClick={addPassengerField}>Add Passenger</button>

            <h3>Destination</h3>
            <input
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="Enter destination"
            />

            <button onClick={handleLocationSubmit}>Submit All Locations</button>

            {errorMessage && <p style={{ color: 'red' }}>{errorMessage}</p>}
        </div>
    );
}

export default LocationInput;
