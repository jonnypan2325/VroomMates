import React, { useState } from 'react';

function LocationInput({ setCoordinates }) {
    const [driverData, setDriverLocs] = useState([{location: '', capacity: 0}]);
    const [passengerLocs, setPassengerLocs] = useState(['']);
    const [destination, setDestination] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    const handleDriverChange = (index, value) => {
        const updatedDrivers = [...driverLocs];
        updatedDrivers[index] = value;
        setDriverLocs(updatedDrivers);
    };

    const handleDriverCapacityChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].capacity = value;
        setDriverData(updatedDrivers);
    };

    const addDriverField = () => setDriverData([...driverData, {location: '', capacity: 0}]);

    const handlePassengerChange = (index, value) => {
        const updatedPassengers = [...passngersLocs];
        updatedPassengers[index] = value;
        setPassengerLocs(updatedPassengers);
    };

    const addPassengerField = () => setPassengerLocs([...passengerLocs, '']);

    const handleLocSubmit = async () => {
    try {
        const driverCoords = await Promise.all(driverData.map(driver => fetchCoordinates(driver.location)));
        const passengerCoords = await Promise.all(passengerLocs.map(fetchCoordinates));
        const destCoords = await fetchCoordinates(destination);

        if (driverCoords && passengerCoords && destCoords) {
            sendCoordsToRouteOptimizer(driverCoords, passengerCoords, destCoords);
        }
    }
    catch (error){
        console.error('Error processing locations', error);
    }

    const fetchCoords = async(location) => {
        const apiKey = 'api key';
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.status == 'OK') {
                const { lat, lng } = data.results[0].geometry.location;
                return { lat, lng };
            }
            else {
                console.error('Geocoding error: ', data.status);
                setErrorMessage('Error fetching location data');
                return null;
            }
        }
        catch {
            console.error('Error fetching geocode:', error);
            return null;
        }
    };

    const sendCoordsToRouteOptimizer = (driverCoords, passengerCoords, destCoords) => {
        const routeOptimizerURL = 'http://localhost:5000/routeoptimizer'; //replace with flask api url
        const driverDataWithCoords = driverCoords.map((coords, index) => ({
            location: coords,
            capacity: driverData[index].capacity,
        }));

        fetch(routeOptimizerURL, {
            method: 'POST',
            headers: { 'Content-Type': 'applications/json'},
            body: JSON.stringify({
                drivers: driverDataWithCoords,
                passengers: passengerCoords,
                destination: destCoords,
            })
        }) 
            .then ((response) => response.json())
            .then ((data) => {
                console.log('Route optimization data: ', data);
                setRouteData(data);
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
            {passengerLocations.map((passenger, index) => (
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
}   

export default LocationInput;
