/**
 * GitHub Action skript: Zpracování Raiffka PDF výpisů
 * 
 * Spouští se přes repository_dispatch (Apps Script pošle PDF jako payload)
 * nebo manuálně z GitHub Actions UI.
 * 
 * Argumenty jsou v ENV:
 *   PDF_BASE64         - base64 PDF dat (nebo PDF_BASE64_LIST jako JSON array)
 *   DASHBOARD_URL      - URL dashboardu
 *   DASHBOARD_TOKEN    - auth token pro Cloudflare API
 *   NTFY_TOPIC         - ntfy topic name (volitelné)
 *   NTFY_TOKEN         - ntfy access token (volitelné)
 */

import { fetchCiselnik, parseRaiffkaText } from './parser-node.js';

// pdfjs-dist v3.11.174 je CommonJS - musíme přes dynamic import + .default
const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.js');
const pdfjsLib = pdfjsModule.default || pdfjsModule;

// Vypnout worker (Node.js prostředí nemá Web Worker)
pdfjsLib.GlobalWorkerOptions.workerSrc = null;

async function extractPdfText(pdfBuffer) {
  // V Node.js prostředí
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdf = await pdfjsLib.getDocument({
    data: uint8Array,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;
  
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join('\n');
    fullText += pageText + '\n';
  }
  return fullText;
}

async function uploadTransactions(transactions, config) {
  const r = await fetch(`${config.dashboardUrl}/api/transactions/upload-pdf`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      filename: 'github-action-batch',
      parsedTransactions: transactions
    })
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`API ${r.status}: ${text.substring(0, 300)}`);
  }

  return r.json();
}

async function checkLimitsAndNotify(config, newCount) {
  if (!config.ntfyTopic) return;

  try {
    const r = await fetch(`${config.dashboardUrl}/api/limits/check`, {
      headers: { 'Authorization': `Bearer ${config.token}` }
    });
    
    if (!r.ok) return;
    const data = await r.json();

    // Hlavní souhrn
    let title = `💰 ${newCount} ${newCount === 1 ? 'nová transakce' : newCount < 5 ? 'nové transakce' : 'nových transakcí'}`;
    let body = `Celkem za měsíc: ${data.totalSpent.toLocaleString('cs-CZ')} / ${data.totalLimit.toLocaleString('cs-CZ')} Kč (${data.totalPercent} %)`;
    let priority = 'default';
    let tags = 'moneybag';

    if (data.totalPercent >= 100) {
      priority = 'urgent';
      tags = 'rotating_light,money_with_wings';
      title = '🚨 ' + title + ' — PŘEKROČEN LIMIT';
    } else if (data.totalPercent >= 90) {
      priority = 'high';
      tags = 'warning';
      title = '⚠️ ' + title;
    }

    await sendNtfy(config, title, body, tags, priority);

    // Varování pro každou kategorii
    if (data.warnings) {
      for (const w of data.warnings) {
        if (w.percent < 95) continue;
        const t = w.percent >= 105
          ? `🚨 ${w.category}: ${w.percent} % limitu`
          : `⚠️ ${w.category}: dosažen limit`;
        const b = `Vyčerpáno ${w.spent.toLocaleString('cs-CZ')} z ${w.limit.toLocaleString('cs-CZ')} Kč`;
        const p = w.percent >= 105 ? 'urgent' : 'high';
        const tg = w.percent >= 105 ? 'rotating_light,money_with_wings' : 'warning';
        await sendNtfy(config, t, b, tg, p);
        await new Promise(res => setTimeout(res, 500));
      }
    }
  } catch (e) {
    console.error('checkLimitsAndNotify error:', e.message);
  }
}

async function sendNtfy(config, title, body, tags, priority) {
  if (!config.ntfyTopic) return;
  try {
    const r = await fetch(`${config.dashboardUrl}/api/ntfy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        topic: config.ntfyTopic,
        title,
        body,
        tags,
        priority
      })
    });
    if (r.ok) {
      console.log(`📱 ntfy: ${title}`);
    } else {
      const t = await r.text();
      console.error(`ntfy failed (${r.status}): ${t.substring(0, 200)}`);
    }
  } catch (e) {
    console.error('ntfy error:', e.message);
  }
}

async function main() {
  console.log('=== Aneta Finance Bot - GitHub Action ===');
  console.log('Time:', new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }));

  // Načti konfiguraci z ENV
  const config = {
    dashboardUrl: process.env.DASHBOARD_URL,
    token: process.env.DASHBOARD_TOKEN,
    ntfyTopic: process.env.NTFY_TOPIC,
  };

  if (!config.dashboardUrl || !config.token) {
    console.error('❌ Missing DASHBOARD_URL or DASHBOARD_TOKEN');
    process.exit(1);
  }

  // Načti PDFka - buď single (PDF_BASE64) nebo list (PDF_BASE64_LIST jako JSON array)
  let pdfsBase64 = [];
  if (process.env.PDF_BASE64_LIST) {
    try {
      pdfsBase64 = JSON.parse(process.env.PDF_BASE64_LIST);
      console.log(`Loaded ${pdfsBase64.length} PDFs from PDF_BASE64_LIST`);
    } catch (e) {
      console.error('❌ PDF_BASE64_LIST není validní JSON:', e.message);
      process.exit(1);
    }
  } else if (process.env.PDF_BASE64) {
    pdfsBase64 = [{ filename: process.env.PDF_FILENAME || 'statement.pdf', data: process.env.PDF_BASE64 }];
    console.log('Loaded 1 PDF from PDF_BASE64');
  } else {
    console.error('❌ Missing PDF_BASE64 or PDF_BASE64_LIST');
    process.exit(1);
  }

  // Načti číselník
  console.log('Stahuji číselník...');
  const ciselnik = await fetchCiselnik();
  console.log(`  Patternů: ${ciselnik.patterny.length}, Účtů: ${ciselnik.ucty.length}`);
  if (ciselnik.errors.length > 0) {
    console.warn('  Chyby:', ciselnik.errors);
  }

  // Zpracuj všechny PDFka
  let allTransactions = [];
  let errors = [];

  for (const pdfInfo of pdfsBase64) {
    const { filename, data } = pdfInfo;
    console.log(`\n📄 Zpracovávám ${filename}...`);
    
    try {
      const buffer = Buffer.from(data, 'base64');
      console.log(`  Velikost: ${Math.round(buffer.length / 1024)} KB`);
      
      const text = await extractPdfText(buffer);
      console.log(`  Text: ${text.length} znaků, ${text.split('\n').length} řádků`);
      
      const transactions = parseRaiffkaText(text, ciselnik.patterny, ciselnik.ucty);
      console.log(`  ✓ Rozpoznáno ${transactions.length} transakcí`);
      
      allTransactions.push(...transactions);
    } catch (err) {
      console.error(`  ❌ ${filename}: ${err.message}`);
      errors.push(`${filename}: ${err.message}`);
    }
  }

  if (allTransactions.length === 0) {
    console.log('\n⚠️ Žádné transakce nerozpoznány. Nic neuploaduju.');
    if (errors.length > 0 && config.ntfyTopic) {
      await sendNtfy(config, 'Dashboard: chyba', errors.join('\n').substring(0, 200), 'warning', 'high');
    }
    process.exit(errors.length > 0 ? 1 : 0);
  }

  // Upload do D1
  console.log(`\nUploaduji ${allTransactions.length} transakcí do D1...`);
  const uploadResult = await uploadTransactions(allTransactions, config);
  const newCount = uploadResult.newCount || 0;
  const dupCount = (uploadResult.totalCount || allTransactions.length) - newCount;
  console.log(`✓ ${newCount} nových, ${dupCount} duplikátů`);

  // Notifikace
  if (newCount > 0) {
    await checkLimitsAndNotify(config, newCount);
  } else {
    console.log('Žádné nové transakce, notifikace se neposílá.');
  }

  console.log('\n=== Hotovo ===');
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
