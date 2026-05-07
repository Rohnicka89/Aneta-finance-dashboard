import { json, error, hashPin, generateToken } from '../../_shared/utils.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const { pin } = body;
  if (!pin || typeof pin !== 'string') return error('PIN chybí');

  const user = await env.DB.prepare('SELECT id, pin_hash, pin_salt FROM users LIMIT 1').first();
  if (!user) return error('Uživatel neexistuje. Spusť setup.', 404);

  const hash = await hashPin(pin, user.pin_salt);
  if (hash !== user.pin_hash) return error('Špatný PIN', 401);

  const token = generateToken();
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  await env.DB
    .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, user.id, expires)
    .run();

  await env.DB
    .prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?')
    .bind(user.id)
    .run();

  // Vyčisti expirovsé sessions
  await env.DB
    .prepare('DELETE FROM sessions WHERE expires_at < unixepoch()')
    .run();

  return json({ token, userId: user.id });
}
