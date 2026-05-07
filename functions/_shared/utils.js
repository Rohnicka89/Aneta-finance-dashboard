// Sdílené utility pro Cloudflare Pages Functions

// Hash PIN pomocí Web Crypto API (SHA-256 + salt)
export async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(pin + ':' + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Validuje Bearer token z Authorization header, vrátí user_id nebo null
export async function authenticate(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB
    .prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(token, now)
    .first();
  return result ? result.user_id : null;
}

// Standardní JSON response
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}
