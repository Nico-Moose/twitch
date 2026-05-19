const express = require("express");
const path = require("path");
const db = require("./src/database");
const twitchManager = require("./src/twitch-manager");
const apiRoutes = require("./src/api");

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

// Импорт аккаунтов из ENV при первом запуске
const ACCOUNTS_RAW = process.env.TWITCH_ACCOUNTS || "";
if (ACCOUNTS_RAW && db.getAccountCount() === 0) {
  ACCOUNTS_RAW.split("|").forEach(line => {
    const parts = line.trim().split(":");
    if (parts.length >= 3) {
      db.addAccount(parts[0], parts[2]);
    }
  });
  console.log("[DB] Аккаунты импортированы из ENV");
}

// Канал из ENV
const ENV_CHANNEL = process.env.TWITCH_CHANNEL || "";
if (ENV_CHANNEL && !db.getSetting("channel")) {
  db.setSetting("channel", ENV_CHANNEL.toLowerCase().trim());
}

// Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Авторизация
app.use("/api", (req, res, next) => {
  const pass = req.headers["x-pass"] || req.query.pass;
  if (pass === ADMIN_PASS) return next();
  res.status(401).json({ error: "Unauthorized" });
});

app.use("/admin", (req, res, next) => {
  const pass = req.query.pass || "";
  if (pass === ADMIN_PASS) return next();
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// API
app.use("/api", apiRoutes);

// Админка
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Запуск
app.listen(PORT, () => {
  console.log(`[HTTP] Панель: порт ${PORT}`);
  console.log(`[INFO] Пароль: ${ADMIN_PASS}`);

  // Автоподключение
  setTimeout(() => {
    twitchManager.connectAll();
  }, 2000);
});
