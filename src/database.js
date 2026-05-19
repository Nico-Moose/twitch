const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// Создаём папку data если нет
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "bot.db"));
db.pragma("journal_mode = WAL");

// Создаём таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL,
    token TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    status TEXT DEFAULT 'отключен',
    queue_action TEXT DEFAULT NULL,
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

// Настройки по умолчанию
const defaults = {
  channel: "",
  auto_rejoin: "0",
  rejoin_interval: "30",
  auto_follow: "0",
};

for (const [key, value] of Object.entries(defaults)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

module.exports = {
  // Аккаунты
  getAccounts() {
    return db.prepare("SELECT * FROM accounts ORDER BY id").all();
  },

  getEnabledAccounts() {
    return db.prepare("SELECT * FROM accounts WHERE enabled = 1 ORDER BY id").all();
  },

  getAccountCount() {
    return db.prepare("SELECT COUNT(*) as cnt FROM accounts").get().cnt;
  },

  addAccount(login, token) {
    return db.prepare("INSERT INTO accounts (login, token) VALUES (?, ?)").run(login, token);
  },

  deleteAccount(id) {
    return db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  },

  toggleAccount(id, enabled) {
    return db.prepare("UPDATE accounts SET enabled = ? WHERE id = ?").run(enabled, id);
  },

  setAccountStatus(id, status) {
    return db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id);
  },

  setQueueAction(id, action) {
    return db.prepare("UPDATE accounts SET queue_action = ? WHERE id = ?").run(action, id);
  },

  clearQueue(id) {
    return db.prepare("UPDATE accounts SET queue_action = NULL WHERE id = ?").run(id);
  },

  getQueuedAccounts(action) {
    return db.prepare("SELECT * FROM accounts WHERE queue_action = ?").all(action);
  },

  // Настройки
  getSetting(key) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : "";
  },

  setSetting(key, value) {
    return db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  },

  getAllSettings() {
    const rows = db.prepare("SELECT * FROM settings").all();
    const obj = {};
    rows.forEach(r => obj[r.key] = r.value);
    return obj;
  },

  // Логи
  addLog(type, message) {
    db.prepare("INSERT INTO logs (type, message) VALUES (?, ?)").run(type, message);
    // Храним только последние 200 записей
    db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)").run();
  },

  getLogs(limit = 50) {
    return db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
  },
};
