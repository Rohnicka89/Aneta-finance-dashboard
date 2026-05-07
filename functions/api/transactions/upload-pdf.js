// POST /api/transactions/upload-pdf
// Přijímá base64-encoded PDF z Apps Scriptu, parsuje ho a vrací info o nových transakcích
//
// Protože pdf.js v Cloudflare Worker prostředí potřebuje extra setup,
// pro fázi 3 doporučuji přijít s jiným přístupem:
//   1) Apps Script pošle JEN PARSED transakce (přidělá mu i parser logiku)
//   2) Nebo: Apps Script jen pošle email do storage a frontend si pro něj přijde
//
// Tato verze je MOCK / placeholder - vrátí instrukci, že parsování má dělat
// frontend (po manuálním nahrání PDF v UI). V production verzi by se to dořešilo
// přesunem parser logiky na Worker side, nebo druhým endpointem.

import { json, error, authenticate } from '../../_shared/utils.js';

export async function onRequestPost({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const { filename, pdfBase64, parsedTransactions } = body;

  // VARIANTA A: Apps Script už PDF parsoval a posílá hotové transakce
  if (Array.isArray(parsedTransactions)) {
    return await saveTransactions(parsedTransactions, userId, env);
  }

  // VARIANTA B: Apps Script poslal jen base64 PDF
  // Pro tuto fázi vrátíme jen potvrzení o uložení do "raw queue"
  // (frontend si při dalším otevření PDF stáhne a zpracuje)
  if (pdfBase64) {
    return json({
      ok: true,
      message: 'PDF přijato. Otevři dashboard pro zpracování.',
      filename,
      newCount: 0,
      totalCount: 0,
      hint: 'Server-side parsing není implementován. Přidej parser logiku do Apps Script a posílej parsedTransactions.'
    });
  }

  return error('Pošli buď pdfBase64 nebo parsedTransactions');
}

async function saveTransactions(transactions, userId, env) {
  const stmt = env.DB.prepare(`
    INSERT INTO transactions (
      id, user_id, date, amount, is_positive, type, rb_type, rb_category,
      account_number, merchant, full_description, category, category_source, is_subscription
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  // Najdi, které ID už máme (ať víme kolik je nových)
  const existingResult = await env.DB
    .prepare('SELECT id FROM transactions WHERE user_id = ?')
    .bind(userId)
    .all();
  const existingIds = new Set((existingResult.results || []).map(r => r.id));
  const newOnes = transactions.filter(t => !existingIds.has(t.id));

  if (newOnes.length === 0) {
    return json({ ok: true, newCount: 0, totalCount: transactions.length });
  }

  const batch = newOnes.map(t => stmt.bind(
    t.id,
    userId,
    t.date,
    t.amount,
    t.isPositive ? 1 : 0,
    t.type,
    t.rbType || null,
    t.rbCategory || null,
    t.accountNumber || null,
    t.merchant || null,
    t.fullDescription || null,
    t.category,
    t.categorySource || null,
    t.isSubscription ? 1 : 0
  ));

  await env.DB.batch(batch);

  return json({
    ok: true,
    newCount: newOnes.length,
    totalCount: transactions.length
  });
}
