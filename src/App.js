import React, { useState } from 'react';
import './App.css';
import LocationInput from './LocationInput';
import { MOBILE_QUERY } from './breakpoints';
import useMediaQuery from './hooks/useMediaQuery';
import useGoogleMap from './hooks/useGoogleMap';
import useGoogleProfile from './hooks/useGoogleProfile';
import useResizablePanels from './hooks/useResizablePanels';

const MAP_CONTAINER_ID = 'map';

function App() {
  const [routeData, setRouteData] = useState(null);

  const isStacked = useMediaQuery(MOBILE_QUERY);
  const { map, directionsRenderer } = useGoogleMap(MAP_CONTAINER_ID);
  const { profile, login, logOut } = useGoogleProfile();
  const { containerRef, sidebarWidth, mapHeight, startResizing } = useResizablePanels(isStacked);

  // Each layout drives one axis; CSS overrides the other, so a stale value here
  // can never break the layout.
  const sidebarStyle = isStacked ? {} : { width: `${sidebarWidth}%` };
  const mapStyle = isStacked ? { height: `${mapHeight}%` } : {};

  return (
    <div className="app-shell" ref={containerRef}>
      <div className="sidebar" style={sidebarStyle}>
        <div className="sidebar-card">
          <h1 className="brand-title">VroomMates</h1>
          <p className="brand-subtitle">
            Enter locations for drivers, passengers, and destination:
          </p>

          {profile ? (
            <div className="account-row">
              <p className="account-greeting">Hello, {profile.given_name}</p>
              <button className="google-btn google-logout-btn" onClick={logOut}>
                Log out
              </button>
            </div>
          ) : (
            <button className="google-btn" onClick={() => login()}>
              Sign in with Google
            </button>
          )}

          <LocationInput
            map={map}
            directionsRenderer={directionsRenderer}
            setRouteData={setRouteData}
          />

          {routeData && (
            <div className="route-data-card">
              <h3>Optimized Route Data</h3>
              <pre>{JSON.stringify(routeData, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>

      {/* Divider: drags horizontally when side by side, vertically when stacked */}
      <div
        className="resizer"
        onPointerDown={startResizing}
        role="separator"
        aria-orientation={isStacked ? 'horizontal' : 'vertical'}
        aria-label={isStacked ? 'Resize map, or tap to expand' : 'Resize panels'}
      />

      <div id={MAP_CONTAINER_ID} style={mapStyle} />
    </div>
  );
}

export default App;
