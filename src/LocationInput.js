import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ICON = { driver: '🚗', passenger: '🙋', destination: '🏁' };

const emojiIconUrl = (emoji) =>
    'data:image/svg+xml;utf8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">` +
        `<text x="50%" y="55%" text-anchor="middle" font-size="28" dominant-baseline="middle">${emoji}</text>` +
        `</svg>`
    );

const hasCoords = (c) => c && c.lat != null && c.lng != null;

const buildMapsUrl = (route) => {
    if (!route || route.length < 2) return '';
    const fmt = (p) => `${p.lat},${p.lng}`;
    const [origin, ...rest] = route;
    const dest = rest[rest.length - 1];
    const waypoints = rest.slice(0, -1).map(fmt).join('|');
    const base = 'https://www.google.com/maps/dir/?api=1';
    return `${base}&origin=${encodeURIComponent(fmt(origin))}&destination=${encodeURIComponent(fmt(dest))}`
        + (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '')
        + '&travelmode=driving';
};

const qrSrc = (url) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;

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
    const [editOpen, setEditOpen] = useState(true);
    const [copyStatus, setCopyStatus] = useState('');

    const markersRef = useRef([]);

    const displayRoutesForDriver = useCallback((route) => {
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
                    directionsRenderer.setDirections(response);
                } else {
                    console.error('Directions request failed due to ' + status);
                }
            }
        );
    }, [directionsRenderer]);

    useEffect(() => {
        if (optimizedRoutes && optimizedRoutes.length > 0) {
            displayRoutesForDriver(optimizedRoutes[selectedDriver]);
        }
    }, [optimizedRoutes, selectedDriver, displayRoutesForDriver]);

    // Render emoji markers for every entity with valid coordinates.
    useEffect(() => {
        if (!map || !window.google) return;
        markersRef.current.forEach((m) => m.setMap(null));
        markersRef.current = [];

        const addMarker = (coords, emoji, title) => {
            const marker = new window.google.maps.Marker({
                position: { lat: coords.lat, lng: coords.lng },
                map,
                title,
                icon: {
                    url: emojiIconUrl(emoji),
                    scaledSize: new window.google.maps.Size(40, 40),
                    anchor: new window.google.maps.Point(20, 20),
                },
            });
            markersRef.current.push(marker);
        };

        driverData.forEach((d, i) => {
            if (hasCoords(d.coordinates)) addMarker(d.coordinates, ICON.driver, `Driver ${i + 1}`);
        });
        passengerLocs.forEach((p, i) => {
            if (hasCoords(p.coordinates)) addMarker(p.coordinates, ICON.passenger, `Passenger ${i + 1}`);
        });
        if (hasCoords(destination.coordinates)) {
            addMarker(destination.coordinates, ICON.destination, 'Destination');
        }
    }, [map, driverData, passengerLocs, destination]);

    useEffect(() => {
        // Cleanup markers when component unmounts.
        return () => {
            markersRef.current.forEach((m) => m.setMap(null));
            markersRef.current = [];
        };
    }, []);

    const handleDriverChange = useCallback((index, locationData) => {
        setDriverData((prev) => {
            const updated = [...prev];
            updated[index] = { ...updated[index], ...locationData };
            return updated;
        });
    }, []);

    const handlePassengerChange = useCallback((index, locationData) => {
        setPassengerLocs((prev) => {
            const updated = [...prev];
            updated[index] = { ...updated[index], ...locationData };
            return updated;
        });
    }, []);

    useEffect(() => {
        if (map && directionsRenderer) {
            driverData.forEach((_, index) => {
                const input = document.getElementById(`location-input-${index}`);
                if (input) {
                    const autocomplete = new window.google.maps.places.Autocomplete(input);
                    autocomplete.bindTo('bounds', map);
                    autocomplete.addListener('place_changed', () => {
                        const place = autocomplete.getPlace();
                        if (!place.geometry || !place.geometry.location) return;
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

            passengerLocs.forEach((_, index) => {
                const input = document.getElementById(`passenger-loc-${index}`);
                if (input) {
                    const autocomplete = new window.google.maps.places.Autocomplete(input);
                    autocomplete.bindTo('bounds', map);
                    autocomplete.addListener('place_changed', () => {
                        const place = autocomplete.getPlace();
                        if (!place.geometry || !place.geometry.location) return;
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

            const destInput = document.getElementById('destination');
            if (destInput) {
                const destAutocomplete = new window.google.maps.places.Autocomplete(destInput);
                destAutocomplete.bindTo('bounds', map);
                destAutocomplete.addListener('place_changed', () => {
                    const place = destAutocomplete.getPlace();
                    if (!place.geometry || !place.geometry.location) return;
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

    const removeDriver = (index) => setDriverData((prev) => prev.filter((_, i) => i !== index));
    const removePassenger = (index) => setPassengerLocs((prev) => prev.filter((_, i) => i !== index));

    const handleClear = () => {
        setDriverData([{ address: '', capacity: 0, coordinates: { lat: null, lng: null } }]);
        setPassengerLocs([{ address: '', coordinates: { lat: null, lng: null } }]);
        setDestination({ address: '', coordinates: { lat: null, lng: null } });
        setOptimizedRoutes([]);
        setSelectedDriver(0);
        setErrorMessage('');
        setCopyStatus('');
        if (directionsRenderer) {
            directionsRenderer.setDirections({ routes: [] });
        }
    };

    const handleLocSubmit = async () => {
        setErrorMessage('');
        try {
            if (driverData.length === 0) {
                setErrorMessage('Please add at least one driver before submitting.');
                return;
            }
            if (passengerLocs.length === 0) {
                setErrorMessage('Please add at least one passenger before submitting.');
                return;
            }
            const hasInvalidDriver = driverData.some(d => !hasCoords(d.coordinates));
            const hasInvalidPassenger = passengerLocs.some(p => !hasCoords(p.coordinates));
            const hasInvalidDestination = !hasCoords(destination.coordinates);

            if (hasInvalidDriver || hasInvalidPassenger || hasInvalidDestination) {
                setErrorMessage('Please enter a valid address for every driver, passenger, and the destination before submitting.');
                return;
            }

            await sendCoordsToRouteOptimizer();
        } catch (error) {
            console.error('Error processing locations', error);
            setErrorMessage('Something went wrong while preparing your locations. Please try again.');
        }
    };

    const sendCoordsToRouteOptimizer = async () => {
        const routeOptimizerURL = `${process.env.REACT_APP_FLASK_API_URL || 'http://127.0.0.1:5000'}/routeoptimizer/`;

        const driverDataWithCoords = driverData.map((d) => ({
            location: d.coordinates,
            capacity: d.capacity,
        }));
        const passengerCoords = passengerLocs.map((p) => p.coordinates);

        try {
            const response = await fetch(routeOptimizerURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drivers: driverDataWithCoords,
                    passengers: passengerCoords,
                    destination: destination.coordinates,
                })
            });

            if (!response.ok) {
                const errorBody = await response.json().catch(() => null);
                const backendMessage = errorBody?.error || response.statusText || 'Unknown error';
                setErrorMessage(`The route optimizer rejected the request: ${backendMessage}`);
                return;
            }

            const result = await response.json();

            if (!result.optimizedRoutes || result.optimizedRoutes.length === 0) {
                setErrorMessage('No optimized routes were returned. Please check your inputs and try again.');
                return;
            }

            setOptimizedRoutes(result.optimizedRoutes);
            setSelectedDriver(0);
            setEditOpen(false);
            setCopyStatus('');

        } catch (error) {
            console.error('Error sending coordinates to route optimizer:', error);
            setErrorMessage(
                'Could not reach the route optimizer service. Please make sure the backend is running and try again.'
            );
        }
    };

    const handleDriverView = (e) => {
        setSelectedDriver(parseInt(e.target.value, 10));
        setCopyStatus('');
    };

    const mapsUrl = useMemo(() => {
        if (!optimizedRoutes.length) return '';
        return buildMapsUrl(optimizedRoutes[selectedDriver]);
    }, [optimizedRoutes, selectedDriver]);

    const handleCopyLink = async () => {
        if (!mapsUrl) return;
        try {
            await navigator.clipboard.writeText(mapsUrl);
            setCopyStatus('Copied!');
        } catch {
            setCopyStatus('Copy failed — select the link manually.');
        }
    };

    return (
        <div>
            <details
                className="edit-section"
                open={editOpen}
                onToggle={(e) => setEditOpen(e.currentTarget.open)}
            >
                <summary className="edit-summary">
                    {editOpen ? 'Hide locations' : 'Edit locations'}
                </summary>

                <h3>Driver Locations and Capacities</h3>
                {driverData.map((driver, index) => (
                    <div key={index} className="driver-input-group">
                        <span className="icon-cell" aria-hidden="true">{ICON.driver}</span>
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
                        <button
                            type="button"
                            className="row-remove-btn"
                            onClick={() => removeDriver(index)}
                            aria-label={`Remove driver ${index + 1}`}
                        >
                            ✕
                        </button>
                    </div>
                ))}
                <button onClick={addDriverField}>Add Driver</button>

                <h3>Passenger Locations</h3>
                {passengerLocs.map((passenger, index) => (
                    <div key={index} className="passenger-input-group">
                        <span className="icon-cell" aria-hidden="true">{ICON.passenger}</span>
                        <input
                            id={`passenger-loc-${index}`}
                            type="text"
                            value={passenger.address}
                            onChange={(e) => handlePassengerChange(index, { address: e.target.value, coordinates: passenger.coordinates })}
                            placeholder={`Passenger ${index + 1} location`}
                        />
                        <button
                            type="button"
                            className="row-remove-btn"
                            onClick={() => removePassenger(index)}
                            aria-label={`Remove passenger ${index + 1}`}
                        >
                            ✕
                        </button>
                    </div>
                ))}
                <button onClick={addPassengerField}>Add Passenger</button>

                <h3>Destination</h3>
                <div className="destination-input-group">
                    <span className="icon-cell" aria-hidden="true">{ICON.destination}</span>
                    <input
                        type="text"
                        id="destination"
                        value={destination.address}
                        onChange={(e) => setDestination({ address: e.target.value, coordinates: destination.coordinates })}
                        placeholder="Destination"
                    />
                </div>

                <div className="action-row">
                    <button onClick={handleLocSubmit}>Submit All Locations</button>
                    <button type="button" className="google-btn clear-btn" onClick={handleClear}>Clear all</button>
                </div>
            </details>

            {optimizedRoutes.length > 0 && (
                <>
                    <h3>Driver View:</h3>
                    <select id="driver-view-select" value={selectedDriver} onChange={handleDriverView}>
                        {optimizedRoutes.map((_, index) => (
                            <option key={index} value={index}>
                                {index + 1}
                            </option>
                        ))}
                    </select>

                    <div className="send-to-phone">
                        <p>Send this route to your phone:</p>
                        <img alt="QR code for Google Maps route" src={qrSrc(mapsUrl)} width="160" height="160" />
                        <div>
                            <button type="button" className="google-btn" onClick={handleCopyLink}>
                                Copy link
                            </button>
                            {copyStatus && <span className="copy-status"> {copyStatus}</span>}
                        </div>
                    </div>
                </>
            )}

            {errorMessage && <p style={{ color: 'red' }}>{errorMessage}</p>}
        </div>
    );
}

export default LocationInput;
