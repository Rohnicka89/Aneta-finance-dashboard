/**
 * Anetin Finance Dashboard - Gmail → Cloudflare Bridge
 * =====================================================
 *
 * Tento skript pouze:
 *   1. Najde v Gmailu nové výpisy z Raiffeisenbank (přeposlané z iCloud)
 *   2. Stáhne PDF přílohy jako base64
 *   3. POSTne každé PDF do Cloudflare endpointu /api/pending-pdfs
 *   4. Označí emaily jako "DASHBOARD-PROCESSED"
 *   5. (volitelně) Pošle ntfy notifikaci "Nový výpis čeká na import"
 *
 * Vlastní zpracování (PDF parsing, kategorizace, upload do D1) dělá
 * dashboard v prohlížeči - Aneta ráno otevře appku, klikne "Naimportovat"
 * a parser.js (pdf.js) spolehlivě zpracuje výpis. Single source of truth.
 *
 * Proč ne GitHub Actions? repository_dispatch má limit ~64 KB na payload,
 * base64 PDF je ~92 KB. Cloudflare endpoint takový limit nemá.
 *
 * Setup:
 *   1. Script properties:
 *      - DASHBOARD_URL: https://aneta-finance-dashboard.pages.dev
 *      - DASHBOARD_TOKEN: Anetin dashboard token (z localStorage po PIN loginu)
 *      - NTFY_TOPIC: aneta-fin-saf4kond (volitelné, pro notifikaci)
 *   2. Spusť setup() jednou pro vytvoření labelu
 *   3. Nastav trigger: processNewEmails každý den ráno
 */

// ============================================================================
// KONFIGURACE
// ============================================================================

const SUBJECT_FILTER = 'Výpis z účtu';
const FORWARDED_FROM = 'info@rb.cz';
const PROCESSED_LABEL = 'DASHBOARD-PROCESSED';
const MAX_EMAILS_PER_RUN = 10;
const SEARCH_DAYS = 7;

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    dashboardUrl: (props.getProperty('DASHBOARD_URL') || '').replace(/\/$/, ''),
    dashboardToken: props.getProperty('DASHBOARD_TOKEN'),
    ntfyTopic: props.getProperty('NTFY_TOPIC')
  };
}

// ============================================================================
// SETUP - spusť JEDNOU manuálně
// ============================================================================

function setup() {
  const config = getConfig();

  let label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(PROCESSED_LABEL);
    Logger.log('✓ Vytvořen label: ' + PROCESSED_LABEL);
  } else {
    Logger.log('✓ Label už existuje: ' + PROCESSED_LABEL);
  }

  const missing = [];
  if (!config.dashboardUrl) missing.push('DASHBOARD_URL');
  if (!config.dashboardToken) missing.push('DASHBOARD_TOKEN');

  if (missing.length > 0) {
    Logger.log('❌ NUTNO NASTAVIT v Project Settings → Script properties:');
    missing.forEach(function(p) { Logger.log('   - ' + p); });
    Logger.log('\nDASHBOARD_URL = https://aneta-finance-dashboard.pages.dev');
    Logger.log('DASHBOARD_TOKEN = token z localStorage (aneta_auth_token) po PIN loginu');
    return;
  }

  Logger.log('✓ Konfigurace OK');
  Logger.log('  Dashboard: ' + config.dashboardUrl);
  Logger.log('  Token: ' + config.dashboardToken.substring(0, 12) + '...');
  if (config.ntfyTopic) Logger.log('  ntfy topic: ' + config.ntfyTopic);

  // Ověř spojení - GET /api/pending-pdfs (vrátí seznam, prázdný je OK)
  try {
    const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/pending-pdfs', {
      headers: { 'Authorization': 'Bearer ' + config.dashboardToken },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) {
      const data = JSON.parse(r.getContentText());
      Logger.log('✓ Dashboard připojení OK. Čekajících PDF: ' + (data.pdfs ? data.pdfs.length : 0));
    } else if (r.getResponseCode() === 401) {
      Logger.log('❌ Dashboard vrátil 401 Unauthorized - zkontroluj DASHBOARD_TOKEN.');
    } else {
      Logger.log('⚠ Dashboard vrátil ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    }
  } catch (e) {
    Logger.log('❌ Chyba: ' + e.message);
  }
}

// ============================================================================
// HLAVNÍ FUNKCE
// ============================================================================

function processNewEmails() {
  const startTime = new Date();
  Logger.log('=== Spuštěno: ' + startTime.toLocaleString('cs-CZ') + ' ===');

  const config = getConfig();
  if (!config.dashboardUrl || !config.dashboardToken) {
    Logger.log('❌ Chybí konfigurace. Spusť setup().');
    return;
  }

  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    Logger.log('❌ Chybí Gmail label. Spusť setup().');
    return;
  }

  const query = 'from:' + FORWARDED_FROM + ' subject:"' + SUBJECT_FILTER + '" -label:' + PROCESSED_LABEL + ' has:attachment newer_than:' + SEARCH_DAYS + 'd';
  const threads = GmailApp.search(query, 0, MAX_EMAILS_PER_RUN);

  Logger.log('Hledám: ' + query);
  Logger.log('Nalezeno ' + threads.length + ' nezpracovaných emailů');

  if (threads.length === 0) {
    Logger.log('Žádné nové emaily.');
    return;
  }

  let uploadedCount = 0;
  const uploadedNames = [];

  for (const thread of threads) {
    const messages = thread.getMessages();
    let threadHadPdf = false;
    let threadAllOk = true;

    for (const message of messages) {
      const attachments = message.getAttachments();
      const messagePdfs = attachments.filter(function(a) {
        return a.getName().toLowerCase().indexOf('.pdf') !== -1;
      });

      if (messagePdfs.length === 0) {
        Logger.log('⚠ Email "' + message.getSubject().substring(0, 50) + '" nemá PDF');
        continue;
      }

      for (const pdf of messagePdfs) {
        threadHadPdf = true;
        const base64 = Utilities.base64Encode(pdf.getBytes());
        const ok = uploadPending(config, pdf.getName(), base64);
        if (ok) {
          uploadedCount++;
          uploadedNames.push(pdf.getName());
          Logger.log('  ✓ ' + pdf.getName() + ' (' + Math.round(pdf.getSize()/1024) + ' KB) → pending');
        } else {
          threadAllOk = false;
          Logger.log('  ❌ ' + pdf.getName() + ' upload selhal');
        }
      }
    }

    // Označ thread jako processed jen pokud všechna jeho PDF prošla
    if (threadHadPdf && threadAllOk) {
      thread.addLabel(label);
      const messages2 = thread.getMessages();
      for (const m of messages2) m.markRead();
    } else if (!threadAllOk) {
      Logger.log('⚠ Thread neoznačen (některé PDF selhalo) - zkusí se znovu příště.');
    }
  }

  Logger.log('\n✓ Nahráno ' + uploadedCount + ' PDF do fronty.');

  // Volitelná notifikace
  if (uploadedCount > 0 && config.ntfyTopic) {
    sendNtfy(config,
      '📥 ' + uploadedCount + ' ' + (uploadedCount === 1 ? 'nový výpis' : 'nových výpisů'),
      'Otevři dashboard a klikni na import: ' + uploadedNames.join(', '));
  }

  const duration = Math.round((new Date() - startTime) / 1000);
  Logger.log('\n=== Hotovo za ' + duration + 's ===');
}

// ============================================================================
// HELPERY
// ============================================================================

function uploadPending(config, filename, base64) {
  try {
    const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/pending-pdfs', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + config.dashboardToken },
      payload: JSON.stringify({ filename: filename, data: base64 }),
      muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) return true;
    Logger.log('    Dashboard vrátil ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    return false;
  } catch (e) {
    Logger.log('    Chyba uploadu: ' + e.message);
    return false;
  }
}

// ntfy přes Cloudflare proxy (/api/ntfy přidá Authorization s NTFY_TOKEN)
// POZN: endpoint očekává pole "body" pro text zprávy (ne "message")
function sendNtfy(config, title, message) {
  try {
    const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/ntfy', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + config.dashboardToken },
      payload: JSON.stringify({ topic: config.ntfyTopic, title: title, body: message }),
      muteHttpExceptions: true
    });
    Logger.log('  ntfy status: ' + r.getResponseCode());
  } catch (e) {
    Logger.log('  ntfy chyba: ' + e.message);
  }
}

// ============================================================================
// Test funkce
// ============================================================================

function testDashboardConnection() {
  const config = getConfig();
  if (!config.dashboardToken) { Logger.log('❌ Chybí DASHBOARD_TOKEN'); return; }
  const r = UrlFetchApp.fetch(config.dashboardUrl + '/api/pending-pdfs', {
    headers: { 'Authorization': 'Bearer ' + config.dashboardToken },
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + r.getResponseCode());
  Logger.log('Response: ' + r.getContentText().substring(0, 300));
}

function testNtfy() {
  const config = getConfig();
  if (!config.ntfyTopic) { Logger.log('❌ Chybí NTFY_TOPIC'); return; }
  sendNtfy(config, '🧪 Test', 'Notifikace z Apps Scriptu funguje.');
}
