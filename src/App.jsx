import React, { useState, useEffect } from 'react';
import PinScreen from './components/PinScreen.jsx';
import Dashboard from './components/Dashboard.jsx';
import { getAuthToken, clearAuthToken } from './lib/api.js';

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Pokud máme token v localStorage, považujeme za přihlášenou
    if (getAuthToken()) setAuthed(true);
    setChecked(true);
  }, []);

  const handleUnlock = () => setAuthed(true);

  const handleLogout = () => {
    clearAuthToken();
    setAuthed(false);
  };

  if (!checked) {
    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0F0F0E',
        color: '#EAE3D2'
      }}>
        Načítám…
      </div>
    );
  }

  if (!authed) return <PinScreen onUnlock={handleUnlock} />;

  return <Dashboard onLogout={handleLogout} />;
}
