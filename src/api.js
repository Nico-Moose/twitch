const express = require("express");
const router = express.Router();
const db = require("./database");
const twitch = require("./twitch-manager");

// Статус
router.get("/status", (req, res) => {
  const status = twitch.getStatus();
  const settings = db.getAllSettings();
  res.json({ ...status, settings });
});

// Аккаунты
router.get("/accounts", (req, res) => {
  const accounts = db.getAccounts();
  res.json(accounts);
});

router.post("/accounts/add", (req, res) => {
  const { accounts } = req.body;
  if (!accounts) return res.json({ ok: false, error: "Нет данных" });

  const lines = accounts.replace(/\|/g, "\n").split("\n").filter(l => l.trim());
  let added = 0;

  for (const line of lines) {
    const parts = line.trim().split(":");
    if (parts.length >= 3) {
      db.addAccount(parts[0], parts[2]);
      added++;
    }
  }

  db.addLog("accounts", `Добавлено ${added} аккаунтов`);
  res.json({ ok: true, added });
});

router.post("/accounts/delete", (req, res) => {
  const { id } = req.body;
  twitch.disconnectAccount(id);
  db.deleteAccount(id);
  db.addLog("accounts", `Аккаунт #${id} удалён`);
  res.json({ ok: true });
});

router.post("/accounts/toggle", (req, res) => {
  const { id, enabled } = req.body;
  db.toggleAccount(id, enabled);
  if (!enabled) twitch.disconnectAccount(id);
  res.json({ ok: true });
});

// Действия с одним аккаунтом
router.post("/accounts/connect", (req, res) => {
  const { id } = req.body;
  twitch.connectOne(id);
  res.json({ ok: true });
});

router.post("/accounts/disconnect", (req, res) => {
  const { id } = req.body;
  twitch.disconnectAccount(id);
  res.json({ ok: true });
});

// Очередь
router.post("/accounts/queue-join", (req, res) => {
  const { id } = req.body;
  twitch.queueJoin(id);
  res.json({ ok: true });
});

router.post("/accounts/queue-leave", (req, res) => {
  const { id } = req.body;
  twitch.queueLeave(id);
  res.json({ ok: true });
});

router.post("/accounts/queue-join-all", (req, res) => {
  const accounts = db.getAccounts().filter(a => a.enabled && a.status !== "подключен");
  accounts.forEach(a => twitch.queueJoin(a.id));
  res.json({ ok: true, queued: accounts.length });
});

router.post("/accounts/queue-leave-all", (req, res) => {
  const accounts = db.getAccounts().filter(a => a.status === "подключен");
  accounts.forEach(a => twitch.queueLeave(a.id));
  res.json({ ok: true, queued: accounts.length });
});

// Массовые действия
router.post("/action/connect-all", (req, res) => {
  twitch.connectAll();
  res.json({ ok: true });
});

router.post("/action/disconnect-all", (req, res) => {
  twitch.disconnectAll();
  res.json({ ok: true });
});

router.post("/action/reconnect-all", (req, res) => {
  twitch.reconnectAll();
  res.json({ ok: true });
});

// Фолловинг
router.post("/accounts/follow", (req, res) => {
  const { id } = req.body;
  const accounts = db.getAccounts();
  const account = accounts.find(a => a.id === id);
  if (!account) return res.json({ ok: false, error: "Аккаунт не найден" });
  twitch.followChannel(account).then(result => res.json(result));
});

router.post("/action/follow-all", (req, res) => {
  const accounts = db.getEnabledAccounts();
  accounts.forEach(a => twitch.followChannel(a));
  db.addLog("follow", `Фолловинг: ${accounts.length} аккаунтов`);
  res.json({ ok: true, count: accounts.length });
});

// Настройки
router.post("/settings", (req, res) => {
  const { channel, auto_rejoin, rejoin_interval, auto_follow } = req.body;
  if (channel !== undefined) db.setSetting("channel", channel.toLowerCase().trim());
  if (auto_rejoin !== undefined) db.setSetting("auto_rejoin", auto_rejoin);
  if (rejoin_interval !== undefined) db.setSetting("rejoin_interval", rejoin_interval);
  if (auto_follow !== undefined) db.setSetting("auto_follow", auto_follow);
  twitch.startAutoRejoin();
  db.addLog("settings", "Настройки обновлены");
  res.json({ ok: true });
});

// Логи
router.get("/logs", (req, res) => {
  const logs = db.getLogs(100);
  res.json(logs);
});

router.post("/logs/clear", (req, res) => {
  db.addLog("system", "Логи очищены");
  res.json({ ok: true });
});

module.exports = router;
