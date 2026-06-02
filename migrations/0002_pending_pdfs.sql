-- Fronta PDF výpisů přijatých z Apps Scriptu, čekajících na import přes browser
CREATE TABLE IF NOT EXISTS pending_pdfs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
