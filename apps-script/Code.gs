/**
 * Anetin Finance Dashboard - Gmail Automation
 * ============================================
 * 
 * Tento skript každý den ráno:
 *  1. Najde v Gmailu nové výpisy z Raiffeisenbank (přeposlané z iCloud)
 *  2. Stáhne PDF přílohu
 *  3. Vyextrahuje text (přes Google Drive konverzi PDF → Doc)
 *  4. Parsuje transakce (stejná logika jako web appka)
 *  5. Načte číselník z tvého Google Sheets
 *  6. Kategorizuje (pattern → účet → Nezařazeno)
 *  7. Pošle hotové transakce do Cloudflare D1 přes dashboard API
 *  8. Při překročení limitu pošle ntfy notifikaci na iPhone
 *  9. Označí email jako "DASHBOARD-PROCESSED" + přečtený
 * 
 * Setup viz README.md sekce "Fáze C".
 */

// ============================================================================
// KONFIGURACE - čte se z Script Properties (File → Project properties)
// Nastavte: DASHBOARD_URL, DASHBOARD_TOKEN, NTFY_TOPIC
// ============================================================================

const SUBJECT_FILTER = 'Výpis z účtu';
const FORWARDED_FROM = 'rohnicka@icloud.com';      // odkud iCloud přeposílá
const PROCESSED_LABEL = 'DASHBOARD-PROCESSED';
const MAX_EMAILS_PER_RUN = 20;
const SEARCH_DAYS = 7;  // jak daleko zpět hledat

// Tvé Google Sheets URL (musí být veřejně publikovaný - "Publish to web")
const SHEETS_URLS = {
  patterny: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1094225134&single=true&output=csv',
  ucty:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vRTH8jcVhp-BXOn8wz8k6N1vh-RG98wgrOtMPBkxpSsQMRdjV9F9tWp8Vdsf9pWAg/pub?gid=1149749359&single=true&output=csv',
};

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    dashboardUrl: props.getProperty('DASHBOARD_URL'),
    token: props.getProperty('DASHBOARD_TOKEN'),
    ntfyTopic: props.getProperty('NTFY_TOPIC')
  };
}

// ============================================================================
// SETUP - spusť JEDNOU manuálně po prvním vložení kódu
// ============================================================================

function setup() {
  const config = getConfig();
  
  // 1) Vytvoř Gmail label, pokud neexistuje
  let label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(PROCESSED_LABEL);
    Logger.log('✓ Vytvořen Gmail label: ' + PROCESSED_LABEL);
  } else {
    Logger.log('✓ Gmail label už existuje: ' + PROCESSED_LABEL);
  }

  // 2) Zkontroluj konfiguraci
  const missing = [];
  if (!config.dashboardUrl) missing.push('DASHBOARD_URL');
  if (!config.token) missing.push('DASHBOARD_TOKEN');
  if (!config.ntfyTopic) missing.push('NTFY_TOPIC');

  if (missing.length > 0) {
    Logger.log('❌ NUTNO NASTAVIT v Project Settings → Script properties:');
    missing.forEach(p => Logger.log('   - ' + p));
    return;
  }

  Logger.log('✓ Konfigurace OK');
  Logger.log('  Dashboard: ' + config.dashboardUrl);
  Logger.log('  Token: ' + config.token.substring(0, 12) + '...');
  Logger.log('  ntfy topic: ' + config.ntfyTopic);

  // 3) Otestuj připojení k dashboardu
  try {
    const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/transactions', {
      headers: { 'Authorization': 'Bearer ' + config.token },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) {
      const txs = JSON.parse(r.getContentText());
      Logger.log('✓ Dashboard připojení OK. Aktuální počet transakcí: ' + txs.length);
    } else {
      Logger.log('⚠ Dashboard vrátil ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    }
  } catch (e) {
    Logger.log('❌ Chyba připojení: ' + e.message);
  }

  Logger.log('\n=== HOTOVO ===');
  Logger.log('Nyní v Triggers (ikona budíku) přidej trigger:');
  Logger.log('  - Function: processNewEmails');
  Logger.log('  - Event source: Time-driven');
  Logger.log('  - Type: Day timer');
  Logger.log('  - Time of day: 8am to 9am (nebo kdy chceš dostávat notifikace)');
}

// ============================================================================
// HLAVNÍ FUNKCE - spouští se denně přes trigger
// ============================================================================

function processNewEmails() {
  const startTime = new Date();
  Logger.log('=== Spuštěno: ' + startTime.toLocaleString('cs-CZ') + ' ===');

  const config = getConfig();
  if (!config.dashboardUrl || !config.token) {
    Logger.log('❌ Chybí konfigurace. Spusť setup().');
    return;
  }

  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    Logger.log('❌ Chybí Gmail label. Spusť setup().');
    return;
  }

  // Hledej emaily přeposlané z iCloud s předmětem výpisu
  const query = 'from:' + FORWARDED_FROM + ' subject:"' + SUBJECT_FILTER + '" -label:' + PROCESSED_LABEL + ' has:attachment newer_than:' + SEARCH_DAYS + 'd';
  const threads = GmailApp.search(query, 0, MAX_EMAILS_PER_RUN);

  Logger.log('Hledám: ' + query);
  Logger.log('Nalezeno ' + threads.length + ' nezpracovaných emailů');

  if (threads.length === 0) {
    Logger.log('Žádné nové emaily. Konec.');
    return;
  }

  // Načti číselník (jednou pro všechny emaily)
  Logger.log('Stahuji číselník z Google Sheets...');
  const ciselnik = fetchCiselnik();
  Logger.log('  Patternů: ' + ciselnik.patterny.length);
  Logger.log('  Účtů: ' + ciselnik.ucty.length);

  let totalNew = 0;
  let totalDuplicate = 0;
  let errors = [];

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const message of messages) {
      try {
        const result = processMessage(message, config, ciselnik);
        totalNew += result.newCount || 0;
        totalDuplicate += result.duplicateCount || 0;
        thread.addLabel(label);
        message.markRead();
      } catch (err) {
        const errMsg = 'Email "' + message.getSubject() + '": ' + err.message;
        Logger.log('❌ ' + errMsg);
        errors.push(errMsg);
      }
    }
  }

  const duration = Math.round((new Date() - startTime) / 1000);
  Logger.log('\n=== Hotovo za ' + duration + 's ===');
  Logger.log('Nové transakce: ' + totalNew + ', duplikáty: ' + totalDuplicate + ', chyby: ' + errors.length);

  // Pokud byly nové transakce, zkontroluj limity a pošli notifikaci
  if (totalNew > 0) {
    checkLimitsAndNotify(config, totalNew);
  }

  // Pokud byly chyby, pošli o nich notifikaci
  if (errors.length > 0 && config.ntfyTopic) {
    sendNtfy(config.ntfyTopic, 
      'Dashboard: chyba zpracování', 
      'Selhalo ' + errors.length + ' emailů:\n' + errors.slice(0, 3).join('\n'),
      'warning', 'high');
  }
}

// ============================================================================
// Zpracování jednoho emailu
// ============================================================================

function processMessage(message, config, ciselnik) {
  const attachments = message.getAttachments();
  const pdfs = attachments.filter(function(a) { return a.getName().toLowerCase().indexOf('.pdf') !== -1; });

  if (pdfs.length === 0) {
    Logger.log('⚠ Email "' + message.getSubject().substring(0, 50) + '" nemá PDF');
    return { newCount: 0, duplicateCount: 0 };
  }

  let totalNew = 0;
  let totalDup = 0;

  for (const pdf of pdfs) {
    Logger.log('📄 ' + pdf.getName() + ' (' + Math.round(pdf.getSize()/1024) + ' KB)');

    // Konvertuj PDF → text přes Drive (jediná spolehlivá cesta v Apps Script)
    const text = extractPdfText(pdf);
    
    if (!text || text.length < 100) {
      Logger.log('  ⚠ PDF má jen ' + (text ? text.length : 0) + ' znaků, přeskakuji');
      continue;
    }

    // Parsuj transakce (stejná logika jako web appka)
    const transactions = parseRaiffkaText(text, ciselnik.patterny, ciselnik.ucty);
    Logger.log('  Rozpoznáno ' + transactions.length + ' transakcí');

    if (transactions.length === 0) continue;

    // Pošli do dashboardu
    const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/transactions/upload-pdf', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + config.token },
      payload: JSON.stringify({
        filename: pdf.getName(),
        parsedTransactions: transactions
      }),
      muteHttpExceptions: true
    });

    if (r.getResponseCode() !== 200) {
      throw new Error('API ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    }

    const data = JSON.parse(r.getContentText());
    const newCount = data.newCount || 0;
    const dupCount = (data.totalCount || transactions.length) - newCount;
    
    Logger.log('  ✓ ' + newCount + ' nových, ' + dupCount + ' duplikátů');
    totalNew += newCount;
    totalDup += dupCount;
  }

  return { newCount: totalNew, duplicateCount: totalDup };
}

// ============================================================================
// PDF → text (přes Google Drive konverzi)
// Vyžaduje povolení Advanced Drive Service (viz README)
// ============================================================================

function extractPdfText(pdfBlob) {
  let tempFileId = null;
  try {
    // 1) Nahraj PDF na Drive a požádej o konverzi na Google Doc
    const resource = {
      title: 'temp-pdf-extract-' + Date.now(),
      mimeType: 'application/pdf'
    };
    const tempFile = Drive.Files.insert(resource, pdfBlob, {
      ocr: true,
      ocrLanguage: 'cs',
      convert: true   // PDF se zkonvertuje na Google Doc
    });
    tempFileId = tempFile.id;
    
    // 2) Otevři Doc a vytáhni text
    const doc = DocumentApp.openById(tempFileId);
    const text = doc.getBody().getText();
    
    return text;
  } finally {
    // 3) Vždy smaž temp soubor
    if (tempFileId) {
      try { Drive.Files.remove(tempFileId); } catch (e) {}
    }
  }
}

// ============================================================================
// Načtení číselníku z Google Sheets
// ============================================================================

function fetchCiselnik() {
  const result = { patterny: [], ucty: [], errors: [] };

  // Patterny (Pattern, Kategorie)
  try {
    const text = UrlFetchApp.fetch(SHEETS_URLS.patterny).getContentText();
    const rows = parseCSV(text);
    for (let i = 1; i < rows.length; i++) {
      const [pattern, cat] = rows[i];
      if (pattern && cat && pattern.trim() && cat.trim()) {
        result.patterny.push({ pattern: pattern.trim(), cat: cat.trim() });
      }
    }
    // Seřaď delší dřív (specifičtější vyhrají)
    result.patterny.sort(function(a, b) { return b.pattern.length - a.pattern.length; });
  } catch (e) { result.errors.push('Patterny: ' + e.message); }

  // Účty (Číslo, Název, Kategorie, Typ)
  try {
    const text = UrlFetchApp.fetch(SHEETS_URLS.ucty).getContentText();
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
  } catch (e) { result.errors.push('Účty: ' + e.message); }

  return result;
}

// Robustní CSV parser (respektuje uvozovky)
function parseCSV(text) {
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
  return rows.filter(function(r) { return r.some(function(f) { return f && f.trim(); }); });
}

// ============================================================================
// Normalizace textu pro matching (diakritika, case, mezery, znaky)
// ============================================================================

function normalize(s) {
  if (!s) return '';
  return s
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ============================================================================
// Kategorizace (stejná logika jako web appka)
// ============================================================================

function categorize(note, rbCategory, accountNumber, patterns, accounts) {
  const RB_CATEGORIES = {
    'Poplatek': 'Bankovní poplatky',
    'Úrok': 'Bankovní poplatky',
    'Vklad/Výběr z bankomatu': 'Hotovost',
  };
  if (RB_CATEGORIES[rbCategory]) return { cat: RB_CATEGORIES[rbCategory], source: 'rb' };

  // Pattern matching (normalizováno)
  const n = normalize(note);
  for (const rule of patterns) {
    if (!rule.pattern) continue;
    const p = normalize(rule.pattern);
    if (!p) continue;
    if (n.indexOf(p) !== -1) {
      return { cat: rule.cat, source: 'pattern', matched: rule.pattern };
    }
  }

  // Číslo účtu
  if (accountNumber) {
    for (const acc of accounts) {
      if (acc.ucet === accountNumber) {
        return { cat: acc.cat, source: 'account', matched: acc.nazev };
      }
    }
  }

  return { cat: 'Nezařazeno', source: 'none' };
}

// ============================================================================
// Raiffka PDF text parser (port z web appky parser.js)
// ============================================================================

function parseRaiffkaText(text, patterns, accounts) {
  const transactions = [];
  const lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });

  const knownRbCategories = ['Platba kartou', 'Platba', 'Trvalá platba', 'Inkaso', 'Poplatek', 'Úrok', 'Vklad/Výběr z bankomatu'];
  const typeKeywords = [
    'Příchozí úhrada', 'Odchozí okamžitá úhrada', 'Odchozí úhrada',
    'Trvalý příkaz', 'Jednorázová úhrada',
    'Platba kartou Apple Pay', 'Platba na internetu Apple Pay', 'Platba kartou',
    'Výběr hotovosti z bankomatu', 'Výběr hotovosti z bankomatu Apple Pay',
    'Vedení účtu', 'Jiný poplatek', 'Úrok z úvěru', 'Splátka úvěru'
  ];

  const accountRegex = /^(\d{1,6}-)?(\d{6,10})\/(\d{4})$/;
  const dateRegex = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d{2})$/;
  const codeRegex = /^\d{8,10}$/;

  // KROK 1: Najdi indexy začátků transakcí (řádek s kódem následující 2x datum)
  const txStartIndices = [];
  for (let i = 2; i < lines.length; i++) {
    if (codeRegex.test(lines[i])) {
      if (dateRegex.test(lines[i-1]) && dateRegex.test(lines[i-2])) {
        txStartIndices.push(i - 2);
      }
    }
  }

  // KROK 2: Pro každou transakci vyparsuj blok
  for (let idx = 0; idx < txStartIndices.length; idx++) {
    const blockStart = txStartIndices[idx];
    const blockEnd = idx + 1 < txStartIndices.length ? txStartIndices[idx + 1] : Math.min(blockStart + 30, lines.length);
    const block = lines.slice(blockStart, blockEnd);

    if (block.length < 4) continue;

    const dateMatch = block[0].match(dateRegex);
    if (!dateMatch) continue;
    const d = dateMatch[1], m = dateMatch[2], y = dateMatch[3];
    const txDate = y + '-' + padZero(m) + '-' + padZero(d);
    const txCode = block[2];

    // RB kategorie
    let rbCategory = '';
    for (let i = 0; i < block.length; i++) {
      if (knownRbCategories.indexOf(block[i]) !== -1) { rbCategory = block[i]; break; }
    }

    // Typ transakce
    let txType = '';
    for (let i = 0; i < block.length; i++) {
      if (typeKeywords.indexOf(block[i]) !== -1) { txType = block[i]; break; }
    }

    // Účet protistrany
    let accountNumber = '';
    for (let i = 0; i < block.length; i++) {
      if (accountRegex.test(block[i])) { accountNumber = block[i]; break; }
    }

    // Najdi částku
    let amount = null;
    for (let j = 0; j < block.length; j++) {
      const m2 = block[j].match(/^(-?[\d\s]+[.,]\d{2})\s+CZK$/);
      if (m2) {
        const v = parseFloat(m2[1].replace(/\s/g, '').replace(',', '.'));
        if (!isNaN(v)) { amount = v; break; }
      }
    }
    if (amount === null || amount === 0) continue;

    // Najdi popis obchodu (řádek se středníkem + 3 znaky velkými)
    let merchant = '';
    for (let j = block.length - 1; j >= 0; j--) {
      if (block[j].indexOf(';') !== -1 && /[A-Z]{3}$/.test(block[j])) {
        merchant = block[j];
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
      const knownTexts = ['ANETA BEITLEROVÁ', 'Aneta Beitlerová', 'Aneta Beitlerova']
        .concat(knownRbCategories).concat(typeKeywords);

      for (let j = 3; j < block.length; j++) {
        const c = block[j];
        if (!c) continue;
        if (knownTexts.indexOf(c) !== -1) continue;
        let skip = false;
        for (let k = 0; k < skipPatterns.length; k++) {
          if (skipPatterns[k].test(c)) { skip = true; break; }
        }
        if (skip) continue;
        merchant = c;
        break;
      }
    }

    if (!merchant) merchant = txType || rbCategory || 'Bez popisu';

    // Kategorizace
    const catResult = categorize(merchant + ' ' + txType, rbCategory, accountNumber, patterns, accounts);

    let normalizedType = 'expense';
    if (amount > 0) normalizedType = 'income';

    // Použij typ z účtu, pokud existuje
    let accountMatch = null;
    if (accountNumber) {
      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i].ucet === accountNumber) { accountMatch = accounts[i]; break; }
      }
    }
    if (accountMatch) {
      if (accountMatch.typ === 'Převod') normalizedType = 'transfer';
      else if (accountMatch.typ === 'Příjem') normalizedType = 'income';
    }

    // Extract merchant display name (first part before semicolon)
    let displayMerchant = merchant.split(';')[0].trim() || 'Bez popisu';
    if (accountMatch && accountMatch.nazev && (
      displayMerchant === 'Bez popisu' ||
      typeKeywords.indexOf(displayMerchant) !== -1 ||
      knownRbCategories.indexOf(displayMerchant) !== -1
    )) {
      displayMerchant = accountMatch.nazev;
    }

    // Finalizuj kategorii
    let category;
    if (normalizedType === 'income') {
      category = catResult.cat !== 'Nezařazeno' ? catResult.cat : 'Příjem';
    } else if (normalizedType === 'transfer') {
      category = 'Převod';
    } else {
      category = catResult.cat;
    }

    const merchantLower = merchant.toLowerCase();
    const subscriptionKeywords = ['netflix', 'spotify', 'apple.com/bill', 'youtube', 'hbo', 'adobe', 'anthropic', 'tv nova'];
    let isSubscription = false;
    for (let i = 0; i < subscriptionKeywords.length; i++) {
      if (merchantLower.indexOf(subscriptionKeywords[i]) !== -1) { isSubscription = true; break; }
    }

    transactions.push({
      id: txDate + '-' + txCode,
      date: txDate,
      amount: Math.abs(amount),
      isPositive: amount > 0,
      type: normalizedType,
      rbType: txType,
      rbCategory: rbCategory,
      accountNumber: accountNumber,
      merchant: displayMerchant,
      fullDescription: merchant,
      category: category,
      categorySource: catResult.source,
      isSubscription: isSubscription
    });
  }

  return transactions;
}

function padZero(n) {
  return (n.toString().length === 1) ? '0' + n : n.toString();
}

// ============================================================================
// Kontrola limitů + ntfy notifikace
// ============================================================================

function checkLimitsAndNotify(config, newTxCount) {
  try {
    const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/limits/check', {
      headers: { 'Authorization': 'Bearer ' + config.token },
      muteHttpExceptions: true
    });

    if (r.getResponseCode() !== 200) {
      Logger.log('⚠ /api/limits/check vrátil ' + r.getResponseCode());
      return;
    }

    const data = JSON.parse(r.getContentText());

    // Souhrn nahoru: kolik nových + jak na tom jsi celkově
    let summaryTitle = '💰 ' + newTxCount + ' nových transakcí';
    let summaryBody = 'Celkem za měsíc: ' + data.totalSpent.toLocaleString('cs-CZ') + ' / ' 
                    + data.totalLimit.toLocaleString('cs-CZ') + ' Kč (' + data.totalPercent + ' %)';
    
    let priority = 'default';
    let tags = 'moneybag';

    if (data.totalPercent >= 100) {
      priority = 'urgent';
      tags = 'rotating_light,money_with_wings';
      summaryTitle = '🚨 ' + summaryTitle + ' - PŘEKROČENÝ LIMIT';
    } else if (data.totalPercent >= 90) {
      priority = 'high';
      tags = 'warning';
      summaryTitle = '⚠️ ' + summaryTitle;
    }

    sendNtfy(config.ntfyTopic, summaryTitle, summaryBody, tags, priority);

    // Pro každou překročenou kategorii samostatná notifikace
    if (data.warnings && data.warnings.length > 0) {
      for (const w of data.warnings) {
        if (w.percent < 95) continue; // jen reálná překročení/dosažení
        
        const title = w.percent >= 105 
          ? '🚨 ' + w.category + ': ' + w.percent + ' % limitu'
          : '⚠️ ' + w.category + ': dosažen limit';
        const body = w.percent >= 105
          ? (w.roast || 'Vyčerpáno ' + w.spent.toLocaleString('cs-CZ') + ' z ' + w.limit.toLocaleString('cs-CZ') + ' Kč')
          : 'Vyčerpáno ' + w.spent.toLocaleString('cs-CZ') + ' z ' + w.limit.toLocaleString('cs-CZ') + ' Kč';
        const p = w.percent >= 105 ? 'urgent' : 'high';
        const t = w.percent >= 105 ? 'rotating_light,money_with_wings' : 'warning';
        
        sendNtfy(config.ntfyTopic, title, body, t, p);
        Utilities.sleep(500); // mezi notifikacemi malá pauza
      }
    }
  } catch (e) {
    Logger.log('❌ checkLimitsAndNotify: ' + e.message);
  }
}

function sendNtfy(topic, title, body, tags, priority) {
  if (!topic) return;
  const config = getConfig();
  if (!config.dashboardUrl || !config.token) {
    Logger.log('❌ ntfy: chybí dashboardUrl/token');
    return;
  }
  try {
    // Voláme přes dashboard proxy, protože Apps Script blokuje ntfy.sh přímo
    const response = UrlFetchApp.fetch(config.dashboardUrl + '/api/ntfy', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + config.token
      },
      payload: JSON.stringify({
        topic: topic,
        title: title,
        body: body,
        tags: tags || 'moneybag',
        priority: priority || 'default'
      }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      Logger.log('📱 ntfy: ' + title);
    } else {
      Logger.log('❌ ntfy proxy ' + response.getResponseCode() + ': ' + response.getContentText().substring(0, 200));
    }
  } catch (e) {
    Logger.log('❌ ntfy: ' + e.message);
  }
}

// ============================================================================
// Test funkce - manuální spuštění
// ============================================================================

function testConnection() {
  const config = getConfig();
  if (!config.dashboardUrl || !config.token) {
    Logger.log('❌ Chybí DASHBOARD_URL nebo DASHBOARD_TOKEN');
    return;
  }
  const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/transactions', {
    headers: { 'Authorization': 'Bearer ' + config.token },
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + r.getResponseCode());
  Logger.log('Body: ' + r.getContentText().substring(0, 500));
}

function testNtfy() {
  const config = getConfig();
  if (!config.ntfyTopic) {
    Logger.log('❌ Chybí NTFY_TOPIC');
    return;
  }
  sendNtfy(config.ntfyTopic, '🧪 Test notifikace', 'Funguje to! Apps Script ti posílá zprávy.', 'white_check_mark', 'default');
  Logger.log('✓ Test ntfy poslán. Mrkni do appky.');
}

function testCiselnik() {
  Logger.log('Stahuji číselník...');
  const c = fetchCiselnik();
  Logger.log('Patternů: ' + c.patterny.length);
  Logger.log('Účtů: ' + c.ucty.length);
  if (c.errors.length > 0) {
    Logger.log('Chyby: ' + c.errors.join(', '));
  }
  if (c.patterny.length > 0) {
    Logger.log('První 3 patterny:');
    for (let i = 0; i < 3 && i < c.patterny.length; i++) {
      Logger.log('  ' + c.patterny[i].pattern + ' → ' + c.patterny[i].cat);
    }
  }
}
