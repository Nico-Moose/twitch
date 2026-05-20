const puppeteer = require("puppeteer");
const db = require("./database");

const browsers = new Map(); // accountId -> { browser, page, timer }
let loopTimer = null;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// === PUPPETEER VIEWER ===
// Каждый аккаунт открывает headless Chrome и заходит на Twitch.
// Twitch видит реальный браузер с уникальным fingerprint — засчитывает как зрителя.
// Прокси НЕ нужны.

async function startViewer(account) {
  const channel = db.getSetting("channel");
  if (!channel) return;
  if (browsers.has(account.id)) return;

  try {
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--no-first-run",
        "--window-size=1280,720",
        "--single-process",
        "--disable-features=site-per-process",
      ],
    });

    const page = await browser.newPage();

    // Устанавливаем viewport как у обычного пользователя
    await page.setViewport({ width: 1280, height: 720 });

    // Устанавливаем cookies для авторизации на Twitch
    const token = account.token.startsWith("oauth:") ? account.token.replace("oauth:", "") : account.token;
    await page.setCookie(
      {
        name: "auth-token",
        value: token,
        domain: ".twitch.tv",
        path: "/",
        httpOnly: false,
        secure: true,
      },
      {
        name: "login",
        value: account.login,
        domain: ".twitch.tv",
        path: "/",
        httpOnly: false,
        secure: true,
      }
    );

    // Переходим на страницу канала
    console.log(`[VIEWER] ${account.login} открывает ${channel}...`);
    await page.goto(`https://www.twitch.tv/${channel}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Ждём загрузки плеера (до 15 сек)
    await page.waitForSelector("video", { timeout: 15000 }).catch(() => {});

    // Кликаем "Start Watching" если есть (mature content warning)
    await page.evaluate(() => {
      const btn = document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
      if (btn) btn.click();
    }).catch(() => {});

    // Устанавливаем качество на минимум (экономия трафика)
    await setLowestQuality(page);

    db.setStatus(account.id, "online");
    console.log(`[VIEWER] ${account.login} смотрит ${channel} ✓`);
    db.addLog("hls", `${account.login} смотрит (browser)`);

    // Периодически проверяем что страница жива и кликаем "Still watching?" если появится
    const timer = setInterval(async () => {
      try {
        // Проверяем что браузер ещё открыт
        if (!browser.isConnected()) {
          clearInterval(timer);
          browsers.delete(account.id);
          db.setStatus(account.id, "offline");
          console.log(`[VIEWER] ${account.login} отключился`);
          // Перезапуск через 30 сек
          setTimeout(() => startViewer(account), 30000);
          return;
        }

        // Кликаем "Still watching?" если Twitch спрашивает
        await page.evaluate(() => {
          const btn = document.querySelector('[data-a-target="player-overlay-content-gate-confirm-button"]');
          if (btn) btn.click();
          // Также ищем кнопку "Continue Watching"
          const btns = document.querySelectorAll("button");
          btns.forEach(b => {
            if (b.textContent.includes("Continue Watching") || b.textContent.includes("Start Watching")) {
              b.click();
            }
          });
        }).catch(() => {});
      } catch (e) {
        // Браузер закрылся
        clearInterval(timer);
        browsers.delete(account.id);
        db.setStatus(account.id, "offline");
      }
    }, 60000); // проверяем каждую минуту

    browsers.set(account.id, { browser, page, timer });
  } catch (err) {
    console.log(`[VIEWER] ${account.login}: ошибка — ${err.message}`);
    db.setStatus(account.id, "error");
    db.addLog("error", `${account.login}: ${err.message}`);
  }
}

async function setLowestQuality(page) {
  try {
    // Открываем настройки плеера
    await page.evaluate(() => {
      const settingsBtn = document.querySelector('[data-a-target="player-settings-button"]');
      if (settingsBtn) settingsBtn.click();
    });
    await new Promise(r => setTimeout(r, 500));

    // Кликаем "Quality"
    await page.evaluate(() => {
      const items = document.querySelectorAll('[data-a-target="player-settings-menu-item-quality"]');
      if (items.length) items[0].click();
    });
    await new Promise(r => setTimeout(r, 500));

    // Выбираем самое низкое качество (последний пункт в списке, обычно 160p или audio only)
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[name="player-quality"]');
      if (radios.length) {
        const last = radios[radios.length - 1];
        last.click();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // Закрываем меню
    await page.evaluate(() => {
      const settingsBtn = document.querySelector('[data-a-target="player-settings-button"]');
      if (settingsBtn) settingsBtn.click();
    });
  } catch (e) {}
}

async function stopViewer(id) {
  const entry = browsers.get(id);
  if (entry) {
    clearInterval(entry.timer);
    try { await entry.browser.close(); } catch (e) {}
    browsers.delete(id);
  }
  db.setStatus(id, "offline");
}

async function stopAllViewers() {
  for (const [id] of browsers) {
    await stopViewer(id);
  }
}

// === ЦИКЛ ===
function start() {
  try {
    const accounts = db.getEnabledAccounts();
    if (accounts.length === 0) { console.log("[START] Нет аккаунтов"); return; }
    const channel = db.getSetting("channel");
    if (!channel) { console.log("[START] Канал не задан"); return; }

    stopAllViewers().then(() => {
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
    });
  } catch (err) {
    console.error("[START ERROR]", err.message);
    db.addLog("error", "start: " + err.message);
  }
}

function stop() {
  db.setSetting("running", "0");
  stopLoop();
  stopAllViewers().then(() => {
    db.resetAll();
    db.addLog("system", "СТОП");
    console.log("[STOP]");
  });
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
      startViewer(acc);
      db.setPhase(acc.id, "watching", now + rand(30, 90) * 60 * 1000);
    } else if (acc.phase === "watching") {
      stopViewer(acc.id);
      db.setPhase(acc.id, "afk", now + rand(5, 15) * 60 * 1000);
      db.setStatus(acc.id, "афк");
      db.addLog("afk", acc.login + " АФК");
    } else if (acc.phase === "afk") {
      startViewer(acc);
      db.setPhase(acc.id, "watching", now + rand(30, 90) * 60 * 1000);
      db.addLog("join", acc.login + " вернулся");
    }
  });
}

function connectNow(id) {
  const account = db.getAccountById(id);
  if (!account) return;
  startViewer(account);
  db.setPhase(id, "watching", Date.now() + rand(30, 90) * 60 * 1000);
  db.addLog("join", account.login + " запущен вручную");
}

// Заглушки для совместимости с API
function disconnect(id) { stopViewer(id); }
function disconnectAll() { stopAllViewers(); }
function sendMessage(id, message) {
  return Promise.resolve({ ok: false, error: "Чат через браузер не поддерживается" });
}

if (db.getSetting("running") === "1") { console.log("[RESUME]"); startLoop(); }

module.exports = { start, stop, disconnect, disconnectAll, sendMessage, connectNow, clients: browsers };
