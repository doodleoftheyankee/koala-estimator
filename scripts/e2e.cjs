const { chromium, devices } = require('playwright');
// End-to-end check of the built app on an iPhone-sized screen, including offline mode.
// Needs Playwright: npm run build && npx vite preview --port 4173, then
//   npx -p playwright node scripts/e2e.cjs [screenshot-dir]
const OUT = process.argv[2] || require('os').tmpdir();
const ICON = require('path').join(__dirname, '../public/icons/icon-512.png');
const base = 'http://localhost:4173';
const log = (...a) => console.log('✔', ...a);
function expect(cond, msg) { if (!cond) throw new Error('FAILED: ' + msg); log(msg); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.getByRole('button', { name: '+ New job' }).click();
  await page.getByLabel('Customer name').fill('Pat Smith');
  await page.getByLabel('Address').fill('12 Main St, Newark DE');

  const net = () => page.locator('.totals .num.big').textContent();
  const back = () => page.locator('.topbar .back').click();

  // Attic floor: 40 × 30'6" minus 2 chimneys 3×4
  await page.getByRole('button', { name: /\+ Attic Floor/ }).click();
  await page.getByLabel('A · Width').fill('40');
  await page.getByLabel('B · Depth').fill(`30'6"`);
  expect((await net()) === '1,220', 'attic floor net 1,220 live');
  await page.getByRole('button', { name: '+ Add cutout' }).click();
  await page.locator('.cutout').getByLabel('A · Width').fill('3');
  await page.locator('.cutout').getByLabel('B · Depth').fill('4');
  await page.locator('.cutout').getByLabel('How many').fill('2');
  expect((await net()) === '1,196', 'cutout ×2 subtracted → 1,196');
  await page.locator('.cutout').getByRole('button', { name: 'HVAC platform' }).click();
  await page.screenshot({ path: OUT + '/1-attic.png', fullPage: true });
  await back();

  // Roofline 40×30 at 6/12 then two-slope
  await page.getByRole('button', { name: /\+ Roofline/ }).click();
  await page.getByLabel('A · Width').fill('40');
  await page.getByLabel('B · Depth').fill('30');
  await page.getByLabel('Roof pitch (rise / 12)').fill('6/12');
  expect((await net()) === '1,342', 'roofline 1200 × 1.118 → 1,342');
  expect((await page.locator('.factor').first().textContent()) === 'factor ×1.118', 'pitch factor shown');
  await page.getByText('Two different slopes').click();
  await page.getByLabel('Second pitch (rise / 12)').fill('12/12');
  expect((await net()) === '1,519', 'two slopes 50/50 → 1,519');
  await back();

  // Crawl walls 40×30 outline, 3'6" high, 4 vents 16"×8"
  await page.getByRole('button', { name: /\+ Crawl Walls/ }).click();
  await page.getByLabel('Average wall height').fill(`3'6"`);
  await page.getByLabel('A · Width').first().fill('40');
  await page.getByLabel('B · Depth').first().fill('30');
  expect((await net()) === '490', 'walls 140 × 3.5 → 490');
  await page.getByRole('button', { name: '+ Add vent or door' }).click();
  await page.locator('.cutout').getByLabel('A · Width').fill(`16"`);
  await page.locator('.cutout').getByLabel('B · Depth').fill(`8"`);
  await page.locator('.cutout').getByLabel('How many').fill('4');
  expect((await net()) === '486', 'vents subtracted → 486');
  await back();

  // Crawl floor: custom L drawn by tapping, sides typed
  await page.getByRole('button', { name: /\+ Crawl Floor/ }).click();
  await page.getByRole('radio', { name: 'Custom' }).first().click();
  const tap = async (fx, fy) => {
    // plan feet → grid units (2 ft squares, 12.5 px each in the 300 viewBox, y up)
    const pt = await page.locator('svg.grid').evaluate((svg, [x, y]) => {
      svg.scrollIntoView({ block: 'center' });
      const p = new DOMPoint((x / 2) * 12.5, 300 - (y / 2) * 12.5).matrixTransform(svg.getScreenCTM());
      return [p.x, p.y];
    }, [fx, fy]);
    await page.mouse.click(pt[0], pt[1]);
  };
  for (const [x, y] of [[4, 4], [44, 4], [44, 24], [24, 24], [24, 34], [4, 34], [4, 4]]) await tap(x, y);
  expect((await page.locator('.dims .field').count()) === 6, 'tapping the first corner closes a 6-sided outline');
  const sides = ['40', '', '20', '', '20', '30'];
  for (let i = 0; i < 6; i++) if (sides[i]) await page.getByLabel(`Side ${i + 1}`, { exact: true }).fill(sides[i]);
  expect((await net()) === '1,000', 'custom L solved by shoelace → 1,000');
  await page.screenshot({ path: OUT + '/2-custom.png', fullPage: true });

  // Photos
  await page.getByRole('link', { name: /Photos \(0\/6\)/ }).click();
  await page.locator('#photo-input').setInputFiles([ICON, ICON]);
  await page.locator('.thumb').nth(1).waitFor();
  expect((await page.locator('.thumb').count()) === 2, '2 photos stored and shown as thumbnails');
  await page.getByRole('button', { name: /Analyze photos/ }).click();
  expect(await page.locator('#toast').textContent().then((t) => t.includes('coming soon')), 'analyzePhotos stub reports not available');
  await page.screenshot({ path: OUT + '/3-photos.png', fullPage: true });
  await back();
  await back();
  await page.screenshot({ path: OUT + '/4-job.png', fullPage: true });

  // Summary
  await page.getByRole('link', { name: 'View summary' }).click();
  await page.locator('table.summary').waitFor();
  expect((await page.locator('table.summary tbody tr').count()) === 4, 'summary lists 4 spaces');
  const href = await page.getByRole('link', { name: /Price Attic Floor/ }).getAttribute('href');
  expect(href === 'https://koala-foam-desk.vercel.app/?sqft=1196&type=attic_floor', 'Foam Desk link ' + href);
  await page.getByRole('button', { name: /Copy summary/ }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.includes('Customer: Pat Smith') && clip.includes('All spaces: 4,202 sq ft'), 'summary text copied with grand total 4,202');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export JSON/ }).click()]);
  const json = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  expect(json.spaces.length === 4 && json.spaces[3].photos === 2, 'JSON export has 4 spaces, photo count 2: ' + dl.suggestedFilename());
  await page.screenshot({ path: OUT + '/5-summary.png', fullPage: true });

  // Persistence + offline
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 10000 }).catch(() => {});
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller != null, null, { timeout: 10000 });
  log('service worker controls the page');
  await ctx.setOffline(true);
  await page.goto(base + '/#/');
  await page.getByText('Pat Smith').waitFor({ timeout: 5000 });
  expect(true, 'offline reload shows the saved job from IndexedDB');
  await page.getByText('Pat Smith').click();
  await page.locator('.space-card').first().waitFor();
  expect((await page.locator('.space-card').count()) === 4, 'offline: job with 4 spaces opens');
  const manifest = await page.evaluate(() => fetch('/manifest.webmanifest').then((r) => r.json()));
  expect(manifest.display === 'standalone', 'manifest served offline, display standalone');
  expect(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
