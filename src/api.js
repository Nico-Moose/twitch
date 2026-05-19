const express = require("express");
const router = express.Router();
const db = require("./database");
const bot = require("./bot");
const proxyPool = require("./proxy-pool");

// Статус
router.get("/status", (req, res) => {
  const accounts = db.getAccounts();
  const now = Date.now();
  let online = 0, afk = 0, waiting = 0;
  accounts.forEach(a => {
    if (a.status === "online") online++;
    else if (a.status === "афк") afk++;
    else if (a.status === "ожидание") waiting++;
  });
  res.json({
    total: accounts.length,
    online,
    afk,
    waiting,
    running: db.getSetting("running") === "1",
    channel: db.getSetting("channel"),
    join_interval: db.getSetting("join_interval"),
  });
});

// Аккаунты с таймерами
router.get("/accounts", (req, res) => {
  const accounts = db.getAccounts();
  const now = Date.now();
  const list = accounts.map(a => ({
    id: a.id,
    login: a.login,
    proxy: a.proxy || "",
    status: a.status || "offline",
    phase: a.phase || "idle",
    time_left: a.next_action > now ? Math.round((a.next_action - now) / 1000) : 0,
  }));
  res.json(list);
});

// Добавить аккаунты
router.post("/accounts/add", (req, res) => {
  const { accounts } = req.body;
  if (!accounts) return res.json({ ok: false });
  const lines = accounts.replace(/\|/g, "\n").split("\n").filter(l => l.trim());
  let added = 0;
  for (const line of lines) {
    const parts = line.trim().split(":");
    if (parts.length >= 3) { db.addAccount(parts[0], parts[2]); added++; }
  }
  db.addLog("system", `Добавлено ${added} аккаунтов`);
  res.json({ ok: true, added });
});

// Удалить
router.post("/accounts/delete", (req, res) => {
  const { id } = req.body;
  bot.disconnect(id);
  db.deleteAccount(id);
  res.json({ ok: true });
});

// Запустить одного сразу
router.post("/accounts/connect-now", (req, res) => {
  const { id } = req.body;
  try { bot.connectNow(id); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// Прокси
router.post("/proxy/set", (req, res) => {
  const { id, proxy } = req.body;
  db.setProxy(id, proxy || "");
  res.json({ ok: true });
});

router.post("/proxy/bulk", (req, res) => {
  const { proxies } = req.body;
  if (!proxies) return res.json({ ok: false });
  const list = proxies.replace(/\|/g, "\n").split("\n").map(p => p.trim()).filter(p => p);
  db.setProxyBulk(list);
  db.addLog("system", `Прокси назначены: ${list.length}`);
  res.json({ ok: true, count: list.length });
});

// Загрузить прокси в пул
router.post("/proxy/load", (req, res) => {
  const { proxies } = req.body;
  if (!proxies) return res.json({ ok: false });
  const count = proxyPool.loadProxies(proxies);
  res.json({ ok: true, loaded: count });
});

// Проверить все прокси
router.post("/proxy/check", (req, res) => {
  const stats = proxyPool.getStats();
  if (stats.checking) {
    return res.json({ ok: true, message: "Уже проверяется" });
  }
  proxyPool.checkAll();
  res.json({ ok: true, message: "Проверка запущена" });
});

// Назначить рабочие прокси аккаунтам
router.post("/proxy/assign", (req, res) => {
  const count = proxyPool.assignToAccounts();
  res.json({ ok: true, assigned: count });
});

// Статус прокси
router.get("/proxy/stats", (req, res) => {
  res.json(proxyPool.getStats());
});

// Старт/Стоп
router.post("/start", (req, res) => {
  try {
    bot.start();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post("/stop", (req, res) => {
  try {
    bot.stop();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Настройки
router.post("/settings", (req, res) => {
  if (req.body.channel !== undefined) db.setSetting("channel", req.body.channel.toLowerCase().trim());
  if (req.body.join_interval !== undefined) db.setSetting("join_interval", req.body.join_interval);
  res.json({ ok: true });
});

// Чат
router.post("/chat/send", (req, res) => {
  const { id, message } = req.body;
  if (!message) return res.json({ ok: false, error: "Нет сообщения" });
  bot.sendMessage(id, message).then(r => res.json(r));
});

router.post("/chat/send-all", (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ ok: false });
  const accounts = db.getAccounts().filter(a => a.status === "online");
  accounts.forEach((a, i) => {
    setTimeout(() => bot.sendMessage(a.id, message), i * 2000);
  });
  res.json({ ok: true, count: accounts.length });
});

// Логи
router.get("/logs", (req, res) => {
  try {
    const logs = db.getLogs(50);
    res.json(logs || []);
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
