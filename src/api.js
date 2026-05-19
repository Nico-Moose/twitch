const express = require("express");
const router = express.Router();
const db = require("./database");
const bot = require("./bot");

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
  try {
    bot.connectNow(id);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
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
  res.json(db.getLogs(50));
});

module.exports = router;
