const tmi = require("tmi.js");
const http = require("http");

// ===== НАСТРОЙКИ ЧЕРЕЗ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ =====
const CHANNEL = (process.env.TWITCH_CHANNEL || "").replace(/^#/, "").toLowerCase().trim();
const ACCOUNTS_RAW = process.env.TWITCH_ACCOUNTS || "";
const PORT = process.env.PORT || 3000;

// =================================================

if (!CHANNEL) {
  console.error("[ОШИБКА] Не задана переменная TWITCH_CHANNEL");
  process.exit(1);
}

if (!ACCOUNTS_RAW) {
  console.error("[ОШИБКА] Не задана переменная TWITCH_ACCOUNTS");
  process.exit(1);
}

// Парсим аккаунты (формат: LOGIN:PASS:TOKEN:ID:DATE разделены через |)
const accounts = ACCOUNTS_RAW.split("|").map(line => {
  const parts = line.trim().split(":");
  if (parts.length < 3) return null;
  return {
    login: parts[0],
    token: parts[2].startsWith("oauth:") ? parts[2] : "oauth:" + parts[2],
  };
}).filter(a => a !== null);

console.log(`[START] Twitch Viewer Bot`);
console.log(`[INFO] Канал: ${CHANNEL}`);
console.log(`[INFO] Аккаунтов: ${accounts.length}`);
console.log("");

const status = {
  total: accounts.length,
  connected: 0,
  errors: 0,
  startTime: Date.now(),
  accounts: [],
};

const server = http.createServer((req, res) => {
  const uptime = Math.floor((Date.now() - status.startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <html>
    <head><title>Twitch Viewer Bot</title></head>
    <body style="font-family: Arial; padding: 20px; background: #1a1a2e; color: #eee;">
      <h1>Twitch Viewer Bot</h1>
      <p><b>Канал:</b> ${CHANNEL}</p>
      <p><b>Всего аккаунтов:</b> ${status.total}</p>
      <p><b>Подключено:</b> ${status.connected}</p>
      <p><b>Ошибок:</b> ${status.errors}</p>
      <p><b>Время работы:</b> ${hours}ч ${minutes}м ${seconds}с</p>
      <h3>Аккаунты:</h3>
      <ul>
        ${status.accounts.map(a => `<li>${a.login} — ${a.state}</li>`).join("")}
      </ul>
    </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(`[HTTP] Сервер на порту ${PORT}`);
});

function connectAccount(account, index) {
  const accountStatus = { login: account.login, state: "подключение..." };
  status.accounts.push(accountStatus);

  const client = new tmi.Client({
    options: { debug: false },
    connection: {
      reconnect: true,
      secure: true,
    },
    identity: {
      username: account.login,
      password: account.token,
    },
    channels: [CHANNEL],
  });

  client.connect().then(() => {
    status.connected++;
    accountStatus.state = "подключен";
    console.log(`[OK] ${account.login} подключен (${status.connected}/${status.total})`);
  }).catch((err) => {
    status.errors++;
    accountStatus.state = "ошибка: " + err.message;
    console.error(`[ОШИБКА] ${account.login}: ${err.message}`);
  });

  client.on("disconnected", (reason) => {
    status.connected = Math.max(0, status.connected - 1);
    accountStatus.state = "отключен";
    console.log(`[DISCONNECT] ${account.login}: ${reason}`);
  });

  client.on("reconnect", () => {
    accountStatus.state = "переподключение...";
    console.log(`[RECONNECT] ${account.login}`);
  });

  client.on("connected", () => {
    accountStatus.state = "подключен";
  });

  setInterval(() => {
    if (client.readyState() === "OPEN") {
      client.ping().catch(() => {});
    }
  }, 4 * 60 * 1000 + index * 5000);

  return client;
}

accounts.forEach((account, index) => {
  setTimeout(() => {
    connectAccount(account, index);
  }, index * 3000);
});
