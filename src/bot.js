const tmi = require("tmi.js");
const https = require("https");
const db = require("./database");

const clients = new Map(); // id -> tmi.Client
const watchers = new Map(); // id -> { timer, token }
let loopTimer = null;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// === HTTPS запрос ===
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    }).on("error", reject);
  });
}

// === IRC ПОДКЛЮЧЕНИЕ ===
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
    // Запускаем HLS просмотр
    startHLS(account);
  }).catch(err => {
    db.setStatus(account.id, "error");
    console.log(`[!] ${account.login}: ${err.message}`);
    db.addLog("error", account.login + ": " + err.message);
  });

  clients.set(account.id, client);
}

function disconnect(id) {
  const client = clients.get(id);
  if (client) {
    client.disconnect().catch(() => {});
    clients.delete(id);
  }
  stopHLS(id);
  db.setStatus(id, "offline");
}

function disconnectAll() {
  for (const [id] of clients) {
    disconnect(id);
  }
  db.resetAll();
}

// === HLS ПРОСМОТР (это то что увеличивает viewer count) ===

// Шаг 1: Получить access token через GQL
function getAccessToken(channel, oauthToken) {
  const cleanToken = oauthToken.replace("oauth:", "");
  const body = JSON.stringify({
    operationName: "PlaybackAccessToken_Template",
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}',
    variables: {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: "",
      playerType: "site"
    }
  });

  return httpsRequest({
    hostname: "gql.twitch.tv",
    path: "/gql",
    method: "POST",
    headers: {
      "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
      "Authorization": "OAuth " + cleanToken,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    }
  }, body).then(res => {
    const json = JSON.parse(res.data);
    if (json.data && json.data.streamPlaybackAccessToken) {
      return json.data.streamPlaybackAccessToken;
    }
    throw new Error("No access token: " + res.data.substring(0, 100));
  });
}

// Шаг 2: Получить master playlist (список качеств)
function getMasterPlaylist(channel, tokenData) {
  const params = new URLSearchParams({
    allow_source: "true",
    allow_audio_only: "true",
    allow_spectre: "true",
    p: String(rand(100000, 9999999)),
    player: "twitchweb",
    playlist_include_framerate: "true",
    segment_preference: "4",
    sig: tokenData.signature,
    token: tokenData.value,
    type: "any",
    referrer: "https://www.twitch.tv",
  });

  const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params.toString()}`;
  return httpsGet(url).then(res => {
    if (res.status !== 200) throw new Error("Master playlist: " + res.status);
    // Парсим — берём audio_only или самое низкое качество
    const lines = res.data.split("\n");
    let audioOnly = null;
    let lowest = null;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("audio_only") && i + 1 < lines.length) {
        // Следующая строка после audio_only — URL
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith("http")) { audioOnly = lines[j].trim(); break; }
        }
      }
      if (lines[i].startsWith("http") && !lowest) {
        lowest = lines[i].trim();
      }
    }

    // Предпочитаем audio_only (минимум трафика)
    return audioOnly || lowest;
  });
}

// Шаг 3: Запрашивать media playlist каждые 10 сек
function startHLS(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;

  // Не запускаем если уже смотрит
  if (watchers.has(account.id)) return;

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;

  getAccessToken(channel, token).then(tokenData => {
    return getMasterPlaylist(channel, tokenData);
  }).then(mediaPlaylistUrl => {
    if (!mediaPlaylistUrl) {
      console.log(`[HLS] ${account.login}: нет playlist URL (стрим оффлайн?)`);
      return;
    }

    console.log(`[HLS] ${account.login} смотрит поток`);
    db.addLog("hls", account.login + " смотрит поток");

    let errorCount = 0;

    // Каждые 10 сек запрашиваем media playlist
    const timer = setInterval(() => {
      httpsGet(mediaPlaylistUrl).then(res => {
        if (res.status !== 200) {
          errorCount++;
          if (errorCount >= 3) {
            // Плейлист протух — переподключаемся
            console.log(`[HLS] ${account.login}: переподключение`);
            stopHLS(account.id);
            setTimeout(() => startHLS(account), 10000 + rand(0, 5000));
          }
        } else {
          errorCount = 0; // сброс при успехе
        }
      }).catch(() => {
        errorCount++;
        if (errorCount >= 5) {
          stopHLS(account.id);
        }
      });
    }, 10000);

    watchers.set(account.id, { timer });

  }).catch(err => {
    console.log(`[HLS] ${account.login}: ${err.message}`);
  });
}

function stopHLS(id) {
  const w = watchers.get(id);
  if (w) {
    clearInterval(w.timer);
    watchers.delete(id);
  }
}

// === ГЛАВНЫЙ ЦИКЛ ===
function start() {
  try {
    const accounts = db.getEnabledAccounts();
    if (accounts.length === 0) { console.log("[START] Нет аккаунтов"); return; }

    const channel = db.getSetting("channel");
    if (!channel) { console.log("[START] Канал не задан"); return; }

    disconnectAll();

    db.setSetting("running", "1");
    db.addLog("system", "СТАРТ — " + channel);

    const interval = (parseInt(db.getSetting("join_interval")) || 3) * 60 * 1000;
    const now = Date.now();

    accounts.forEach((acc, i) => {
      const joinAt = now + i * interval;
      db.setPhase(acc.id, "waiting_join", joinAt);
      db.setStatus(acc.id, "ожидание");
    });

    console.log(`[START] ${accounts.length} акк, интервал ${interval / 60000} мин`);
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
  db.addLog("system", "СТОП");
  console.log("[STOP]");
}

function startLoop() {
  if (loopTimer) return;
  loopTimer = setInterval(tick, 15000);
  tick();
}

function stopLoop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

function tick() {
  if (db.getSetting("running") !== "1") return;

  const now = Date.now();
  const accounts = db.getEnabledAccounts();

  accounts.forEach(acc => {
    if (acc.next_action === 0) return;
    if (now < acc.next_action) return;

    if (acc.phase === "waiting_join") {
      connect(acc);
      const watchTime = rand(10, 30) * 60 * 1000;
      db.setPhase(acc.id, "watching", now + watchTime);
      console.log(`[>] ${acc.login} смотрит ${Math.round(watchTime / 60000)} мин`);
    }
    else if (acc.phase === "watching") {
      disconnect(acc.id);
      const afkTime = rand(5, 15) * 60 * 1000;
      db.setPhase(acc.id, "afk", now + afkTime);
      db.setStatus(acc.id, "афк");
      console.log(`[<] ${acc.login} АФК ${Math.round(afkTime / 60000)} мин`);
      db.addLog("afk", acc.login + " АФК");
    }
    else if (acc.phase === "afk") {
      connect(acc);
      const watchTime = rand(10, 30) * 60 * 1000;
      db.setPhase(acc.id, "watching", now + watchTime);
      console.log(`[>] ${acc.login} вернулся ${Math.round(watchTime / 60000)} мин`);
      db.addLog("join", acc.login + " вернулся");
    }
  });
}

// Чат
function sendMessage(id, message) {
  const client = clients.get(id);
  if (!client) return Promise.resolve({ ok: false, error: "Не подключен" });
  const channel = db.getSetting("channel");
  return client.say(channel, message).then(() => {
    db.addLog("chat", db.getAccountById(id).login + ": " + message);
    return { ok: true };
  }).catch(err => ({ ok: false, error: err.message }));
}

// Авто-возобновление
if (db.getSetting("running") === "1") {
  console.log("[RESUME] Продолжаем");
  startLoop();
}

// Подключить одного сразу (без ожидания) и дать рандомный таймер просмотра
function connectNow(id) {
  const account = db.getAccountById(id);
  if (!account) return;
  connect(account);
  const watchTime = rand(10, 30) * 60 * 1000;
  db.setPhase(id, "watching", Date.now() + watchTime);
  console.log(`[>] ${account.login} запущен вручную, смотрит ${Math.round(watchTime / 60000)} мин`);
  db.addLog("join", account.login + " запущен вручную");
}

module.exports = { start, stop, disconnect, disconnectAll, sendMessage, connectNow, clients };
