const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const db = require("./database");

let proxyList = [];
let goodProxies = [];
let badProxies = new Set();
let checking = false;

// Загрузить список прокси
function loadProxies(text) {
  const lines = text.replace(/\|/g, "\n").split("\n")
    .map(l => l.trim())
    .filter(l => l && l.includes(":") && !l.startsWith("#"));

  proxyList = lines;
  badProxies.clear();
  goodProxies = [];
  checking = false;
  db.addLog("proxy", `Загружено ${lines.length} прокси`);
  console.log(`[PROXY] Загружено ${lines.length} прокси`);
  return lines.length;
}

// Проверить один прокси через Twitch GQL
function checkProxy(proxy) {
  return new Promise((resolve) => {
    try {
      const parts = proxy.split(":");
      if (parts.length < 2) return resolve(false);

      const host = parts[0];
      const port = parts[1];
      const user = parts[2] || null;
      const pass = parts[3] || null;

      const auth = user ? `${user}:${pass}@` : "";
      const proxyUrl = `http://${auth}${host}:${port}`;
      const agent = new HttpsProxyAgent(proxyUrl);

      const body = JSON.stringify({
        operationName: "PlaybackAccessToken_Template",
        query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature } }',
        variables: { isLive: true, login: "twitch", isVod: false, vodID: "", playerType: "site" }
      });

      const req = https.request({
        hostname: "gql.twitch.tv",
        path: "/gql",
        method: "POST",
        agent: agent,
        timeout: 5000,
        headers: {
          "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        }
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            // Рабочий если Twitch вернул валидный JSON с полем data
            resolve(!!(json && json.data !== undefined));
          } catch (e) {
            resolve(false);
          }
        });
      });

      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

// Проверить все прокси пачками
async function checkAll() {
  if (checking) return 0;
  if (proxyList.length === 0) {
    db.addLog("proxy", "Нет прокси для проверки");
    return 0;
  }

  checking = true;
  const batchSize = 30;

  console.log(`[PROXY] Проверяем ${proxyList.length} прокси...`);
  db.addLog("proxy", `Проверка ${proxyList.length} прокси...`);

  goodProxies = [];
  badProxies.clear();
  let checked = 0;

  for (let i = 0; i < proxyList.length; i += batchSize) {
    const batch = proxyList.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(p => checkProxy(p)));

    batch.forEach((proxy, idx) => {
      if (results[idx]) {
        goodProxies.push(proxy);
      } else {
        badProxies.add(proxy);
      }
    });

    checked += batch.length;
    console.log(`[PROXY] ${checked}/${proxyList.length} | good: ${goodProxies.length}`);
  }

  checking = false;
  console.log(`[PROXY] Готово. Рабочих: ${goodProxies.length}/${proxyList.length}`);
  db.addLog("proxy", `Рабочих: ${goodProxies.length}/${proxyList.length}`);
  return goodProxies.length;
}

function getProxy(accountId) {
  if (goodProxies.length === 0) return null;
  return goodProxies[accountId % goodProxies.length];
}

function markBad(proxy) {
  badProxies.add(proxy);
  goodProxies = goodProxies.filter(p => p !== proxy);
  console.log(`[PROXY] ${proxy} помечен нерабочим. Осталось: ${goodProxies.length}`);
}

function assignToAccounts() {
  const accounts = db.getAccounts();
  accounts.forEach((acc, i) => {
    if (goodProxies[i]) db.setProxy(acc.id, goodProxies[i]);
  });
  const count = Math.min(accounts.length, goodProxies.length);
  db.addLog("proxy", `Назначено ${count} прокси`);
  return count;
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
