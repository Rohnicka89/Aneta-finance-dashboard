import { json, error, authenticate } from '../../_shared/utils.js';

const ROAST = {
  'Jídlo ven': "Wolt, McDonald, Klášterní sýpka… Doma máš sporák, pamatuješ?",
  'Jídlo': "Žabka už zase? Drahý drobky tě sežerou.",
  'Káva': "Cukrárna Mučenka už zase? Káva doma je o 80 % levnější.",
  'Předplatné': "Subscription apokalypsa.",
  'Zábava': "Zábava nad limit. Knihovna je taky zábava. A zdarma.",
  'Krása': "Salon, kadeřnictví, nehty… pravidelný obličej je důležitější než pravidelná manikúra."
};

export async function onRequestGet({ request, env }) {
  const userId = await authenticate(request, env);
  if (!userId) return error('Unauthorized', 401);

  const settingsRow = await env.DB
    .prepare('SELECT total_limit, category_limits FROM settings WHERE user_id = ?')
    .bind(userId)
    .first();

  if (!settingsRow) return json({ warnings: [], totalPercent: 0 });

  let categoryLimits = {};
  try { categoryLimits = JSON.parse(settingsRow.category_limits || '{}'); }
  catch {}

  // Sečti výdaje aktuálního měsíce
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const { results: spending } = await env.DB
    .prepare(`
      SELECT category, SUM(amount) as total
      FROM transactions
      WHERE user_id = ? AND type = 'expense' AND date LIKE ?
      GROUP BY category
    `)
    .bind(userId, monthPrefix + '%')
    .all();

  const warnings = [];
  let totalSpent = 0;

  for (const row of (spending || [])) {
    totalSpent += row.total;
    const limit = categoryLimits[row.category];
    if (!limit || limit <= 0) continue;
    const pct = (row.total / limit) * 100;
    if (pct < 75) continue;
    warnings.push({
      category: row.category,
      spent: Math.round(row.total),
      limit: Math.round(limit),
      percent: Math.round(pct),
      roast: ROAST[row.category] || `Limit ${row.category} je vyčerpán.`
    });
  }

  warnings.sort((a, b) => b.percent - a.percent);

  const totalLimit = settingsRow.total_limit || 35000;
  const totalPercent = totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0;

  return json({
    warnings,
    totalSpent: Math.round(totalSpent),
    totalLimit: Math.round(totalLimit),
    totalPercent
  });
}
