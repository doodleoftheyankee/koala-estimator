// End-to-end check of the retired Roof Takeoff page (the notice that sends people to the Koala app), in Chromium,
// served by the mock dev server (no network, no key).
//   npm run e2e                 runs everything, screenshots go to a temp folder (printed at the end)
//   SHOTS=some/dir npm run e2e  keeps the screenshots there
//   CHROMIUM=/path/to/chrome    uses that browser instead of Playwright's own
// Needs Playwright (require('playwright') must resolve; it is not a dependency of this project).
// Starts its own mock dev server on a free port and stops it at the end. The Koala app is a local stand-in:
// nothing here reaches the real Koala site, Google or Google Fonts.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.error('Playwright is not installed here. Install it (npm i -g playwright) and run again.');
  process.exit(1);
}
const SHOTS = process.env.SHOTS || join(tmpdir(), 'roof-takeoff-e2e');
mkdirSync(SHOTS, { recursive: true });
const KOALA = 'https://koala-estimator-indol.vercel.app/field/roof';
const KOALA_HOST = /^https:\/\/koala-estimator-indol\.vercel\.app\//;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const TITLE = 'Roof Takeoff is now part of the Koala app';
const LINE = "Roof lookups, the attic floor, roof edges, materials and the printable report now live in Koala's Roof lookup.";
const forward = place => `${KOALA}?address=${encodeURIComponent(place)}`;

/* ---------- server ---------- */
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}
async function startServer() {
  const port = await freePort();
  const env = { ...process.env, MOCK: '1', PORT: String(port) };
  delete env.ACCESS_CODE; delete env.PARTNER_KEY;
  const child = spawn(process.execPath, ['dev-server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The mock dev server did not start:\n' + log)), 15000);
    const on = d => { log += d; if (log.includes('dev server')) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', c => { clearTimeout(t); reject(new Error(`The mock dev server exited (${c}):\n${log}`)); });
  });
  return { url: `http://localhost:${port}`, stop: () => child.kill() };
}

/* ---------- tiny runner ---------- */
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok  ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')}`); }
}

/* ---------- browser helpers ---------- */
let browser, server;
const shots = [];
// Every request a context makes is kept, so a test can check that the page never calls /api or loads a script.
// Koala is a stand-in page; Google Fonts are refused (the page falls back to system fonts).
async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, ...opts });
  ctx.requests = []; ctx.koala = [];
  ctx.on('request', r => ctx.requests.push({ url: r.url(), type: r.resourceType() }));
  await ctx.route(FONTS, r => r.abort());
  await ctx.route(KOALA_HOST, r => {
    ctx.koala.push(r.request().url());
    return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Koala stand-in</title><p>Koala stand-in</p>' });
  });
  return ctx;
}
async function open(ctx, query = '', opts = {}) {
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(server.url + '/' + query, { waitUntil: 'domcontentloaded', ...opts });
  return p;
}
const q = params => '?' + new URLSearchParams(params).toString();
const text = (p, sel) => p.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());
const shown = (p, sel) => p.$eval(sel, el => el.innerText.replace(/\s+/g, ' ').trim()); // what is on screen
const href = p => p.getAttribute('#go', 'href');
const shot = async (p, name) => { const path = join(SHOTS, name + '.png'); await p.screenshot({ path, fullPage: true }); shots.push(path); };
// Nothing the page asks for may reach /api (no paid lookups) or be a script; only the page, fonts and Koala.
function onlyAllowedRequests(ctx) {
  for (const r of ctx.requests) {
    assert.ok(!/\/api\//.test(new URL(r.url).pathname), `the page called ${r.url}`);
    assert.notEqual(r.type, 'script', `the page loaded a script: ${r.url}`);
    const ok = r.url.startsWith(server.url + '/') || FONTS.test(r.url) || KOALA_HOST.test(r.url);
    assert.ok(ok, `unexpected request: ${r.url}`);
  }
}
async function noSideScroll(p) {
  const [sw, w] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= w, `page scrolls sideways: ${sw} > ${w}`);
}
// Waits on the page's own one-second timer with Playwright's fake clock, so the timing checks can't flake.
async function staysUntilOneSecond(p) {
  await p.clock.runFor(900);
  assert.equal(p.url().startsWith(server.url), true, 'still on the notice before 1 s');
}

/* ---------- the tests ---------- */
async function main() {
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  server = await startServer();

  await test('the dev server serves the notice as the home page, and it is tidy HTML with no scripts from elsewhere', async () => {
    const r = await fetch(server.url + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    const html = await r.text();
    assert.equal(html, readFileSync(join(ROOT, 'index.html'), 'utf8'));
    assert.match(html, /^<!doctype html>\n<html lang="en">/);
    assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
    assert.ok(!/\/api\//.test(html), 'the page names no /api endpoint');
    const ctx = await newContext(), p = await open(ctx);
    const dom = await p.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
      return {
        doctype: document.doctype && document.doctype.name, mode: document.compatMode, title: document.title,
        dupIds: ids.filter((id, i) => ids.indexOf(id) !== i), h1: document.querySelectorAll('h1').length,
        scripts: document.querySelectorAll('script[src]').length,
        sheets: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href),
        charsetFirst: document.head.firstElementChild.getAttribute('charset'),
      };
    });
    assert.deepEqual(dom, { doctype: 'html', mode: 'CSS1Compat', title: 'Roof Takeoff is now in Koala', dupIds: [], h1: 1, scripts: 0, sheets: dom.sheets, charsetFirst: 'utf-8' });
    assert.ok(dom.sheets.every(s => FONTS.test(s)), 'only Google Fonts stylesheets');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('the notice: title, the one line, a big button to Koala\'s Roof lookup, and no redirect without a link', async () => {
    const ctx = await newContext();
    await ctx.clock.install();
    const p = await open(ctx, '', { waitUntil: 'load' });
    assert.equal(await text(p, 'h1'), TITLE);
    assert.equal(await text(p, '#lede'), LINE);
    assert.equal(await href(p), KOALA);
    assert.equal(await text(p, '#go'), 'Open Roof lookup in Koala →');
    assert.match(await text(p, '.small'), /Sign in with your Koala account/);
    assert.ok(await p.isHidden('#going'));
    await p.clock.runFor(5000);
    assert.equal(p.url(), server.url + '/', 'no link, no redirect');
    assert.deepEqual(ctx.koala, []);
    await p.click('#go');
    await p.waitForURL(KOALA);
    assert.deepEqual(ctx.koala, [KOALA]);
    onlyAllowedRequests(ctx);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('an old ?address= link: the button carries the address, encoded, and Koala opens after 1 s', async () => {
    const addr = '12 Oak & Elm St #3, Newark, DE 19711 (rear) café 50%';
    const ctx = await newContext();
    await ctx.clock.install();
    const p = await open(ctx, q({ address: `  ${addr}  ` }));
    const want = forward(addr);
    assert.equal(want, `${KOALA}?address=12%20Oak%20%26%20Elm%20St%20%233%2C%20Newark%2C%20DE%2019711%20(rear)%20caf%C3%A9%2050%25`);
    assert.equal(await href(p), want);
    assert.ok(await p.isVisible('#going'));
    assert.equal(await shown(p, '#going'), `Opening Koala for ${addr}. If nothing happens, tap the button.`);
    assert.equal(await text(p, '#goingTo'), addr);
    await staysUntilOneSecond(p);
    assert.deepEqual(ctx.koala, []);
    await p.clock.runFor(200);
    await p.waitForURL(want);
    assert.deepEqual(ctx.koala, [want]);
    assert.equal(new URL(ctx.koala[0]).searchParams.get('address'), addr, 'Koala reads back the same address');
    onlyAllowedRequests(ctx);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('the redirect runs on a real clock too, and Back does not bounce to Koala again', async () => {
    const ctx = await newContext();
    const p = await ctx.newPage();
    p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    const t0 = Date.now();
    await p.goto(server.url + '/' + q({ address: '1 Gable Ln' }), { waitUntil: 'domcontentloaded' });
    await p.waitForURL(forward('1 Gable Ln'), { timeout: 10000 });
    assert.ok(Date.now() - t0 >= 950, `redirected after ${Date.now() - t0} ms`);
    // The notice replaced itself, so Back goes to where the person came from (here the blank tab).
    await p.goBack();
    assert.equal(p.url(), 'about:blank');
    assert.deepEqual(ctx.koala, [forward('1 Gable Ln')]);
    onlyAllowedRequests(ctx);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('an old map pin link (?lat=&lng=) goes over as "lat,lng"', async () => {
    const ctx = await newContext();
    await ctx.clock.install();
    const p = await open(ctx, q({ lat: ' 39.68347 ', lng: '-75.75039' }));
    const want = forward('39.68347,-75.75039');
    assert.equal(want, `${KOALA}?address=39.68347%2C-75.75039`);
    assert.equal(await href(p), want);
    assert.equal(await shown(p, '#going'), 'Opening Koala for the map pin at 39.68347,-75.75039. If nothing happens, tap the button.');
    await staysUntilOneSecond(p);
    await p.clock.runFor(200);
    await p.waitForURL(want);
    assert.deepEqual(ctx.koala, [want]);
    onlyAllowedRequests(ctx);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('links that are blank or broken just show the button; the address wins over a pin; long addresses are cut at 200', async () => {
    const ctx = await newContext();
    await ctx.clock.install();
    for (const params of [{ address: '   ' }, { lat: '999', lng: '5' }, { lat: '39.7', lng: '' }, { lat: 'abc', lng: '-75' }, { lng: '-75.7' }, { other: 'x' }]) {
      const p = await open(ctx, q(params));
      assert.equal(await href(p), KOALA, JSON.stringify(params));
      assert.ok(await p.isHidden('#going'), JSON.stringify(params));
      await p.clock.runFor(3000);
      assert.ok(p.url().startsWith(server.url), 'stays put: ' + JSON.stringify(params));
      assert.deepEqual(p.errors, []);
      await p.close();
    }
    assert.deepEqual(ctx.koala, []);

    let p = await open(ctx, q({ address: '3 Cross Gable Ct', lat: '39.7', lng: '-75.7' }));
    assert.equal(await href(p), forward('3 Cross Gable Ct'));
    await p.close();

    const long = 'Lot 7, '.repeat(40) + 'Newark, DE';
    p = await open(ctx, q({ address: long }));
    const cut = long.slice(0, 200).trim();
    assert.equal(await href(p), forward(cut));
    assert.equal(await text(p, '#goingTo'), cut.replace(/\s+/g, ' '));
    await p.close();

    // A cut must never split a two-part character (encodeURIComponent would throw on half of one).
    const emoji = 'a'.repeat(199) + '\u{1F3E0} house';
    p = await open(ctx, q({ address: emoji }));
    assert.equal(await href(p), forward('a'.repeat(199) + '\u{1F3E0}'));
    assert.deepEqual(p.errors, []);
    await p.close();
    onlyAllowedRequests(ctx);
    await ctx.close();
  });

  await test('what the old page kept in this browser (access code, recent addresses, last result) is cleared', async () => {
    const ctx = await newContext();
    await ctx.clock.install();
    const p = await open(ctx);
    await p.evaluate(() => {
      localStorage.setItem('roofTakeoff.accessCode', '4321');
      localStorage.setItem('roofTakeoff.recent', JSON.stringify([{ q: 'address=1+Gable+Ln' }]));
      localStorage.setItem('someone.else', 'kept');
      sessionStorage.setItem('roofTakeoff.last', '{}');
    });
    await p.reload({ waitUntil: 'domcontentloaded' });
    const left = await p.evaluate(() => [localStorage.getItem('roofTakeoff.accessCode'), localStorage.getItem('roofTakeoff.recent'), sessionStorage.getItem('roofTakeoff.last'), localStorage.getItem('someone.else')]);
    assert.deepEqual(left, [null, null, null, 'kept']);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('phones and desktops, light and dark: no sideways scroll, a big button, the right colors, screenshots', async () => {
    const bg = { light: 'rgb(237, 240, 243)', dark: 'rgb(14, 20, 26)' };
    const accent = { light: 'rgb(28, 93, 184)', dark: 'rgb(106, 163, 242)' };
    for (const [w, h] of [[320, 640], [375, 812], [1280, 900]]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
        await ctx.clock.install();
        for (const [name, query] of [['notice', ''], ['address-link', q({ address: '7 Cape Dormer Way, Newark, DE 19711' })]]) {
          const p = await open(ctx, query, { waitUntil: 'load' });
          await noSideScroll(p);
          const look = await p.evaluate(() => {
            const b = document.querySelector('#go').getBoundingClientRect(), cs = getComputedStyle(document.querySelector('#go'));
            return { bg: getComputedStyle(document.body).backgroundColor, btnBg: cs.backgroundColor, w: b.width, h: b.height, right: b.right, bottom: b.bottom, scheme: getComputedStyle(document.documentElement).colorScheme };
          });
          assert.equal(look.bg, bg[scheme], `${w} ${scheme} page color`);
          assert.equal(look.btnBg, accent[scheme], `${w} ${scheme} button color`);
          assert.equal(look.scheme, scheme);
          assert.ok(look.h >= 44, `button is ${look.h} px tall`);
          if (w <= 375) assert.ok(look.w >= w - 2 * 16 - 2 * 21 - 1, `button spans the card on a phone: ${look.w} px`);
          assert.ok(look.right <= w, 'button inside the screen');
          assert.ok(look.bottom <= h, 'button on the first screen, no scrolling needed');
          if (w !== 320) await shot(p, `${name}-${w}-${scheme}`);
          assert.deepEqual(p.errors, []);
          await p.close();
        }
        onlyAllowedRequests(ctx);
        assert.deepEqual(ctx.koala, [], 'the fake clock held the redirect for the screenshots');
        await ctx.close();
      }
    }
  });

  await test('the engine stays: the same dev server still answers /api/takeoff and /api/satellite (Koala calls these)', async () => {
    const r = await fetch(`${server.url}/api/takeoff?${new URLSearchParams({ address: '1 Gable Ln' })}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.version, 1);
    assert.ok(j.attic.floorM2 > 0 && j.segments.length > 0 && j.edges.length > 0);
    const s = await fetch(`${server.url}/api/satellite?lat=${j.building.center.lat}&lng=${j.building.center.lng}&zoom=20`);
    assert.equal(s.status, 200);
    assert.match(s.headers.get('content-type'), /^image\//);
  });

  await browser.close();
  server.stop();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`Screenshots in ${SHOTS}:\n  ${shots.join('\n  ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(e => {
  console.error(e);
  try { server && server.stop(); } catch (_) {}
  process.exit(1);
});
