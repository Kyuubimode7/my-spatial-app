import React from 'react';
import MapComponent from './components/map'; // Update this path if your file is named differently
import './App.css'; // Optional: useful for standardizing margins/padding

export default function App() {
  return (
    // We use a clean, full-viewport container so Leaflet has room to render
    <div className="app-container" style={{ width: '100vw', height: '100vh', margin: 0, padding: 0 }}>
      
      {}
      <MapComponent />
      
    </div>
  );
}