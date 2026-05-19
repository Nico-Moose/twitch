const express = require("express");
const path = require("path");
const db = require("./src/database");
const bot = require("./src/bot");
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
  console.log("[DB] Импортировано аккаунтов: " + db.getAccountCount());
}

// Канал из ENV
const ENV_CHANNEL = process.env.TWITCH_CHANNEL || "";
if (ENV_CHANNEL && !db.getSetting("channel")) {
  db.setSetting("channel", ENV_CHANNEL.toLowerCase().trim());
}

// Express
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Авторизация API
app.use("/api", (req, res, next) => {
  const pass = req.headers["x-pass"] || req.query.pass;
  if (pass === ADMIN_PASS) return next();
  res.status(401).json({ error: "Unauthorized" });
});

app.use("/api", apiRoutes);

app.get("/admin", (req, res) => {
  const pass = req.query.pass || "";
  if (pass === ADMIN_PASS) return res.sendFile(path.join(__dirname, "public", "admin.html"));
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.listen(PORT, () => {
  console.log(`[HTTP] Порт ${PORT}`);
  console.log(`[INFO] Пароль: ${ADMIN_PASS}`);
  console.log(`[INFO] Канал: ${db.getSetting("channel") || "не задан"}`);
});
