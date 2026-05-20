const tmi = require("tmi.js");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const db = require("./database");
const proxyPool = require("./proxy-pool");

const clients = new Map();
const watchers = new Map();
let loopTimer = null;

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Парсим прокси в URL — поддерживаем все форматы
function buildProxyUrl(proxyStr) {
  const p = (proxyStr || "").trim();
  if (!p) return null;
  if (/^socks[45]:\/\//i.test(p)) return p;
  if (/^https?:\/\//i.test(p)) return p.replace(/^https:\/\//i, "http://");

  if (p.includes("@")) {
    const at = p.lastIndexOf("@");
    const left = p.slice(0, at);
    const right = p.slice(at + 1);
    const leftParts = left.split(":");
    const leftPort = parseInt(leftParts[1], 10);
    const leftIsHostPort = leftParts.length === 2 && !isNaN(leftPort) && leftPort > 0 && leftPort < 65536;
    if (leftIsHostPort) {
      // host:port@user:pass
      const rightParts = right.split(":");
      return `http://${encodeURIComponent(rightParts[0])}:${encodeURIComponent(rightParts.slice(1).join(":"))}@${leftParts[0]}:${leftPort}`;
    } else {
      // user:pass@host:port
      return `http://${left}@${right}`;
    }
  }

  const parts = p.split(":");
  if (parts.length >= 4) return `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts.slice(3).join(":"))}@${parts[0]}:${parts[1]}`;
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return null;
}

// HTTPS запрос с опциональным прокси
function httpsPost(hostname, path, body, headers, proxyUrl) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      timeout: 15000,
    };
    if (proxyUrl) opts.agent = new HttpsProxyAgent(proxyUrl);

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

function httpsGet(url, proxyUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
      }
    };
    if (proxyUrl) opts.agent = new HttpsProxyAgent(proxyUrl);

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// === IRC ===
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
  if (client) { client.disconnect().catch(() => {}); clients.delete(id); }
  stopHLS(id);
  db.setStatus(id, "offline");
}

function disconnectAll() {
  for (const [id] of clients) disconnect(id);
  db.resetAll();
}

// === HLS ===
async function getAccessToken(channel, oauthToken, proxyUrl) {
  const cleanToken = oauthToken.replace("oauth:", "");
  const body = JSON.stringify({
    operationName: "PlaybackAccessToken_Template",
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature } }',
    variables: { isLive: true, login: channel, isVod: false, vodID: "", playerType: "site" }
  });

  const res = await httpsPost("gql.twitch.tv", "/gql", body, {
    "Client-Id": CLIENT_ID,
    "Authorization": "OAuth " + cleanToken,
    "Content-Type": "application/json",
  }, proxyUrl);

  const json = JSON.parse(res.data);
  if (json.data && json.data.streamPlaybackAccessToken) {
    return json.data.streamPlaybackAccessToken;
  }
  throw new Error(`No token (${res.status}): ${res.data.substring(0, 100)}`);
}

async function getMasterPlaylist(channel, tokenData, proxyUrl) {
  const params = new URLSearchParams({
    allow_source: "true", allow_audio_only: "true", allow_spectre: "true",
    p: String(rand(100000, 9999999)), player: "twitchweb",
    playlist_include_framerate: "true", segment_preference: "4",
    sig: tokenData.signature, token: tokenData.value, type: "any",
  });

  const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params.toString()}`;
  const res = await httpsGet(url, proxyUrl);
  if (res.status !== 200) throw new Error("Playlist: " + res.status);

  const lines = res.data.split("\n");
  let audioOnly = null, lowest = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("audio_only")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("http")) { audioOnly = lines[j].trim(); break; }
      }
    }
    if (lines[i].startsWith("http") && !lowest) lowest = lines[i].trim();
  }
  return audioOnly || lowest;
}

async function startHLS(account) {
  const channel = db.getSetting("channel");
  if (!channel || watchers.has(account.id)) return;

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;
  const proxyUrl = account.proxy ? buildProxyUrl(account.proxy) : null;
  const proxyLabel = account.proxy ? ` [${account.proxy.slice(0, 30)}]` : " [no proxy]";

  try {
    const tokenData = await getAccessToken(channel, token, proxyUrl);
    const mediaPlaylistUrl = await getMasterPlaylist(channel, tokenData, proxyUrl);

    if (!mediaPlaylistUrl) {
      console.log(`[HLS] ${account.login}: нет playlist${proxyLabel}`);
      return;
    }

    console.log(`[HLS] ${account.login} смотрит поток${proxyLabel}`);
    db.addLog("hls", account.login + " смотрит" + proxyLabel);

    let errorCount = 0;
    let lastSegment = "";

    const timer = setInterval(async () => {
      try {
        const res = await httpsGet(mediaPlaylistUrl, proxyUrl);
        if (res.status !== 200) {
          errorCount++;
          if (errorCount >= 5) { stopHLS(account.id); setTimeout(() => startHLS(account), 15000); }
          return;
        }
        errorCount = 0;

        const lines = res.data.split("\n");
        let seg = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (l && !l.startsWith("#")) { seg = l; break; }
        }

        if (seg && seg !== lastSegment) {
          lastSegment = seg;
          // Скачиваем первые 16KB сегмента
          httpsGet(seg, proxyUrl).catch(() => {});
        }
      } catch (e) {
        errorCount++;
        if (errorCount >= 5) stopHLS(account.id);
      }
    }, 10000);

    watchers.set(account.id, { timer });
  } catch (err) {
    console.log(`[HLS] ${account.login}: ${err.message}${proxyLabel}`);
    if (account.proxy) {
      proxyPool.markBad(account.proxy);
      const newProxy = proxyPool.getProxy(account.id);
      if (newProxy && newProxy !== account.proxy) {
        db.setProxy(account.id, newProxy);
        const updated = db.getAccountById(account.id);
        setTimeout(() => startHLS(updated), 3000);
      }
    }
  }
}

function stopHLS(id) {
  const w = watchers.get(id);
  if (w) { clearInterval(w.timer); watchers.delete(id); }
}

// === ЦИКЛ ===
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
      db.setPhase(acc.id, "waiting_join", now + i * interval);
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

function startLoop() { if (loopTimer) return; loopTimer = setInterval(tick, 15000); tick(); }
function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }

function tick() {
  if (db.getSetting("running") !== "1") return;
  const now = Date.now();
  const accounts = db.getEnabledAccounts();

  accounts.forEach(acc => {
    if (acc.next_action === 0 || now < acc.next_action) return;
    if (acc.phase === "waiting_join") {
      connect(acc);
      db.setPhase(acc.id, "watching", now + rand(10, 30) * 60 * 1000);
    } else if (acc.phase === "watching") {
      disconnect(acc.id);
      db.setPhase(acc.id, "afk", now + rand(5, 15) * 60 * 1000);
      db.setStatus(acc.id, "афк");
      db.addLog("afk", acc.login + " АФК");
    } else if (acc.phase === "afk") {
      connect(acc);
      db.setPhase(acc.id, "watching", now + rand(10, 30) * 60 * 1000);
      db.addLog("join", acc.login + " вернулся");
    }
  });
}

function connectNow(id) {
  const account = db.getAccountById(id);
  if (!account) return;
  connect(account);
  db.setPhase(id, "watching", Date.now() + rand(10, 30) * 60 * 1000);
  db.addLog("join", account.login + " запущен вручную");
}

function sendMessage(id, message) {
  const client = clients.get(id);
  if (!client) return Promise.resolve({ ok: false, error: "Не подключен" });
  const channel = db.getSetting("channel");
  return client.say(channel, message).then(() => {
    db.addLog("chat", db.getAccountById(id).login + ": " + message);
    return { ok: true };
  }).catch(err => ({ ok: false, error: err.message }));
}

if (db.getSetting("running") === "1") { console.log("[RESUME]"); startLoop(); }

module.exports = { start, stop, disconnect, disconnectAll, sendMessage, connectNow, clients };
