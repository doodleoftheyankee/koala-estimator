// End-to-end check of the Roof Takeoff page in Chromium against the mock Google (no network, no key).
//   npm run e2e                 runs everything, screenshots go to a temp folder (printed at the end)
//   SHOTS=some/dir npm run e2e  keeps the screenshots there
//   CHROMIUM=/path/to/chrome    uses that browser instead of Playwright's own
// Needs Playwright (require('playwright') must resolve; it is not a dependency of this project).
// Starts its own mock dev servers on free ports and stops them at the end.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import { encodePng } from '../dev/png.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.error('Playwright is not installed here. Install it (npm i -g playwright) and run again.');
  process.exit(1);
}
const SHOTS = process.env.SHOTS || join(tmpdir(), 'roof-takeoff-e2e');
mkdirSync(SHOTS, { recursive: true });
const GEOTIFF_CDN = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';
const GEOTIFF_JS = readFileSync(join(ROOT, 'node_modules/geotiff/dist-browser/geotiff.js'));
const FT2 = 10.7639, M2FT = 3.28084, INCH = 0.0254;
const fmt0 = n => Math.round(n).toLocaleString('en-US');
const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- servers ---------- */
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}
async function startServer(extra = {}) {
  const port = await freePort();
  const env = { ...process.env, MOCK: '1', PORT: String(port) };
  delete env.ACCESS_CODE; delete env.PARTNER_KEY;
  Object.assign(env, extra);
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
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ok  ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')}`); }
}

/* ---------- browser helpers ---------- */
let browser, server, coded;
const shots = [];
async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
  await ctx.route(GEOTIFF_CDN, r => r.fulfill({ body: GEOTIFF_JS, contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
async function open(ctx, path = '/', srv = server) {
  const p = await ctx.newPage();
  p.errors = []; p.takeoff = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('request', r => { if (r.url().includes('/api/takeoff')) p.takeoff.push(new URL(r.url())); });
  await p.goto(srv.url + path);
  return p;
}
const runs = p => p.evaluate(() => Number(document.querySelector('#lkCard').dataset.runs || 0));
// Runs fn, then waits until one more lookup has finished (photo included).
async function andWait(p, fn) {
  const before = await runs(p);
  await fn();
  await p.waitForFunction(b => Number(document.querySelector('#lkCard').dataset.runs || 0) > b, before, { timeout: 20000 });
}
const lookup = (p, address) => andWait(p, async () => { await p.fill('#addr', address); await p.click('#lookupBtn'); });
const text = (p, sel) => p.$eval(sel, el => el.textContent.trim());
const shot = async (p, name, opts = {}) => { const path = join(SHOTS, name + '.png'); await p.screenshot({ path, fullPage: true, ...opts }); shots.push(path); };
async function api(params, srv = server) {
  const r = await fetch(`${srv.url}/api/takeoff?${new URLSearchParams(params)}`);
  return r.json();
}
// CONTRACT.md attic floor, in sq ft, with an overhang in inches and a rule for which faces are over the attic
// (default: the server's attic.excluded). noDataOut: leave out the parts with no roof data.
function contractAttic(j, overhangIn, over = s => !j.attic.excluded.includes(s.n), noDataOut = false) {
  const A = j.attic.footprintM2, P = j.attic.perimeterM, S = j.attic.sharedWallM || 0, d = overhangIn * INCH;
  const ex = j.segments.filter(s => !over(s)).reduce((t, s) => t + s.groundM2, 0) + (noDataOut ? j.attic.unmatchedM2 : 0);
  return (A > 0 ? Math.max(0, A - (P - S) * d + 4 * d * d) * Math.max(0, 1 - ex / A) : 0) * FT2;
}
// Roof deck over the attic floor (sq ft) with the same choices.
function contractDeck(j, overhangIn, over = s => !j.attic.excluded.includes(s.n)) {
  const kept = j.segments.filter(over);
  return contractAttic(j, overhangIn, over) * kept.reduce((t, s) => t + s.areaM2, 0) / kept.reduce((t, s) => t + s.groundM2, 0);
}
const ADDRESSES = ['1 Gable Ln', '2 Hip Rd', '3 Cross Gable Ct', '4 Low Detail Dr', '5 Twin Ave', '6 Flat Roof Plaza', '7 Cape Dormer Way'];
const box = (p, sel) => p.locator(sel).first().boundingBox();
const sloped = j => j.segments.reduce((t, s) => t + s.areaM2, 0) * FT2;
// Main pitch: the whole pitch with the most footprint.
function mainPitch(j) {
  const m = new Map();
  for (const s of j.segments) { const k = Math.max(0, Math.round(12 * Math.tan(s.pitchDeg * Math.PI / 180))); m.set(k, (m.get(k) || 0) + s.groundM2); }
  return [...m].sort((a, b) => b[1] - a[1])[0][0];
}
async function noSideScroll(p) {
  const [sw, w] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= w, `page scrolls sideways: ${sw} > ${w}`);
}

/* ---------- the tests ---------- */
async function main() {
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  server = await startServer();
  coded = await startServer({ ACCESS_CODE: '4321' });
  const truth = {};
  for (const a of ADDRESSES) truth[a] = await api({ address: a });
  const cross = truth['3 Cross Gable Ct'];

  await test('first load shows the sample house totals, unchanged from before this page change', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await p.waitForTimeout(300);
    // Read from the page before this change (commit 4d89ffd). They also follow from the sample geometry:
    // main roof 644 x 420 px and porch 280 x 112 px at 280 px = 20 ft, pitches 6/12 and 3/12.
    const k = 20 / 280, main = 644 * 420 * k * k, porch = 280 * 112 * k * k;
    const slope = main * Math.sqrt(1 + 0.25) + porch * Math.sqrt(1 + 1 / 16);
    assert.equal(fmt0(slope), '1,708'); assert.equal(fmt0(main + porch), '1,540');
    const got = await p.evaluate(() => Object.fromEntries(['kArea', 'kSq', 'kOrder', 'kBundles', 'kFoot', 'kSecs', 'kOrderLbl', 'totFoot', 'totSlope', 'pitchVal'].map(id => [id, document.getElementById(id).textContent])));
    assert.deepEqual(got, { kArea: '1,708', kSq: '17.1', kOrder: '19⅔', kBundles: '59 bundles at 3 per square', kFoot: '1,540', kSecs: '2 of 2 sections measured', kOrderLbl: 'Order with 15% waste', totFoot: '1,540', totSlope: '1,708', pitchVal: '6.0' });
    // New: the attic floor. Main roof traced outline 1380 sq ft, perimeter 152 ft, 12" overhang: 1380 - 152 + 4. The porch is not over the attic.
    assert.equal(await text(p, '#kAttic'), '1,232');
    assert.equal(await text(p, '#totAttic'), '1,232');
    assert.ok(await p.isVisible('#sampleNote'));
    assert.ok(await p.isHidden('#srcSeg'));
    assert.ok(await p.isDisabled('#copyLink'));
    assert.equal(await p.$$eval('#refGrid .ref-cell', els => els.length), 10);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('each mock address: both numbers, pitch, faces, aerial photo, summary card follows the lookup', async () => {
    const ctx = await newContext(), p = await open(ctx);
    for (const [addr, j] of Object.entries(truth)) {
      await lookup(p, addr);
      assert.equal(await p.getAttribute('#lkCard', 'data-state'), 'done', addr);
      assert.equal(await text(p, '#lkAddress'), j.place.address);
      assert.equal(await text(p, '#lkArea'), fmt0(sloped(j)), addr);
      assert.equal(await text(p, '#lkAttic'), fmt0(j.attic.floorM2 * FT2), addr + ' attic = server attic.floorM2');
      assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(j, 12)), addr + ' attic = contract formula');
      if (j.attic.deckM2 != null) assert.match(await text(p, '#lkDeck'), new RegExp(`^Roof deck over the attic floor: ${fmt0(j.attic.deckM2 * FT2)} sq ft \\(for spray foam under the roof\\)$`));
      assert.equal(await text(p, '#lkFaces'), String(j.segments.length));
      assert.equal(await text(p, '#lkPitch'), String(mainPitch(j)));
      assert.equal(await p.getAttribute('#mapBoard', 'data-kind'), 'photo', addr);
      assert.equal(await text(p, '#kArea'), fmt0(sloped(j)));
      assert.equal(await text(p, '#kAttic'), fmt0(j.attic.floorM2 * FT2));
      assert.equal(await p.getAttribute('#srcLookup', 'aria-pressed'), 'true');
      assert.equal(await p.$$eval('#faceBody tr[data-face]', r => r.length), j.segments.length);
      // default face choices come from attic.excluded
      for (const s of j.segments) assert.equal(await p.isChecked(`#faceBody input[data-n="${s.n}"]`), !j.attic.excluded.includes(s.n), `${addr} face ${s.n}`);
      assert.equal(await p.$$eval('#faceBody .tag.hint', r => r.length), j.segments.filter(s => s.lower).length, addr + ' lower-roof hints');
      assert.match(await text(p, '#lookupStatus'), /Found \d+ roof face/);
      assert.match(await p.getAttribute('#lookupStatus', 'class'), j.warnings.length ? /warn/ : /ok/, addr + ' status tone');
    }
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('attic floor follows the overhang chips and face checkboxes, matching the CONTRACT formula and the server', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await lookup(p, '3 Cross Gable Ct');
    for (const oh of [0, 6, 12, 18, 24]) {
      await p.click(`#lkCard .chips.oh button[data-oh="${oh}"]`);
      const want = fmt0(contractAttic(cross, oh));
      assert.equal(await text(p, '#lkAttic'), want, `overhang ${oh}`);
      assert.equal(await text(p, '#kAttic'), want, `summary at overhang ${oh}`);
      // The server rounds to 0.01 m2 (0.05 sq ft), so a floor on a .5 boundary can round the other way.
      const server = await api({ address: '3 Cross Gable Ct', overhangIn: oh });
      assert.ok(Math.abs(server.attic.floorM2 * FT2 - contractAttic(cross, oh)) < 0.06, `server agrees at overhang ${oh}`);
      // the step 3 chips are the same setting
      assert.equal(await p.getAttribute(`.card:has(#secBody) .chips.oh button[data-oh="${oh}"]`, 'aria-pressed'), 'true');
    }
    await p.click('#lkCard .chips.oh button[data-oh="12"]');
    assert.equal(await p.isChecked('#faceBody input[data-n="5"]'), false, 'low-slope porch starts unchecked');
    assert.ok(await p.isVisible('#lowNote'));
    await p.check('#faceBody input[data-n="5"]');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(cross, 12, () => true)));
    await p.uncheck('#faceBody input[data-n="1"]');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(cross, 12, s => s.n !== 1)));
    assert.equal(await text(p, '#kAttic'), fmt0(contractAttic(cross, 12, s => s.n !== 1)));
    assert.match(await text(p, '#lkAtticNote'), /without face 1\./);
    await p.click('#lkCard .chips.oh button[data-oh="0"]');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(cross, 0, s => s.n !== 1)));
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('cross gable: edge legend, edge totals and materials', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await lookup(p, '3 Cross Gable Ct');
    const ft = Object.fromEntries(Object.entries(cross.edgeTotalsM).map(([k, v]) => [k, v * M2FT]));
    const legend = await text(p, '#edgeLegend');
    for (const [k, label] of [['ridge', 'Ridge'], ['valley', 'Valley'], ['eave', 'Eave'], ['rake', 'Rake'], ['headwall', 'Headwall']]) {
      assert.ok(ft[k] > 0); assert.ok(legend.includes(`${label} ${fmt0(ft[k])} ft`), `legend has ${label}`);
    }
    assert.ok(!/Hip|Pitch break|Step/.test(legend), 'types with zero length are left out');
    assert.ok(legend.includes('Not over the attic'));
    const rows = await p.$$eval('#edgeBody tr', r => r.map(tr => [...tr.cells].map(c => c.textContent.trim())));
    assert.deepEqual(rows.map(r => [r[0], r[2]]), [['Ridge', fmt0(ft.ridge)], ['Valley', fmt0(ft.valley)], ['Eave', fmt0(ft.eave)], ['Rake', fmt0(ft.rake)], ['Headwall', fmt0(ft.headwall)]]);
    assert.equal(rows[4][1], 'Level top of a roof against a wall');
    const mats = await p.$$eval('#matBody tr', r => r.map(tr => [tr.cells[0].textContent.trim(), tr.cells[2].textContent.trim()]));
    const up = v => fmt0(Math.ceil(v - 1e-9));
    assert.deepEqual(mats, [
      ['Drip edge', up(ft.eave + ft.rake)], ['Starter strip', up(ft.eave)], ['Ridge cap', up(ft.ridge + ft.hip)],
      ['Valley (ice and water, flashing)', up(ft.valley)], ['Headwall (apron) flashing', up(ft.headwall)],
    ]);
    assert.match(await text(p, '#edgesBlock'), /estimates from aerial data: check them on site/);
    // the photo-method note stays in step 3 only
    assert.equal(await p.locator('text=Measuring from photos doesn\'t give ridge').count(), 1);
    assert.equal(await p.locator('#lkCard >> text=aren\'t measured here').count(), 0);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('degraded address (4 Low Detail Dr) shows its warnings and still gives both numbers', async () => {
    const ctx = await newContext(), p = await open(ctx), j = truth['4 Low Detail Dr'];
    await lookup(p, '4 Low Detail Dr');
    const warns = await p.$$eval('#lkWarn li', l => l.map(x => x.textContent));
    assert.deepEqual(warns, j.warnings);
    assert.ok(warns.some(w => /surface heights didn't load/.test(w)));
    assert.equal(await text(p, '#lkAttic'), fmt0(j.attic.floorM2 * FT2));
    assert.equal(await text(p, '#lkArea'), fmt0(sloped(j)));
    assert.ok(await p.isVisible('#edgesNone'));
    assert.ok(await p.isHidden('#edgesBlock'));
    assert.match(await text(p, '#lkQuality'), /Lower-detail aerial imagery from Sep 2019/);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('warnings sit next to the numbers: amber status, "Check on site" under the lookup numbers and in the Roof total', async () => {
    const ctx = await newContext({ viewport: { width: 375, height: 812 } }), p = await open(ctx), j = truth['4 Low Detail Dr'];
    await lookup(p, '1 Gable Ln');
    assert.match(await p.getAttribute('#lookupStatus', 'class'), /chip ok/);
    assert.ok(await p.isHidden('#lkCheck'));
    assert.ok(await p.isHidden('#sumCheck'));
    await lookup(p, '4 Low Detail Dr');
    assert.match(await p.getAttribute('#lookupStatus', 'class'), /chip warn/, 'amber, not green, when there are warnings');
    assert.equal(await text(p, '#lookupStatus'), 'Found 2 roof faces. 3 things to check on site, see below.');
    assert.equal(await text(p, '#lkCheck'), 'Check on site: 3 notes about this roof See notes');
    const nums = await box(p, '#lkCard .kpis.two'), chk = await box(p, '#lkCheck');
    assert.ok(chk.y >= nums.y + nums.height && chk.y - (nums.y + nums.height) < 30, 'right under the lookup numbers');
    assert.ok(await p.isVisible('#sumCheck'), 'in the Roof total card too');
    assert.equal(await text(p, '#sumCheck'), 'Check on site: 3 notes from the address lookup See notes');
    const sk = await box(p, '#sumCard .kpis'), sc = await box(p, '#sumCheck');
    assert.ok(sc.y >= sk.y + sk.height && sc.y - (sk.y + sk.height) < 30, 'right under the Roof total numbers');
    assert.equal(await p.getAttribute('#lkCheck', 'href'), '#lkWarn');
    assert.equal(await p.$$eval('#lkWarn li', l => l.length), j.warnings.length);
    // The totals switch to steps 1-3: the summary's line goes, the lookup's stays.
    await p.click('#srcSteps');
    assert.ok(await p.isHidden('#sumCheck'));
    assert.ok(await p.isVisible('#lkCheck'));
    // Printed report: the notes come right after the numbers.
    await p.click('#srcLookup');
    await p.emulateMedia({ media: 'print' });
    await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    const order = await p.evaluate(() => [...document.querySelector('#report').children].map(el => el.className));
    assert.ok(order.indexOf('r-warn') === order.indexOf('r-top') + 1, `report order: ${order}`);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('parts with no roof data: their own row, in by default, toggles the attic floor', async () => {
    const ctx = await newContext(), p = await open(ctx), j = truth['4 Low Detail Dr'];
    await lookup(p, '4 Low Detail Dr');
    const row = p.locator('#faceBody tr.nodata');
    assert.equal(await row.count(), 1);
    assert.match(await row.textContent(), new RegExp(`Parts with no roof data\\s*${fmt0(j.attic.unmatchedM2 * FT2)}`));
    assert.ok(await p.isChecked('#faceBody input[data-nodata]'), 'included by default');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(j, 12)));
    await p.uncheck('#faceBody input[data-nodata]');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(j, 12, undefined, true)));
    assert.equal(await text(p, '#kAttic'), fmt0(contractAttic(j, 12, undefined, true)));
    assert.match(await text(p, '#kAtticSub'), /parts with no roof data left out/);
    assert.match(await text(p, '#lkAtticNote'), /without the parts with no roof data\.$/);
    // Not shown when the outline matches the faces (under 5% of the footprint).
    await lookup(p, '1 Gable Ln');
    assert.equal(await p.locator('#faceBody tr.nodata').count(), 0);
    // Nor when Google sent no roof faces at all (the whole outline would be "no roof data"), as in the Koala app.
    const bare = { ...j, segments: [], faces: [], edges: [], attic: { ...j.attic, unmatchedM2: j.attic.footprintM2, perimeterByFaceM: {}, excluded: [], excludedM2: 0, deckM2: null } };
    await p.route(/\/api\/takeoff\?/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bare) }));
    await lookup(p, '4 Low Detail Dr');
    await p.unroute(/\/api\/takeoff\?/);
    assert.equal(await p.locator('#faceBody tr.nodata').count(), 0, 'no row without faces');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(bare, 12)), 'the attic floor is the whole outline less the overhang');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('ZERO_RESULTS and "no roof" give plain errors', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await lookup(p, '404 Nowhere St');
    assert.equal(await p.getAttribute('#lkCard', 'data-state'), 'error');
    assert.match(await p.getAttribute('#lookupStatus', 'class'), /warn/);
    assert.equal(await text(p, '#lookupStatus'), "Google couldn't find that address. Check the spelling, or add the town and state.");
    assert.ok(await p.isHidden('#lookupResult'));
    await lookup(p, '12 no roof Rd');
    assert.equal(await text(p, '#lookupStatus'), 'Google has no roof data at that spot. Check the address, or measure the roof from photos in steps 1 to 3.');
    await p.fill('#addr', '   ');
    await p.click('#lookupBtn');
    assert.equal(await text(p, '#lookupStatus'), 'Type an address first.');
    // the sample numbers are untouched
    assert.equal(await text(p, '#kArea'), '1,708');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('progress text while the lookup runs, then the result', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await p.route(/\/api\/takeoff\?/, async r => { await sleep(3300); await r.continue(); });
    await p.evaluate(() => {
      window.__seen = [];
      new MutationObserver(() => window.__seen.push(document.querySelector('#lookupStatus').textContent)).observe(document.querySelector('#lookupStatus'), { childList: true, characterData: true, subtree: true });
    });
    await lookup(p, '1 Gable Ln');
    const seen = await p.evaluate(() => window.__seen);
    assert.equal(seen[0], 'Finding the address…');
    assert.ok(seen.includes('Measuring the roof…'), JSON.stringify(seen));
    assert.match(seen[seen.length - 1], /^Found 2 roof faces/);
    assert.equal(p.takeoff.length, 1, 'one call to /api/takeoff');
    await ctx.close();
  });

  await test('busy guard: a second submit while a lookup runs is ignored', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await p.route(/\/api\/takeoff\?/, async r => { await sleep(800); await r.continue(); });
    await andWait(p, async () => {
      await p.fill('#addr', '2 Hip Rd');
      await p.press('#addr', 'Enter');
      await p.press('#addr', 'Enter');
      assert.ok(await p.isDisabled('#lookupBtn'));
    });
    await sleep(300);
    assert.equal(p.takeoff.length, 1);
    await ctx.close();
  });

  await test('falls back to the satellite picture when the aerial photo fails', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await p.route(/\/api\/geotiff\?/, r => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Mock photo failure."}' }));
    await lookup(p, '2 Hip Rd');
    assert.equal(await p.getAttribute('#mapBoard', 'data-kind'), 'satellite');
    assert.match(await text(p, '#mapNote'), /Regular satellite photo/);
    assert.equal(await text(p, '#lkAttic'), fmt0(truth['2 Hip Rd'].attic.floorM2 * FT2));
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('tapping the photo only marks the spot; looking it up there takes a yes, and keeps the street name', async () => {
    const ctx = await newContext({ viewport: { width: 375, height: 812 } }), p = await open(ctx);
    await lookup(p, '3 Cross Gable Ct');
    await p.uncheck('#faceBody input[data-n="1"]');
    const before = await text(p, '#lkAttic'), calls = p.takeoff.length;
    const b = await p.locator('#mapCanvas').boundingBox();
    const tap = () => p.locator('#mapCanvas').click({ position: { x: b.width * 0.45, y: b.height * 0.4 } });
    await tap();
    await sleep(400);
    assert.equal(p.takeoff.length, calls, 'a tap alone runs nothing');
    assert.ok(await p.isVisible('#pinBar'));
    assert.equal(await text(p, '#pinGo'), 'Look up the roof here (paid)');
    assert.match(await text(p, '#pinText'), /^New spot marked on the photo, near 3 Cross Gable Ct, Newark, DE 19711, USA\. Each lookup is a paid Google request\.$/);
    const bar = await box(p, '#pinBar'), board = await box(p, '#mapBoard');
    assert.ok(bar.y > board.y + board.height && bar.y - (board.y + board.height) < 200, 'the yes/cancel bar sits under the photo');
    for (const id of ['#pinGo', '#pinCancel']) assert.ok((await box(p, id)).height >= 44);
    // Cancel: nothing changes, face choices kept.
    await p.click('#pinCancel');
    assert.ok(await p.isHidden('#pinBar'));
    assert.equal(await text(p, '#lkAttic'), before);
    assert.equal(p.takeoff.length, calls);
    // Tap again and say yes: one lookup by lat/lng, labelled near the old address.
    await tap();
    await andWait(p, () => p.click('#pinGo'));
    assert.equal(p.takeoff.length, calls + 1);
    const last = p.takeoff[p.takeoff.length - 1];
    assert.ok(last.searchParams.has('lat') && last.searchParams.has('lng') && !last.searchParams.has('address') && !last.searchParams.has('near'));
    assert.equal(await text(p, '#lkAddress'), 'Near 3 Cross Gable Ct, Newark, DE 19711, USA');
    assert.equal(await text(p, '#sumFrom'), 'From the address lookup: Near 3 Cross Gable Ct, Newark, DE 19711, USA');
    assert.ok(await p.isHidden('#pinBar'));
    const u = new URL(p.url());
    assert.equal(u.searchParams.get('lat'), last.searchParams.get('lat'));
    assert.equal(u.searchParams.get('lng'), last.searchParams.get('lng'));
    const j = await api({ lat: last.searchParams.get('lat'), lng: last.searchParams.get('lng') });
    assert.equal(await text(p, '#lkAttic'), fmt0(j.attic.floorM2 * FT2));
    assert.match(await text(p, '#recentList'), /Near 3 Cross Gable Ct/);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('a failed lookup takes the last house off the screen and out of the totals', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await lookup(p, '4 Low Detail Dr');
    // While the next lookup runs, the old result is faded and can't be used.
    await p.route(/\/api\/takeoff\?/, async r => { await sleep(700); await r.continue(); });
    await andWait(p, async () => {
      await p.fill('#addr', '9 no roof Rd');
      await p.click('#lookupBtn');
      await sleep(250);
      assert.match(await p.getAttribute('#lookupResult', 'class'), /stale/);
      assert.equal(await p.getAttribute('#sumCard', 'data-stale'), '1');
    });
    assert.equal(await p.getAttribute('#lkCard', 'data-state'), 'error');
    assert.ok(await p.isHidden('#lookupResult'), 'the old house is gone');
    assert.equal(await text(p, '#lookupStatus'), 'Google has no roof data at that spot. Check the address, or measure the roof from photos in steps 1 to 3.');
    assert.ok(!/tap/i.test(await text(p, '#lookupStatus')), 'no photo to tap');
    assert.equal(await p.getAttribute('#sumCard', 'data-stale'), null);
    assert.ok(await p.isHidden('#srcSeg'));
    assert.ok(await p.isHidden('#sumFrom'));
    assert.equal(await text(p, '#kArea'), '1,708', 'the Roof total is back on steps 1 to 3');
    assert.equal(await text(p, '#kAttic'), '1,232');
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
    await p.click('#copySum');
    assert.match(await p.evaluate(() => navigator.clipboard.readText()), /^Roof Takeoff: Sample house\n/);
    assert.ok(await p.isDisabled('#copyLink'));
    assert.equal(new URL(p.url()).searchParams.get('address'), '9 no roof Rd', 'the link is the address in the box, not the old house');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('links never run a paid lookup on their own: ?address= fills the box, ?lat=&lng= marks a pin', async () => {
    const ctx = await newContext();
    let p = await open(ctx, '/?address=' + encodeURIComponent('2 Hip Rd'));
    await sleep(600);
    assert.equal(p.takeoff.length, 0, 'no call to /api/takeoff on load');
    assert.equal(await p.inputValue('#addr'), '2 Hip Rd');
    assert.equal(await text(p, '#lookupStatus'), 'Address filled in from the link. Tap Look up roof to measure it. Each lookup is a paid Google request.');
    assert.ok(await p.isHidden('#lookupResult'));
    assert.equal(await text(p, '#kArea'), '1,708');
    await andWait(p, () => p.click('#lookupBtn'));
    assert.equal(p.takeoff.length, 1, 'the button runs it');
    assert.equal(new URL(p.url()).searchParams.get('address'), '2 Hip Rd, Newark, DE 19711, USA', 'the URL follows the lookup');
    assert.equal(await text(p, '#lkAttic'), fmt0(truth['2 Hip Rd'].attic.floorM2 * FT2));
    await p.close();
    const c = truth['1 Gable Ln'].building.center;
    p = await open(ctx, `/?lat=${c.lat}&lng=${c.lng}`);
    await sleep(600);
    assert.equal(p.takeoff.length, 0, 'a pin link runs nothing either');
    assert.ok(await p.isVisible('#pinBar'));
    assert.equal(await text(p, '#pinText'), `Pin at ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}. Each lookup is a paid Google request.`);
    await andWait(p, () => p.click('#pinGo'));
    assert.equal(p.takeoff.length, 1);
    assert.equal(p.takeoff[0].searchParams.get('lat'), String(c.lat));
    assert.match(await text(p, '#lkAddress'), /^Pin at /);
    assert.equal(await text(p, '#lkAttic'), fmt0((await api({ lat: c.lat, lng: c.lng })).attic.floorM2 * FT2));
    await p.close();
    p = await open(ctx, `/?lat=${c.lat}&lng=${c.lng}`);
    await p.click('#pinCancel');
    assert.ok(await p.isHidden('#pinBar'));
    assert.equal(new URL(p.url()).search, '');
    await p.close();
    p = await open(ctx, '/?lat=north&lng=-75.75');
    await sleep(500);
    assert.equal(p.takeoff.length, 0, 'a bad pin runs nothing');
    assert.ok(await p.isHidden('#pinBar'));
    assert.equal(await text(p, '#kArea'), '1,708');
    await ctx.close();
  });

  await test('reload and tab restore show this tab\'s last result again with no call to the server', async () => {
    const ctx = await newContext(), p = await open(ctx), j = truth['3 Cross Gable Ct'];
    await lookup(p, '3 Cross Gable Ct');
    await p.click('#lkCard .chips.oh button[data-oh="18"]');
    await p.uncheck('#faceBody input[data-n="1"]');
    await sleep(500);
    const want = await p.evaluate(() => ['#lkAttic', '#lkArea', '#kAttic', '#lkAddress', '#lkDeck', '#edgeLegend'].map(s => document.querySelector(s).textContent));
    const seen = [];
    p.on('request', r => { if (/\/api\//.test(r.url())) seen.push(r.url()); });
    await p.reload();
    await p.waitForSelector('#lkCard[data-state="restored"]');
    await p.waitForFunction(() => document.querySelector('#mapBoard').dataset.kind === 'photo');
    await sleep(300);
    assert.deepEqual(seen, [], 'nothing reaches the server: no lookup, no photo download');
    assert.deepEqual(await p.evaluate(() => ['#lkAttic', '#lkArea', '#kAttic', '#lkAddress', '#lkDeck', '#edgeLegend'].map(s => document.querySelector(s).textContent)), want);
    assert.equal(await p.isChecked('#faceBody input[data-n="1"]'), false, 'face choices kept');
    assert.equal(await p.getAttribute('#lkCard .chips.oh button[data-oh="18"]', 'aria-pressed'), 'true', 'overhang kept');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(j, 18, s => s.n !== 1 && s.n !== 5)));
    assert.match(await text(p, '#lookupStatus'), /^Your last lookup, shown again \(no new charge\)\. Found 5 roof faces/);
    assert.equal(await p.inputValue('#addr'), j.place.address);
    // A second reload (choices saved again meanwhile) still has the photo.
    await p.click('#lkCard .chips.oh button[data-oh="6"]');
    await sleep(400);
    await p.reload();
    await p.waitForSelector('#lkCard[data-state="restored"]');
    await p.waitForFunction(() => document.querySelector('#mapBoard').dataset.kind === 'photo');
    assert.equal(await p.getAttribute('#lkCard .chips.oh button[data-oh="6"]', 'aria-pressed'), 'true');
    assert.equal(await text(p, '#lkAttic'), fmt0(contractAttic(j, 6, s => s.n !== 1 && s.n !== 5)));
    assert.deepEqual(seen, []);
    // The photo still taps (marks a spot) after a restore.
    const b = await p.locator('#mapCanvas').boundingBox();
    await p.locator('#mapCanvas').click({ position: { x: b.width * 0.5, y: b.height * 0.5 } });
    assert.ok(await p.isVisible('#pinBar'));
    assert.deepEqual(seen, []);
    // Another tab with the same link has no stored result: it only fills in the address.
    const p2 = await open(ctx, '/?' + new URL(p.url()).searchParams.toString());
    await sleep(500);
    assert.equal(p2.takeoff.length, 0);
    assert.ok(await p2.isHidden('#lookupResult'));
    assert.equal(await p2.inputValue('#addr'), j.place.address);
    // Storage that is broken or blocked: the page still loads and just fills in the address.
    await p.evaluate(() => sessionStorage.setItem('roofTakeoff.last', '{broken'));
    await p.reload();
    await sleep(400);
    assert.deepEqual(seen, []);
    assert.ok(await p.isHidden('#lookupResult'));
    assert.deepEqual([...p.errors, ...p2.errors], []);
    await ctx.close();
  });

  await test('recent lookups: kept on this device, newest first, at most 12, tap to run again', async () => {
    const ctx = await newContext(), p = await open(ctx);
    assert.ok(await p.isHidden('#recentBox'));
    await lookup(p, '1 Gable Ln');
    await lookup(p, '2 Hip Rd');
    await lookup(p, '1 Gable Ln');
    await p.click('#lkCard .chips.oh button[data-oh="24"]');
    await sleep(500);
    await p.goto(server.url + '/'); // a fresh page with no link: only the recent list is on it
    await p.waitForSelector('#recentBox:not([hidden])');
    let items = await p.$$eval('#recentList .recent-item', b => b.map(x => [x.querySelector('.r-addr').textContent, x.querySelector('.r-meta').textContent]));
    assert.equal(items.length, 2, 'same address is not listed twice');
    assert.equal(items[0][0], '1 Gable Ln, Newark, DE 19711, USA');
    assert.ok(items[0][1].endsWith(`attic ${fmt0(contractAttic(truth['1 Gable Ln'], 24))} · roof ${fmt0(sloped(truth['1 Gable Ln']))} sq ft · 6/12`), `numbers follow the overhang shown: ${items[0][1]}`);
    assert.match(await text(p, '#recentBox'), /Each is a new paid lookup/);
    p.takeoff = [];
    await andWait(p, () => p.click('#recentList .recent-item[data-i="1"]'));
    assert.equal(await p.inputValue('#addr'), '2 Hip Rd, Newark, DE 19711, USA');
    assert.equal(p.takeoff.length, 1);
    assert.equal(await text(p, '#lkAddress'), '2 Hip Rd, Newark, DE 19711, USA');
    // cap at 12, a pin entry, bad storage
    await p.evaluate(() => localStorage.setItem('roofTakeoff.recent', JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ address: `${i + 10} Test St`, at: '2026-11-01T12:00:00Z', attic: 1000 + i, surface: 1500, pitch: 6 })))));
    await p.goto(server.url + '/'); // a fresh page with no link: only the recent list is on it
    items = await p.$$eval('#recentList .recent-item', b => b.length);
    assert.equal(items, 4, 'compact: four shown');
    await p.click('#recentMore');
    assert.equal(await p.$$eval('#recentList .recent-item', b => b.length), 12);
    await lookup(p, '2 Hip Rd');
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('roofTakeoff.recent')));
    assert.equal(stored.length, 12);
    assert.equal(stored[0].address, '2 Hip Rd, Newark, DE 19711, USA');
    await p.evaluate(() => localStorage.setItem('roofTakeoff.recent', '{not json'));
    await p.goto(server.url + '/'); // a fresh page with no link: only the recent list is on it
    assert.ok(await p.isHidden('#recentBox'));
    assert.equal(await text(p, '#kArea'), '1,708');
    await p.evaluate(() => localStorage.setItem('roofTakeoff.recent', JSON.stringify([{ lat: 39.6815172, lng: -75.7500077, at: '2026-11-02T12:00:00Z', attic: 1, surface: 2, pitch: 6 }])));
    await p.goto(server.url + '/'); // a fresh page with no link: only the recent list is on it
    assert.match(await text(p, '#recentList'), /Pin at 39\.68152, -75\.75001/);
    await andWait(p, () => p.click('#recentList .recent-item'));
    assert.equal(p.takeoff[p.takeoff.length - 1].searchParams.get('lat'), '39.6815172');
    await p.click('#recentClear');
    assert.ok(await p.isHidden('#recentBox'));
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('copy summary and copy link put plain text on the clipboard', async () => {
    const ctx = await newContext();
    const p = await open(ctx);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
    await p.click('#copySum');
    let clip = await p.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /^Roof Takeoff: Sample house\n/);
    assert.ok(clip.includes('Attic floor: 1,232 sq ft'));
    assert.ok(clip.includes('Roof surface (sloped): 1,708 sq ft'));
    await lookup(p, '3 Cross Gable Ct');
    await p.click('#copySum');
    clip = await p.evaluate(() => navigator.clipboard.readText());
    const ft = k => fmt0(cross.edgeTotalsM[k] * M2FT);
    for (const want of [
      'Roof Takeoff: 3 Cross Gable Ct, Newark, DE 19711, USA',
      'High-detail aerial imagery from May 14, 2024, about 4 inches per pixel.',
      `Attic floor: ${fmt0(contractAttic(cross, 12))} sq ft (Roof outline minus 12" overhang, 1 face left out)`,
      `Roof surface (sloped): ${fmt0(sloped(cross))} sq ft`,
      `Squares: ${fmt1(sloped(cross) / 100)}`,
      'Main pitch: 6/12', 'Overhang used: 12"',
      '5. 1.0/12, faces south, footprint 128 sq ft, sloped 128 sq ft, not over the attic',
      `Roof edges (feet, along the slope): ridge ${ft('ridge')}, valley ${ft('valley')}, eave ${ft('eave')}, rake ${ft('rake')}, headwall ${ft('headwall')}`,
      `Roof deck over the attic floor: ${fmt0(contractDeck(cross, 12))} sq ft (for spray foam under the roof)`,
      'headwall (apron) flashing',
      `drip edge ${fmt0(Math.ceil((cross.edgeTotalsM.eave + cross.edgeTotalsM.rake) * M2FT))} ft`,
      'Estimates from Google aerial imagery. Verify on site.',
      `Link: ${server.url}/?address=3+Cross+Gable+Ct%2C+Newark%2C+DE+19711%2C+USA`,
    ]) assert.ok(clip.includes(want), `summary has: ${want}\n---\n${clip}`);
    assert.ok(!/[<>]/.test(clip), 'plain text');
    assert.ok(await p.isEnabled('#copyLink'));
    await p.click('#copyLink');
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), `${server.url}/?address=3+Cross+Gable+Ct%2C+Newark%2C+DE+19711%2C+USA`);
    assert.match(await text(p, '#toast'), /looking it up there is a new paid lookup/);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('print: the report layout replaces the page, one letter page', async () => {
    const ctx = await newContext({ viewport: { width: 816, height: 1056 } }), p = await open(ctx);
    await lookup(p, '3 Cross Gable Ct');
    await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await p.click('#printBtn');
    assert.equal(await p.evaluate(() => window.__printed), 1);
    assert.ok(await p.isHidden('#report'), 'hidden on screen');
    await p.emulateMedia({ media: 'print' });
    assert.ok(await p.isVisible('#report'));
    assert.ok(await p.isHidden('.page'));
    const r = await text(p, '#report');
    for (const want of ['3 Cross Gable Ct, Newark, DE 19711, USA', 'Looked up ', 'High-detail aerial imagery from May 14, 2024', 'Attic floor', `${fmt0(contractAttic(cross, 12))} sq ft`,
      'Roof surface (sloped)', `${fmt0(sloped(cross))} sq ft`, 'Squares', 'Order with 15% waste', 'Footprint', 'Main pitch', '6/12', 'Overhang used', '12"',
      'Roof faces', 'Roof edges', 'Materials', 'Drip edge', 'Estimates from Google aerial imagery. Verify on site.']) assert.ok(r.includes(want), `report has: ${want}`);
    assert.match(await p.getAttribute('#report img', 'src'), /^data:image\/jpeg;base64,/);
    await p.evaluate(() => new Promise(r => { scrollTo(0, 0); requestAnimationFrame(() => r()); }));
    await shot(p, 'print-cross-gable');
    const pdf = await p.pdf({ format: 'Letter', printBackground: true });
    assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1, 'fits on one letter page');
    // the report follows changes too (re-rendered for printing)
    await p.emulateMedia({ media: 'screen' });
    await p.click('#lkCard .chips.oh button[data-oh="24"]');
    await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    assert.ok((await text(p, '#report')).includes(`${fmt0(contractAttic(cross, 24))} sq ft`));
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('access code: asked for on 401, then the lookup runs with it', async () => {
    const ctx = await newContext(), p = await open(ctx, '/', coded);
    await lookup(p, '1 Gable Ln');
    assert.ok(await p.isVisible('#codeRow'));
    assert.equal(await text(p, '#lookupStatus'), 'Enter the access code your office set up, then look up again.');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'accessCode');
    await p.fill('#accessCode', '1111');
    await andWait(p, () => p.click('#codeSave'));
    assert.ok(await p.isVisible('#codeRow'), 'wrong code asks again');
    await p.fill('#accessCode', '4321');
    await andWait(p, () => p.click('#codeSave'));
    assert.ok(await p.isHidden('#codeRow'));
    assert.equal(await p.getAttribute('#lkCard', 'data-state'), 'done');
    assert.equal(await p.getAttribute('#mapBoard', 'data-kind'), 'photo', 'the photo download sends the code too');
    assert.equal(await text(p, '#lkAttic'), fmt0(truth['1 Gable Ln'].attic.floorM2 * FT2));
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('"Use these faces in step 3" carries the attic choices; the summary switches source', async () => {
    const ctx = await newContext(), p = await open(ctx);
    await lookup(p, '3 Cross Gable Ct');
    await p.click('#lkUse');
    const rows = await p.$$eval('#secBody tr', r => r.map(tr => [tr.querySelector('input.in').value, tr.querySelector('input[type=checkbox]').checked]));
    assert.deepEqual(rows, [['6/12 faces (4)', true], ['1/12 faces, no attic (1)', false]]);
    assert.equal(await p.getAttribute('#srcSteps', 'aria-pressed'), 'true');
    assert.ok(await p.isHidden('#sampleNote'));
    const lk = contractAttic(cross, 12), st = Number((await text(p, '#kAttic')).replace(/,/g, ''));
    assert.ok(Math.abs(st - lk) / lk < 0.01, `step 3 attic ${st} within 1% of the lookup's ${fmt0(lk)}`);
    assert.match(await text(p, '#kAtticSub'), /1 of 2 sections, minus 12" overhang/);
    await p.click('#srcLookup');
    assert.equal(await text(p, '#kAttic'), fmt0(lk));
    assert.equal(await text(p, '#kArea'), fmt0(sloped(cross)));
    // editing step 3 switches the total back to steps 1-3
    await p.fill('#secBody tr:first-child input[type=number]', '8');
    assert.equal(await p.getAttribute('#srcSteps', 'aria-pressed'), 'true');
    await p.uncheck('#secBody tr:first-child input[type=checkbox]');
    assert.equal(await text(p, '#kAttic'), '–');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('photo method: paste, drag and drop, and upload of photos still work', async () => {
    const ctx = await newContext(), p = await open(ctx);
    const rgb = Buffer.alloc(200 * 150 * 3, 120), png = encodePng(200, 150, rgb);
    const b64 = png.toString('base64');
    // paste goes to the overhead board first
    await p.evaluate(b => {
      const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0)), dt = new DataTransfer();
      dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, b64);
    await p.waitForSelector('#overTag[hidden]', { state: 'attached' });
    assert.equal(await p.getAttribute('#modeScale', 'aria-pressed'), 'true');
    assert.equal(await p.$$eval('#secBody tr', r => r.length), 1);
    assert.ok(await p.isHidden('#sampleNote'));
    assert.equal(await text(p, '#kSecs'), '0 of 1 section measured');
    // drop a photo on the gable board
    await p.evaluate(b => {
      const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0)), dt = new DataTransfer();
      dt.items.add(new File([bytes], 'gable.png', { type: 'image/png' }));
      document.querySelector('#gableBoard').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await p.waitForSelector('#gableTag[hidden]', { state: 'attached' });
    assert.equal(await text(p, '#pitchVal'), '–');
    // file input
    await p.setInputFiles('#overFile', { name: 'roof.png', mimeType: 'image/png', buffer: png });
    await p.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Overhead image loaded'));
    // type a footprint: attic counts it as entered and says so
    await p.fill('#secBody input[type=number][placeholder="sq ft"]', '1000');
    assert.equal(await text(p, '#kArea'), fmt0(1000 * Math.sqrt(1 + 0.25)));
    assert.equal(await text(p, '#kAttic'), '1,000');
    assert.match(await text(p, '#kAtticSub'), /typed footprints as entered/);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('keyboard and screen reader basics', async () => {
    const ctx = await newContext(), p = await open(ctx);
    assert.equal(await p.getAttribute('#lookupStatus', 'aria-live'), 'polite');
    assert.equal(await p.$eval('label[for=addr]', l => l.textContent), 'Property address');
    await p.focus('#addr');
    await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'lookupBtn');
    assert.equal(await p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
    await lookup(p, '3 Cross Gable Ct');
    const unlabeled = await p.evaluate(() => [...document.querySelectorAll('input, select, button')].filter(el => !el.closest('[hidden]') && el.type !== 'file' && !(el.getAttribute('aria-label') || el.labels?.length || el.textContent.trim())).map(el => el.outerHTML.slice(0, 80)));
    assert.deepEqual(unlabeled, []);
    assert.equal(await p.getAttribute('#faceBody input[data-n="5"]', 'aria-label'), 'Face 5 is over the attic');
    await ctx.close();
  });

  await test('phones: key controls are at least 44 px, and the faces table shows both sq ft columns at 375 px', async () => {
    const ctx = await newContext({ viewport: { width: 375, height: 812 } }), p = await open(ctx);
    await lookup(p, '4 Low Detail Dr');
    await lookup(p, '7 Cape Dormer Way');
    const small = await p.evaluate(() => {
      const sel = ['#addr', '#lookupBtn', '#lkCard .chips.oh button', '#faceBody label.att', '#lkUse', '#printBtn', '#copySum', '#copyLink',
        '#srcLookup', '#srcSteps', '.recent-item', '#recentClear', '#lkCheck', '#wasteChips button', '#addSec', '#secBody .icon-btn',
        '#secBody input.in', '#modeScale', '#modeTrace', '#applyTo'];
      const out = [];
      for (const q of sel) for (const el of document.querySelectorAll(q)) {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest('[hidden]')) continue;
        if (r.height < 44 || (el.matches('label.att') && r.width < 44)) out.push(`${q}: ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    assert.deepEqual(small, []);
    const fit = await p.evaluate(() => {
      const wrap = document.querySelector('#facesTitle + .table-wrap').getBoundingClientRect();
      const ths = [...document.querySelectorAll('.secs.faces thead th')].filter(th => th.getBoundingClientRect().width);
      const cells = [...document.querySelectorAll('#faceBody tr[data-face]')].map(tr => [...tr.cells].filter(td => td.getBoundingClientRect().width).map(td => td.getBoundingClientRect().right));
      return { wrapRight: wrap.right, heads: ths.map(th => [th.innerText.trim().replace(/\s+/g, ' '), th.getBoundingClientRect().right]), cells, scroll: document.querySelector('#facesTitle + .table-wrap').scrollWidth - document.querySelector('#facesTitle + .table-wrap').clientWidth };
    });
    assert.deepEqual(fit.heads.map(h => h[0].toLowerCase()), ['face and pitch', 'footprint (sq ft)', 'sloped (sq ft)', 'over the attic']);
    for (const [name, right] of fit.heads) assert.ok(right <= fit.wrapRight + 0.5, `${name} is on screen (${right} > ${fit.wrapRight})`);
    for (const row of fit.cells) for (const right of row) assert.ok(right <= fit.wrapRight + 0.5);
    assert.ok(fit.scroll <= 1, 'the faces table does not scroll sideways');
    assert.match(await text(p, '#faceBody tr[data-face]'), /Slopes (north|south|east|west)/i);
    assert.equal(await p.$$eval('#faceBody .tag.hint', t => t.map(x => x.textContent)).then(t => t.length), 3);
    assert.equal(await text(p, '#faceBody .tag.hint'), 'Lower roof: garage, porch or addition?');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('step 3: two traced sections over the attic keep the overhang along the side they share', async () => {
    const ctx = await newContext(), p = await open(ctx);
    // Sample: main roof 46 x 30 ft and porch 20 x 8 ft (280 x 112 px at 14 px per foot) share the porch's 20 ft top side.
    assert.equal(await text(p, '#kAttic'), '1,232', 'porch not over the attic: main loses the overhang all round');
    await p.check('#secBody tr:nth-child(2) input[type=checkbox]');
    // main 1380 - (152 - 20) + 4 = 1252, porch 160 - (56 - 20) + 4 = 128 (the union is 1540 - 168 + 4 = 1376)
    assert.equal(await text(p, '#attv-2'), '128');
    assert.equal(await text(p, '#attv-1'), '1,252');
    assert.equal(await text(p, '#kAttic'), '1,380');
    await p.click('.card:has(#secBody) .chips.oh button[data-oh="0"]');
    assert.equal(await text(p, '#kAttic'), '1,540', 'no overhang: the whole footprint');
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  await test('phones and desktops, light and dark: tidy layout, screenshots', async () => {
    for (const [w, h] of [[375, 812], [1280, 900]]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await newContext({ viewport: { width: w, height: h }, colorScheme: scheme }), p = await open(ctx);
        await noSideScroll(p);
        await lookup(p, '7 Cape Dormer Way');
        await p.mouse.move(0, 0);
        await noSideScroll(p);
        // tables scroll inside their own wrapper, never the page
        const wrapOk = await p.$$eval('.table-wrap', ws => ws.every(x => x.getBoundingClientRect().right <= innerWidth + 0.5));
        assert.ok(wrapOk);
        await shot(p, `cape-dormer-${w}-${scheme}`);
        if (w === 375) {
          await p.emulateMedia({ media: 'print' });
          await p.evaluate(() => new Promise(r => { scrollTo(0, 0); requestAnimationFrame(() => r()); }));
          assert.ok(await p.isVisible('#report img'));
          await shot(p, `print-375-${scheme}`);
        }
        assert.deepEqual(p.errors, []);
        await ctx.close();
      }
    }
  });

  await browser.close();
  server.stop(); coded.stop();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`Screenshots in ${SHOTS}:\n  ${shots.join('\n  ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(e => {
  console.error(e);
  try { server && server.stop(); coded && coded.stop(); } catch (_) {}
  process.exit(1);
});
