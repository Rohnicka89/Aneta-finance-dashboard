import { json, error, authenticate } from '../../_shared/utils.js';

// POST /api/pending-pdfs  — Apps Script přidá PDF do fronty
// GET  /api/pending-pdfs  — Dashboard načte seznam čekajících PDF
// DELETE /api/pending-pdfs?id=123 — Dashboard smaže po úspěšném importu

export async function onRequestPost({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const { filename, data } = body;
  if (!filename || !data) return error('Chybí filename nebo data');

  // D1 má limit 1 MB na hodnotu - base64 PDF bývá 50-130 KB, bezpečně se vejde
  await env.DB
    .prepare('INSERT INTO pending_pdfs (user_id, filename, data_base64) VALUES (?, ?, ?)')
    .bind(userId, filename, data)
    .run();

  return json({ ok: true, filename });
}

export async function onRequestGet({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  const result = await env.DB
    .prepare('SELECT id, filename, data_base64, created_at FROM pending_pdfs WHERE user_id = ? ORDER BY created_at ASC')
    .bind(userId)
    .all();

  return json({ pdfs: result.results || [] });
}

export async function onRequestDelete({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return error('Chybí parametr id');

  await env.DB
    .prepare('DELETE FROM pending_pdfs WHERE id = ? AND user_id = ?')
    .bind(parseInt(id), userId)
    .run();

  return json({ ok: true });
}
