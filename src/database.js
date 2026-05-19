const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "bot.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL,
    token TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    status TEXT DEFAULT 'отключен',
    watch_time INTEGER DEFAULT 20,
    afk_time INTEGER DEFAULT 10,
    cycle_active INTEGER DEFAULT 0,
    next_action_at INTEGER DEFAULT 0,
    current_phase TEXT DEFAULT 'idle',
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

// Добавляем новые колонки если их нет (миграция)
try { db.exec("ALTER TABLE accounts ADD COLUMN watch_time INTEGER DEFAULT 20"); } catch(e) {}
try { db.exec("ALTER TABLE accounts ADD COLUMN afk_time INTEGER DEFAULT 10"); } catch(e) {}
try { db.exec("ALTER TABLE accounts ADD COLUMN cycle_active INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE accounts ADD COLUMN next_action_at INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE accounts ADD COLUMN current_phase TEXT DEFAULT 'idle'"); } catch(e) {}

const defaults = {
  channel: "",
  auto_rejoin: "0",
  rejoin_interval: "30",
  queue_join_interval: "2",
  queue_leave_interval: "2",
  global_cycle: "0",
  global_watch_time: "20",
  global_afk_time: "10",
};

for (const [key, value] of Object.entries(defaults)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

module.exports = {
  getAccounts() {
    return db.prepare("SELECT * FROM accounts ORDER BY id").all();
  },

  getEnabledAccounts() {
    return db.prepare("SELECT * FROM accounts WHERE enabled = 1 ORDER BY id").all();
  },

  getAccountCount() {
    return db.prepare("SELECT COUNT(*) as cnt FROM accounts").get().cnt;
  },

  getAccountById(id) {
    return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
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

  setAccountTimes(id, watchTime, afkTime) {
    return db.prepare("UPDATE accounts SET watch_time = ?, afk_time = ? WHERE id = ?").run(watchTime, afkTime, id);
  },

  setCycleActive(id, active) {
    return db.prepare("UPDATE accounts SET cycle_active = ? WHERE id = ?").run(active ? 1 : 0, id);
  },

  setPhase(id, phase, nextActionAt) {
    return db.prepare("UPDATE accounts SET current_phase = ?, next_action_at = ? WHERE id = ?").run(phase, nextActionAt, id);
  },

  startAllCycles() {
    return db.prepare("UPDATE accounts SET cycle_active = 1 WHERE enabled = 1").run();
  },

  stopAllCycles() {
    return db.prepare("UPDATE accounts SET cycle_active = 0, current_phase = 'idle', next_action_at = 0").run();
  },

  getCycleAccounts() {
    return db.prepare("SELECT * FROM accounts WHERE cycle_active = 1 AND enabled = 1").all();
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
    db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)").run();
  },

  getLogs(limit = 50) {
    return db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
  },
};
