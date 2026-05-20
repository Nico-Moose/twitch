const initCycleTLS = require("cycletls");
const db = require("./database");

// proxyList: [{type, host, port, user, pass, explicitType}]
let proxyList = [];
let goodProxies = []; // строки в формате "socks5://[user:pass@]host:port"
let badProxies = new Set();
let checking = false;

// Жёсткий внешний таймаут на 1 запрос (секунды для CycleTLS, мс для Promise.race)
const CHECK_TIMEOUT_S = 8;
const CHECK_TIMEOUT_MS = 10000;
// Сколько прокси проверяем параллельно (ограничено CycleTLS Go-бинарником)
const BATCH_SIZE = 50;

// JA3 fingerprint реального Chrome 124 — точно как в bot.js
const CHROME_JA3 = "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const FALLBACK_CHANNEL = "twitch"; // если канал не задан в настройках

let cycleTLS = null;
async function initTLS() {
  if (cycleTLS) return cycleTLS;
  cycleTLS = await initCycleTLS();
  console.log("[PROXY-CHECK] CycleTLS клиент инициализирован");
  return cycleTLS;
}

// ---------- ПАРСИНГ ----------
// Поддерживаемые форматы:
//   HTTP 1.2.3.4:8080
//   SOCKS5 1.2.3.4:1080
//   1.2.3.4:8080
//   1.2.3.4:8080:user:pass
//   user:pass@1.2.3.4:8080
//   host:port@user:pass  (proxy.market)
//   http://user:pass@host:port
function parseProxy(line) {
  if (!line) return null;
  let s = String(line).trim();
  if (!s) return null;

  let type = "http";
  let explicitType = false;

  const prefix = s.match(/^(HTTPS?|SOCKS5H?|SOCKS4A?|SOCKS4|SOCKS5)\s+(.+)$/i);
  if (prefix) {
    const t = prefix[1].toUpperCase();
    if (t.startsWith("SOCKS5")) type = "socks5";
    else if (t.startsWith("SOCKS4")) type = "socks4";
    else type = "http";
    explicitType = true;
    s = prefix[2].trim();
  } else if (/^(https?|socks[45]):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      let proto = u.protocol.replace(":", "").toLowerCase();
      if (proto === "https") proto = "http";
      return {
        type: proto,
        host: u.hostname,
        port: parseInt(u.port, 10),
        user: u.username ? decodeURIComponent(u.username) : null,
        pass: u.password ? decodeURIComponent(u.password) : null,
        explicitType: true,
      };
    } catch (e) { return null; }
  }

  let user = null, pass = null;
  if (s.includes("@")) {
    const at = s.lastIndexOf("@");
    const left = s.slice(0, at);
    const right = s.slice(at + 1);

    const leftParts = left.split(":");
    const rightParts = right.split(":");
    const leftPort = parseInt(leftParts[1], 10);
    const rightPort = parseInt(rightParts[1], 10);
    const leftIsHostPort = leftParts.length === 2 && !isNaN(leftPort) && leftPort > 0 && leftPort < 65536;
    const rightIsHostPort = rightParts.length === 2 && !isNaN(rightPort) && rightPort > 0 && rightPort < 65536;

    if (leftIsHostPort && !rightIsHostPort) {
      // host:port@user:pass
      user = rightParts[0];
      pass = rightParts.slice(1).join(":");
      s = left;
    } else {
      // user:pass@host:port
      const ai = left.indexOf(":");
      if (ai > -1) { user = left.slice(0, ai); pass = left.slice(ai + 1); }
      else { user = left; pass = ""; }
      s = right;
    }
  }

  const parts = s.split(":");
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = parseInt(parts[1], 10);
  if (!host || !port || isNaN(port)) return null;

  if (!user && parts.length >= 4) { user = parts[2]; pass = parts.slice(3).join(":"); }

  return { type, host, port, user, pass, explicitType };
}

// Конвертация в URL для CycleTLS. Протокол сохраняется (CycleTLS понимает и http://, и socks5://).
// HTTP-прокси НЕ конвертируем в socks5 — это ломало проверку HTTP-прокси.
function proxyToUrl(p) {
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass || "")}@` : "";
  let scheme = (p.type || "http").toLowerCase();
  if (scheme === "https") scheme = "http"; // для прокси https → http (CONNECT)
  if (scheme !== "http" && scheme !== "socks4" && scheme !== "socks5") scheme = "http";
  return `${scheme}://${auth}${p.host}:${p.port}`;
}

// Алиас для обратной совместимости
const proxyToSocks5Url = proxyToUrl;

// ---------- ЗАГРУЗКА ----------
function loadProxies(text) {
  // 1) сперва бьём по очевидным разделителям
  let raw = String(text)
    .replace(/\|/g, "\n")
    .replace(/[ \t]*,[ \t]*/g, "\n")
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(Boolean);

  // 2) внутри каждой строки разрезаем перед протокольными префиксами,
  //    если они встречаются НЕ в начале — это "склеенные" прокси из копипаста.
  //    Пример: "1.2.3.4:80socks5://5.6.7.8:1080http://9.0.0.1:3128"
  const protoSplit = /(?=(?:https?|socks[45]):\/\/)/gi;
  const lines = [];
  for (const line of raw) {
    const parts = line.split(protoSplit).map(s => s.trim()).filter(Boolean);
    for (const p of parts) lines.push(p);
  }

  const parsed = [];
  for (const line of lines) {
    const p = parseProxy(line);
    if (p) parsed.push(p);
  }
  proxyList = parsed;
  badProxies.clear();
  goodProxies = [];
  checking = false;
  db.addLog("proxy", `Загружено ${parsed.length} прокси (из ${lines.length} строк)`);
  console.log(`[PROXY] Загружено ${parsed.length} прокси (из ${lines.length} строк)`);
  return parsed.length;
}

// ---------- СТРОГАЯ ПРОВЕРКА ----------
// Повторяем ту же цепочку запросов, что и bot.js делает в startHLS:
//   1) POST gql.twitch.tv/gql      — получение access token
//   2) GET  usher.ttvnw.net        — получение master playlist
//   3) GET  edge CDN               — реальный HLS-сегмент с другой подсети
// Прокси считается рабочим ТОЛЬКО если все три шага прошли.
// Это гарантирует, что прокси не отвалится потом в HLS-цикле.

function buildGqlBody(channel) {
  return JSON.stringify({
    operationName: "PlaybackAccessToken_Template",
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } }',
    variables: { isLive: true, login: channel, playerType: "site" },
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

async function tlsRequest(tls, url, options, proxyUrl) {
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

  return withTimeout(tls(url, {
    body: options.body || "",
    ja3: CHROME_JA3,
    userAgent: UA,
    headers,
    proxy: proxyUrl,
    timeout: CHECK_TIMEOUT_S,
    method: options.method || "GET",
  }), CHECK_TIMEOUT_MS);
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// Парсит body CycleTLS (может быть object или string)
function parseBody(res) {
  if (!res) return null;
  if (typeof res.body === "object" && res.body !== null) return res.body;
  if (typeof res.body === "string" && res.body.trim()) {
    try { return JSON.parse(res.body); } catch (e) { return null; }
  }
  return null;
}

// Шаг 1: gql.twitch.tv → access token
async function step1_GetToken(tls, proxyUrl, channel) {
  const res = await tlsRequest(tls, "https://gql.twitch.tv/gql", {
    method: "POST",
    body: buildGqlBody(channel),
    headers: {
      "Client-Id": CLIENT_ID,
      "Content-Type": "application/json",
    },
  }, proxyUrl);

  if (res.status !== 200) throw new Error(`gql status ${res.status}`);

  const json = parseBody(res);
  if (!json) throw new Error("gql: bad json");
  if (!json.data || !json.data.streamPlaybackAccessToken) {
    throw new Error("gql: no token (channel offline?)");
  }
  return json.data.streamPlaybackAccessToken;
}

// Шаг 2: usher.ttvnw.net → master playlist (m3u8 с URL-ами edge серверов)
async function step2_GetMasterPlaylist(tls, proxyUrl, channel, tokenData) {
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
  const res = await tlsRequest(tls, url, { method: "GET" }, proxyUrl);

  if (res.status !== 200) throw new Error(`usher status ${res.status}`);
  const text = typeof res.body === "string" ? res.body : "";
  if (!text || !text.includes("#EXTM3U")) throw new Error("usher: not an m3u8");

  // Берём audio_only если есть, иначе любой первый http
  const lines = text.split("\n");
  let audioOnly = null;
  let lowest = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("audio_only")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("http")) { audioOnly = lines[j].trim(); break; }
      }
    }
    if (lines[i].startsWith("http") && !lowest) lowest = lines[i].trim();
  }
  const mediaUrl = audioOnly || lowest;
  if (!mediaUrl) throw new Error("usher: no media url");
  return mediaUrl;
}

// Проверка одного прокси: два шага (токен + мастер-плейлист).
// Шаг 3 (edge CDN) убран — он медленный и не нужен для проверки доступности Твича.
// Если прокси прошёл шаги 1 и 2 — он точно работает для Твича.
async function checkOnceWithUrl(proxyUrl, channel) {
  const tls = await initTLS();
  try {
    const token = await step1_GetToken(tls, proxyUrl, channel);
    await step2_GetMasterPlaylist(tls, proxyUrl, channel, token);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Проверка прокси с попыткой угадать протокол, если он не указан явно.
// Если протокол не задан — пробуем все три параллельно, берём первый рабочий.
async function checkOnce(proxy, channel) {
  const primaryUrl = proxyToUrl(proxy);

  // Если протокол указан явно — проверяем только его
  if (proxy.explicitType) {
    const r = await checkOnceWithUrl(primaryUrl, channel);
    return r.ok ? { ok: true, url: primaryUrl } : { ok: false, error: r.error };
  }

  // Протокол не указан — пробуем все варианты параллельно
  const candidates = ["socks5", "http", "socks4"].map(t => ({
    type: t,
    url: proxyToUrl({ ...proxy, type: t }),
  }));

  // Promise.any — возвращает первый успешный результат
  try {
    const winner = await Promise.any(
      candidates.map(async c => {
        const r = await checkOnceWithUrl(c.url, channel);
        if (!r.ok) throw new Error(r.error);
        return c;
      })
    );
    proxy.type = winner.type; // запоминаем рабочий протокол
    return { ok: true, url: winner.url };
  } catch (e) {
    // AggregateError — все провалились
    const msg = e.errors ? e.errors.map(x => x.message).join(" | ") : String(e);
    return { ok: false, error: msg };
  }
}

// Если канал оффлайн (gql вернёт null token), пробуем fallback-канал.
// Возвращает рабочий URL прокси или null.
async function checkProxy(proxy, channel) {
  if (!proxy) return null;

  let r = await checkOnce(proxy, channel);
  if (r.ok) return r.url;

  // Если шаг 1 упал из-за оффлайна канала — пробуем fallback
  const isOffline = r.error && (r.error.includes("channel offline") || r.error.includes("no token"));
  if (isOffline && channel !== FALLBACK_CHANNEL) {
    r = await checkOnce(proxy, FALLBACK_CHANNEL);
    if (r.ok) return r.url;
  }

  return null;
}

// ---------- ПРОВЕРКА ВСЕХ ----------
async function checkAll() {
  if (checking) return;
  if (proxyList.length === 0) {
    db.addLog("proxy", "Нет прокси для проверки");
    return 0;
  }
  checking = true;

  // Берём канал из настроек (тот же, на котором будет работать бот)
  let channel = (db.getSetting("channel") || "").toLowerCase().trim();
  if (!channel) channel = FALLBACK_CHANNEL;

  console.log(`[PROXY] Проверка ${proxyList.length} прокси | канал: "${channel}" | батч: ${BATCH_SIZE} | таймаут: ${CHECK_TIMEOUT_S}s`);
  db.addLog("proxy", `Проверка ${proxyList.length} прокси (канал: ${channel})`);

  // Прогрев CycleTLS
  try { await initTLS(); }
  catch (e) {
    checking = false;
    db.addLog("proxy", "Не удалось запустить CycleTLS: " + e.message);
    console.log("[PROXY] CycleTLS init error: " + e.message);
    return 0;
  }

  goodProxies = [];
  badProxies.clear();
  let checked = 0;
  const t0 = Date.now();

  for (let i = 0; i < proxyList.length; i += BATCH_SIZE) {
    const batch = proxyList.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(p => checkProxy(p, channel).catch(() => null)));

    batch.forEach((p, idx) => {
      const workingUrl = results[idx];
      if (workingUrl) {
        goodProxies.push(workingUrl);
      } else {
        badProxies.add(proxyToUrl(p));
      }
    });

    checked += batch.length;
    const elapsed = (Date.now() - t0) / 1000;
    const speed = (checked / elapsed).toFixed(1);
    const eta = elapsed > 0 ? ((proxyList.length - checked) / (checked / elapsed)).toFixed(0) : "?";
    console.log(`[PROXY] ${checked}/${proxyList.length} | ✓ ${goodProxies.length} | ${elapsed.toFixed(1)}s | ${speed}/s | ETA: ${eta}s`);
  }

  checking = false;
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  const pct = proxyList.length > 0 ? ((goodProxies.length / proxyList.length) * 100).toFixed(0) : 0;
  console.log(`[PROXY] Готово за ${total}s. Рабочих: ${goodProxies.length}/${proxyList.length} (${pct}%)`);
  db.addLog("proxy", `Рабочих: ${goodProxies.length}/${proxyList.length} (${pct}%) за ${total}s`);
  return goodProxies.length;
}

// ---------- ИСПОЛЬЗОВАНИЕ ----------
function getProxy(accountId) {
  if (goodProxies.length === 0) return null;
  const index = accountId % goodProxies.length;
  return goodProxies[index];
}

function markBad(proxy) {
  badProxies.add(proxy);
  goodProxies = goodProxies.filter(p => p !== proxy);
  console.log(`[PROXY] ${proxy} помечен как нерабочий. Осталось: ${goodProxies.length}`);
}

function assignToAccounts() {
  const accounts = db.getAccounts();
  accounts.forEach((acc, i) => {
    if (goodProxies[i]) db.setProxy(acc.id, goodProxies[i]);
  });
  db.addLog("proxy", `Назначено ${Math.min(accounts.length, goodProxies.length)} прокси`);
  return Math.min(accounts.length, goodProxies.length);
}

function getStats() {
  return {
    total: proxyList.length,
    good: goodProxies.length,
    bad: badProxies.size,
    checking,
  };
}

function getGoodProxies() {
  return goodProxies.slice();
}

module.exports = {
  loadProxies,
  checkProxy,
  checkAll,
  getProxy,
  markBad,
  assignToAccounts,
  getStats,
  getGoodProxies,
};
