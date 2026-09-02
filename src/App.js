import './App.css';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import LocationInput from './LocationInput';
import { googleLogout, useGoogleLogin } from '@react-oauth/google';
import axios from 'axios';

const MIN_SIDEBAR_PERCENT = 22;
const MAX_SIDEBAR_PERCENT = 60;

function App() {
  const [map, setMap] = useState(null); // State for the Google Map instance
  const [directionsRenderer, setDirectionsRenderer] = useState(null); // State for DirectionsRenderer instance
  const [routeData, setRouteData] = useState(null); // State for route data

  // State for the draggable divider between the controls and the map
  const [sidebarWidth, setSidebarWidth] = useState(32); // percent
  const shellRef = useRef(null);
  const isResizing = useRef(false);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const startResizing = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleResize = useCallback((e) => {
    if (!isResizing.current || !shellRef.current) return;
    const rect = shellRef.current.getBoundingClientRect();
    const percent = ((e.clientX - rect.left) / rect.width) * 100;
    setSidebarWidth(Math.min(MAX_SIDEBAR_PERCENT, Math.max(MIN_SIDEBAR_PERCENT, percent)));
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResizing);
    return () => {
      document.removeEventListener('mousemove', handleResize);
      document.removeEventListener('mouseup', stopResizing);
    };
  }, [handleResize, stopResizing]);

  // State for handling user and profile data
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);

  // Google login functionality
  const login = useGoogleLogin({
    onSuccess: (codeResponse) => {
      setUser(codeResponse);
      console.log("User signed in");
    },
    onError: (error) => console.log('Login Failed:', error),
  });

  // Fetch user profile data after login
  useEffect(() => {
    if (user) {
      axios
        .get(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${user.access_token}`, {
          headers: {
            Authorization: `Bearer ${user.access_token}`,
            Accept: 'application/json',
          },
        })
        .then((res) => setProfile(res.data))
        .catch((err) => console.log(err));
    }
  }, [user]);

  // Log out functionality
  const logOut = () => {
    googleLogout();
    setProfile(null);
    console.log("User signed out");
  };

  useEffect(() => {
    const initMap = () => {
      const mapInstance = new window.google.maps.Map(document.getElementById('map'), {
        center: { lat: 37.784, lng: -122.403 },
        zoom: 14,
      });

      const directionsRendererInstance = new window.google.maps.DirectionsRenderer();
      directionsRendererInstance.setMap(mapInstance); // Attach the directions renderer to the map

      // Store the map and directionsRenderer instances in state
      setMap(mapInstance);
      setDirectionsRenderer(directionsRendererInstance);

      const locationButton = document.createElement('button');
      locationButton.textContent = 'Pan to Current Location';
      locationButton.classList.add('custom-map-control-button');
      mapInstance.controls[window.google.maps.ControlPosition.TOP_CENTER].push(locationButton);

      locationButton.addEventListener('click', () => {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const pos = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              };
              mapInstance.setCenter(pos);
            },
            () => {
              handleLocationError(true, mapInstance.getCenter(), mapInstance);
            }
          );
        } else {
          //handleLocationError(false, infoWindow, mapInstance.getCenter(), mapInstance);
        }
      });
    };

    const handleLocationError = (browserHasGeolocation, pos, mapInstance) => {
      const infoWindow = new window.google.maps.InfoWindow({
        position: pos,
      });
      infoWindow.setContent(
        browserHasGeolocation
          ? 'Error: The Geolocation service failed.'
          : "Error: Your browser doesn't support geolocation."
      );
      infoWindow.open(mapInstance);
    };

    // Initialize map when Google Maps is ready
    if (window.google) {
      initMap();
    } else {
      window.onload = initMap;
    }
  }, []); // Ensure this runs only once, when the component mounts

  return (
    <div className="app-shell" ref={shellRef}>
      <div className="sidebar" style={{ width: `${sidebarWidth}%` }}>
        <div className="sidebar-card">
          <h1 className="brand-title">VroomMates</h1>
          <p className="brand-subtitle">Enter locations for drivers, passengers, and destination:</p>
          {/* Google Login Button */}
          {profile ? (
            <div>
              <p>Hello, {profile.given_name}</p>
              <button className="google-btn google-logout-btn" onClick={logOut}>
                Log out
              </button>
            </div>
          ) : (
            <button className="google-btn" onClick={() => login()}>Sign in with Google</button>
          )}

          {/* Location Input Component */}
          <LocationInput
            map={map}
            directionsRenderer={directionsRenderer}
            setRouteData={setRouteData}
          />

          {/* Display route data */}
          {routeData && (
            <div className="route-data-card">
              <h3>Optimized Route Data</h3>
              <pre>{JSON.stringify(routeData, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>

      {/* Draggable divider between the controls and the map */}
      <div
        className="resizer"
        onMouseDown={startResizing}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
      />

      {/* Google Map */}
      <div id="map"></div>
    </div>
  );
}

export default App;
