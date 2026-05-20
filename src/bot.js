const tmi = require("tmi.js");
const initCycleTLS = require("cycletls");
const crypto = require("crypto");
const db = require("./database");
const proxyPool = require("./proxy-pool");

const clients = new Map();
const watchers = new Map();
let loopTimer = null;

// CycleTLS — единый клиент с TLS fingerprint реального Chrome.
// Это обходит JA3 fingerprinting Twitch.
let cycleTLS = null;

async function initTLS() {
  if (cycleTLS) return cycleTLS;
  cycleTLS = await initCycleTLS();
  console.log("[TLS] CycleTLS клиент инициализирован (Chrome JA3)");
  return cycleTLS;
}

// Уникальный device-id для каждого аккаунта
const deviceIds = new Map();
function getDeviceId(accountId) {
  if (!deviceIds.has(accountId)) {
    deviceIds.set(accountId, crypto.randomBytes(16).toString("hex"));
  }
  return deviceIds.get(accountId);
}

// JA3 fingerprint реального Chrome 124
const CHROME_JA3 = "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// === HTTP запросы через CycleTLS ===
async function tlsRequest(url, options, account) {
  const tls = await initTLS();
  const proxy = account && account.proxy ? account.proxy : "";

  const headers = Object.assign({
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.twitch.tv",
    "Referer": "https://www.twitch.tv/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  }, options.headers || {});

  return tls(url, {
    body: options.body || "",
    ja3: CHROME_JA3,
    userAgent: UA,
    headers,
    proxy: proxy ? buildProxyUrl(proxy) : "",
    timeout: 15,
    method: options.method || "GET",
  });
}

function buildProxyUrl(proxyStr) {
  // Поддержка форматов: host:port:user:pass, user:pass@host:port, host:port@user:pass
  const p = proxyStr.trim();
  if (/^https?:\/\//i.test(p)) return p;

  if (p.includes("@")) {
    const at = p.lastIndexOf("@");
    const left = p.slice(0, at);
    const right = p.slice(at + 1);
    const leftParts = left.split(":");
    const rightParts = right.split(":");
    const leftPort = parseInt(leftParts[1], 10);
    const rightPort = parseInt(rightParts[1], 10);
    const leftIsHostPort = leftParts.length === 2 && !isNaN(leftPort) && leftPort > 0 && leftPort < 65536;

    if (leftIsHostPort) {
      // host:port@user:pass
      return `http://${rightParts[0]}:${rightParts.slice(1).join(":")}@${leftParts[0]}:${leftPort}`;
    } else {
      // user:pass@host:port
      return `http://${left}@${right}`;
    }
  }

  const parts = p.split(":");
  if (parts.length >= 4) {
    return `http://${parts[2]}:${parts.slice(3).join(":")}@${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 2) {
    return `http://${parts[0]}:${parts[1]}`;
  }
  return "";
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

// === HLS С TLS FINGERPRINT ===
async function getAccessToken(channel, oauthToken, account) {
  const cleanToken = oauthToken.replace("oauth:", "");
  const body = JSON.stringify({
    operationName: "PlaybackAccessToken_Template",
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } }',
    variables: { isLive: true, login: channel, playerType: "site" },
  });

  const res = await tlsRequest("https://gql.twitch.tv/gql", {
    method: "POST",
    body,
    headers: {
      "Client-Id": CLIENT_ID,
      "Authorization": "OAuth " + cleanToken,
      "Content-Type": "application/json",
      "X-Device-Id": getDeviceId(account.id),
    },
  }, account);

  // CycleTLS может вернуть body как object (JSON автопарсинг) или как string
  let json;
  if (typeof res.body === "object" && res.body !== null) {
    json = res.body;
  } else if (typeof res.body === "string" && res.body.trim()) {
    try { json = JSON.parse(res.body); }
    catch (e) {
      throw new Error(`Bad JSON (status ${res.status}): ${res.body.substring(0, 100)}`);
    }
  } else {
    throw new Error(`Empty response (status ${res.status})`);
  }

  if (json.data && json.data.streamPlaybackAccessToken) {
    return json.data.streamPlaybackAccessToken;
  }
  throw new Error(`No token (status ${res.status}): ${JSON.stringify(json).substring(0, 200)}`);
}

async function getMasterPlaylist(channel, tokenData, account) {
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
  });

  const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params.toString()}`;
  const res = await tlsRequest(url, { method: "GET" }, account);

  if (res.status !== 200) throw new Error("Playlist: " + res.status);

  const text = typeof res.body === "string" ? res.body : (res.body ? JSON.stringify(res.body) : "");
  if (!text) throw new Error("Playlist: empty body (status " + res.status + ")");

  const lines = text.split("\n");
  let audioOnly = null;
  let lowest = null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("audio_only")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("http")) { audioOnly = lines[j].trim(); break; }
      }
    }
    if (lines[i].startsWith("http") && !lowest) {
      lowest = lines[i].trim();
    }
  }
  return audioOnly || lowest;
}

async function startHLS(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;
  if (watchers.has(account.id)) return;

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;
  let proxyLabel = " [no proxy]";
  if (account.proxy) {
    const p = account.proxy.split("@")[0];
    proxyLabel = ` [${account.proxy.length > 40 ? account.proxy.slice(0, 40) + "..." : account.proxy}]`;
  }

  try {
    const tokenData = await getAccessToken(channel, token, account);
    const mediaPlaylistUrl = await getMasterPlaylist(channel, tokenData, account);

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
        const res = await tlsRequest(mediaPlaylistUrl, { method: "GET" }, account);
        if (res.status !== 200) {
          errorCount++;
          if (errorCount >= 5) {
            stopHLS(account.id);
            setTimeout(() => startHLS(account), 15000 + rand(0, 5000));
          }
          return;
        }
        errorCount = 0;

        const text = typeof res.body === "string" ? res.body : "";
        const lines = text.split("\n");
        let newestSegment = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line && !line.startsWith("#")) { newestSegment = line; break; }
        }

        if (newestSegment && newestSegment !== lastSegment) {
          lastSegment = newestSegment;
          // Скачиваем сегмент через TLS — Twitch видит запрос как от Chrome
          downloadSegment(newestSegment, account);
        }
      } catch (e) {
        errorCount++;
        if (errorCount >= 5) stopHLS(account.id);
      }
    }, 15000);

    watchers.set(account.id, { timer });
  } catch (err) {
    console.log(`[HLS] ${account.login}: ${err.message}${proxyLabel}`);
    if (account.proxy) {
      proxyPool.markBad(account.proxy);
      const newProxy = proxyPool.getProxy(account.id);
      if (newProxy && newProxy !== account.proxy) {
        db.setProxy(account.id, newProxy);
        console.log(`[HLS] ${account.login}: сменили прокси`);
        const updatedAccount = db.getAccountById(account.id);
        setTimeout(() => startHLS(updatedAccount), 3000);
      }
    }
  }
}

async function downloadSegment(url, account) {
  try {
    await tlsRequest(url, {
      method: "GET",
      headers: { "Range": "bytes=0-511" },
    }, account);
  } catch (e) {}
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
