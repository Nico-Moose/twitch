const tmi = require("tmi.js");
const db = require("./database");

const clients = new Map(); // id -> tmi.Client
let loopTimer = null;

// Рандом от min до max
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Подключить аккаунт к каналу
function connect(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;

  if (clients.has(account.id)) disconnect(account.id);

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;

  const client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: { username: account.login, password: token },
    channels: [channel],
  });

  client.connect().then(() => {
    db.setStatus(account.id, "online");
    console.log(`[+] ${account.login} зашёл`);
    db.addLog("join", account.login + " зашёл");
  }).catch(err => {
    db.setStatus(account.id, "error");
    console.log(`[!] ${account.login}: ${err.message}`);
    db.addLog("error", account.login + ": " + err.message);
  });

  clients.set(account.id, client);
}

// Отключить аккаунт
function disconnect(id) {
  const client = clients.get(id);
  if (client) {
    client.disconnect().catch(() => {});
    clients.delete(id);
  }
  db.setStatus(id, "offline");
}

// Отключить всех
function disconnectAll() {
  for (const [id] of clients) {
    disconnect(id);
  }
  db.resetAll();
}

// === ГЛАВНЫЙ ЦИКЛ ===
// Логика:
// 1. Нажал СТАРТ -> аккаунты начинают заходить по одному с интервалом
// 2. Каждый аккаунт после захода получает рандомное время просмотра (10-30 мин)
// 3. Когда время вышло — уходит на АФК (5-15 мин)
// 4. После АФК — снова заходит и повторяет

function start() {
  const accounts = db.getEnabledAccounts();
  if (accounts.length === 0) return;

  const channel = db.getSetting("channel");
  if (!channel) return;

  db.setSetting("running", "1");
  db.addLog("system", "СТАРТ — заходим на " + channel);

  const interval = (parseInt(db.getSetting("join_interval")) || 3) * 60 * 1000; // минуты
  const now = Date.now();

  // Расставляем время захода для каждого аккаунта (по очереди с интервалом)
  accounts.forEach((acc, i) => {
    const joinAt = now + i * interval;
    db.setPhase(acc.id, "waiting_join", joinAt);
    db.setStatus(acc.id, "ожидание");
  });

  console.log(`[START] ${accounts.length} аккаунтов, интервал ${interval / 60000} мин`);
  startLoop();
}

function stop() {
  db.setSetting("running", "0");
  stopLoop();
  disconnectAll();
  db.addLog("system", "СТОП — все отключены");
  console.log("[STOP] Остановлено");
}

function startLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(tick, 15000); // каждые 15 сек проверяем
  tick(); // сразу первый тик
}

function stopLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

function tick() {
  if (db.getSetting("running") !== "1") return;

  const now = Date.now();
  const accounts = db.getEnabledAccounts();

  accounts.forEach(acc => {
    if (acc.next_action === 0) return;
    if (now < acc.next_action) return; // ещё не время

    if (acc.phase === "waiting_join") {
      // Пора заходить
      connect(acc);
      // Время просмотра: 10-30 мин
      const watchTime = rand(10, 30) * 60 * 1000;
      db.setPhase(acc.id, "watching", now + watchTime);
      console.log(`[>] ${acc.login} смотрит ${Math.round(watchTime / 60000)} мин`);
    }
    else if (acc.phase === "watching") {
      // Время вышло — уходим в АФК
      disconnect(acc.id);
      // АФК: 5-15 мин
      const afkTime = rand(5, 15) * 60 * 1000;
      db.setPhase(acc.id, "afk", now + afkTime);
      db.setStatus(acc.id, "афк");
      console.log(`[<] ${acc.login} АФК ${Math.round(afkTime / 60000)} мин`);
      db.addLog("afk", acc.login + " ушёл в АФК");
    }
    else if (acc.phase === "afk") {
      // АФК закончился — заходим обратно
      connect(acc);
      const watchTime = rand(10, 30) * 60 * 1000;
      db.setPhase(acc.id, "watching", now + watchTime);
      console.log(`[>] ${acc.login} вернулся, смотрит ${Math.round(watchTime / 60000)} мин`);
      db.addLog("join", acc.login + " вернулся");
    }
  });
}

// Отправить сообщение в чат
function sendMessage(id, message) {
  const client = clients.get(id);
  if (!client) return Promise.resolve({ ok: false, error: "Не подключен" });
  const channel = db.getSetting("channel");
  return client.say(channel, message).then(() => {
    db.addLog("chat", db.getAccountById(id).login + ": " + message);
    return { ok: true };
  }).catch(err => ({ ok: false, error: err.message }));
}

// Если бот был запущен до перезагрузки — продолжаем
if (db.getSetting("running") === "1") {
  console.log("[RESUME] Продолжаем работу");
  startLoop();
}

module.exports = { start, stop, disconnect, disconnectAll, sendMessage, clients };
