// =============================================================================
// Raiffka PDF parser
// Načte PDF přes pdf.js, extrahuje text a rozpozná transakce
// =============================================================================

import { categorize } from './ciselnik.js';
import { isSubscriptionMerchant } from './categories.js';

let pdfjsLib = null;

const loadPdfJs = async () => {
  if (pdfjsLib) return pdfjsLib;
  // Importuj jako ES module - v Vite to funguje
  pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
  // Worker URL - musí ukazovat na worker bundle
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();
  return pdfjsLib;
};

export const extractPdfText = async (file) => {
  const lib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join('\n');
    fullText += pageText + '\n';
  }
  return fullText;
};

export const extractMerchant = (note) => {
  if (!note) return 'Bez popisu';
  const parts = note.split(';');
  return parts[0].trim() || 'Bez popisu';
};

// Hlavní parser - rozděluje text na bloky podle kódu transakce
export const parseRaiffkaText = (text, patterns = [], accounts = []) => {
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

    // Extrakce čísla účtu protistrany
    let accountNumber = '';
    for (const line of block) {
      if (accountRegex.test(line)) {
        accountNumber = line;
        break;
      }
    }

    // Najdi částku v CZK
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

    // Popis obchodu (řádek se středníkem)
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

    // Kategorizace s prioritou: pattern → účet
    const catResult = categorize(merchant + ' ' + txType, rbCategory, accountNumber, patterns, accounts);

    let normalizedType = 'expense';
    if (amount > 0) normalizedType = 'income';

    // Pokud má účet typ "Převod"/"Příjem", použij ho
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
};
