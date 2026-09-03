import React, { useState } from 'react';
import './App.css';
import LocationInput from './LocationInput';
import useMediaQuery, { MOBILE_QUERY } from './hooks/useMediaQuery';
import useGoogleMap from './hooks/useGoogleMap';
import useGoogleProfile from './hooks/useGoogleProfile';
import useResizablePanels from './hooks/useResizablePanels';

const MAP_CONTAINER_ID = 'map';

function App() {
  const [routeData, setRouteData] = useState(null);

  const isStacked = useMediaQuery(MOBILE_QUERY);
  const { map, directionsRenderer } = useGoogleMap(MAP_CONTAINER_ID);
  const { profile, login, logOut } = useGoogleProfile();
  const { containerRef, panelStyle, startResizing } = useResizablePanels(isStacked);

  // panelStyle publishes both sizes as CSS variables; each layout's stylesheet
  // rules consume the one that applies, so neither can strand the other.
  return (
    <div className="app-shell" ref={containerRef} style={panelStyle}>
      <div className="sidebar">
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
        aria-label={isStacked ? 'Resize map' : 'Resize panels'}
      />

      <div id={MAP_CONTAINER_ID} />
    </div>
  );
}

export default App;
