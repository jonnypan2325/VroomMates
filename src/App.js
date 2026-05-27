import './App.css';
import React, { useState, useEffect } from 'react';
import LocationInput from './LocationInput';
import { googleLogout, useGoogleLogin } from '@react-oauth/google';
import axios from 'axios';

function App() {
   const [map, setMap] = useState(null); // State for the Google Map instance
  const [directionsRenderer, setDirectionsRenderer] = useState(null); // State for DirectionsRenderer instance
  const [routeData, setRouteData] = useState(null); // State for route data

  // State for handling user and profile data
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [activeTab, setActiveTab] = useState('inputs');

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
    <div className="app-shell" data-active-tab={activeTab}>
      <nav className="mobile-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'inputs'}
          onClick={() => setActiveTab('inputs')}
        >
          Inputs
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'map'}
          onClick={() => setActiveTab('map')}
        >
          Map
        </button>
      </nav>

      <aside className="sidebar">
        <h1>VroomMates</h1>
        <p>Enter locations for drivers, passengers, and destination:</p>
        {profile ? (
          <div>
            <p>Hello, {profile.given_name}</p>
            <button className="google-btn google-logout-btn" onClick={logOut}>
              <span> Log out </span> 👋
            </button>
          </div>
        ) : (
          <button className="google-btn" onClick={() => login()}>Sign in with Google 🚀</button>
        )}

        <LocationInput
          map={map}
          directionsRenderer={directionsRenderer}
          setRouteData={setRouteData}
        />

        {routeData && (
          <div>
            <h3>Optimized Route Data</h3>
            <pre>{JSON.stringify(routeData, null, 2)}</pre>
          </div>
        )}
      </aside>

      <main className="map-pane">
        <div id="map"></div>
      </main>
    </div>
  );
}

export default App;
