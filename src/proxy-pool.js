const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const db = require("./database");

let proxyList = []; // все загруженные прокси
let goodProxies = []; // рабочие прокси
let badProxies = new Set(); // забаненные/мёртвые
let checking = false;

// Загрузить список прокси (из текста)
function loadProxies(text) {
  const lines = text.replace(/\|/g, "\n").split("\n").map(l => l.trim()).filter(l => l && l.includes(":"));
  proxyList = lines;
  badProxies.clear();
  goodProxies = [];
  checking = false; // сброс если зависло
  db.addLog("proxy", `Загружено ${lines.length} прокси`);
  console.log(`[PROXY] Загружено ${lines.length} прокси`);
  return lines.length;
}

// Проверить один прокси (пытаемся подключиться к Twitch)
function checkProxy(proxy) {
  return new Promise((resolve) => {
    try {
      const parts = proxy.split(":");
      const host = parts[0];
      const port = parts[1];
      const user = parts[2] || null;
      const pass = parts[3] || null;

      const auth = user ? `${user}:${pass}@` : "";
      const url = `http://${auth}${host}:${port}`;
      const agent = new HttpsProxyAgent(url);

      const body = JSON.stringify({
        operationName: "PlaybackAccessToken_Template",
        query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }}',
        variables: { isLive: true, login: "xqc", isVod: false, vodID: "", playerType: "site" }
      });

      const req = https.request({
        hostname: "gql.twitch.tv",
        path: "/gql",
        method: "POST",
        agent: agent,
        timeout: 3000,
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
            // Рабочий только если Twitch вернул валидный JSON с data
            resolve(json && json.data !== undefined);
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

// Проверить пачку прокси и отобрать рабочие
async function checkAll() {
  if (checking) return;
  checking = true;

  const batchSize = 100;
  console.log(`[PROXY] Проверяем ${proxyList.length} прокси...`);
  db.addLog("proxy", `Проверка ${proxyList.length} прокси...`);

  goodProxies = [];
  badProxies.clear();
  let checked = 0;

  for (let i = 0; i < proxyList.length; i += batchSize) {
    const batch = proxyList.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(proxy => checkProxy(proxy)));

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

// Получить рабочий прокси для аккаунта (рандомный из пула)
function getProxy(accountId) {
  if (goodProxies.length === 0) return null;
  // Каждому аккаунту свой прокси (по индексу)
  const index = accountId % goodProxies.length;
  return goodProxies[index];
}

// Пометить прокси как нерабочий и заменить
function markBad(proxy) {
  badProxies.add(proxy);
  goodProxies = goodProxies.filter(p => p !== proxy);
  console.log(`[PROXY] ${proxy} помечен как нерабочий. Осталось: ${goodProxies.length}`);
}

// Назначить прокси аккаунтам из пула рабочих
function assignToAccounts() {
  const accounts = db.getAccounts();
  accounts.forEach((acc, i) => {
    if (goodProxies[i]) {
      db.setProxy(acc.id, goodProxies[i]);
    }
  });
  db.addLog("proxy", `Назначено ${Math.min(accounts.length, goodProxies.length)} прокси`);
  return Math.min(accounts.length, goodProxies.length);
}

function getStats() {
  return {
    total: proxyList.length,
    good: goodProxies.length,
    bad: badProxies.size,
    checking: checking,
  };
}

function getGoodProxies() {
  return goodProxies;
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
