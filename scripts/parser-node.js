/**
 * Node.js port of Raiffka PDF parser + categorization
 * Sdílená logika s web appkou (src/lib/parser.js, src/lib/ciselnik.js)
 * 
 * Spouštěné z GitHub Action denně.
 */

// =============================================================================
// Normalizace textu pro matching
// =============================================================================
export function normalize(s) {
  if (!s) return '';
  return s
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// =============================================================================
// Kategorizace (port z src/lib/ciselnik.js)
// =============================================================================
export function categorize(note, rbCategory, accountNumber, patterns, accounts) {
  const RB_CATEGORIES = {
    'Poplatek': 'Bankovní poplatky',
    'Úrok': 'Bankovní poplatky',
    'Vklad/Výběr z bankomatu': 'Hotovost',
  };
  if (RB_CATEGORIES[rbCategory]) return { cat: RB_CATEGORIES[rbCategory], source: 'rb' };

  const n = normalize(note);
  for (const rule of (patterns || [])) {
    if (!rule.pattern) continue;
    const p = normalize(rule.pattern);
    if (!p) continue;
    if (n.includes(p)) {
      return { cat: rule.cat, source: 'pattern', matched: rule.pattern };
    }
  }

  if (accountNumber) {
    const acc = (accounts || []).find(a => a.ucet === accountNumber);
    if (acc) return { cat: acc.cat, source: 'account', matched: acc.nazev };
  }

  return { cat: 'Nezařazeno', source: 'none' };
}

// =============================================================================
// Helpers
// =============================================================================
const extractMerchant = (note) => {
  if (!note) return 'Bez popisu';
  const parts = note.split(';');
  return parts[0].trim() || 'Bez popisu';
};

const isSubscriptionMerchant = (note) => {
  const n = (note || '').toLowerCase();
  return ['netflix', 'spotify', 'apple.com/bill', 'youtube', 'hbo', 'adobe', 'anthropic', 'tv nova']
    .some(k => n.includes(k));
};

// =============================================================================
// Raiffka PDF text parser (port z src/lib/parser.js)
// =============================================================================
export function parseRaiffkaText(text, patterns = [], accounts = []) {
  const transactions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  const knownRbCategories = ['Platba kartou', 'Platba', 'Trvalá platba', 'Inkaso', 'Poplatek', 'Úrok', 'Vklad/Výběr z bankomatu'];
  const typeKeywords = [
    'Příchozí úhrada', 'Odchozí okamžitá úhrada', 'Odchozí úhrada',
    'Trvalý příkaz', 'Jednorázová úhrada',
    'Platba kartou Apple Pay', 'Platba na internetu Apple Pay', 'Platba kartou',
    'Výběr hotovosti z bankomatu', 'Výběr hotovosti z bankomatu Apple Pay',
    'Vedení účtu', 'Jiný poplatek', 'Úrok z úvěru', 'Splátka úvěru'
  ];

  const accountRegex = /^(\d{1,6}-)?(\d{6,10})\/(\d{4})$/;

  // KROK 1: Najdi všechny indexy začátků transakcí
  const txStartIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d{8,10}$/.test(lines[i])) {
      const prev1 = lines[i-1];
      const prev2 = lines[i-2];
      if (prev1 && prev2 && /^\d{1,2}\.\s*\d{1,2}\.\s*20\d{2}$/.test(prev1) && /^\d{1,2}\.\s*\d{1,2}\.\s*20\d{2}$/.test(prev2)) {
        txStartIndices.push(i - 2);
      }
    }
  }

  // KROK 2: Pro každou transakci vezmi blok
  for (let idx = 0; idx < txStartIndices.length; idx++) {
    const blockStart = txStartIndices[idx];
    const blockEnd = idx + 1 < txStartIndices.length ? txStartIndices[idx + 1] : Math.min(blockStart + 30, lines.length);
    const block = lines.slice(blockStart, blockEnd);

    if (block.length < 4) continue;

    const dateMatch = block[0].match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d{2})$/);
    if (!dateMatch) continue;
    const [_, d, m, y] = dateMatch;
    const txDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    const txCode = block[2];

    let rbCategory = '';
    for (const line of block) {
      if (knownRbCategories.includes(line)) { rbCategory = line; break; }
    }

    let txType = '';
    for (const line of block) {
      if (typeKeywords.includes(line)) { txType = line; break; }
    }

    let accountNumber = '';
    for (const line of block) {
      if (accountRegex.test(line)) {
        accountNumber = line;
        break;
      }
    }

    const amountLines = [];
    for (let j = 0; j < block.length; j++) {
      const am = block[j].match(/^(-?[\d\s]+[.,]\d{2})\s+CZK$/);
      if (am) {
        const v = parseFloat(am[1].replace(/\s/g, '').replace(',', '.'));
        if (!isNaN(v)) amountLines.push({ idx: j, value: v });
      }
    }
    if (amountLines.length === 0) continue;

    const amount = amountLines[0].value;
    if (amount === 0) continue;

    let merchant = '';
    for (let j = block.length - 1; j >= 0; j--) {
      const c = block[j];
      if (c.includes(';') && /[A-Z]{3}$/.test(c)) {
        merchant = c;
        break;
      }
    }

    if (!merchant) {
      const skipPatterns = [
        /^\d+\.\s*\d+\.\s*20\d{2}$/,
        /^\d{8,10}$/,
        /^KS:/, /^PK:/, /^VS:/, /^SS:/,
        /^\d+$/,
        /^\d{6,}-?\d*\/\d+$/,
        /^\d+\/\d+$/,
        /CZK$/,
        /^[A-Z]{3}$/
      ];
      const knownTexts = new Set([
        'ANETA BEITLEROVÁ', 'Aneta Beitlerová', 'Aneta Beitlerova',
        ...knownRbCategories,
        ...typeKeywords
      ]);

      for (let j = 3; j < block.length; j++) {
        const c = block[j];
        if (!c) continue;
        if (knownTexts.has(c)) continue;
        if (skipPatterns.some(p => p.test(c))) continue;
        merchant = c;
        break;
      }
    }

    if (!merchant) merchant = txType || rbCategory || 'Bez popisu';

    const catResult = categorize(merchant + ' ' + txType, rbCategory, accountNumber, patterns, accounts);

    let normalizedType = 'expense';
    if (amount > 0) normalizedType = 'income';

    const accountMatch = accountNumber ? accounts.find(a => a.ucet === accountNumber) : null;
    if (accountMatch) {
      if (accountMatch.typ === 'Převod') normalizedType = 'transfer';
      else if (accountMatch.typ === 'Příjem') normalizedType = 'income';
    }

    let displayMerchant = extractMerchant(merchant);
    if (accountMatch && accountMatch.nazev && (
      displayMerchant === 'Bez popisu' ||
      typeKeywords.includes(displayMerchant) ||
      knownRbCategories.includes(displayMerchant)
    )) {
      displayMerchant = accountMatch.nazev;
    }

    let category;
    if (normalizedType === 'income') {
      category = catResult.cat !== 'Nezařazeno' ? catResult.cat : 'Příjem';
    } else if (normalizedType === 'transfer') {
      category = 'Převod';
    } else {
      category = catResult.cat;
    }

    transactions.push({
      id: `${txDate}-${txCode}`,
      date: txDate,
      amount: Math.abs(amount),
      isPositive: amount > 0,
      type: normalizedType,
      rbType: txType,
      rbCategory,
      accountNumber,
      merchant: displayMerchant,
      fullDescription: merchant,
      category,
      categorySource: catResult.source,
      isSubscription: isSubscriptionMerchant(merchant)
    });
  }

  return transactions;
}

// =============================================================================
// CSV parser pro Google Sheets
// =============================================================================
export function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i+1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      cur.push(field); field = '';
    } else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (field || cur.length) { cur.push(field); rows.push(cur); }
      cur = []; field = '';
      if (c === '\r' && text[i+1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.some(f => f && f.trim()));
}

export async function fetchCiselnik() {
  const SHEETS_URLS = {
    patterny: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1094225134&single=true&output=csv',
    ucty:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1149749359&single=true&output=csv',
  };
  const result = { patterny: [], ucty: [], errors: [] };

  try {
    const r = await fetch(SHEETS_URLS.patterny);
    const text = await r.text();
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [pattern, cat] = rows[i];
      if (pattern && cat && pattern.trim() && cat.trim()) {
        result.patterny.push({ pattern: pattern.trim(), cat: cat.trim() });
      }
    }
    result.patterny.sort((a, b) => b.pattern.length - a.pattern.length);
  } catch (e) { result.errors.push(`Patterny: ${e.message}`); }

  try {
    const r = await fetch(SHEETS_URLS.ucty);
    const text = await r.text();
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [ucet, nazev, cat, typ] = rows[i];
      if (ucet && cat && ucet.trim() && cat.trim()) {
        result.ucty.push({
          ucet: ucet.trim(),
          nazev: (nazev || '').trim(),
          cat: cat.trim(),
          typ: (typ || 'Výdaj').trim()
        });
      }
    }
  } catch (e) { result.errors.push(`Účty: ${e.message}`); }

  return result;
}    if (!p) continue;
    if (n.includes(p)) {
      return { cat: rule.cat, source: 'pattern', matched: rule.pattern };
    }
  }

  if (accountNumber) {
    const acc = (accounts || []).find(a => a.ucet === accountNumber);
    if (acc) return { cat: acc.cat, source: 'account', matched: acc.nazev };
  }

  return { cat: 'Nezařazeno', source: 'none' };
}

// =============================================================================
// Helpers
// =============================================================================
const extractMerchant = (note) => {
  if (!note) return 'Bez popisu';
  const parts = note.split(';');
  return parts[0].trim() || 'Bez popisu';
};

const isSubscriptionMerchant = (note) => {
  const n = (note || '').toLowerCase();
  return ['netflix', 'spotify', 'apple.com/bill', 'youtube', 'hbo', 'adobe', 'anthropic', 'tv nova']
    .some(k => n.includes(k));
};

// =============================================================================
// Raiffka PDF text parser (port z src/lib/parser.js)
// =============================================================================
export function parseRaiffkaText(text, patterns = [], accounts = []) {
  const transactions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  const knownRbCategories = ['Platba kartou', 'Platba', 'Trvalá platba', 'Inkaso', 'Poplatek', 'Úrok', 'Vklad/Výběr z bankomatu'];
  const typeKeywords = [
    'Příchozí úhrada', 'Odchozí okamžitá úhrada', 'Odchozí úhrada',
    'Trvalý příkaz', 'Jednorázová úhrada',
    'Platba kartou Apple Pay', 'Platba na internetu Apple Pay', 'Platba kartou',
    'Výběr hotovosti z bankomatu', 'Výběr hotovosti z bankomatu Apple Pay',
    'Vedení účtu', 'Jiný poplatek', 'Úrok z úvěru', 'Splátka úvěru'
  ];

  const accountRegex = /^(\d{1,6}-)?(\d{6,10})\/(\d{4})$/;

  // KROK 1: Najdi všechny indexy začátků transakcí
  const txStartIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\d{8,10}$/.test(lines[i])) {
      const prev1 = lines[i-1];
      const prev2 = lines[i-2];
      if (prev1 && prev2 && /^\d{1,2}\.\s*\d{1,2}\.\s*20\d{2}$/.test(prev1) && /^\d{1,2}\.\s*\d{1,2}\.\s*20\d{2}$/.test(prev2)) {
        txStartIndices.push(i - 2);
      }
    }
  }

  // KROK 2: Pro každou transakci vezmi blok
  for (let idx = 0; idx < txStartIndices.length; idx++) {
    const blockStart = txStartIndices[idx];
    const blockEnd = idx + 1 < txStartIndices.length ? txStartIndices[idx + 1] : Math.min(blockStart + 30, lines.length);
    const block = lines.slice(blockStart, blockEnd);

    if (block.length < 4) continue;

    const dateMatch = block[0].match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d{2})$/);
    if (!dateMatch) continue;
    const [_, d, m, y] = dateMatch;
    const txDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    const txCode = block[2];

    let rbCategory = '';
    for (const line of block) {
      if (knownRbCategories.includes(line)) { rbCategory = line; break; }
    }

    let txType = '';
    for (const line of block) {
      if (typeKeywords.includes(line)) { txType = line; break; }
    }

    let accountNumber = '';
    for (const line of block) {
      if (accountRegex.test(line)) {
        accountNumber = line;
        break;
      }
    }

    const amountLines = [];
    for (let j = 0; j < block.length; j++) {
      const am = block[j].match(/^(-?[\d\s]+[.,]\d{2})\s+CZK$/);
      if (am) {
        const v = parseFloat(am[1].replace(/\s/g, '').replace(',', '.'));
        if (!isNaN(v)) amountLines.push({ idx: j, value: v });
      }
    }
    if (amountLines.length === 0) continue;

    const amount = amountLines[0].value;
    if (amount === 0) continue;

    let merchant = '';
    for (let j = block.length - 1; j >= 0; j--) {
      const c = block[j];
      if (c.includes(';') && /[A-Z]{3}$/.test(c)) {
        merchant = c;
        break;
      }
    }

    if (!merchant) {
      const skipPatterns = [
        /^\d+\.\s*\d+\.\s*20\d{2}$/,
        /^\d{8,10}$/,
        /^KS:/, /^PK:/, /^VS:/, /^SS:/,
        /^\d+$/,
        /^\d{6,}-?\d*\/\d+$/,
        /^\d+\/\d+$/,
        /CZK$/,
        /^[A-Z]{3}$/
      ];
      const knownTexts = new Set([
        'ANETA BEITLEROVÁ', 'Aneta Beitlerová', 'Aneta Beitlerova',
        ...knownRbCategories,
        ...typeKeywords
      ]);

      for (let j = 3; j < block.length; j++) {
        const c = block[j];
        if (!c) continue;
        if (knownTexts.has(c)) continue;
        if (skipPatterns.some(p => p.test(c))) continue;
        merchant = c;
        break;
      }
    }

    if (!merchant) merchant = txType || rbCategory || 'Bez popisu';

    const catResult = categorize(merchant + ' ' + txType, rbCategory, accountNumber, patterns, accounts);

    let normalizedType = 'expense';
    if (amount > 0) normalizedType = 'income';

    const accountMatch = accountNumber ? accounts.find(a => a.ucet === accountNumber) : null;
    if (accountMatch) {
      if (accountMatch.typ === 'Převod') normalizedType = 'transfer';
      else if (accountMatch.typ === 'Příjem') normalizedType = 'income';
    }

    let displayMerchant = extractMerchant(merchant);
    if (accountMatch && accountMatch.nazev && (
      displayMerchant === 'Bez popisu' ||
      typeKeywords.includes(displayMerchant) ||
      knownRbCategories.includes(displayMerchant)
    )) {
      displayMerchant = accountMatch.nazev;
    }

    let category;
    if (normalizedType === 'income') {
      category = catResult.cat !== 'Nezařazeno' ? catResult.cat : 'Příjem';
    } else if (normalizedType === 'transfer') {
      category = 'Převod';
    } else {
      category = catResult.cat;
    }

    transactions.push({
      id: `${txDate}-${txCode}`,
      date: txDate,
      amount: Math.abs(amount),
      isPositive: amount > 0,
      type: normalizedType,
      rbType: txType,
      rbCategory,
      accountNumber,
      merchant: displayMerchant,
      fullDescription: merchant,
      category,
      categorySource: catResult.source,
      isSubscription: isSubscriptionMerchant(merchant)
    });
  }

  return transactions;
}

// =============================================================================
// CSV parser pro Google Sheets
// =============================================================================
export function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i+1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      cur.push(field); field = '';
    } else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (field || cur.length) { cur.push(field); rows.push(cur); }
      cur = []; field = '';
      if (c === '\r' && text[i+1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.some(f => f && f.trim()));
}

export async function fetchCiselnik() {
  const SHEETS_URLS = {
    patterny: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1094225134&single=true&output=csv',
    ucty:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1149749359&single=true&output=csv',
  };
  const result = { patterny: [], ucty: [], errors: [] };

  try {
    const r = await fetch(SHEETS_URLS.patterny);
    const text = await r.text();
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [pattern, cat] = rows[i];
      if (pattern && cat && pattern.trim() && cat.trim()) {
        result.patterny.push({ pattern: pattern.trim(), cat: cat.trim() });
      }
    }
    result.patterny.sort((a, b) => b.pattern.length - a.pattern.length);
  } catch (e) { result.errors.push(`Patterny: ${e.message}`); }

  try {
    const r = await fetch(SHEETS_URLS.ucty);
    const text = await r.text();
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [ucet, nazev, cat, typ] = rows[i];
      if (ucet && cat && ucet.trim() && cat.trim()) {
        result.ucty.push({
          ucet: ucet.trim(),
          nazev: (nazev || '').trim(),
          cat: cat.trim(),
          typ: (typ || 'Výdaj').trim()
        });
      }
    }
  } catch (e) { result.errors.push(`Účty: ${e.message}`); }

  return result;
}
