import { json, error, hashPin, generateSalt, generateToken } from '../../_shared/utils.js';

export async function onRequestPost({ request, env }) {
  // Zkontroluj, že ještě není uživatel
  const existing = await env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first();
  if ((existing?.cnt || 0) > 0) {
    return error('Setup již proběhl. Použij login.', 409);
  }

  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const { pin } = body;
  if (!pin || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
    return error('PIN musí být 4-6 číslic');
  }

  const salt = generateSalt();
  const hash = await hashPin(pin, salt);

  const userResult = await env.DB
    .prepare('INSERT INTO users (pin_hash, pin_salt) VALUES (?, ?) RETURNING id')
    .bind(hash, salt)
    .first();

  const userId = userResult.id;

  // Initial settings record
  await env.DB
    .prepare('INSERT INTO settings (user_id, total_limit, category_limits) VALUES (?, ?, ?)')
    .bind(userId, 35000, '{}')
    .run();

  // Session token
  const token = generateToken();
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 dní
  await env.DB
    .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expires)
    .run();

  return json({ token, userId });
}
