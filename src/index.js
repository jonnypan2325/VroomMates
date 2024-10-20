import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { GoogleOAuthProvider } from "@react-oauth/google"

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <GoogleOAuthProvider clientId='172458795590-bhimpf11p5srub5vhbknkpd5l9eb17sb.apps.googleusercontent.com'>
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  </GoogleOAuthProvider>
);


function initMap() {
  new window.google.maps.Map(document.getElementById("map"), {
    center: { lat: 37.784, lng: -122.403 },
    zoom: 12,
  });
}

// Wait for the DOM to be fully loaded before initializing the map
window.onload = initMap;

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
