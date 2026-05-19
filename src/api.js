const express = require("express");
const router = express.Router();
const db = require("./database");
const twitch = require("./twitch-manager");

// Статус
router.get("/status", (req, res) => {
  const status = twitch.getStatus();
  const settings = db.getAllSettings();
  const queue = twitch.getQueueStatus();
  res.json({ ...status, settings, queue });
});

// Аккаунты
router.get("/accounts", (req, res) => {
  const accounts = db.getAccounts();
  const now = Date.now();
  const enriched = accounts.map(a => ({
    ...a,
    time_left: a.next_action_at > now ? Math.round((a.next_action_at - now) / 1000) : 0,
  }));
  res.json(enriched);
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

// Таймеры
router.post("/accounts/set-times", (req, res) => {
  const { id, watch_time, afk_time } = req.body;
  db.setAccountTimes(id, watch_time, afk_time);
  res.json({ ok: true });
});

// Цикл одного
router.post("/accounts/start-cycle", (req, res) => {
  const { id } = req.body;
  db.setCycleActive(id, true);
  db.setPhase(id, "joining", Date.now());
  twitch.startCycleProcessor();
  db.addLog("cycle", `Цикл запущен для #${id}`);
  res.json({ ok: true });
});

router.post("/accounts/stop-cycle", (req, res) => {
  const { id } = req.body;
  db.setCycleActive(id, false);
  db.setPhase(id, "idle", 0);
  res.json({ ok: true });
});

// === ЧАТ ===
router.post("/chat/send", (req, res) => {
  const { id, message } = req.body;
  if (!message) return res.json({ ok: false, error: "Нет сообщения" });

  twitch.sendMessage(id, message).then(result => {
    res.json(result);
  });
});

router.post("/chat/send-all", (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ ok: false, error: "Нет сообщения" });

  const result = twitch.sendMessageAll(message);
  res.json(result);
});

// === ФОЛЛОВИНГ ===
router.post("/accounts/follow", (req, res) => {
  const { id } = req.body;
  const account = db.getAccountById(id);
  if (!account) return res.json({ ok: false, error: "Аккаунт не найден" });
  twitch.followChannel(account).then(result => res.json(result));
});

router.post("/action/follow-all", (req, res) => {
  const result = twitch.followAll();
  res.json(result);
});

// Очередь
router.post("/queue/start-join", (req, res) => {
  twitch.startQueueJoin();
  res.json({ ok: true });
});

router.post("/queue/start-leave", (req, res) => {
  twitch.startQueueLeave();
  res.json({ ok: true });
});

router.post("/queue/stop", (req, res) => {
  twitch.stopQueues();
  res.json({ ok: true });
});

// Цикл глобальный
router.post("/cycle/start", (req, res) => {
  twitch.startCycleAll();
  res.json({ ok: true });
});

router.post("/cycle/stop", (req, res) => {
  twitch.stopCycleAll();
  res.json({ ok: true });
});

// Массовые
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

// Настройки
router.post("/settings", (req, res) => {
  const fields = ["channel", "queue_join_interval", "queue_leave_interval", "global_watch_time", "global_afk_time", "client_id"];
  fields.forEach(key => {
    if (req.body[key] !== undefined) {
      db.setSetting(key, key === "channel" ? req.body[key].toLowerCase().trim() : req.body[key]);
    }
  });
  db.addLog("settings", "Настройки обновлены");
  res.json({ ok: true });
});

// Логи
router.get("/logs", (req, res) => {
  const logs = db.getLogs(100);
  res.json(logs);
});

module.exports = router;
