-- Anetin Finance Dashboard - D1 schéma
-- Spuštění: npm run db:migrate (lokálně) nebo npm run db:migrate:remote (do prod)

-- Tabulka uživatelů (jen 1 uživatel = Aneta)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  last_login INTEGER
);

-- Aktivní session tokeny
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Všechny transakce
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  is_positive INTEGER NOT NULL,
  type TEXT NOT NULL,
  rb_type TEXT,
  rb_category TEXT,
  account_number TEXT,
  merchant TEXT,
  full_description TEXT,
  category TEXT NOT NULL,
  category_source TEXT,
  is_subscription INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);

-- Nastavení (limity, totalLimit)
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY,
  total_limit REAL DEFAULT 35000,
  category_limits TEXT DEFAULT '{}',
  ntfy_topic TEXT,
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
