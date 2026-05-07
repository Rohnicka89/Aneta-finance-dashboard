# 💰 Anetin finanční dashboard

Osobní dashboard pro sledování výdajů z Raiffeisenbank účtu. Načítá PDF výpisy, kategorizuje transakce podle Google Sheets číselníku, hlídá limity a peprně pošťouchne, když utrácíš nad rámec.

**Stack:** Vite + React · Cloudflare Pages + D1 · Google Apps Script · ntfy notifikace · PWA

**Cena:** $0/měsíc (vše free tier)

---

## 🚀 Quickstart (15 minut)

### 1) Lokální dev (volitelné — pokud chceš nejdřív vyzkoušet)

```bash
npm install
npm run dev
# Otevře http://localhost:5173
# Backend nepoběží (chybí D1) → appka jede v lokálním režimu s localStorage
```

### 2) Deploy na Cloudflare Pages

#### Krok A: GitHub repo

1. Nahraj všechny soubory do `Aneta-finance-dashboard` repa (drag & drop přes web nebo `git push`)
2. Hotovo

#### Krok B: Cloudflare účet

1. Jdi na https://dash.cloudflare.com → vytvoř free účet (jen email, bez karty)
2. V dashboardu jdi na **Workers & Pages** v levém menu

#### Krok C: Vytvoř D1 databázi

1. Workers & Pages → **D1** → **Create database**
2. Název: `aneta-finance-db`
3. Region: nech default
4. Klikni **Create**
5. **Zkopíruj `Database ID`** (vypadá jako `abcd1234-...`)
6. Otevři `wrangler.toml` v repu, nahraď `PLACEHOLDER-ZÍSKÁŠ-PO-VYTVOŘENÍ-DB` tímto ID
7. Commit změnu

#### Krok D: Spusť migraci D1

```bash
npm install
npx wrangler login   # otevře prohlížeč, povolíš
npm run db:migrate:remote
```

Vytvoří tabulky `users`, `sessions`, `transactions`, `settings` ve tvé D1.

#### Krok E: Vytvoř Pages projekt

1. Workers & Pages → **Create** → **Pages** → **Connect to Git**
2. Vyber svoje GitHub repo `Aneta-finance-dashboard`
3. Build settings:
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. **Save and Deploy**

První build trvá ~2 minuty. Pak dostaneš URL typu `aneta-finance-dashboard-xyz.pages.dev`.

#### Krok F: Propoj D1 s Pages

1. Otevři svůj Pages projekt → **Settings** → **Functions** → **D1 database bindings**
2. **Add binding**:
   - Variable name: `DB`
   - D1 database: `aneta-finance-db`
3. **Save**
4. Vrať se na **Deployments**, klikni **Retry deployment** u posledního buildu (aby si binding načetl)

#### Krok G: Otestuj

1. Otevři `aneta-finance-dashboard-xyz.pages.dev`
2. **Nastav PIN** (4-6 číslic)
3. **Nahraj PDF výpis** z Raiffky
4. ✓ Hotovo!

---

## 📱 PWA install

### iPhone (Safari)
1. Otevři URL v Safari
2. Klikni na **Sdílet** (čtverec se šipkou nahoru)
3. **Přidat na plochu**
4. Příště otevíráš jako appku, ne web

### Macbook (Safari)
1. Otevři URL
2. Menu **File** → **Add to Dock**

### Chrome (Mac/iOS)
1. Pravý horní roh → ⋮ → **Install app**

---

## 📧 Fáze 3: Automatické čtení emailů (Apps Script)

Apps Script čte tvoje Gmail emaily od `info@rb.cz`, parsuje PDF přílohy a posílá data do dashboardu **bez tvého zásahu**.

### Nastavení (10 minut)

1. **Předpoklad:** Raiffka výpisy chodí na Gmail (nebo přeposíláš z iCloudu)

2. Jdi na https://script.google.com → **Nový projekt**

3. Smaž default kód, vlož obsah `apps-script/Code.gs`

4. **File → Project properties → Script properties**, přidej:
   - `DASHBOARD_URL` = `https://aneta-finance-dashboard-xyz.pages.dev` (tvoje Pages URL)
   - `DASHBOARD_TOKEN` = (viz níže)
   - `NTFY_TOPIC` = `aneta-finance-XXXX` (vlastní náhodný název pro ntfy)

5. **Získej DASHBOARD_TOKEN:**
   - Otevři dashboard v prohlížeči, přihlas se PINem
   - Cmd+Option+I (Developer Tools) → **Console**
   - Napiš: `localStorage.getItem('aneta_auth_token')`
   - Zkopíruj výsledek (bez uvozovek)

6. **Spusť funkci `setup`** jednou (ikona ▶)
   - Povolíš oprávnění (Google se zeptá)
   - Vytvoří se label `DASHBOARD-PROCESSED`

7. **Triggers** (ikona budíku vlevo) → **Add Trigger**:
   - Function: `processNewEmails`
   - Event source: `Time-driven`
   - Type: `Minute timer`
   - Interval: `Every 15 minutes`

8. **Hotovo!** Každých 15 minut Apps Script:
   - Najde nové emaily od `info@rb.cz`
   - Stáhne PDF
   - Pošle do dashboardu
   - Označí email jako zpracovaný

### ⚠️ Známé omezení této fáze

Server-side parsování PDF v Cloudflare Workers je komplikované. Pro plně automatický flow doporučuji:

**Variant A (jednodušší):** Apps Script PDF jen "uvítá", ty otevřeš dashboard a klikneš "Aktualizovat" — appka si všechny pending PDF stáhne a zpracuje.

**Variant B (pokročilejší):** Přepsat parser logiku z `src/lib/parser.js` do `apps-script/Code.gs` jako čistý JS bez pdf.js (Apps Script má jiné PDF nástroje). Pošle pak parsed transakce přímo.

Pro teď je Variant A doporučená — méně práce, stejný cíl.

---

## 🔔 ntfy notifikace na iPhone

1. Stáhni **ntfy** appku z App Store
2. V appce klikni **+** → **Subscribe to topic**
3. Topic name: stejný jako `NTFY_TOPIC` v Apps Script (např. `aneta-finance-XYZ123`)
4. **Hotovo** — když Apps Script zjistí překročení limitu, dostaneš push notifikaci

> 💡 Topic je *de facto* heslo. Komukoliv kdo zná název topicu může poslat notifikaci, takže si vyber **nehádatelný** název (např. `aneta-finance-h7k9p2m`).

---

## 🔧 Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (Frontend)                          │
│  - Vite + React PWA                         │
│  - PIN screen → Dashboard                   │
│  - Lokální cache v localStorage             │
└────────────────┬────────────────────────────┘
                 │ HTTPS
                 ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Pages                            │
│  - Statický hosting (HTML/JS/CSS)           │
│  - Pages Functions (backend API)            │
└────────────────┬────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│  Cloudflare D1 (SQLite)                      │
│  - users, sessions, transactions, settings  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Google Sheets (Číselník)                    │
│  - Patterny / Účty / Limity                 │
│  - Veřejně publikovaný CSV export           │
└────────────────┬────────────────────────────┘
                 │ fetch CSV
                 ▼
                Frontend přečte při startu

┌─────────────────────────────────────────────┐
│  Gmail + Apps Script (Fáze 3)                │
│  - Trigger every 15 min                     │
│  - Najde nové emaily → POST do Pages API    │
│  - Při překročení limitu → ntfy push        │
└─────────────────────────────────────────────┘
```

---

## 🗂 Struktura projektu

```
aneta-finance-dashboard/
├── src/
│   ├── App.jsx                    # Auth orchestrace
│   ├── main.jsx                   # Vstup
│   ├── components/
│   │   ├── PinScreen.jsx          # PIN obrazovka
│   │   └── Dashboard.jsx          # Hlavní UI
│   ├── lib/
│   │   ├── api.js                 # API klient + offline fallback
│   │   ├── ciselnik.js            # Google Sheets fetch
│   │   ├── parser.js              # Raiffka PDF parser
│   │   ├── categories.js          # Styly + kategorie
│   │   └── roasts.js              # Peprné notifikace
│   └── styles/
│       └── global.css
├── functions/                      # Cloudflare Pages Functions
│   ├── _shared/utils.js           # Auth helpers
│   └── api/
│       ├── auth/
│       │   ├── setup-status.js
│       │   ├── setup.js
│       │   └── login.js
│       ├── transactions/
│       │   ├── index.js           # GET/PUT/DELETE
│       │   └── upload-pdf.js      # POST z Apps Script
│       ├── settings/index.js      # GET/PUT
│       └── limits/check.js        # GET (pro Apps Script ntfy)
├── migrations/
│   └── 0001_init.sql              # D1 schéma
├── apps-script/
│   └── Code.gs                    # Gmail integrace
├── public/                         # PWA ikony
├── package.json
├── vite.config.js
├── wrangler.toml                   # Cloudflare config
└── README.md
```

---

## 🆘 Troubleshooting

### "Failed to fetch" pro Google Sheets

V production by to mělo fungovat. Pokud ne:
- Zkontroluj, že sheet je opravdu "Publikováno na webu" (ne jen sdíleno)
- Zkontroluj URL v `src/lib/ciselnik.js` (každý list jiné `gid`)

### PIN nefunguje

- Pokud máš v consoli error 401, smaž token: `localStorage.removeItem('aneta_auth_token')` a zkus znovu
- Pokud backend není dostupný, appka přepne na lokální PIN (uložený v prohlížeči)

### "Database not configured" v API

- D1 binding chybí. Vrať se ke **Kroku F** výše

### PDF parser nic nenajde

- Zkontroluj raw text v debug okně (klik na DEBUG po uploadu)
- Možná Raiffka změnila formát výpisu — pošli mi sample PDF

### Apps Script: "Authorization required"

- Při prvním běhu Google chce povolení. Klikni **Review permissions** → vyber účet → **Advanced** → **Go to (unsafe)** → **Allow**
- Tohle "unsafe" je proto, že tvůj script není veřejně publikovaný — je to OK pro tvoje vlastní skripty

---

## 📝 Poznámky pro vývoj

- **Lokální dev s D1:** `npx wrangler pages dev dist --d1 DB` (po `npm run build`)
- **Test PDF parseru:** Otevři dashboard v dev modu, nahraj PDF, klikni DEBUG pro raw text
- **Debug API:** Network tab v Developer Tools, response 401 = nesprávný token
- **Reset všeho:** D1 → drop tables → znovu migrace; localStorage → `localStorage.clear()`

---

## 📜 License

Soukromý projekt. Neveřejný.
