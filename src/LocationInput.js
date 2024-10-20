import React, { useEffect, useState } from 'react';

function LocationInput({ map, directionsRenderer, setRouteData }) {
    const [driverData, setDriverData] = useState([
        { address: '', capacity: 0, coordinates: { lat: null, lng: null } }
    ]);
    const [passengerLocs, setPassengerLocs] = useState([
        { address: '', coordinates: { lat: null, lng: null } }
    ]);
    const [destination, setDestination] = useState({ address: '', coordinates: { lat: null, lng: null } });
    const [optimizedRoutes, setOptimizedRoutes] = useState([]);
    const [errorMessage, setErrorMessage] = useState('');
    const [selectedDriver, setSelectedDriver] = useState(0); 

    const displayRoutesForDriver = (route) => {
        console.log("Displaying Route");
        const [driver, ...passengers] = route;

        const waypoints = passengers.slice(0, -1).map((location) => ({
            location: new window.google.maps.LatLng(location.lat, location.lng),
            stopover: true
        }));

        const finalDestination = passengers[passengers.length - 1];

        const directionsService = new window.google.maps.DirectionsService();
        directionsService.route(
            {
                origin: new window.google.maps.LatLng(driver.lat, driver.lng),
                destination: new window.google.maps.LatLng(finalDestination.lat, finalDestination.lng),
                waypoints: waypoints,
                travelMode: window.google.maps.TravelMode.DRIVING
            },
            (response, status) => {
                if (status === 'OK') {
                    directionsRenderer.setDirections(response); // Display the route on the map
                } else {
                    console.error('Directions request failed due to ' + status);
                }
            }
        );
    };

    useEffect(() => {
        console.log("test");
        console.log("optimizedRoutes: ", optimizedRoutes);
        if (optimizedRoutes && optimizedRoutes.length > 0) {
            console.log("Running");
            displayRoutesForDriver(optimizedRoutes[selectedDriver]);
        }
    }, [optimizedRoutes, directionsRenderer, selectedDriver]);

    useEffect(() => {
        if (map && directionsRenderer) {
            // Driver Autocomplete
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
                        // Update address and coordinates for the driver
                        handleDriverChange(index, {
                            address: place.formatted_address,
                            coordinates: {
                                lat: place.geometry.location.lat(),
                                lng: place.geometry.location.lng(),
                            }
                        });
                    });
                }
            });

            // Passenger Autocomplete
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
                        // Update address and coordinates for the passenger
                        handlePassengerChange(index, {
                            address: place.formatted_address,
                            coordinates: {
                                lat: place.geometry.location.lat(),
                                lng: place.geometry.location.lng(),
                            }
                        });
                    });
                }
            });

            // Destination Autocomplete
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
                    // Update address and coordinates for the destination
                    setDestination({
                        address: place.formatted_address,
                        coordinates: {
                            lat: place.geometry.location.lat(),
                            lng: place.geometry.location.lng(),
                        }
                    });
                });
            }
        }
    }, [map, directionsRenderer, driverData, passengerLocs]);

    // Handle driver changes (both address and coordinates)
    const handleDriverChange = (index, locationData) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index] = { ...updatedDrivers[index], ...locationData };
        setDriverData(updatedDrivers);
    };

    const handleDriverCapacityChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].capacity = value;
        setDriverData(updatedDrivers);
    };

    const addDriverField = () => setDriverData([...driverData, { address: '', capacity: 0, coordinates: { lat: null, lng: null } }]);

    // Handle passenger changes (both address and coordinates)
    const handlePassengerChange = (index, locationData) => {
        const updatedPassengers = [...passengerLocs];
        updatedPassengers[index] = { ...updatedPassengers[index], ...locationData };
        setPassengerLocs(updatedPassengers);
    };

    const addPassengerField = () => setPassengerLocs([...passengerLocs, { address: '', coordinates: { lat: null, lng: null } }]);

    const handleLocSubmit = async () => {
        try {
            const driverCoords = driverData.map(driver => driver.coordinates);
            const passengerCoords = passengerLocs.map(passenger => passenger.coordinates);
            const destCoords = destination.coordinates;

            if (driverCoords && passengerCoords && destCoords) {
                await sendCoordsToRouteOptimizer(driverCoords, passengerCoords, destCoords);
            }
        } catch (error) {
            console.error('Error processing locations', error);
        }
    };

    const sendCoordsToRouteOptimizer = async (driverCoords, passengerCoords, destCoords) => {
        const routeOptimizerURL = 'http://127.0.0.1:5000/routeoptimizer'; // Your Flask API URL

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

            if (!response.ok) {
                throw new Error('Failed to compute routes: ' + response.statusText);
            }
    
            // const result = await response.json();
            // console.log(result.message);
            
            // console.log("Getting routes");
            // //const result = await response.json();

            // console.log("Optimized Routes from Flask:", JSON.stringify(result.optimizedRoutes, null, 2));

            // //Log the entire result in a readable format
            // console.log("Result:", JSON.stringify(result, null, 2)); // Pretty-print with 2 spaces indentation

            // //Use the result after awaiting response.json()
            // setOptimizedRoutes(result.optimizedRoutes);

            const result = {
                optimizedRoutes: [
                    [
                        { lat: 34.052235, lng: -118.243683 }, // Driver 1 location (e.g., Los Angeles)
                        { lat: 34.062235, lng: -118.243683 }, // Passenger 1 location for Driver 1
                        { lat: 34.072235, lng: -118.243683 }, // Passenger 2 location for Driver 1
                        { lat: 34.082235, lng: -118.243683 }, // Final destination for Driver 1
                    ],
                    [
                        { lat: 33.941589, lng: -118.40853 }, // Driver 2 location (e.g., LAX)
                        { lat: 33.951589, lng: -118.40853 }, // Passenger 1 location for Driver 2
                        { lat: 33.961589, lng: -118.40853 }, // Passenger 2 location for Driver 2
                        { lat: 33.971589, lng: -118.40853 }, // Final destination for Driver 2
                    ]
                ]
            };
            setOptimizedRoutes(result.optimizedRoutes);

        } catch (error) {
            console.error('Error sending coordinates to route optimizer:', error);
        }
    };

    async function getOptimizedRoutes() {
        try {
            const response = await fetch('http://127.0.0.1:5000/routeoptimizer/', {
                method: 'GET'
            });
    
            if (!response.ok) {
                throw new Error('Failed to fetch routes: ' + response.statusText);
            }
    
            const result = await response.json();
            console.log('Retrieved Optimized Routes:', result.optimizedRoutes);
        } catch (error) {
            console.error('Error fetching routes:', error);
        }
    }

    const handleDriverView = async (index) => {
        console.log(`Displaying route for driver ${index + 1}`);
        const selectedDriverIndex = parseInt(index.target.value);
        setSelectedDriver(selectedDriverIndex); 
    };

    return (
        <div>
            <h3>Driver Locations and Capacities</h3>
            {driverData.map((driver, index) => (
                <div key={index} className="driver-input-group">
                    <input
                        type="number"
                        value={driver.capacity}
                        onChange={(e) => handleDriverCapacityChange(index, parseInt(e.target.value))}
                        placeholder={`Driver ${index + 1} capacity`}
                        min="1"
                    />
                    <input
                        type="text"
                        id={`location-input-${index}`}
                        value={driver.address}
                        onChange={(e) => handleDriverChange(index, { address: e.target.value, coordinates: driver.coordinates })}
                        placeholder={`Driver ${index + 1} location`}
                    />
                </div>
            ))}
            <button onClick={addDriverField}>Add Driver</button>
    
            <h3>Passenger Locations</h3>
            {passengerLocs.map((passenger, index) => (
                <div key={index} className="passenger-input-group">
                    <input
                        id={`passenger-loc-${index}`}
                        type="text"
                        value={passenger.address}
                        onChange={(e) => handlePassengerChange(index, { address: e.target.value, coordinates: passenger.coordinates })}
                        placeholder={`Passenger ${index + 1} location`}
                    />
                </div>
            ))}
            <button onClick={addPassengerField}>Add Passenger</button>
    
            <h3>Destination</h3>
            <input
                type="text"
                id="destination"
                value={destination.address}
                onChange={(e) => setDestination({ address: e.target.value, coordinates: destination.coordinates })}
                placeholder="Destination"
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
