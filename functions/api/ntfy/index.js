// POST /api/ntfy
// Proxy pro odesílání ntfy notifikací z Apps Scriptu
// (Apps Script neumí volat ntfy.sh přímo - blokuje to)
//
// Body: { title, body, priority?, tags? }
// Topic se bere z user settings (ntfy_topic v D1)

import { json, error, authenticate } from '../../_shared/utils.js';

export async function onRequestPost({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const { title, body: messageBody, priority, tags, topic: topicOverride } = body;

  if (!messageBody) return error('Chybí body');

  // Načti topic z user settings (nebo použij override z requestu)
  let topic = topicOverride;
  if (!topic) {
    const settings = await env.DB
      .prepare('SELECT ntfy_topic FROM settings WHERE user_id = ?')
      .bind(userId)
      .first();
    topic = settings?.ntfy_topic;
  }

  if (!topic) {
    return error('ntfy topic neni nastaveny. Nastav ho v dashboard settings.', 400);
  }

  // Pošli na ntfy.sh
  try {
    const headers = {
      'Content-Type': 'text/plain'
    };
    if (title) headers['Title'] = title;
    if (priority) headers['Priority'] = priority;
    if (tags) headers['Tags'] = tags;
    
    // Pokud máme ntfy access token (z env), použij ho pro autentizaci
    // -> ntfy nás bude počítat jako paying account, ne jako anonymní free
    if (env.NTFY_TOKEN) {
      headers['Authorization'] = 'Bearer ' + env.NTFY_TOKEN;
    }

    const ntfyResponse = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: messageBody
    });

    if (!ntfyResponse.ok) {
      const text = await ntfyResponse.text().catch(() => '');
      return error(`ntfy vrátil ${ntfyResponse.status}: ${text.substring(0, 200)}`, 502);
    }

    return json({ ok: true, topic, sent: true });
  } catch (e) {
    return error(`Selhalo odeslání na ntfy: ${e.message}`, 502);
  }
}
