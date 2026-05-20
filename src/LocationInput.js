import React, { useCallback, useEffect, useState } from 'react';

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

    const displayRoutesForDriver = useCallback((route) => {
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
    }, [directionsRenderer]);

    useEffect(() => {
        console.log("test");
        console.log("optimizedRoutes: ", optimizedRoutes);
        if (optimizedRoutes && optimizedRoutes.length > 0) {
            console.log("Running");
            displayRoutesForDriver(optimizedRoutes[selectedDriver]);
        }
    }, [optimizedRoutes, selectedDriver, displayRoutesForDriver]);

    // Handle driver changes (both address and coordinates)
    const handleDriverChange = useCallback((index, locationData) => {
        setDriverData((prev) => {
            const updated = [...prev];
            updated[index] = { ...updated[index], ...locationData };
            return updated;
        });
    }, []);

    // Handle passenger changes (both address and coordinates)
    const handlePassengerChange = useCallback((index, locationData) => {
        setPassengerLocs((prev) => {
            const updated = [...prev];
            updated[index] = { ...updated[index], ...locationData };
            return updated;
        });
    }, []);

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
    }, [map, directionsRenderer, driverData, passengerLocs, handleDriverChange, handlePassengerChange]);

    const handleDriverCapacityChange = (index, value) => {
        const updatedDrivers = [...driverData];
        updatedDrivers[index].capacity = value;
        setDriverData(updatedDrivers);
    };

    const addDriverField = () => setDriverData([...driverData, { address: '', capacity: 0, coordinates: { lat: null, lng: null } }]);

    const addPassengerField = () => setPassengerLocs([...passengerLocs, { address: '', coordinates: { lat: null, lng: null } }]);

    const handleLocSubmit = async () => {
        setErrorMessage('');
        try {
            const driverCoords = driverData.map(driver => driver.coordinates);
            const passengerCoords = passengerLocs.map(passenger => passenger.coordinates);
            const destCoords = destination.coordinates;

            const hasInvalidDriver = driverCoords.some(c => c.lat == null || c.lng == null);
            const hasInvalidPassenger = passengerCoords.some(c => c.lat == null || c.lng == null);
            const hasInvalidDestination = destCoords.lat == null || destCoords.lng == null;

            if (hasInvalidDriver || hasInvalidPassenger || hasInvalidDestination) {
                setErrorMessage('Please enter a valid address for every driver, passenger, and the destination before submitting.');
                return;
            }

            await sendCoordsToRouteOptimizer(driverCoords, passengerCoords, destCoords);
        } catch (error) {
            console.error('Error processing locations', error);
            setErrorMessage('Something went wrong while preparing your locations. Please try again.');
        }
    };

    const sendCoordsToRouteOptimizer = async (driverCoords, passengerCoords, destCoords) => {
        const routeOptimizerURL = `${process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000'}/routeoptimizer/`;

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

            const result = await response.json();
            console.log("Optimized Routes from Flask:", JSON.stringify(result.optimizedRoutes, null, 2));

            if (!result.optimizedRoutes || result.optimizedRoutes.length === 0) {
                setErrorMessage('No optimized routes were returned. Please check your inputs and try again.');
                return;
            }

            setOptimizedRoutes(result.optimizedRoutes);

        } catch (error) {
            console.error('Error sending coordinates to route optimizer:', error);
            setErrorMessage(
                'Could not reach the route optimizer service. Please make sure the backend is running and try again.'
            );
        }
    };

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
