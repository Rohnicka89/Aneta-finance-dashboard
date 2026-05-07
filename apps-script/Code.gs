/**
 * Anetin Finance Dashboard - Gmail integrace
 *
 * Co tento skript dělá:
 * 1. Hledá nové emaily od info@rb.cz s předmětem "Výpis z účtu"
 * 2. Stáhne PDF přílohu
 * 3. Pošle PDF do dashboard backendu (POST /api/transactions/upload-pdf)
 * 4. Po úspěšném zpracování označí email jako přečtený a přidá label "DASHBOARD-PROCESSED"
 *
 * Nastavení:
 * 1. Otevři script.google.com → Nový projekt
 * 2. Vlož celý kód
 * 3. V SCRIPT_PROPERTIES nastav:
 *    - DASHBOARD_URL = https://aneta-finance-dashboard.pages.dev
 *    - DASHBOARD_TOKEN = (token získaný z dashboardu po PIN přihlášení)
 *    - NTFY_TOPIC = aneta-finance-XXXX (volitelné, pro notifikace)
 * 4. Spusť funkci `setup` JEDNOU (vytvoří label + povolí oprávnění)
 * 5. V Triggers nastav `processNewEmails` na "Time-driven" → "Every 15 minutes"
 *
 * Jak získat DASHBOARD_TOKEN:
 * 1. Otevři dashboard, přihlas se PINem
 * 2. V prohlížeči otevři Developer Console (Cmd+Option+I)
 * 3. Console: localStorage.getItem('aneta_auth_token')
 * 4. Zkopíruj výsledek (bez uvozovek)
 */

// =============================================================================
// KONFIGURACE - tyto hodnoty se čtou z Script Properties (bezpečnější)
// =============================================================================

const SENDER = 'info@rb.cz';
const SUBJECT_FILTER = 'Výpis z účtu';
const PROCESSED_LABEL = 'DASHBOARD-PROCESSED';
const MAX_EMAILS_PER_RUN = 10;

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    dashboardUrl: props.getProperty('DASHBOARD_URL'),
    token: props.getProperty('DASHBOARD_TOKEN'),
    ntfyTopic: props.getProperty('NTFY_TOPIC')
  };
}

// =============================================================================
// SETUP - spustit JEDNOU manuálně po vytvoření skriptu
// =============================================================================

function setup() {
  // Vytvoř label, pokud neexistuje
  let label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(PROCESSED_LABEL);
    Logger.log('✓ Vytvořen label: ' + PROCESSED_LABEL);
  } else {
    Logger.log('✓ Label už existuje: ' + PROCESSED_LABEL);
  }

  const config = getConfig();
  if (!config.dashboardUrl || !config.token) {
    Logger.log('⚠️ NUTNO NASTAVIT v File → Project properties → Script properties:');
    Logger.log('  - DASHBOARD_URL = https://...');
    Logger.log('  - DASHBOARD_TOKEN = (z prohlížeče)');
  } else {
    Logger.log('✓ Konfigurace OK');
    Logger.log('  Dashboard URL: ' + config.dashboardUrl);
  }
}

// =============================================================================
// HLAVNÍ FUNKCE - spouští se trigger každých 15 minut
// =============================================================================

function processNewEmails() {
  const config = getConfig();
  if (!config.dashboardUrl || !config.token) {
    Logger.log('❌ Konfigurace chybí. Spusť setup() a nastav properties.');
    return;
  }

  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    Logger.log('❌ Label chybí. Spusť nejdřív setup().');
    return;
  }

  // Vyhledávací dotaz: nové emaily od Raiffky bez našeho labelu
  const query = `from:${SENDER} subject:"${SUBJECT_FILTER}" -label:${PROCESSED_LABEL} has:attachment newer_than:7d`;
  const threads = GmailApp.search(query, 0, MAX_EMAILS_PER_RUN);

  Logger.log(`Nalezeno ${threads.length} nezpracovaných emailů`);

  let totalNewTransactions = 0;
  let errors = 0;

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const message of messages) {
      try {
        const result = processMessage(message, config);
        totalNewTransactions += result.newCount || 0;
        thread.addLabel(label);
        message.markRead();
      } catch (err) {
        Logger.log(`❌ Chyba u emailu "${message.getSubject()}": ${err.message}`);
        errors++;
      }
    }
  }

  Logger.log(`✓ Hotovo. Nových transakcí: ${totalNewTransactions}, chyb: ${errors}`);

  // Po načtení dat zkontroluj limity a pošli notifikaci
  if (totalNewTransactions > 0 && config.ntfyTopic) {
    checkLimitsAndNotify(config);
  }
}

// =============================================================================
// Zpracování jednotlivého emailu
// =============================================================================

function processMessage(message, config) {
  const attachments = message.getAttachments();
  const pdfs = attachments.filter(a => a.getName().toLowerCase().endsWith('.pdf'));

  if (pdfs.length === 0) {
    Logger.log(`⚠️  Email "${message.getSubject()}" nemá PDF přílohu`);
    return { newCount: 0 };
  }

  let totalNew = 0;
  for (const pdf of pdfs) {
    Logger.log(`📄 Zpracovávám: ${pdf.getName()} (${Math.round(pdf.getSize()/1024)} KB)`);
    
    // Pošleme PDF jako base64 do dashboardu
    const base64 = Utilities.base64Encode(pdf.getBytes());
    
    const response = UrlFetchApp.fetch(`${config.dashboardUrl}/api/transactions/upload-pdf`, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': `Bearer ${config.token}`
      },
      payload: JSON.stringify({
        filename: pdf.getName(),
        pdfBase64: base64
      }),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(`Backend vrátil ${code}: ${response.getContentText().substring(0, 200)}`);
    }

    const data = JSON.parse(response.getContentText());
    Logger.log(`  ✓ Načteno ${data.newCount} nových transakcí (z ${data.totalCount})`);
    totalNew += (data.newCount || 0);
  }

  return { newCount: totalNew };
}

// =============================================================================
// Notifikace přes ntfy
// =============================================================================

function checkLimitsAndNotify(config) {
  try {
    const response = UrlFetchApp.fetch(`${config.dashboardUrl}/api/limits/check`, {
      headers: {
        'Authorization': `Bearer ${config.token}`
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) return;
    
    const data = JSON.parse(response.getContentText());
    if (!data.warnings || data.warnings.length === 0) return;

    // Pošli ntfy notifikaci pro každé varování
    for (const w of data.warnings) {
      const title = `${w.category}: ${w.percent}% limitu`;
      const body = w.roast || `Vyčerpáno ${w.spent}/${w.limit} Kč`;
      
      UrlFetchApp.fetch(`https://ntfy.sh/${config.ntfyTopic}`, {
        method: 'post',
        payload: body,
        headers: {
          'Title': title,
          'Priority': w.percent >= 100 ? 'urgent' : 'high',
          'Tags': w.percent >= 100 ? 'rotating_light,money_with_wings' : 'warning'
        }
      });
      Logger.log(`📱 Notifikace: ${title}`);
    }
  } catch (e) {
    Logger.log(`⚠️ Notifikace selhala: ${e.message}`);
  }
}

// =============================================================================
// Pro testování - spusť manuálně z editoru
// =============================================================================

function testConnection() {
  const config = getConfig();
  if (!config.dashboardUrl || !config.token) {
    Logger.log('❌ Nastav DASHBOARD_URL a DASHBOARD_TOKEN');
    return;
  }
  const response = UrlFetchApp.fetch(`${config.dashboardUrl}/api/transactions`, {
    headers: { 'Authorization': `Bearer ${config.token}` },
    muteHttpExceptions: true
  });
  Logger.log(`Status: ${response.getResponseCode()}`);
  Logger.log(`Body: ${response.getContentText().substring(0, 500)}`);
}
