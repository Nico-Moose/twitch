const tmi = require("tmi.js");
const https = require("https");
const http = require("http");
const db = require("./database");

const clients = new Map(); // id -> tmi.Client
const streamWatchers = new Map(); // id -> interval (HLS)
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
    // Запускаем просмотр HLS потока
    startWatching(account);
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
  stopWatching(id);
  db.setStatus(id, "offline");
}

// === HLS ПРОСМОТР (увеличивает счётчик зрителей) ===
function getStreamToken(channel, oauthToken) {
  return new Promise((resolve, reject) => {
    const token = oauthToken.replace("oauth:", "");
    const body = JSON.stringify({
      operationName: "PlaybackAccessToken",
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712"
        }
      },
      variables: {
        isLive: true,
        login: channel,
        isVod: false,
        vodID: "",
        playerType: "embed"
      }
    });

    const options = {
      hostname: "gql.twitch.tv",
      path: "/gql",
      method: "POST",
      headers: {
        "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
        "Authorization": "OAuth " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.data && json.data.streamPlaybackAccessToken) {
            resolve(json.data.streamPlaybackAccessToken);
          } else {
            reject(new Error("No token"));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getPlaylist(channel, tokenData) {
  return new Promise((resolve, reject) => {
    const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?` +
      `allow_source=true&fast_bread=true&p=${Math.floor(Math.random()*999999)}` +
      `&player_backend=mediaplayer&playlist_include_framerate=true&reassignments_supported=true` +
      `&sig=${tokenData.signature}&supported_codecs=avc1&token=${encodeURIComponent(tokenData.value)}` +
      `&cdm=wv&player_version=1.22.0`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          // Берём самое низкое качество (160p) чтобы не жрать трафик
          const lines = data.split("\n");
          let streamUrl = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].startsWith("http")) {
              streamUrl = lines[i].trim();
              break;
            }
          }
          resolve(streamUrl);
        } else {
          reject(new Error("Playlist " + res.statusCode));
        }
      });
    }).on("error", reject);
  });
}

function fetchSegment(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      // Просто читаем данные и выбрасываем — нам нужен только факт запроса
      res.on("data", () => {});
      res.on("end", () => resolve(true));
    }).on("error", () => resolve(false));
  });
}

function startWatching(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;

  // Получаем токен и плейлист, потом запрашиваем сегменты каждые 10 сек
  getStreamToken(channel, token).then(tokenData => {
    return getPlaylist(channel, tokenData);
  }).then(playlistUrl => {
    if (!playlistUrl) return;

    // Запрашиваем плейлист каждые 15 сек (имитация просмотра)
    const interval = setInterval(() => {
      // Запрашиваем плейлист чтобы Twitch считал нас зрителем
      https.get(playlistUrl, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          // Берём последний сегмент и запрашиваем его
          const lines = data.split("\n").filter(l => l.startsWith("http"));
          if (lines.length > 0) {
            fetchSegment(lines[lines.length - 1]);
          }
        });
      }).on("error", () => {});
    }, 15000);

    streamWatchers.set(account.id, interval);
    console.log(`[HLS] ${account.login} смотрит поток`);
  }).catch(err => {
    console.log(`[HLS] ${account.login}: ${err.message}`);
  });
}

function stopWatching(id) {
  const interval = streamWatchers.get(id);
  if (interval) {
    clearInterval(interval);
    streamWatchers.delete(id);
  }
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
  try {
    const accounts = db.getEnabledAccounts();
    if (accounts.length === 0) { console.log("[START] Нет аккаунтов"); return; }

    const channel = db.getSetting("channel");
    if (!channel) { console.log("[START] Канал не задан"); return; }

    // Сначала сбрасываем всех
    disconnectAll();

    db.setSetting("running", "1");
    db.addLog("system", "СТАРТ — заходим на " + channel);

    const interval = (parseInt(db.getSetting("join_interval")) || 3) * 60 * 1000;
    const now = Date.now();

    accounts.forEach((acc, i) => {
      const joinAt = now + i * interval;
      db.setPhase(acc.id, "waiting_join", joinAt);
      db.setStatus(acc.id, "ожидание");
    });

    console.log(`[START] ${accounts.length} аккаунтов, интервал ${interval / 60000} мин`);
    startLoop();
  } catch (err) {
    console.error("[START ERROR]", err.message);
    db.addLog("error", "start: " + err.message);
  }
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
