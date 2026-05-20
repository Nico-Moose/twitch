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
// Форматы:
//   type://[user:pass@]host:port  (предпочтительный, type = http|socks4|socks5)
//   ip:port
//   ip:port:user:pass
//   user:pass@ip:port
function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  const p = proxyStr.trim();

  // С схемой
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

  // user:pass@host:port
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
function httpsRequestProxy(options, postData, agent) {
  return new Promise((resolve, reject) => {
    if (agent) options.agent = agent;
    const req = https.request(options, (res) => {
      let data = "";
      let bytes = 0;
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 16384) { res.destroy(); return; } // лимит 16 КБ на ответ
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

function httpsGetProxy(url, agent) {
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
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 4096) { res.destroy(); return; } // лимит 4 КБ — плейлист не больше
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

  // tmi.js не поддерживает прокси напрямую, подключаем без прокси (IRC не влияет на viewer count)
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
  for (const [id] of clients) {
    disconnect(id);
  }
  db.resetAll();
}

// === HLS С ПРОКСИ ===

// Кэш access token на уровне канала — все боты смотрят один канал,
// токен одинаковый, нет смысла запрашивать 19 раз.
// Живёт 3 часа (Twitch выдаёт на ~4 часа).
let tokenCache = { channel: null, data: null, expires: 0 };

function getAccessToken(channel, oauthToken, agent) {
  const now = Date.now();
  if (tokenCache.channel === channel && tokenCache.expires > now) {
    return Promise.resolve(tokenCache.data);
  }

  const cleanToken = oauthToken.replace("oauth:", "");
  // Корректный минимальный GraphQL запрос — без $vodID в variables
  const body = JSON.stringify({
    operationName: "PlaybackAccessToken_Template",
    query: 'query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature}}',
    variables: { isLive: true, login: channel, playerType: "site" },
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
  }, body, agent).then(res => {
    const json = JSON.parse(res.data);
    if (json.data && json.data.streamPlaybackAccessToken) {
      tokenCache = { channel, data: json.data.streamPlaybackAccessToken, expires: now + 3 * 60 * 60 * 1000 };
      return tokenCache.data;
    }
    throw new Error("No token: " + res.data.substring(0, 80));
  });
}

function getMasterPlaylist(channel, tokenData, agent) {
  // Минимальный набор параметров — только обязательные sig/token + audio_only
  const params = new URLSearchParams({
    allow_audio_only: "true",
    sig: tokenData.signature,
    token: tokenData.value,
    p: String(rand(100000, 9999999)),
  });

  const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params.toString()}`;
  return httpsGetProxy(url, agent).then(res => {
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
    const lowest = allUrls.length ? allUrls[allUrls.length - 1] : null;
    return audioOnly || lowest;
  });
}

// Кэш media playlist URL: { accountId -> { url, expires } }
const playlistCache = new Map();

function startHLS(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;
  if (watchers.has(account.id)) return;

  const token = account.token.startsWith("oauth:") ? account.token : "oauth:" + account.token;

  // Создаём прокси-агент для этого аккаунта
  const agent = account.proxy ? createAgent(account.proxy) : null;
  // Короткий человекочитаемый лейбл: type host:port
  let proxyLabel = " [no proxy]";
  if (account.proxy) {
    const pp = parseProxy(account.proxy);
    proxyLabel = pp ? ` [${pp.type} ${pp.host}:${pp.port}]` : ` [${account.proxy}]`;
  }

  // Используем кэшированный URL плейлиста если он не старше 90 минут
  // (access token Twitch живёт ~4 часа, но перестрахуемся)
  const cached = playlistCache.get(account.id);
  const now = Date.now();
  const getPlaylistUrl = (cached && cached.expires > now)
    ? Promise.resolve(cached.url)
    : getAccessToken(channel, token, agent)
        .then(tokenData => getMasterPlaylist(channel, tokenData, agent))
        .then(url => {
          playlistCache.set(account.id, { url, expires: now + 90 * 60 * 1000 });
          return url;
        });

  getPlaylistUrl.then(mediaPlaylistUrl => {
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
      httpsGetProxy(mediaPlaylistUrl, agent).then(res => {
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

        // Качаем каждый 2-й новый сегмент по 128 байт через Range.
        // Twitch обновляет счётчик каждые ~2 мин — нужен хотя бы 1 сегмент за это время.
        // При интервале 25 сек и каждом 2-м сегменте = 1 запрос каждые ~50 сек. Достаточно.
        if (newestSegment && newestSegment !== lastSegment) {
          lastSegment = newestSegment;
          segmentCounter++;
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
  }).catch(err => {
    console.log(`[HLS] ${account.login}: ${err.message}${proxyLabel}`);
    // Прокси не работает — помечаем и берём другой из пула
    if (account.proxy) {
      proxyPool.markBad(account.proxy);
      const newProxy = proxyPool.getProxy(account.id);
      if (newProxy && newProxy !== account.proxy) {
        db.setProxy(account.id, newProxy);
        playlistCache.delete(account.id); // сбрасываем кэш — новый прокси, новый агент
        const np = parseProxy(newProxy);
        const npLabel = np ? `${np.type} ${np.host}:${np.port}` : newProxy;
        console.log(`[HLS] ${account.login}: сменили прокси на ${npLabel}`);
        // Пробуем с новым прокси
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
      // Range: 0-511 — просим только первые 512 байт. Twitch отдаёт 206 Partial Content,
      // зритель засчитывается, а трафик минимален.
      headers: { "Range": "bytes=0-127" },
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
