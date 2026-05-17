/**
 * Anetin Finance Dashboard - Gmail → GitHub Actions Bridge
 * =========================================================
 * 
 * Tento skript pouze:
 *   1. Najde v Gmailu nové výpisy z Raiffeisenbank (přeposlané z iCloud)
 *   2. Stáhne PDF přílohy jako base64
 *   3. POSTne je do GitHub Actions přes repository_dispatch
 *   4. Označí emaily jako "DASHBOARD-PROCESSED"
 * 
 * Veškerou logiku (PDF parsing, kategorizace, upload do D1, ntfy) 
 * dělá GitHub Action - používá stejný pdf.js a parser jako web appka.
 * 
 * Setup:
 *   1. Script properties:
 *      - GITHUB_TOKEN: Personal Access Token (s 'repo' scope)
 *      - GITHUB_OWNER: tvuj GitHub username (Rohnicka89)
 *      - GITHUB_REPO: jmeno repa (Aneta-finance-dashboard)
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
    githubToken: props.getProperty('GITHUB_TOKEN'),
    owner: props.getProperty('GITHUB_OWNER'),
    repo: props.getProperty('GITHUB_REPO')
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
  if (!config.githubToken) missing.push('GITHUB_TOKEN');
  if (!config.owner) missing.push('GITHUB_OWNER');
  if (!config.repo) missing.push('GITHUB_REPO');

  if (missing.length > 0) {
    Logger.log('❌ NUTNO NASTAVIT v Project Settings → Script properties:');
    missing.forEach(function(p) { Logger.log('   - ' + p); });
    Logger.log('\nGITHUB_TOKEN získáš na github.com/settings/tokens (Personal Access Token, scope: repo)');
    return;
  }

  Logger.log('✓ Konfigurace OK');
  Logger.log('  GitHub: ' + config.owner + '/' + config.repo);
  Logger.log('  Token: ' + config.githubToken.substring(0, 12) + '...');

  try {
    const url = 'https://api.github.com/repos/' + config.owner + '/' + config.repo;
    const r = UrlFetchApp.fetch(url, {
      headers: {
        'Authorization': 'token ' + config.githubToken,
        'Accept': 'application/vnd.github.v3+json'
      },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) {
      const repoData = JSON.parse(r.getContentText());
      Logger.log('✓ GitHub připojení OK. Repo: ' + repoData.full_name);
    } else {
      Logger.log('⚠ GitHub vrátil ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
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
  if (!config.githubToken || !config.owner || !config.repo) {
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

  const pdfs = [];
  const processedThreads = [];

  for (const thread of threads) {
    const messages = thread.getMessages();
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
        const base64 = Utilities.base64Encode(pdf.getBytes());
        pdfs.push({
          filename: pdf.getName(),
          data: base64
        });
        Logger.log('  📄 ' + pdf.getName() + ' (' + Math.round(pdf.getSize()/1024) + ' KB)');
      }
    }
    processedThreads.push(thread);
  }

  if (pdfs.length === 0) {
    Logger.log('Žádné PDFka ke zpracování.');
    return;
  }

  Logger.log('\nPosílám ' + pdfs.length + ' PDFek do GitHub Actions...');

  try {
    const url = 'https://api.github.com/repos/' + config.owner + '/' + config.repo + '/dispatches';
    const r = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'token ' + config.githubToken,
        'Accept': 'application/vnd.github.v3+json'
      },
      payload: JSON.stringify({
        event_type: 'process-statements',
        client_payload: {
          pdfs: pdfs,
          timestamp: new Date().toISOString()
        }
      }),
      muteHttpExceptions: true
    });

    if (r.getResponseCode() === 204) {
      Logger.log('✓ GitHub Action triggered');
      
      for (const thread of processedThreads) {
        thread.addLabel(label);
        const messages = thread.getMessages();
        for (const message of messages) {
          message.markRead();
        }
      }
      Logger.log('✓ ' + processedThreads.length + ' emailů označeno jako processed');
    } else {
      Logger.log('❌ GitHub vrátil ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
      Logger.log('Emaily zůstávají neoznčené - skript je při dalším běhu zkusí znovu.');
    }
  } catch (e) {
    Logger.log('❌ Chyba: ' + e.message);
  }

  const duration = Math.round((new Date() - startTime) / 1000);
  Logger.log('\n=== Hotovo za ' + duration + 's ===');
}

// ============================================================================
// Test funkce
// ============================================================================

function testGitHubConnection() {
  const config = getConfig();
  if (!config.githubToken) {
    Logger.log('❌ Chybí GITHUB_TOKEN');
    return;
  }
  const url = 'https://api.github.com/repos/' + config.owner + '/' + config.repo;
  const r = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'token ' + config.githubToken,
      'Accept': 'application/vnd.github.v3+json'
    },
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + r.getResponseCode());
  if (r.getResponseCode() === 200) {
    const d = JSON.parse(r.getContentText());
    Logger.log('Repo: ' + d.full_name);
    Logger.log('Default branch: ' + d.default_branch);
  } else {
    Logger.log('Error: ' + r.getContentText().substring(0, 500));
  }
}

function testDispatch() {
  const config = getConfig();
  if (!config.githubToken) { Logger.log('❌ Chybí GITHUB_TOKEN'); return; }

  const url = 'https://api.github.com/repos/' + config.owner + '/' + config.repo + '/dispatches';
  const r = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'token ' + config.githubToken,
      'Accept': 'application/vnd.github.v3+json'
    },
    payload: JSON.stringify({
      event_type: 'process-statements',
      client_payload: {
        pdfs: [],
        test: true
      }
    }),
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + r.getResponseCode());
  Logger.log('Response: ' + r.getContentText().substring(0, 200));
  if (r.getResponseCode() === 204) {
    Logger.log('✓ Dispatch poslán. Mrkni v GitHubu na Actions tab.');
  }
}
