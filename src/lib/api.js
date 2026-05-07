// =============================================================================
// API klient - komunikuje s Cloudflare Pages Functions backendem
// Funkce v této vrstvě umí volat backend API i fungovat v offline režimu
// (data se cachují v localStorage a synchronizují později)
// =============================================================================

const API_BASE = '/api';
const TOKEN_KEY = 'aneta_auth_token';

// Token management
export const getAuthToken = () => localStorage.getItem(TOKEN_KEY);
export const setAuthToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearAuthToken = () => localStorage.removeItem(TOKEN_KEY);

// Wrapper kolem fetch s auth a error handlingem
const apiFetch = async (path, options = {}) => {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const r = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (r.status === 401) {
    clearAuthToken();
    throw new Error('UNAUTHORIZED');
  }

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`API ${r.status}: ${text || r.statusText}`);
  }

  return r.json();
};

// =============================================================================
// AUTH endpoints
// =============================================================================

export const checkSetup = async () => {
  // Vrátí { isSetup: bool } - jestli už existuje PIN
  try {
    return await apiFetch('/auth/setup-status');
  } catch (e) {
    // Pokud backend neběží (lokální dev bez wrangler), předpokládej že není
    return { isSetup: false, offline: true };
  }
};

export const setupPin = async (pin) => {
  const result = await apiFetch('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ pin })
  });
  if (result.token) setAuthToken(result.token);
  return result;
};

export const loginWithPin = async (pin) => {
  const result = await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ pin })
  });
  if (result.token) setAuthToken(result.token);
  return result;
};

export const logout = async () => {
  clearAuthToken();
};

// =============================================================================
// TRANSACTIONS endpoints
// =============================================================================

export const fetchTransactions = async () => {
  try {
    return await apiFetch('/transactions');
  } catch (e) {
    console.warn('Fetch transactions failed, using local cache:', e.message);
    const cached = localStorage.getItem('cache_transactions');
    return cached ? JSON.parse(cached) : [];
  }
};

export const saveTransactions = async (transactions) => {
  // Uložit lokálně jako cache
  localStorage.setItem('cache_transactions', JSON.stringify(transactions));
  // Synchronizovat na backend
  try {
    return await apiFetch('/transactions', {
      method: 'PUT',
      body: JSON.stringify({ transactions })
    });
  } catch (e) {
    console.warn('Save transactions to backend failed (will retry):', e.message);
    return { offline: true };
  }
};

export const deleteAllTransactions = async () => {
  localStorage.removeItem('cache_transactions');
  try {
    return await apiFetch('/transactions', { method: 'DELETE' });
  } catch (e) {
    return { offline: true };
  }
};

// =============================================================================
// SETTINGS endpoints (limity, pin nastavení atd.)
// =============================================================================

export const fetchSettings = async () => {
  try {
    return await apiFetch('/settings');
  } catch (e) {
    const cached = localStorage.getItem('cache_settings');
    return cached ? JSON.parse(cached) : { totalLimit: 35000, categoryLimits: {} };
  }
};

export const saveSettings = async (settings) => {
  localStorage.setItem('cache_settings', JSON.stringify(settings));
  try {
    return await apiFetch('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    });
  } catch (e) {
    return { offline: true };
  }
};

// =============================================================================
// LOKÁLNÍ-ONLY režim (když backend není deployovaný)
// =============================================================================

export const isOfflineMode = () => {
  // Pokud nemáme token a backend říká setup je offline, jsme v offline modu
  return !getAuthToken();
};

// Lokální PIN check (jen pro fallback - pokud backend neběží)
const LOCAL_PIN_KEY = 'aneta_local_pin_hash';

const hashPin = async (pin) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + 'aneta-salt-2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};

export const localSetupPin = async (pin) => {
  const hash = await hashPin(pin);
  localStorage.setItem(LOCAL_PIN_KEY, hash);
  setAuthToken('local-' + Date.now()); // pseudo token
  return { token: getAuthToken(), local: true };
};

export const localCheckPin = async (pin) => {
  const stored = localStorage.getItem(LOCAL_PIN_KEY);
  if (!stored) return false;
  const hash = await hashPin(pin);
  return hash === stored;
};

export const localLoginPin = async (pin) => {
  const ok = await localCheckPin(pin);
  if (!ok) throw new Error('Špatný PIN');
  setAuthToken('local-' + Date.now());
  return { token: getAuthToken(), local: true };
};

export const localIsSetup = () => !!localStorage.getItem(LOCAL_PIN_KEY);
