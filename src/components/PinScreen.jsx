import React, { useState, useEffect, useRef } from 'react';
import { Lock, Delete } from 'lucide-react';
import * as api from '../lib/api.js';

export default function PinScreen({ onUnlock }) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [mode, setMode] = useState('checking'); // checking | setup | confirm | login
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Při startu zjisti, jestli už PIN existuje
  useEffect(() => {
    (async () => {
      try {
        const status = await api.checkSetup();
        if (status.offline) {
          setMode(api.localIsSetup() ? 'login' : 'setup');
        } else {
          setMode(status.isSetup ? 'login' : 'setup');
        }
      } catch (e) {
        setMode(api.localIsSetup() ? 'login' : 'setup');
      }
    })();
  }, []);

  const addDigit = (d) => {
    setError('');
    if (mode === 'confirm') {
      if (confirmPin.length < 6) setConfirmPin(c => c + d);
    } else {
      if (pin.length < 6) setPin(p => p + d);
    }
  };

  const removeDigit = () => {
    setError('');
    if (mode === 'confirm') {
      setConfirmPin(c => c.slice(0, -1));
    } else {
      setPin(p => p.slice(0, -1));
    }
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      if (mode === 'setup') {
        if (pin.length < 4) {
          setError('PIN musí mít alespoň 4 číslice');
          setBusy(false);
          return;
        }
        setMode('confirm');
        setBusy(false);
        return;
      }
      if (mode === 'confirm') {
        if (pin !== confirmPin) {
          setError('PIN se neshoduje. Zkus to znovu.');
          setPin('');
          setConfirmPin('');
          setMode('setup');
          setBusy(false);
          return;
        }
        // Setup
        try {
          await api.setupPin(pin);
        } catch (e) {
          // Fallback na lokální setup
          await api.localSetupPin(pin);
        }
        onUnlock();
        return;
      }
      if (mode === 'login') {
        try {
          await api.loginWithPin(pin);
          onUnlock();
        } catch (e) {
          // Fallback na lokální login
          try {
            await api.localLoginPin(pin);
            onUnlock();
          } catch (localErr) {
            setError('Špatný PIN');
            setPin('');
          }
        }
      }
    } catch (e) {
      setError(e.message || 'Něco se pokazilo');
    }
    setBusy(false);
  };

  // Submit po dosažení 6 číslic (auto-submit pro lepší UX)
  useEffect(() => {
    const target = mode === 'confirm' ? confirmPin : pin;
    if (target.length === 6 && mode !== 'checking' && !busy) {
      const t = setTimeout(() => submit(), 200);
      return () => clearTimeout(t);
    }
  }, [pin, confirmPin, mode]);

  if (mode === 'checking') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0F0F0E', color: '#EAE3D2' }}>
        <div className="display" style={{ fontSize: '24px' }}>Načítám…</div>
      </div>
    );
  }

  const displayPin = mode === 'confirm' ? confirmPin : pin;

  const titles = {
    setup: 'Nastav si PIN',
    confirm: 'Potvrď PIN',
    login: 'Zadej svůj PIN'
  };

  const subtitles = {
    setup: 'Bude tě chránit při dalších přihlášeních. 4-6 číslic.',
    confirm: 'Pro jistotu ho zadej ještě jednou.',
    login: 'Vítej zpět, Aneto.'
  };

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0F0F0E',
      color: '#EAE3D2',
      padding: '24px',
      maxWidth: '480px',
      margin: '0 auto'
    }}>
      <Lock size={48} style={{ marginBottom: '24px', color: '#E5B73B' }} />
      
      <h1 className="display" style={{ fontSize: '40px', fontWeight: 600, margin: 0, marginBottom: '8px', textAlign: 'center', letterSpacing: '-1.5px' }}>
        {titles[mode]}
      </h1>
      
      <p className="mono" style={{ fontSize: '12px', color: '#8A8377', textAlign: 'center', marginBottom: '40px', textTransform: 'uppercase', letterSpacing: '2px' }}>
        {subtitles[mode]}
      </p>

      {/* PIN dots */}
      <div style={{ display: 'flex', gap: '14px', marginBottom: '32px', minHeight: '20px' }}>
        {[0, 1, 2, 3, 4, 5].map(i => (
          <div key={i} style={{
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: i < displayPin.length ? '#E5B73B' : 'transparent',
            border: '2px solid ' + (i < displayPin.length ? '#E5B73B' : '#3A3530'),
            transition: 'all 0.2s'
          }} />
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="shake" style={{ color: '#D62828', fontSize: '13px', marginBottom: '24px', minHeight: '20px', fontWeight: 600 }}>
          {error}
        </div>
      )}
      {!error && <div style={{ minHeight: '20px', marginBottom: '24px' }} />}

      {/* Numpad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', width: '100%', maxWidth: '320px' }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
          <button
            key={n}
            onClick={() => addDigit(String(n))}
            disabled={busy}
            style={{
              aspectRatio: '1',
              background: '#1A1816',
              border: '1px solid #2A2622',
              color: '#EAE3D2',
              fontSize: '28px',
              fontFamily: 'Inter Tight, sans-serif',
              fontWeight: 500,
              borderRadius: '50%',
              transition: 'all 0.1s',
              touchAction: 'manipulation'
            }}
            onTouchStart={(e) => e.currentTarget.style.background = '#2A2622'}
            onTouchEnd={(e) => e.currentTarget.style.background = '#1A1816'}
          >
            {n}
          </button>
        ))}
        <div /> {/* prázdné místo */}
        <button
          onClick={() => addDigit('0')}
          disabled={busy}
          style={{
            aspectRatio: '1',
            background: '#1A1816',
            border: '1px solid #2A2622',
            color: '#EAE3D2',
            fontSize: '28px',
            fontFamily: 'Inter Tight, sans-serif',
            fontWeight: 500,
            borderRadius: '50%',
            touchAction: 'manipulation'
          }}
        >
          0
        </button>
        <button
          onClick={removeDigit}
          disabled={busy || displayPin.length === 0}
          style={{
            aspectRatio: '1',
            background: 'transparent',
            color: displayPin.length > 0 ? '#EAE3D2' : '#3A3530',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            touchAction: 'manipulation'
          }}
        >
          <Delete size={24} />
        </button>
      </div>
    </div>
  );
}
