const tmi = require("tmi.js");
const db = require("./database");

const clients = new Map(); // id -> { client, pingInterval }
let cycleTimer = null;
let queueJoinTimer = null;
let queueLeaveTimer = null;

// === СТАТУС ===
function getStatus() {
  const accounts = db.getAccounts();
  let connected = 0, disconnected = 0, errors = 0, cycling = 0;

  accounts.forEach(a => {
    if (a.status === "подключен") connected++;
    else if (a.status.includes("ошибка")) errors++;
    else disconnected++;
    if (a.cycle_active) cycling++;
  });

  return { total: accounts.length, connected, disconnected, errors, cycling };
}

// === ПОДКЛЮЧЕНИЕ ===
function connectAccount(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;

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
    console.error(`[ERR] ${account.login}: ${err.message}`);
  });

  client.on("disconnected", () => { db.setAccountStatus(account.id, "отключен"); });
  client.on("reconnect", () => { db.setAccountStatus(account.id, "переподключение..."); });
  client.on("connected", () => { db.setAccountStatus(account.id, "подключен"); });

  const pingInterval = setInterval(() => {
    if (client.readyState() === "OPEN") client.ping().catch(() => {});
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
  if (!channel) { console.log("[WARN] Канал не задан"); return; }
  db.addLog("system", `Подключаем ${accounts.length} аккаунтов к ${channel}`);
  accounts.forEach((account, index) => {
    setTimeout(() => connectAccount(account), index * 3000);
  });
}

function disconnectAll() {
  const accounts = db.getAccounts();
  accounts.forEach(a => disconnectAccount(a.id));
  db.addLog("system", "Все отключены");
}

function reconnectAll() {
  disconnectAll();
  setTimeout(() => connectAll(), 5000);
  db.addLog("system", "Переподключение всех");
}

function connectOne(id) {
  const account = db.getAccountById(id);
  if (account) connectAccount(account);
}

// === ОЧЕРЕДЬ ЗАХОДА (по одному через интервал) ===
let joinQueue = [];
let leaveQueue = [];

function startQueueJoin() {
  const accounts = db.getEnabledAccounts().filter(a => a.status !== "подключен");
  // Рандомный порядок
  joinQueue = accounts.sort(() => Math.random() - 0.5);
  const interval = (parseInt(db.getSetting("queue_join_interval")) || 2) * 60 * 1000;

  db.addLog("queue", `Очередь на заход: ${joinQueue.length} аккаунтов, интервал ${interval / 60000} мин`);

  clearInterval(queueJoinTimer);
  processJoinQueue(); // первый сразу

  queueJoinTimer = setInterval(() => {
    processJoinQueue();
  }, interval);
}

function processJoinQueue() {
  if (joinQueue.length === 0) {
    clearInterval(queueJoinTimer);
    queueJoinTimer = null;
    db.addLog("queue", "Очередь на заход завершена");
    return;
  }
  const account = joinQueue.shift();
  connectAccount(account);
  db.addLog("queue", `${account.login} зашёл (осталось: ${joinQueue.length})`);
}

function startQueueLeave() {
  const accounts = db.getAccounts().filter(a => a.status === "подключен");
  leaveQueue = accounts.sort(() => Math.random() - 0.5);
  const interval = (parseInt(db.getSetting("queue_leave_interval")) || 2) * 60 * 1000;

  db.addLog("queue", `Очередь на выход: ${leaveQueue.length} аккаунтов, интервал ${interval / 60000} мин`);

  clearInterval(queueLeaveTimer);
  processLeaveQueue();

  queueLeaveTimer = setInterval(() => {
    processLeaveQueue();
  }, interval);
}

function processLeaveQueue() {
  if (leaveQueue.length === 0) {
    clearInterval(queueLeaveTimer);
    queueLeaveTimer = null;
    db.addLog("queue", "Очередь на выход завершена");
    return;
  }
  const account = leaveQueue.shift();
  disconnectAccount(account.id);
  db.addLog("queue", `${account.login} вышел (осталось: ${leaveQueue.length})`);
}

function stopQueues() {
  clearInterval(queueJoinTimer);
  clearInterval(queueLeaveTimer);
  queueJoinTimer = null;
  queueLeaveTimer = null;
  joinQueue = [];
  leaveQueue = [];
  db.addLog("queue", "Очереди остановлены");
}

// === ЦИКЛ ЗАХОД/ВЫХОД (для каждого аккаунта индивидуально) ===
// Каждый аккаунт: сидит watch_time мин -> уходит на afk_time мин -> возвращается -> повтор

function startCycleAll() {
  const accounts = db.getEnabledAccounts();
  const globalWatch = parseInt(db.getSetting("global_watch_time")) || 20;
  const globalAfk = parseInt(db.getSetting("global_afk_time")) || 10;
  const now = Date.now();

  accounts.forEach((account, index) => {
    const watchTime = account.watch_time || globalWatch;
    // Рандомный старт чтобы не все одновременно
    const randomDelay = index * 30 * 1000 + Math.random() * 60 * 1000;
    const nextAction = now + randomDelay;

    db.setCycleActive(account.id, true);
    db.setPhase(account.id, "joining", nextAction);
  });

  db.addLog("cycle", `Цикл запущен для ${accounts.length} аккаунтов`);
  startCycleProcessor();
}

function stopCycleAll() {
  db.stopAllCycles();
  stopCycleProcessor();
  db.addLog("cycle", "Цикл остановлен");
}

function startCycleProcessor() {
  if (cycleTimer) return;
  cycleTimer = setInterval(() => {
    processCycles();
  }, 15 * 1000); // проверяем каждые 15 сек
}

function stopCycleProcessor() {
  if (cycleTimer) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
}

function processCycles() {
  const now = Date.now();
  const accounts = db.getCycleAccounts();

  accounts.forEach(account => {
    if (account.next_action_at > now) return; // ещё не время

    const globalWatch = parseInt(db.getSetting("global_watch_time")) || 20;
    const globalAfk = parseInt(db.getSetting("global_afk_time")) || 10;
    const watchTime = account.watch_time || globalWatch;
    const afkTime = account.afk_time || globalAfk;

    if (account.current_phase === "joining") {
      // Пора подключиться
      connectAccount(account);
      const watchMs = watchTime * 60 * 1000 + (Math.random() * 2 * 60 * 1000); // +0-2 мин рандом
      db.setPhase(account.id, "watching", now + watchMs);
      db.addLog("cycle", `${account.login} зашёл, будет смотреть ${Math.round(watchMs / 60000)} мин`);
    }
    else if (account.current_phase === "watching") {
      // Время вышло — уходим в АФК
      disconnectAccount(account.id);
      const afkMs = afkTime * 60 * 1000 + (Math.random() * 2 * 60 * 1000);
      db.setPhase(account.id, "afk", now + afkMs);
      db.addLog("cycle", `${account.login} ушёл в АФК на ${Math.round(afkMs / 60000)} мин`);
    }
    else if (account.current_phase === "afk") {
      // АФК закончился — снова заходим
      connectAccount(account);
      const watchMs = watchTime * 60 * 1000 + (Math.random() * 2 * 60 * 1000);
      db.setPhase(account.id, "watching", now + watchMs);
      db.addLog("cycle", `${account.login} вернулся, будет смотреть ${Math.round(watchMs / 60000)} мин`);
    }
  });
}

// Запускаем процессор если есть активные циклы
const activeCycles = db.getCycleAccounts();
if (activeCycles.length > 0) {
  startCycleProcessor();
}

module.exports = {
  getStatus,
  connectAccount,
  disconnectAccount,
  connectAll,
  disconnectAll,
  reconnectAll,
  connectOne,
  startQueueJoin,
  startQueueLeave,
  stopQueues,
  startCycleAll,
  stopCycleAll,
  startCycleProcessor,
  getQueueStatus: () => ({ joinQueue: joinQueue.length, leaveQueue: leaveQueue.length }),
};
