const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const db = require("./database");

// proxyList: [{type, host, port, user, pass, explicitType}]
let proxyList = [];
let goodProxies = []; // строки в формате "type://[user:pass@]host:port"
let badProxies = new Set();
let checking = false;

// Жёсткий внешний таймаут на 1 прокси
const CHECK_TIMEOUT_MS = 5000;
// Сколько прокси проверяем параллельно
const BATCH_SIZE = 100;

// ---------- ПАРСИНГ ----------
// Поддерживаемые форматы:
//   HTTP 1.2.3.4:8080
//   HTTPS 1.2.3.4:8080
//   SOCKS4 1.2.3.4:1080
//   SOCKS5 1.2.3.4:1080
//   1.2.3.4:8080
//   1.2.3.4:8080:user:pass
//   user:pass@1.2.3.4:8080
//   http://user:pass@host:port
function parseProxy(line) {
  if (!line) return null;
  let s = String(line).trim();
  if (!s) return null;

  let type = "http";
  let explicitType = false;

  // Префикс типа: "HTTP 1.2.3.4:80"
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

  // Поддерживаем два формата с @:
  //   user:pass@host:port  (стандартный)
  //   host:port@user:pass  (proxy.market и некоторые другие)
  let user = null, pass = null;
  if (s.includes("@")) {
    const at = s.lastIndexOf("@");
    const left = s.slice(0, at);
    const right = s.slice(at + 1);

    // Определяем кто из двух частей host:port — по тому что вторая часть является числом-портом
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
      // user:pass@host:port (по умолчанию)
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

  // host:port:user:pass
  if (!user && parts.length >= 4) { user = parts[2]; pass = parts.slice(3).join(":"); }

  return { type, host, port, user, pass, explicitType };
}

function proxyToString(p) {
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass || "")}@` : "";
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

// ---------- ЗАГРУЗКА ----------
function loadProxies(text) {
  const lines = String(text)
    .replace(/\|/g, "\n")
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(Boolean);

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

// ---------- ПРОВЕРКА ОДНОГО ----------
// Стратегия: реальный POST к gql.twitch.tv/gql с тем же запросом, что делает плеер.
// Прокси считается рабочим только если:
//   - HTTP 200
//   - Content-Type содержит "json"
//   - Тело парсится как JSON и в нём есть поле data или errors (т.е. это реально Twitch GraphQL)
// Это отсекает captive-портали, провайдерские заглушки и HTML-страницы прокси.
const PROBE_BODY = JSON.stringify({
  operationName: "PlaybackAccessToken_Template",
  query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }}',
  variables: { isLive: true, login: "xqc", isVod: false, vodID: "", playerType: "site" },
});

function checkOnce(proxy, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    let killer = null;

    const finish = (ok) => {
      if (done) return;
      done = true;
      if (killer) clearTimeout(killer);
      try { if (req) req.destroy(); } catch (e) {}
      resolve(ok);
    };

    // Внешний killer — гарантия выхода
    killer = setTimeout(() => finish(false), timeoutMs);

    try {
      let agent;
      const auth = proxy.user ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass || "")}@` : "";

      if (proxy.type === "socks4" || proxy.type === "socks5") {
        const url = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
        agent = new SocksProxyAgent(url, { timeout: timeoutMs });
      } else {
        const url = `http://${auth}${proxy.host}:${proxy.port}`;
        agent = new HttpsProxyAgent(url, { timeout: timeoutMs });
      }

      req = https.request({
        hostname: "gql.twitch.tv",
        path: "/gql",
        method: "POST",
        agent,
        timeout: timeoutMs,
        headers: {
          "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(PROBE_BODY),
          "User-Agent": "Mozilla/5.0",
          "Connection": "close",
        },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(false); }
        const ct = String(res.headers["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) { res.resume(); return finish(false); }

        let data = "";
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 32768) { res.destroy(); return finish(false); }
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            // Twitch GraphQL всегда возвращает либо data, либо errors
            finish(!!(json && (json.data !== undefined || json.errors)));
          } catch (e) {
            finish(false);
          }
        });
        res.on("error", () => finish(false));
      });

      req.on("error", () => finish(false));
      req.on("timeout", () => finish(false));
      req.write(PROBE_BODY);
      req.end();
    } catch (e) {
      finish(false);
    }
  });
}

// Если тип явно не указан, пробуем http -> socks5 -> socks4
async function checkProxy(proxy) {
  if (!proxy) return false;

  let ok = await checkOnce(proxy, CHECK_TIMEOUT_MS);
  if (ok) return true;

  if (proxy.explicitType) return false;

  for (const t of ["socks5", "socks4"]) {
    if (t === proxy.type) continue;
    const alt = { ...proxy, type: t };
    ok = await checkOnce(alt, CHECK_TIMEOUT_MS);
    if (ok) {
      proxy.type = t;
      return true;
    }
  }
  return false;
}

// ---------- ПРОВЕРКА ВСЕХ ----------
async function checkAll() {
  if (checking) return;
  if (proxyList.length === 0) {
    db.addLog("proxy", "Нет прокси для проверки");
    return 0;
  }
  checking = true;

  console.log(`[PROXY] Проверка ${proxyList.length} прокси (батч ${BATCH_SIZE}, таймаут ${CHECK_TIMEOUT_MS}ms)`);
  db.addLog("proxy", `Проверка ${proxyList.length} прокси...`);

  goodProxies = [];
  badProxies.clear();
  let checked = 0;
  const t0 = Date.now();

  for (let i = 0; i < proxyList.length; i += BATCH_SIZE) {
    const batch = proxyList.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(p => checkProxy(p)));

    batch.forEach((p, idx) => {
      const str = proxyToString(p);
      if (results[idx]) goodProxies.push(str);
      else badProxies.add(str);
    });

    checked += batch.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[PROXY] ${checked}/${proxyList.length} | good: ${goodProxies.length} | ${elapsed}s`);
  }

  checking = false;
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[PROXY] Готово за ${total}s. Рабочих: ${goodProxies.length}/${proxyList.length}`);
  db.addLog("proxy", `Рабочих: ${goodProxies.length}/${proxyList.length} (${total}s)`);
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
