const express = require("express");
const Database = require("better-sqlite3");
const tmi = require("tmi.js");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

// ===== БАЗА ДАННЫХ =====
const db = new Database("./data/bot.db");
db.pragma("journal_mode = WAL");

// Создаём таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL,
    token TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Настройки по умолчанию
const defaultSettings = {
  channel: process.env.TWITCH_CHANNEL || "",
  auto_rejoin: "1",
  rejoin_interval: "30",
};

for (const [key, value] of Object.entries(defaultSettings)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// Загружаем аккаунты из переменной окружения при первом запуске
const ACCOUNTS_RAW = process.env.TWITCH_ACCOUNTS || "";
if (ACCOUNTS_RAW && db.prepare("SELECT COUNT(*) as cnt FROM accounts").get().cnt === 0) {
  const insert = db.prepare("INSERT INTO accounts (login, token) VALUES (?, ?)");
  ACCOUNTS_RAW.split("|").forEach(line => {
    const parts = line.trim().split(":");
    if (parts.length >= 3) {
      const login = parts[0];
      const token = parts[2];
      insert.run(login, token);
    }
  });
  console.log("[DB] Аккаунты импортированы из переменной окружения");
}

// ===== ФУНКЦИИ =====
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : "";
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function getAccounts() {
  return db.prepare("SELECT * FROM accounts ORDER BY id").all();
}

// ===== TWITCH КЛИЕНТЫ =====
const clients = new Map(); // id -> { client, status }

function connectAccount(account) {
  const channel = getSetting("channel");
  if (!channel) return;

  // Отключаем если уже подключен
  if (clients.has(account.id)) {
    disconnectAccount(account.id);
  }

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;

  const client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: { username: account.login, password: token },
    channels: [channel],
  });

  const info = { client, status: "подключение...", login: account.login };
  clients.set(account.id, info);

  client.connect().then(() => {
    info.status = "подключен";
    console.log(`[OK] ${account.login} подключен к ${channel}`);
  }).catch((err) => {
    info.status = "ошибка: " + err.message;
    console.error(`[ОШИБКА] ${account.login}: ${err.message}`);
  });

  client.on("disconnected", () => { info.status = "отключен"; });
  client.on("reconnect", () => { info.status = "переподключение..."; });
  client.on("connected", () => { info.status = "подключен"; });

  // Пинг
  const pingInterval = setInterval(() => {
    if (client.readyState() === "OPEN") {
      client.ping().catch(() => {});
    }
  }, 4 * 60 * 1000);

  info.pingInterval = pingInterval;
}

function disconnectAccount(id) {
  const info = clients.get(id);
  if (info) {
    clearInterval(info.pingInterval);
    info.client.disconnect().catch(() => {});
    clients.delete(id);
    console.log(`[DISCONNECT] ${info.login} отключен`);
  }
}

function connectAll() {
  const accounts = getAccounts().filter(a => a.enabled);
  const channel = getSetting("channel");
  if (!channel) {
    console.log("[WARN] Канал не задан");
    return;
  }
  console.log(`[START] Подключаем ${accounts.length} аккаунтов к ${channel}`);
  accounts.forEach((account, index) => {
    setTimeout(() => connectAccount(account), index * 3000);
  });
}

function disconnectAll() {
  for (const [id] of clients) {
    disconnectAccount(id);
  }
}

// ===== АВТО ЗАХОД/ВЫХОД =====
let rejoinInterval = null;

function startAutoRejoin() {
  stopAutoRejoin();
  const enabled = getSetting("auto_rejoin") === "1";
  const minutes = parseInt(getSetting("rejoin_interval")) || 30;

  if (!enabled) return;

  console.log(`[AUTO] Авто-перезаход каждые ${minutes} мин`);
  rejoinInterval = setInterval(() => {
    console.log("[AUTO] Перезаход...");
    disconnectAll();
    setTimeout(() => connectAll(), 5000);
  }, minutes * 60 * 1000);
}

function stopAutoRejoin() {
  if (rejoinInterval) {
    clearInterval(rejoinInterval);
    rejoinInterval = null;
  }
}

// ===== ВЕБ СЕРВЕР =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Простая авторизация
function auth(req, res, next) {
  const pass = req.query.pass || req.body.pass || req.headers["x-pass"];
  if (pass === ADMIN_PASS) return next();
  // Проверяем cookie
  const cookie = req.headers.cookie || "";
  if (cookie.includes(`pass=${ADMIN_PASS}`)) return next();
  res.status(401).send(getLoginPage());
}

function getLoginPage() {
  return `
  <html>
  <head><meta charset="utf-8"><title>Login</title>
  <style>
    body { font-family: Arial; background: #0e0e1a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .box { background: #1a1a2e; padding: 30px; border-radius: 10px; }
    input { padding: 10px; margin: 5px; border-radius: 5px; border: 1px solid #333; background: #16213e; color: #fff; }
    button { padding: 10px 20px; background: #6c63ff; color: #fff; border: none; border-radius: 5px; cursor: pointer; }
  </style></head>
  <body>
    <div class="box">
      <h2>Вход в панель</h2>
      <form method="GET">
        <input name="pass" type="password" placeholder="Пароль">
        <button type="submit">Войти</button>
      </form>
    </div>
  </body></html>`;
}

// Главная страница - панель управления
app.get("/", auth, (req, res) => {
  const accounts = getAccounts();
  const channel = getSetting("channel");
  const autoRejoin = getSetting("auto_rejoin") === "1";
  const rejoinMin = getSetting("rejoin_interval");
  const pass = ADMIN_PASS;

  let accountRows = accounts.map(a => {
    const clientInfo = clients.get(a.id);
    const status = clientInfo ? clientInfo.status : "отключен";
    const statusColor = status === "подключен" ? "#4caf50" : status.includes("ошибка") ? "#f44336" : "#ff9800";
    return `
      <tr>
        <td>${a.login}</td>
        <td><span style="color:${statusColor}">${status}</span></td>
        <td>${a.enabled ? "Да" : "Нет"}</td>
        <td>
          <button onclick="toggleAccount(${a.id}, ${a.enabled ? 0 : 1})">${a.enabled ? "Выкл" : "Вкл"}</button>
          <button onclick="deleteAccount(${a.id})" style="background:#f44336">Удалить</button>
        </td>
      </tr>`;
  }).join("");

  res.send(`
  <html>
  <head>
    <meta charset="utf-8">
    <title>Twitch Viewer Bot - Панель</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial; background: #0e0e1a; color: #eee; margin: 0; padding: 20px; }
      h1 { color: #6c63ff; }
      .card { background: #1a1a2e; padding: 20px; border-radius: 10px; margin: 15px 0; }
      input, select { padding: 8px 12px; border-radius: 5px; border: 1px solid #333; background: #16213e; color: #fff; margin: 5px; }
      button { padding: 8px 16px; background: #6c63ff; color: #fff; border: none; border-radius: 5px; cursor: pointer; margin: 3px; }
      button:hover { background: #5a52d5; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
      .stats { display: flex; gap: 20px; flex-wrap: wrap; }
      .stat { background: #16213e; padding: 15px 25px; border-radius: 8px; }
      .stat b { font-size: 24px; color: #6c63ff; }
      textarea { width: 100%; padding: 10px; border-radius: 5px; border: 1px solid #333; background: #16213e; color: #fff; min-height: 80px; }
    </style>
  </head>
  <body>
    <h1>Twitch Viewer Bot</h1>

    <div class="stats">
      <div class="stat"><b>${clients.size}</b><br>Подключено</div>
      <div class="stat"><b>${accounts.length}</b><br>Всего аккаунтов</div>
      <div class="stat"><b>${channel || "не задан"}</b><br>Канал</div>
    </div>

    <!-- НАСТРОЙКИ -->
    <div class="card">
      <h3>Настройки</h3>
      <form id="settingsForm">
        <label>Канал: </label>
        <input name="channel" value="${channel}" placeholder="название канала">
        <br><br>
        <label>Авто-перезаход: </label>
        <select name="auto_rejoin">
          <option value="1" ${autoRejoin ? "selected" : ""}>Включен</option>
          <option value="0" ${!autoRejoin ? "selected" : ""}>Выключен</option>
        </select>
        <label> каждые </label>
        <input name="rejoin_interval" value="${rejoinMin}" style="width:60px" type="number"> мин
        <br><br>
        <button type="submit">Сохранить</button>
      </form>
    </div>

    <!-- УПРАВЛЕНИЕ -->
    <div class="card">
      <h3>Управление</h3>
      <button onclick="doAction('connect')">Подключить всех</button>
      <button onclick="doAction('disconnect')" style="background:#f44336">Отключить всех</button>
      <button onclick="doAction('reconnect')" style="background:#ff9800">Переподключить</button>
    </div>

    <!-- ДОБАВИТЬ АККАУНТЫ -->
    <div class="card">
      <h3>Добавить аккаунты</h3>
      <p>Формат: LOGIN:PASS:TOKEN:ID:DATE (каждый с новой строки или через |)</p>
      <textarea id="newAccounts" placeholder="login1:pass1:token1:id1:date1&#10;login2:pass2:token2:id2:date2"></textarea>
      <br>
      <button onclick="addAccounts()">Добавить</button>
    </div>

    <!-- СПИСОК АККАУНТОВ -->
    <div class="card">
      <h3>Аккаунты</h3>
      <table>
        <tr><th>Логин</th><th>Статус</th><th>Активен</th><th>Действия</th></tr>
        ${accountRows}
      </table>
    </div>

    <script>
      const pass = "${pass}";

      async function api(url, data) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-pass": pass },
          body: JSON.stringify(data)
        });
        return res.json();
      }

      document.getElementById("settingsForm").onsubmit = async (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        await api("/api/settings", Object.fromEntries(form));
        location.reload();
      };

      async function doAction(action) {
        await api("/api/action", { action });
        setTimeout(() => location.reload(), 2000);
      }

      async function addAccounts() {
        const text = document.getElementById("newAccounts").value;
        await api("/api/accounts/add", { accounts: text });
        location.reload();
      }

      async function toggleAccount(id, enabled) {
        await api("/api/accounts/toggle", { id, enabled });
        location.reload();
      }

      async function deleteAccount(id) {
        if (!confirm("Удалить аккаунт?")) return;
        await api("/api/accounts/delete", { id });
        location.reload();
      }
    </script>
  </body></html>`);
});

// ===== API =====
app.post("/api/settings", auth, (req, res) => {
  const { channel, auto_rejoin, rejoin_interval } = req.body;
  if (channel !== undefined) setSetting("channel", channel.toLowerCase().trim());
  if (auto_rejoin !== undefined) setSetting("auto_rejoin", auto_rejoin);
  if (rejoin_interval !== undefined) setSetting("rejoin_interval", rejoin_interval);
  startAutoRejoin();
  res.json({ ok: true });
});

app.post("/api/action", auth, (req, res) => {
  const { action } = req.body;
  if (action === "connect") connectAll();
  else if (action === "disconnect") disconnectAll();
  else if (action === "reconnect") {
    disconnectAll();
    setTimeout(() => connectAll(), 3000);
  }
  res.json({ ok: true });
});

app.post("/api/accounts/add", auth, (req, res) => {
  const { accounts } = req.body;
  const lines = accounts.replace(/\|/g, "\n").split("\n").filter(l => l.trim());
  const insert = db.prepare("INSERT INTO accounts (login, token) VALUES (?, ?)");
  let added = 0;
  for (const line of lines) {
    const parts = line.trim().split(":");
    if (parts.length >= 3) {
      insert.run(parts[0], parts[2]);
      added++;
    }
  }
  res.json({ ok: true, added });
});

app.post("/api/accounts/toggle", auth, (req, res) => {
  const { id, enabled } = req.body;
  db.prepare("UPDATE accounts SET enabled = ? WHERE id = ?").run(enabled, id);
  if (!enabled) disconnectAccount(id);
  res.json({ ok: true });
});

app.post("/api/accounts/delete", auth, (req, res) => {
  const { id } = req.body;
  disconnectAccount(id);
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ===== ЗАПУСК =====
app.listen(PORT, () => {
  console.log(`[HTTP] Панель управления: порт ${PORT}`);
  console.log(`[INFO] Пароль: ${ADMIN_PASS}`);

  // Автоподключение при старте
  setTimeout(() => {
    connectAll();
    startAutoRejoin();
  }, 2000);
});
