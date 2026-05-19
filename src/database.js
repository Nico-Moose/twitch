const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "bot.db");

// Удаляем старую базу если нет нужных колонок
if (fs.existsSync(dbPath)) {
  try {
    const testDb = new Database(dbPath);
    const cols = testDb.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
    testDb.close();
    if (!cols.includes("status")) {
      fs.unlinkSync(dbPath);
      console.log("[DB] Старая база удалена");
    }
  } catch (e) {
    fs.unlinkSync(dbPath);
  }
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL,
    token TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    status TEXT DEFAULT 'offline',
    phase TEXT DEFAULT 'idle',
    next_action INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const defaults = {
  channel: "",
  join_interval: "3",
  running: "0",
};
for (const [key, value] of Object.entries(defaults)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

module.exports = {
  getAccounts: () => db.prepare("SELECT * FROM accounts ORDER BY id").all(),
  getEnabledAccounts: () => db.prepare("SELECT * FROM accounts WHERE enabled = 1 ORDER BY id").all(),
  getAccountCount: () => db.prepare("SELECT COUNT(*) as cnt FROM accounts").get().cnt,
  getAccountById: (id) => db.prepare("SELECT * FROM accounts WHERE id = ?").get(id),
  addAccount: (login, token) => db.prepare("INSERT INTO accounts (login, token) VALUES (?, ?)").run(login, token),
  deleteAccount: (id) => db.prepare("DELETE FROM accounts WHERE id = ?").run(id),
  setStatus: (id, status) => db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id),
  setPhase: (id, phase, nextAction) => db.prepare("UPDATE accounts SET phase = ?, next_action = ? WHERE id = ?").run(phase, nextAction, id),
  resetAll: () => db.prepare("UPDATE accounts SET status = 'offline', phase = 'idle', next_action = 0").run(),

  getSetting: (key) => { const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key); return r ? r.value : ""; },
  setSetting: (key, value) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value),
  getAllSettings: () => { const rows = db.prepare("SELECT * FROM settings").all(); const o = {}; rows.forEach(r => o[r.key] = r.value); return o; },

  addLog: (type, msg) => { db.prepare("INSERT INTO logs (type, message) VALUES (?, ?)").run(type, msg); db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 100)").run(); },
  getLogs: (limit) => db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit || 50),
};
