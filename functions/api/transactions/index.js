import { json, error, authenticate } from '../../_shared/utils.js';

// GET = vrátit všechny transakce
export async function onRequestGet({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  const { results } = await env.DB
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC')
    .bind(userId)
    .all();

  // Převed sloupce na JSON formát kompatibilní s frontendem
  const transactions = (results || []).map(r => ({
    id: r.id,
    date: r.date,
    amount: r.amount,
    isPositive: !!r.is_positive,
    type: r.type,
    rbType: r.rb_type,
    rbCategory: r.rb_category,
    accountNumber: r.account_number,
    merchant: r.merchant,
    fullDescription: r.full_description,
    category: r.category,
    categorySource: r.category_source,
    isSubscription: !!r.is_subscription
  }));

  return json(transactions);
}

// PUT = nahradit celou sadu transakcí (idempotentní upsert)
export async function onRequestPut({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  let body;
  try { body = await request.json(); }
  catch { return error('Neplatný JSON'); }

  const { transactions } = body;
  if (!Array.isArray(transactions)) return error('transactions musí být array');

  // Použij batch insert pro výkon
  const stmt = env.DB.prepare(`
    INSERT INTO transactions (
      id, user_id, date, amount, is_positive, type, rb_type, rb_category,
      account_number, merchant, full_description, category, category_source, is_subscription
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      date = excluded.date,
      amount = excluded.amount,
      is_positive = excluded.is_positive,
      type = excluded.type,
      rb_type = excluded.rb_type,
      rb_category = excluded.rb_category,
      account_number = excluded.account_number,
      merchant = excluded.merchant,
      full_description = excluded.full_description,
      category = excluded.category,
      category_source = excluded.category_source,
      is_subscription = excluded.is_subscription
  `);

  const batch = transactions.map(t => stmt.bind(
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

  if (batch.length > 0) await env.DB.batch(batch);

  return json({ ok: true, count: transactions.length });
}

// DELETE = smaž všechny transakce uživatele
export async function onRequestDelete({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  await env.DB
    .prepare('DELETE FROM transactions WHERE user_id = ?')
    .bind(userId)
    .run();

  return json({ ok: true });
}
