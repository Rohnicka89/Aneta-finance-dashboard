import { json } from '../../_shared/utils.js';

export async function onRequestGet({ env }) {
  const result = await env.DB
    .prepare('SELECT COUNT(*) as cnt FROM users')
    .first();
  return json({ isSetup: (result?.cnt || 0) > 0 });
}
