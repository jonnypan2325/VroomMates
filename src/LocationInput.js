import React, { useEffect, useState } from 'react';

function LocationInput({ setCoordinates, map, directionsRenderer, setRouteData }) {
    const [driverData, setDriverData] = useState([{ location: '', capacity: 0 }]);
    const [passengerLocs, setPassengerLocs] = useState(['']);
    const [destination, setDestination] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [selectedDriver, setSelectedDriver] = useState(0); 

    useEffect(() => {
        if (map && directionsRenderer) {
            driverData.forEach((_, index) => {
                const input = document.getElementById(`location-input-${index}`);
                if (input) {
                    const autocomplete = new window.google.maps.places.Autocomplete(input);
                    autocomplete.bindTo('bounds', map);
                    autocomplete.addListener('place_changed', () => {
                        const place = autocomplete.getPlace();
                        if (!place.geometry || !place.geometry.location) {
                            console.log("No details available for input: '" + place.name + "'");
                            return;
                        }
                    });
                }
            });

            passengerLocs.forEach((_, index) => {
                const input = document.getElementById(`passenger-loc-${index}`);
                if (input) {
                    const autocomplete = new window.google.maps.places.Autocomplete(input);
                    autocomplete.bindTo('bounds', map);
                    autocomplete.addListener('place_changed', () => {
                        const place = autocomplete.getPlace();
                        if (!place.geometry || !place.geometry.location) {
                            console.log("No details available for input: '" + place.name + "'");
                            return;
                        }
                    });
                }
            });

            const destInput = document.getElementById('destination');
            if (destInput) {
                const destAutocomplete = new window.google.maps.places.Autocomplete(destInput);
                destAutocomplete.bindTo('bounds', map);
                destAutocomplete.addListener('place_changed', () => {
                    const place = destAutocomplete.getPlace();
                    if (!place.geometry || !place.geometry.location) {
                        console.log("No details available for destination input");
                        return;
                    }
                });
            }
        }
    }, [map, directionsRenderer, driverData]);

    const handleDriverChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].location = value;
        setDriverData(updatedDrivers);
    };

    const handleDriverCapacityChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].capacity = value;
        setDriverData(updatedDrivers);
    };

    const addDriverField = () => setDriverData([...driverData, { location: '', capacity: 0 }]);

    const handlePassengerChange = (index, value) => {
        const updatedPassengers = [...passengerLocs];
        updatedPassengers[index] = value;
        setPassengerLocs(updatedPassengers);
    };

    const addPassengerField = () => setPassengerLocs([...passengerLocs, '']);

    const handleLocSubmit = async () => {
        try {
            const driverCoords = driverData.map(driver => driver.location);
            const passengerCoords = passengerLocs.map(passenger => passenger);
            const destCoords = destination;

            if (driverCoords && passengerCoords && destCoords) {
                await sendCoordsToRouteOptimizer(driverCoords, passengerCoords, destCoords);
            }
        } catch (error) {
            console.error('Error processing locations', error);
        }
    };

    const sendCoordsToRouteOptimizer = async (driverCoords, passengerCoords, destCoords) => {
        const routeOptimizerURL = 'http://localhost:5000/routeoptimizer'; // Your Flask API URL

        const driverDataWithCoords = driverCoords.map((coords, index) => ({
            location: coords,
            capacity: driverData[index].capacity,
        }));

        try {
            const response = await fetch(routeOptimizerURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drivers: driverDataWithCoords,
                    passengers: passengerCoords,
                    destination: destCoords,
                })
            });

            const data = await response.json();
            console.log('Route optimization data: ', data);

            setRouteData(data);  // Store the route data in the parent component

            // Display the route using Google Maps Directions API
            const directionsService = new window.google.maps.DirectionsService();

            const locations = data[0];
            const origin = locations[0];

            locations.forEach((location) => {
                const destination = location;
                directionsService.route(
                    {
                        origin: origin,
                        destination: destination,
                        travelMode: window.google.maps.TravelMode.DRIVING,
                    },
                    (response, status) => {
                        if (status === 'OK') {
                            directionsRenderer.setDirections(response);  // Display the route
                        } else {
                            console.error(`Directions request failed due to ${status}`);
                        }
                    }
                );
            });
        } catch (error) {
            console.error('Error sending coordinates to route optimizer:', error);
        }
    };

    const handleDriverView = async (index) => {
        console.log(`Displaying route for driver ${index + 1}`);
        
        // Fetch the route for this driver from the database (replace with actual implementation)
        // const routeData = await fetchRouteFromDatabaseForDriver(index);
        
        // Placeholder: console log or display route for this driver
        console.log(`Retrieving route for driver ${index + 1} from the database...`);
    };

    return (
        <div>
            <h3>Driver Locations and Capacities</h3>
            {driverData.map((driver, index) => (
                <div key={index} className="driver-input-group">
                    <input
                        type="text"
                        id={`location-input-${index}`}
                        value={driver.location}
                        onChange={(e) => handleDriverChange(index, e.target.value)}
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
                <div key={index} className="passenger-input-group">
                    <input
                        key={index}
                        id={`passenger-loc-${index}`}
                        type="text"
                        value={passenger}
                        onChange={(e) => handlePassengerChange(index, e.target.value)}
                        placeholder={`Enter passenger ${index + 1} location`}
                    />
                </div>
            ))}
            <button onClick={addPassengerField}>Add Passenger</button>

            <h3>Destination</h3>
            <input
                type="text"
                id="destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="Enter destination"
            />

         <button onClick={handleLocSubmit}>Submit All Locations</button>

        <h3>Driver View:</h3>
            <select id="driver-view-select" value={selectedDriver} onChange={handleDriverView}>
                {driverData.map((_, index) => (
                    <option key={index} value={index}>
                        {index + 1}
                    </option>
                ))}
            </select>
            
            {errorMessage && <p style={{ color: 'red' }}>{errorMessage}</p>}
        </div>
    );
}

export default LocationInput;
