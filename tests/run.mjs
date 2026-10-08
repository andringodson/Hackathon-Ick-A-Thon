// Rushcast self-check suite. Runs before every deploy (blocks it on failure) and
// every 6 hours against the live site (the watchdog redeploys and files an issue).
//
//   node tests/run.mjs                 # serves ./site locally and tests it
//   BASE=https://…/ node tests/run.mjs # tests a deployed URL
//
// Checks: translations, every page × phone/desktop × dark/light (no errors, no
// horizontal overflow, nav indicator, glass UI present), Rush AI answers at a
// fixed demo time, the voice call screen, and (soft) live-session relay sync.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..', 'site');
const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail = '') => results.push({ ok: false, name, detail });
const warn = (name, detail = '') => results.push({ ok: true, warn: true, name, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. translations ----------
async function checkI18n() {
  const dir = path.join(SITE, 'assets', 'i18n');
  const en = JSON.parse(await readFile(path.join(dir, 'en.json'), 'utf8'));
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    const d = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    const missing = Object.keys(en).filter((k) => !(k in d));
    const extra = Object.keys(d).filter((k) => !(k in en));
    const badPh = Object.keys(en).filter((k) => k in d && ph(en[k]) !== ph(d[k]));
    if (missing.length || extra.length || badPh.length) fail(`i18n ${file}`, `missing ${missing.length}, extra ${extra.length}, placeholder mismatch ${badPh.slice(0, 5).join(' ')}`);
    else pass(`i18n ${file}`, `${Object.keys(d).length} keys`);
  }
}

// ---------- static server ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serve() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname.replace(/^\/app/, '')) || '/';
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(SITE, p);
      if (!file.startsWith(SITE) || !existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/app/` }));
  });
}

async function launch() {
  let puppeteer;
  try { puppeteer = (await import('puppeteer')).default; } catch { puppeteer = (await import('puppeteer-core')).default; }
  const opts = { headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] };
  if (process.env.CHROME) opts.executablePath = process.env.CHROME;
  return puppeteer.launch(opts);
}

const IGNORE = [/ntfy\.sh/, /favicon/, /Failed to load resource.*(fonts|qrserver)/i];
const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900 },
};
const ROUTES = ['', 'live', 'map', 'insights', 'about', 'f/canteen', 'f/library'];

// ---------- 2. every page ----------
async function checkPages(browser, base) {
  for (const theme of ['dark', 'light']) {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      page.on('console', (m) => m.type() === 'error' && !IGNORE.some((r) => r.test(m.text())) && errs.push(m.text()));
      await page.setViewport(vp);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      for (const r of ROUTES) {
        const name = `page #/${r || ''} ${vpName} ${theme}`;
        try {
          await page.goto(`${base}#/${r}`, { waitUntil: 'load', timeout: 45000 });
          await page.waitForSelector('#view .card', { timeout: 15000 });
          await page.waitForFunction(() => !document.querySelector('[data-splash]'), { timeout: 20000 });
          await sleep(900);
          const info = await page.evaluate(() => {
            const ind = document.querySelector(innerWidth < 832 ? '.tab-ind' : '.nav-ind');
            return {
              overflow: document.documentElement.scrollWidth - innerWidth,
              ind: ind ? parseFloat(getComputedStyle(ind).width) : 0,
              cards: document.querySelectorAll('#view .card').length,
              splash: !!document.querySelector('[data-splash]'),
            };
          });
          const problems = [];
          if (info.overflow > 1) problems.push(`overflow ${info.overflow}px`);
          if (info.ind < 10) problems.push('nav indicator missing');
          if (!info.cards) problems.push('no content');
          if (errs.length) problems.push(`errors: ${errs.splice(0).slice(0, 3).join(' | ')}`);
          problems.length ? fail(name, problems.join('; ')) : pass(name, `${info.cards} cards`);
        } catch (e) {
          fail(name, e.message);
        }
      }
      await page.close();
    }
  }
}

// ---------- 3. Rush AI at a fixed demo time (1 pm campus) ----------
const AI_CASES = [
  ['best time for the canteen?', /(Best time|Go now|closed)/i],
  ['how busy is the library', /Central Library is (quiet|moderate|packed)/i],
  ['how busy will the library be at 6pm', /At 6/i],
  ['is the print shop open?', /Print & Xerox Centre/i],
  ['canteen or food court?', /(Go to|closed)/i],
  ["I'm free for 30 minutes", /(least crowded|closed)/i],
  ['where can I eat?', /(Quietest|Nothing)/i],
  ["what's the rush today?", /(Rushes coming up|No big rushes)/i],
  ['how accurate is this?', /points on average/i],
];
async function checkAI(browser, base) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport(VIEWPORTS.desktop);
  await page.evaluateOnNewDocument(() => {
    const real = Date.now();
    const ist = new Date(real + 330 * 60000);
    const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000;
    sessionStorage.setItem('rc.clock', String(midnight + 13 * 3600000 - real));
    localStorage.setItem('rc.lang', 'en');
  });
  await page.goto(`${base}#/`, { waitUntil: 'load', timeout: 45000 });
  try {
    await page.waitForSelector('.ai-fab', { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('[data-splash]'), { timeout: 20000 });
    await sleep(1600); // let the logo fly-in transition finish
    await page.click('.ai-fab');
    await page.waitForSelector('.ai-input input', { visible: true, timeout: 10000 });
  } catch (e) {
    fail('AI panel opens', e.message);
    await page.close();
    return;
  }
  pass('AI panel opens');
  for (const [q, re] of AI_CASES) {
    try {
      const before = await page.$$eval('.ai-msg.bot:not(.pending)', (n) => n.length);
      await page.type('.ai-input input', q);
      await page.keyboard.press('Enter');
      await page.waitForFunction((n) => document.querySelectorAll('.ai-msg.bot:not(.pending)').length > n, { timeout: 10000 }, before);
      await sleep(1600);
      const text = await page.$$eval('.ai-msg.bot [data-text]', (n) => n.at(-1).textContent);
      re.test(text) ? pass(`AI "${q}"`, text.slice(0, 80)) : fail(`AI "${q}"`, text.slice(0, 120));
    } catch (e) {
      fail(`AI "${q}"`, e.message);
    }
  }
  // Voice call screen opens and hangs up cleanly.
  try {
    await page.keyboard.press('Escape');
    await page.evaluate(() => (location.hash = '#/'));
    await sleep(1200);
    await page.click('[data-action="call"]');
    await page.waitForSelector('.call.open', { timeout: 5000 });
    await sleep(1500);
    await page.click('[data-call="end"]');
    await sleep(600);
    const gone = await page.evaluate(() => !document.querySelector('.call'));
    gone ? pass('voice call opens and ends') : fail('voice call opens and ends', 'call screen stayed open');
  } catch (e) {
    fail('voice call opens and ends', e.message);
  }
  errs.length ? fail('AI page errors', errs.slice(0, 3).join(' | ')) : pass('AI page errors', 'none');
  await page.close();
}

// ---------- 4. live session over the public relay (soft: external network) ----------
async function checkSession(base) {
  let b1;
  let b2;
  try {
    [b1, b2] = await Promise.all([launch(), launch()]);
    const host = await b1.newPage();
    const guest = await b2.newPage();
    await host.goto(`${base}#/`, { waitUntil: 'load', timeout: 45000 });
    await host.waitForSelector('[data-action="session"]');
    await host.waitForFunction(() => !document.querySelector('[data-splash]'), { timeout: 20000 });
    await sleep(1600); // let the logo fly-in transition finish
    await host.click('[data-action="session"]');
    await host.waitForSelector('[data-session="host"]', { visible: true });
    await sleep(700); // sheet slide-in
    await host.click('[data-session="host"]');
    await host.waitForSelector('.session-code', { timeout: 8000 });
    const code = await host.$eval('.session-code', (e) => e.textContent);
    await guest.goto(`${base}#/join/${code}`, { waitUntil: 'load', timeout: 45000 });
    await host.waitForFunction(() => document.querySelector('[data-session-count]')?.textContent === '2', { timeout: 25000 });
    pass('live session: phone joins host', `room ${code}`);
  } catch (e) {
    warn('live session: phone joins host', `relay unreachable or slow: ${e.message}`);
  } finally {
    await b1?.close();
    await b2?.close();
  }
}

// ---------- run ----------
const started = Date.now();
await checkI18n();
let srv = null;
let base = process.env.BASE;
if (!base) ({ srv, base } = await serve());
const browser = await launch();
try {
  await checkPages(browser, base).catch((e) => fail('pages suite', e.message));
  await checkAI(browser, base).catch((e) => fail('AI suite', e.message));
} finally {
  await browser.close();
}
if (!process.env.SKIP_SESSION) await checkSession(base);
srv?.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? (r.warn ? 'WARN' : ' ok ') : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s against ${base}`);
process.exit(failed.length ? 1 : 0);
