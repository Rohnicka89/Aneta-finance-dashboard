// =============================================================================
// Načtení číselníku z Google Sheets (3 listy: Patterny, Účty, Limity)
// =============================================================================

export const SHEETS_URLS = {
  patterny: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1094225134&single=true&output=csv',
  ucty:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1149749359&single=true&output=csv',
  limity:   'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1894138435&single=true&output=csv',
};

// Robustní CSV parser (respektuje uvozovky)
export const parseCSV = (text) => {
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
};

// V produkčním buildu (Cloudflare Pages) fetch funguje bez CORS proxy
// Pokud by někdy přestal, můžeme přidat fallback
const fetchSheet = async (url) => {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

export const fetchCiselnik = async () => {
  const result = { patterny: [], ucty: [], limity: {}, errors: [] };

  // Patterny: A=Pattern, B=Kategorie, C=Poznámka, D=Příklad
  try {
    const text = await fetchSheet(SHEETS_URLS.patterny);
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [pattern, cat] = rows[i];
      if (pattern && cat && pattern.trim() && cat.trim()) {
        result.patterny.push({ pattern: pattern.trim(), cat: cat.trim() });
      }
    }
    // Seřaď delší patterny dřív - aby specifičtější vyhrály
    // "klasterni sypka" vyhraje před "sypka", "dr. max" před "dr"
    result.patterny.sort((a, b) => b.pattern.length - a.pattern.length);
  } catch (e) { result.errors.push(`Patterny: ${e.message}`); }

  // Účty: A=Číslo, B=Název, C=Kategorie, D=Typ, E=Poznámka
  try {
    const text = await fetchSheet(SHEETS_URLS.ucty);
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

  // Limity: A=Kategorie, B=Limit, C=Poznámka
  try {
    const text = await fetchSheet(SHEETS_URLS.limity);
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [cat, limit] = rows[i];
      if (cat && cat.trim() && cat.trim() !== 'CELKEM VÝDAJE') {
        const n = parseFloat((limit || '').toString().replace(/[^\d.,]/g, '').replace(',', '.'));
        if (!isNaN(n)) result.limity[cat.trim()] = n;
      }
    }
  } catch (e) { result.errors.push(`Limity: ${e.message}`); }

  return result;
};

// Normalizace textu pro porovnávání - odstraní diakritiku, zmenší písmena,
// sjednotí mezery a vyhodí speciální znaky
const normalize = (s) => {
  if (!s) return '';
  return s
    .toString()
    .toLowerCase()
    // Odstraní diakritiku: ž → z, š → s, č → c, atd.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Sjednotí všechny netextové znaky na mezery
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
};

// Kategorizace s prioritou: 1) Pattern → 2) Účet → 3) Nezařazeno
// Patterny i hledaný text procházejí přes normalize() - tolerantní na:
//   - velká/malá písmena (WOLT = wolt = Wolt)
//   - diakritiku (žabka = zabka = ZABKA)
//   - speciální znaky (žabka. = žabka = žabka!)
//   - víc mezer ("McDonald s" = "McDonald's" = "Mc Donald s")
export const categorize = (note, rbCategory, accountNumber, patterns, accounts) => {
  // RB systémové kategorie mají přednost
  const RB_CATEGORIES = {
    'Poplatek': 'Bankovní poplatky',
    'Úrok': 'Bankovní poplatky',
    'Vklad/Výběr z bankomatu': 'Hotovost',
  };
  if (RB_CATEGORIES[rbCategory]) return { cat: RB_CATEGORIES[rbCategory], source: 'rb' };

  // Priorita 1: Pattern v popisu (normalizováno)
  const n = normalize(note);
  for (const rule of (patterns || [])) {
    if (!rule.pattern) continue;
    const p = normalize(rule.pattern);
    if (!p) continue;
    if (n.includes(p)) {
      return { cat: rule.cat, source: 'pattern', matched: rule.pattern };
    }
  }

  // Priorita 2: Číslo účtu
  if (accountNumber) {
    const acc = (accounts || []).find(a => a.ucet === accountNumber);
    if (acc) return { cat: acc.cat, source: 'account', matched: acc.nazev };
  }

  return { cat: 'Nezařazeno', source: 'none' };
};
