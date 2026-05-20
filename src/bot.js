const tmi = require("tmi.js");
const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const db = require("./database");
const proxyPool = require("./proxy-pool");

const clients = new Map();
const watchers = new Map();
let loopTimer = null;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// === ПРОКСИ ===
function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  const p = proxyStr.trim();

  if (/^(https?|socks[45]):\/\//i.test(p)) {
    try {
      const u = new URL(p);
      let type = u.protocol.replace(":", "").toLowerCase();
      if (type === "https") type = "http";
      return {
        type,
        host: u.hostname,
        port: parseInt(u.port, 10),
        user: u.username ? decodeURIComponent(u.username) : null,
        pass: u.password ? decodeURIComponent(u.password) : null,
      };
    } catch (e) { return null; }
  }

  if (p.includes("@")) {
    const at = p.lastIndexOf("@");
    const auth = p.slice(0, at);
    const hp = p.slice(at + 1);
    const ai = auth.indexOf(":");
    const user = ai > -1 ? auth.slice(0, ai) : auth;
    const pass = ai > -1 ? auth.slice(ai + 1) : "";
    const [ip, port] = hp.split(":");
    return { type: "http", host: ip, port: parseInt(port, 10), user, pass };
  }

  const parts = p.split(":");
  if (parts.length >= 4) return { type: "http", host: parts[0], port: parseInt(parts[1], 10), user: parts[2], pass: parts.slice(3).join(":") };
  if (parts.length === 2) return { type: "http", host: parts[0], port: parseInt(parts[1], 10), user: null, pass: null };
  return null;
}

function createAgent(proxyStr) {
  const proxy = parseProxy(proxyStr);
  if (!proxy || !proxy.host || !proxy.port) return null;
  const auth = proxy.user ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass || "")}@` : "";
  if (proxy.type === "socks4" || proxy.type === "socks5") {
    return new SocksProxyAgent(`${proxy.type}://${auth}${proxy.host}:${proxy.port}`);
  }
  return new HttpsProxyAgent(`http://${auth}${proxy.host}:${proxy.port}`);
}

// === HTTPS с прокси ===
// maxBytes — лимит на чтение ответа (экономия трафика)
function httpsRequestProxy(options, postData, agent, maxBytes) {
  return new Promise((resolve, reject) => {
    if (agent) options.agent = agent;
    const req = https.request(options, (res) => {
      let data = "";
      let bytes = 0;
      const limit = maxBytes || 32768;
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > limit) { res.destroy(); return; }
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, data }));
      res.on("error", () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

function httpsGetProxy(url, agent, maxBytes) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      timeout: 15000,
    };
    if (agent) reqOpts.agent = agent;

    const req = https.request(reqOpts, (res) => {
      let data = "";
      let bytes = 0;
      const limit = maxBytes || 32768;
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > limit) { res.destroy(); return; }
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, data }));
      res.on("error", () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
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
  for (const [id] of clients) disconnect(id);
  db.resetAll();
}

// === HLS С ПРОКСИ ===

// Кэш access token на уровне канала (все боты смотрят один канал).
// Живёт 3 часа — экономит 18 из 19 запросов при старте.
let tokenCache = { channel: null, data: null, expires: 0 };

function getAccessToken(channel, oauthToken, agent) {
  const now = Date.now();
  if (tokenCache.channel === channel && tokenCache.expires > now) {
    return Promise.resolve(tokenCache.data);
  }

  const cleanToken = oauthToken.replace("oauth:", "");
  const body = JSON.stringify({
    operationName: "PlaybackAccessToken_Template",
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }}',
    variables: { isLive: true, login: channel, isVod: false, vodID: "", playerType: "site" },
  });

  return httpsRequestProxy({
    hostname: "gql.twitch.tv",
    path: "/gql",
    method: "POST",
    headers: {
      "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
      "Authorization": "OAuth " + cleanToken,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    }
  }, body, agent, 16384).then(res => {
    const json = JSON.parse(res.data);
    if (json.data && json.data.streamPlaybackAccessToken) {
      tokenCache = { channel, data: json.data.streamPlaybackAccessToken, expires: now + 3 * 60 * 60 * 1000 };
      return tokenCache.data;
    }
    throw new Error("No token: " + res.data.substring(0, 80));
  });
}

function getMasterPlaylist(channel, tokenData, agent) {
  const params = new URLSearchParams({
    allow_source: "true",
    allow_audio_only: "true",
    sig: tokenData.signature,
    token: tokenData.value,
    p: String(rand(100000, 9999999)),
    player: "twitchweb",
    type: "any",
  });

  const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params.toString()}`;
  // Лимит 16 КБ — master playlist бывает до 10 КБ, нужен полностью
  return httpsGetProxy(url, agent, 16384).then(res => {
    if (res.status !== 200) throw new Error("Playlist: " + res.status);
    const lines = res.data.split("\n");
    let audioOnly = null;
    const allUrls = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("audio_only")) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith("http")) { audioOnly = lines[j].trim(); break; }
        }
      } else if (lines[i].startsWith("http")) {
        allUrls.push(lines[i].trim());
      }
    }
    // audio_only — минимум трафика. Если нет — самое низкое качество (последнее в списке).
    const lowest = allUrls.length ? allUrls[allUrls.length - 1] : null;
    return audioOnly || lowest;
  });
}

function startHLS(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;
  if (watchers.has(account.id)) return;

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;
  const agent = account.proxy ? createAgent(account.proxy) : null;

  let proxyLabel = " [no proxy]";
  if (account.proxy) {
    const pp = parseProxy(account.proxy);
    proxyLabel = pp ? ` [${pp.type} ${pp.host}:${pp.port}]` : ` [${account.proxy}]`;
  }

  getAccessToken(channel, token, agent)
    .then(tokenData => getMasterPlaylist(channel, tokenData, agent))
    .then(mediaPlaylistUrl => {
      if (!mediaPlaylistUrl) {
        console.log(`[HLS] ${account.login}: нет playlist${proxyLabel}`);
        return;
      }

      console.log(`[HLS] ${account.login} смотрит поток${proxyLabel}`);
      db.addLog("hls", account.login + " смотрит" + proxyLabel);

      let errorCount = 0;
      let lastSegment = "";
      let segmentCounter = 0;

      const timer = setInterval(() => {
        // Media playlist лимит 8 КБ — достаточно для списка сегментов
        httpsGetProxy(mediaPlaylistUrl, agent, 8192).then(res => {
          if (res.status !== 200) {
            errorCount++;
            if (errorCount >= 3) {
              stopHLS(account.id);
              setTimeout(() => startHLS(account), 10000 + rand(0, 5000));
            }
            return;
          }
          errorCount = 0;

          const lines = res.data.split("\n");
          let newestSegment = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line && !line.startsWith("#")) { newestSegment = line; break; }
          }

          if (newestSegment && newestSegment !== lastSegment) {
            lastSegment = newestSegment;
            segmentCounter++;
            // Каждый 2-й сегмент, 128 байт — Twitch засчитывает зрителя.
            // 1 сегмент каждые ~50 сек — попадает в окно обновления счётчика (~2 мин).
            if (segmentCounter % 2 === 0) {
              downloadSegment(newestSegment, agent);
            }
          }
        }).catch(() => {
          errorCount++;
          if (errorCount >= 5) stopHLS(account.id);
        });
      }, 25000); // refresh плейлиста каждые 25 сек

      watchers.set(account.id, { timer });
    })
    .catch(err => {
      console.log(`[HLS] ${account.login}: ${err.message}${proxyLabel}`);
      if (account.proxy) {
        proxyPool.markBad(account.proxy);
        const newProxy = proxyPool.getProxy(account.id);
        if (newProxy && newProxy !== account.proxy) {
          db.setProxy(account.id, newProxy);
          tokenCache = { channel: null, data: null, expires: 0 }; // сброс кэша токена
          const np = parseProxy(newProxy);
          const npLabel = np ? `${np.type} ${np.host}:${np.port}` : newProxy;
          console.log(`[HLS] ${account.login}: сменили прокси на ${npLabel}`);
          const updatedAccount = db.getAccountById(account.id);
          setTimeout(() => startHLS(updatedAccount), 3000);
        }
      }
    });
}

function downloadSegment(url, agent) {
  try {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      timeout: 8000,
      headers: { "Range": "bytes=0-127" }, // только 128 байт
    };
    if (agent) reqOpts.agent = agent;

    const req = https.request(reqOpts, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; if (bytes > 128) res.destroy(); });
      res.on("end", () => {});
      res.on("error", () => {});
    });
    req.on("error", () => {});
    req.end();
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
