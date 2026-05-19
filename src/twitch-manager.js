const tmi = require("tmi.js");
const db = require("./database");

const clients = new Map(); // id -> { client, pingInterval }
let rejoinTimer = null;
let queueTimer = null;

function getStatus() {
  const accounts = db.getAccounts();
  let connected = 0;
  let disconnected = 0;
  let errors = 0;

  accounts.forEach(a => {
    if (a.status === "подключен") connected++;
    else if (a.status.includes("ошибка")) errors++;
    else disconnected++;
  });

  return { total: accounts.length, connected, disconnected, errors };
}

function connectAccount(account) {
  const channel = db.getSetting("channel");
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

  db.setAccountStatus(account.id, "подключение...");

  client.connect().then(() => {
    db.setAccountStatus(account.id, "подключен");
    db.addLog("connect", `${account.login} подключен к ${channel}`);
    console.log(`[OK] ${account.login} подключен`);
  }).catch((err) => {
    db.setAccountStatus(account.id, "ошибка: " + err.message);
    db.addLog("error", `${account.login}: ${err.message}`);
    console.error(`[ОШИБКА] ${account.login}: ${err.message}`);
  });

  client.on("disconnected", () => {
    db.setAccountStatus(account.id, "отключен");
  });

  client.on("reconnect", () => {
    db.setAccountStatus(account.id, "переподключение...");
  });

  client.on("connected", () => {
    db.setAccountStatus(account.id, "подключен");
  });

  const pingInterval = setInterval(() => {
    if (client.readyState() === "OPEN") {
      client.ping().catch(() => {});
    }
  }, 4 * 60 * 1000);

  clients.set(account.id, { client, pingInterval });
}

function disconnectAccount(id) {
  const info = clients.get(id);
  if (info) {
    clearInterval(info.pingInterval);
    info.client.disconnect().catch(() => {});
    clients.delete(id);
  }
  db.setAccountStatus(id, "отключен");
}

function connectAll() {
  const accounts = db.getEnabledAccounts();
  const channel = db.getSetting("channel");
  if (!channel) {
    console.log("[WARN] Канал не задан");
    return;
  }
  db.addLog("system", `Подключаем ${accounts.length} аккаунтов к ${channel}`);
  accounts.forEach((account, index) => {
    setTimeout(() => connectAccount(account), index * 3000);
  });
}

function disconnectAll() {
  const accounts = db.getAccounts();
  accounts.forEach(a => disconnectAccount(a.id));
  db.addLog("system", "Все аккаунты отключены");
}

function reconnectAll() {
  disconnectAll();
  setTimeout(() => connectAll(), 5000);
  db.addLog("system", "Переподключение всех аккаунтов");
}

// Подключить один аккаунт
function connectOne(id) {
  const accounts = db.getAccounts();
  const account = accounts.find(a => a.id === id);
  if (account) connectAccount(account);
}

// Очередь: заход/выход
function queueJoin(id) {
  db.setQueueAction(id, "join");
  db.addLog("queue", `Аккаунт #${id} в очереди на заход`);
}

function queueLeave(id) {
  db.setQueueAction(id, "leave");
  db.addLog("queue", `Аккаунт #${id} в очереди на выход`);
}

function processQueue() {
  // Обрабатываем очередь на заход
  const joinQueue = db.getQueuedAccounts("join");
  joinQueue.forEach((account, index) => {
    setTimeout(() => {
      connectAccount(account);
      db.clearQueue(account.id);
    }, index * 3000);
  });

  // Обрабатываем очередь на выход
  const leaveQueue = db.getQueuedAccounts("leave");
  leaveQueue.forEach((account, index) => {
    setTimeout(() => {
      disconnectAccount(account.id);
      db.clearQueue(account.id);
    }, index * 1000);
  });
}

// Авто-перезаход
function startAutoRejoin() {
  stopAutoRejoin();
  const enabled = db.getSetting("auto_rejoin") === "1";
  const minutes = parseInt(db.getSetting("rejoin_interval")) || 30;

  if (!enabled) return;

  console.log(`[AUTO] Перезаход каждые ${minutes} мин`);
  db.addLog("system", `Авто-перезаход: каждые ${minutes} мин`);

  rejoinTimer = setInterval(() => {
    console.log("[AUTO] Перезаход...");
    reconnectAll();
  }, minutes * 60 * 1000);
}

function stopAutoRejoin() {
  if (rejoinTimer) {
    clearInterval(rejoinTimer);
    rejoinTimer = null;
  }
}

// Обработка очереди каждые 10 сек
queueTimer = setInterval(() => {
  processQueue();
}, 10 * 1000);

// Фолловинг (через IRC команду /follow не работает, нужен Twitch API)
// Для фолловинга нужен отдельный подход через Twitch Helix API
async function followChannel(account) {
  const channel = db.getSetting("channel");
  if (!channel) return { ok: false, error: "Канал не задан" };

  // tmi.js не поддерживает follow, нужен HTTP запрос к Twitch API
  // Для этого нужен Client-ID и токен с правами user:edit:follows
  // Пока логируем что функция вызвана
  db.addLog("follow", `${account.login} -> follow ${channel} (требуется API scope)`);
  return { ok: false, error: "Для фолловинга нужен токен с правами user:edit:follows" };
}

module.exports = {
  getStatus,
  connectAccount,
  disconnectAccount,
  connectAll,
  disconnectAll,
  reconnectAll,
  connectOne,
  queueJoin,
  queueLeave,
  processQueue,
  startAutoRejoin,
  stopAutoRejoin,
  followChannel,
  isConnected: (id) => clients.has(id),
};
