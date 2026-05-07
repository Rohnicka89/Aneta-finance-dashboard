import { json, error, authenticate } from '../../_shared/utils.js';

export async function onRequestGet({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  const result = await env.DB
    .prepare('SELECT total_limit, category_limits, ntfy_topic FROM settings WHERE user_id = ?')
    .bind(userId)
    .first();

  if (!result) {
    return json({ totalLimit: 35000, categoryLimits: {}, ntfyTopic: null });
  }

  let categoryLimits = {};
  try { categoryLimits = JSON.parse(result.category_limits || '{}'); }
  catch { /* ignore */ }

  return json({
    totalLimit: result.total_limit || 35000,
    categoryLimits,
    ntfyTopic: result.ntfy_topic
  });
}

export async function onRequestPut({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const totalLimit = parseFloat(body.totalLimit) || 35000;
  const categoryLimits = JSON.stringify(body.categoryLimits || {});
  const ntfyTopic = body.ntfyTopic || null;

  // UPSERT - INSERT nebo UPDATE
  await env.DB
    .prepare(`
      INSERT INTO settings (user_id, total_limit, category_limits, ntfy_topic, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id) DO UPDATE SET
        total_limit = excluded.total_limit,
        category_limits = excluded.category_limits,
        ntfy_topic = excluded.ntfy_topic,
        updated_at = unixepoch()
    `)
    .bind(userId, totalLimit, categoryLimits, ntfyTopic)
    .run();

  return json({ ok: true });
}
