// End-to-end (local only): estimator builds an estimate on a phone (measured with Measure, the roof
// pitch read from a gable photo, a line changed from the model and the deviation explained), sends
// it, customer signs; then the offline flow; owner and
// estimator access; then Phase 2: the office schedules the job, the crew starts it, enters actuals
// and completes it on a phone, the office verifies, the nightly learning run, the learning dashboard.
// Run via scripts/e2e.sh. Needs the `playwright` package resolvable (NODE_PATH or local install).
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)('playwright');
import { sign } from './jwt.mjs';
import { drawGable, turn } from './gable.mjs';
import { execSync } from 'node:child_process';

const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const SHOTS = (process.env.E2E_SHOTS ?? new URL('./shots', import.meta.url).pathname).replace(/\/?$/, '/');
execSync(`mkdir -p ${SHOTS}`);
const psql = (sql) => execSync(`psql "${process.env.E2E_DB_URL}" -tA -c "${sql.replace(/"/g, '\\"')}"`).toString().trim();

function sessionCookie(user) {
  const access = sign({ sub: user.id, role: 'authenticated', email: user.email, aud: 'authenticated' });
  const session = { access_token: access, refresh_token: 'r', token_type: 'bearer', expires_in: 2592000, expires_at: Math.floor(Date.now() / 1000) + 2592000, user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } };
  return { name: 'sb-localhost-auth-token', value: 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'), domain: 'localhost', path: '/', httpOnly: false, sameSite: 'Lax' };
}
const EST = { id: '22222222-2222-4222-8222-222222222222', email: 'est@koala.test' };
const CREW = { id: '33333333-3333-4333-8333-333333333333', email: 'crew@koala.test' };
const check = (ok, what) => {
  if (!ok) throw new Error('E2E check failed: ' + what);
  console.log('  ok:', what);
};
const waitForDb = async (sql, want, what, ms = 30000) => {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end) {
    got = psql(sql);
    if (got === want) return check(true, what);
    await new Promise((r) => setTimeout(r, 500));
  }
  check(false, `${what} (wanted ${want}, got ${got})`);
};

const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const ctx = await browser.newContext(phone);
await ctx.addCookies([sessionCookie(EST)]);
// Copy summary is read back from the clipboard.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const logs = [];
let roofNotFoundStep = false; // the lookup of an unknown address answers 404 on purpose
let offlineStep = false; // with no signal, the app's requests fail on purpose (caught)
let signedPushStep = false; // the phone pushes a change to a quote the customer signed: 409 locked, on purpose (L35)
let unreachableStep = false; // the database is down on purpose: Koala answers 503 (L36)
const expected = (m) =>
  (roofNotFoundStep && m.location().url.endsWith('/api/roof')) ||
  (offlineStep && m.text().includes('ERR_INTERNET_DISCONNECTED')) ||
  (signedPushStep && m.location().url.endsWith('/api/sync') && m.text().includes('409')) ||
  (unreachableStep && m.text().includes('status of 503'));
page.on('console', (m) => m.type() === 'error' && !expected(m) && logs.push(`${m.text()} (${m.location().url})`));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
const step = (s) => console.log('•', s);

step('open /field');
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor();
await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready, null, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOTS + '01-list.png' });

step('create estimate');
await page.getByRole('button', { name: 'New estimate', exact: true }).click();
// A new estimate starts in the town and state of the shop address in the settings (L32, OD14).
check((await page.getByLabel('City').inputValue()) === 'Newark' && (await page.getByLabel('State').inputValue()) === 'DE', 'a new estimate starts in the town of the shop address in the settings');
await page.getByLabel('First name').fill('Pat');
await page.getByLabel('Last name').fill('Lee');
await page.getByLabel('Email').fill('pat@example.com');
await page.getByLabel('Mobile phone').fill('302-555-0100');
await page.getByLabel('Street address').fill('12 Elkton Rd');
await page.getByLabel('ZIP').fill('19711');
await page.screenshot({ path: SHOTS + '02-customer.png' });
await page.getByRole('button', { name: 'Next' }).click();

step('add attic area, measured with the Measure tool, with a photo');
await page.getByRole('button', { name: '+ Attic' }).click();
await page.getByRole('button', { name: /Measure this area/ }).click();
const sheet = page.getByRole('dialog', { name: /Measure/ });
await sheet.getByLabel('A · Width').fill('42');
await sheet.getByLabel('B · Depth').fill(`30'`);
await sheet.getByRole('button', { name: '+ Add cutout' }).click();
await sheet.getByRole('button', { name: 'Chimney', exact: true }).click();
await sheet.getByLabel('A · Width').nth(1).fill('6');
await sheet.getByLabel('B · Depth').nth(1).fill('10');
check((await sheet.getByText('1,200', { exact: true }).count()) > 0, 'measure sheet: 42 × 30 minus a 6 × 10 chimney → 1,200 net');
await page.screenshot({ path: SHOTS + '03a-measure.png' });
await sheet.getByRole('button', { name: 'Use 1,200 sq ft' }).click();
check((await page.getByLabel('Square feet').inputValue()) === '1200', 'measured net fills the area square feet');
check((await page.getByText(/Floor: rectangle, 1 cutout · 1,200 sq ft net/).count()) === 1, 'area card shows what was measured');
await page.locator('input[type=file][multiple]').first().setInputFiles(new URL('../../public/icons/icon-512.png', import.meta.url).pathname);
await page.getByText('On phone').first().waitFor();
check(true, 'photo saved on the phone, waiting to upload');

step('pitch from a photo of the gable, in Measure');
{
  // Nothing from this tool may leave the phone: no request carries a PNG (the test photos are PNGs;
  // area photos are sent as JPEGs).
  const pngSent = [];
  const watchPng = (req) => req.postDataBuffer()?.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])) && pngSent.push(req.url());
  page.on('request', watchPng);
  await page.getByRole('button', { name: /Edit measurement/ }).click();
  const measure = page.getByRole('dialog', { name: /^Measure/ });
  await measure.getByRole('radio', { name: 'Roofline' }).click();
  const openFor = async (field) => {
    await measure.getByRole('button', { name: `Pitch from a photo, for the ${field}` }).click();
    const sheet = page.getByRole('dialog', { name: `Pitch from a photo for the ${field}` });
    await sheet.waitFor();
    return sheet;
  };
  let sheet = await openFor('roof pitch');
  check((await sheet.getByRole('button', { name: 'How to shoot the gable' }).getAttribute('aria-expanded')) === 'true', 'the photo sheet opens with how to shoot the gable');
  check((await sheet.getByText(/Shooting from off to the side makes the pitch read steep/).count()) === 1, 'the tips say to shoot from straight in front');
  check(
    (await sheet.getByText(/^Hold the phone upright, not tipped back\. Tipping it up to fit the roof in makes the pitch read low/).count()) === 1 && (await sheet.getByText(/Tilting the phone is fine/).count()) === 0,
    'and to hold the phone upright, not tipped back',
  );
  await page.screenshot({ path: SHOTS + '03a1-pitch-start.png' });
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  check(await measure.isVisible(), 'Escape closes the photo sheet and leaves Measure open');

  sheet = await openFor('roof pitch');
  await sheet.locator('input[type=file]:not([capture])').setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not a photo this browser can open') });
  await sheet.getByText(/^This browser can't open HEIC photos\. Take a new photo with the camera instead, or pick a JPG\./).waitFor();
  check(true, "a HEIC photo the browser can't open gets a plain message");

  // A big photo of a 6.3/12 gable, taken with the phone tilted 4°.
  const gable = { W: 3200, H: 2400, L: [600, 1640], P: [1600, 1115], R: [2600, 1640], tilt: -4 };
  const png = Buffer.from(await page.evaluate(drawGable, gable), 'base64');
  await sheet.locator('input[type=file][capture]').setInputFiles({ name: 'gable.png', mimeType: 'image/png', buffer: png });
  const board = sheet.getByTestId('pitch-photo');
  await board.waitFor();
  check((await sheet.getByText(/HEIC/).count()) === 0, 'opening a photo clears the message');
  check((await board.getAttribute('data-photo-size')) === '2400x1800', 'a 3200 × 2400 photo is shrunk to 2400 px on its long side');
  /** Where a point of the drawing is on the screen. */
  const onScreen = async (pt) => {
    const box = await board.boundingBox();
    const [x, y] = turn(gable, pt);
    return [box.x + (x * box.width) / gable.W, box.y + (y * box.height) / gable.H];
  };
  const hint = async () => (await sheet.locator('p[aria-live]').innerText()).trim();
  check((await hint()) === 'Tap 1 of 3: the left eave corner, on the top edge of the rake trim.', 'the hint asks for the left eave corner first, on the edge to tap');
  await page.touchscreen.tap(...(await onScreen(gable.L)));
  check((await hint()) === 'Tap 2 of 3: the peak, on that same edge.', 'then the peak');
  await page.touchscreen.tap(...(await onScreen(gable.P)));
  check((await hint()) === 'Tap 3 of 3: the right eave corner, on the same edge.', 'then the right eave corner');
  await page.touchscreen.tap(...(await onScreen(gable.R)));
  check((await hint()) === 'Drag any point to fine-tune it. A magnifier shows while you drag.', 'then how to fine-tune');
  const reading = sheet.getByRole('region', { name: 'Pitch reading' });
  const readingText = async () => (await reading.innerText()).replace(/\s+/g, ' ');
  const read = await readingText();
  check((await sheet.getByTestId('pitch-value').innerText()).replace(/\s+/g, '') === '6.3/12', 'three taps on a tilted photo read 6.3/12');
  check(read.includes('Angle 27.7°') && read.includes('Pitch factor ×1.129'), 'with its angle and pitch factor: ' + read);
  check(read.includes('Left side 6.3/12') && read.includes('Right side 6.3/12') && read.includes('Both sides agree.'), 'both sides read 6.3/12 and agree');
  await page.screenshot({ path: SHOTS + '03a2-pitch-read.png' });

  // Dragging the peak sideways: a magnifier while dragging, and the sides stop agreeing.
  const peak = await onScreen(gable.P);
  await page.mouse.move(...peak);
  await page.mouse.down();
  await page.mouse.move(peak[0] + 30, peak[1], { steps: 5 });
  await page.screenshot({ path: SHOTS + '03a3-pitch-drag.png' });
  await page.mouse.up();
  check(/Sides read \d+\.\d\/12 and \d+\.\d\/12\. Retake from straight in front, unless this gable really has unequal sides\./.test(await readingText()), 'a peak off the middle asks for a retake');
  check((await sheet.getByText("The sides don't agree. Retake from straight in front?").count()) === 1, 'and says so next to the Use buttons');
  // Onto the eave line: not a roof triangle, nothing to use.
  const [l, r] = [await onScreen(gable.L), await onScreen(gable.R)];
  await page.mouse.move(peak[0] + 30, peak[1]);
  await page.mouse.down();
  await page.mouse.move((l[0] + r[0]) / 2, (l[1] + r[1]) / 2, { steps: 3 });
  await page.mouse.up();
  check((await readingText()).includes("Those points don't make a roof triangle. The peak has to sit above and between the two corners."), 'a peak on the eave line is not a roof triangle');
  check(await sheet.getByRole('button', { name: 'Use', exact: true }).isDisabled(), 'and there is nothing to use');
  await page.mouse.move((l[0] + r[0]) / 2, (l[1] + r[1]) / 2);
  await page.mouse.down();
  await page.mouse.move(...peak, { steps: 3 });
  await page.mouse.up();
  check((await sheet.getByTestId('pitch-value').innerText()).replace(/\s+/g, '') === '6.3/12', 'back on the peak it reads 6.3/12 again');
  check((await sheet.getByRole('button', { name: 'Use 6/12' }).count()) === 1, 'Use offers the whole pitch, 6/12');
  await sheet.getByRole('button', { name: 'Use 6.3/12 (as measured)' }).click();
  await sheet.waitFor({ state: 'detached' });
  check((await measure.getByLabel('Roof pitch (rise / 12 or degrees)').inputValue()) === '6.3/12', '"Use 6.3/12 (as measured)" fills the roof pitch');
  check((await measure.getByText('×1.129', { exact: true }).count()) === 1, 'and its pitch factor');
  check((await measure.getByRole('button', { name: 'Use 1,363 sq ft' }).count()) === 1, '1,260 sq ft footprint × 1.129 − 60 sq ft chimney → 1,363 sq ft of roof deck');

  // The second pitch, from a level photo of a 12/12 gable: a whole pitch has one Use button.
  await measure.getByRole('switch', { name: 'Two different slopes' }).click();
  sheet = await openFor('second pitch');
  const steep = { W: 1600, H: 1200, L: [400, 900], P: [800, 500], R: [1200, 900], tilt: 0 };
  await sheet.locator('input[type=file][capture]').setInputFiles({ name: 'steep.png', mimeType: 'image/png', buffer: Buffer.from(await page.evaluate(drawGable, steep), 'base64') });
  await sheet.getByTestId('pitch-photo').waitFor();
  check((await sheet.getByTestId('pitch-photo').getAttribute('data-photo-size')) === '1600x1200', 'a photo under 2400 px keeps its size');
  for (const pt of [steep.L, steep.P, steep.R]) {
    const box = await sheet.getByTestId('pitch-photo').boundingBox();
    await page.touchscreen.tap(box.x + (pt[0] * box.width) / steep.W, box.y + (pt[1] * box.height) / steep.H);
  }
  check((await sheet.getByTestId('pitch-value').innerText()).replace(/\s+/g, '') === '12.0/12', 'a level photo of a 12/12 gable reads 12.0/12');
  check((await sheet.getByRole('button', { name: /as measured/ }).count()) === 0, 'a whole pitch has no "as measured" button');
  await page.screenshot({ path: SHOTS + '03a4-pitch-second.png' });
  await sheet.getByRole('button', { name: 'Use 12/12' }).click();
  await sheet.waitFor({ state: 'detached' });
  check((await measure.getByLabel('Second pitch (rise / 12 or degrees)').inputValue()) === '12/12', '"Use 12/12" fills the second pitch, not the first');
  check((await measure.getByLabel('Roof pitch (rise / 12 or degrees)').inputValue()) === '6.3/12', 'the first pitch is unchanged');
  await measure.getByRole('heading', { name: 'Pitch' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + '03a5-pitch-used.png' });

  // Back to the attic floor this estimate is priced on.
  await measure.getByRole('switch', { name: 'Two different slopes' }).click();
  // A pitch typed in degrees is understood; nothing is steeper than 24/12 (L25, RF-06).
  const pitchBox = measure.getByLabel('Roof pitch (rise / 12 or degrees)');
  await pitchBox.fill('30 deg');
  check((await measure.getByText('1,260 sq ft footprint × pitch (30° = 6.93/12 → ×1.155)').count()) === 1, 'a pitch typed as "30 deg" is 6.93/12 (×1.155)');
  check((await measure.getByRole('button', { name: 'Use 1,395 sq ft' }).count()) === 1, '1,260 sq ft × 1.155 − 60 sq ft chimney → 1,395 sq ft');
  await pitchBox.fill('100');
  check(
    (await measure.getByText('Pitch "100" would be 100/12, steeper than 24/12. Type the rise per 12, e.g. 6/12, or degrees, e.g. 30°.').count()) === 1,
    'a bare 100 is refused with a hint (it was read as 100/12)',
  );
  check((await measure.getByRole('button', { name: 'Done', exact: true }).count()) === 1 && (await measure.getByRole('button', { name: /^Use [\d,]+ sq ft$/ }).count()) === 0, 'and nothing is measured');
  await pitchBox.fill('30');
  check((await measure.getByText('Pitch "30" would be 30/12, steeper than 24/12. For degrees, type 30°.').count()) === 1, 'a bare 30 (30/12) is refused, and offers 30°');
  await measure.getByRole('heading', { name: 'Pitch' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + '03a6-pitch-30-refused.png' });
  await measure.getByRole('button', { name: 'Use 30° (6.93/12)' }).click();
  check((await pitchBox.inputValue()) === '30°' && (await measure.getByRole('button', { name: 'Use 1,395 sq ft' }).count()) === 1, '"Use 30°" puts the degrees in the pitch: 1,395 sq ft');
  await measure.getByRole('radio', { name: 'Floor' }).click();
  await measure.getByRole('button', { name: 'Use 1,200 sq ft' }).click();
  check((await page.getByLabel('Square feet').inputValue()) === '1200', 'back on the floor: 1,200 sq ft');
  check((await page.getByText(/Floor: rectangle, 1 cutout · 1,200 sq ft net/).count()) === 1, 'the area card shows the floor measurement again');
  check((await page.getByText('1/6', { exact: true }).count()) === 1, 'the gable photos were not added to the area photos');
  page.off('request', watchPng);
  check(pngSent.length === 0, 'the gable photos were never sent anywhere: ' + pngSent.join(', '));
}

step('AI photo read');
await page.getByRole('button', { name: /Read this photo/ }).click();
await page.getByRole('heading', { name: 'Photo read', exact: true }).waitFor({ timeout: 60000 });
check((await page.getByText(/Recessed lights that may not be IC-rated/).count()) > 0, 'photo read flags the recessed lights as a hazard');
check((await page.getByText('Suggested changes').count()) === 1, 'photo read suggests changes to the area');
await page.screenshot({ path: SHOTS + '03b-photo-read.png', fullPage: true });
await page.getByRole('button', { name: /Apply all/ }).click();
check((await page.getByLabel('Existing insulation').inputValue()) === 'Blown fiberglass', 'applying sets the existing insulation');
check((await page.getByLabel('Existing depth (in)').inputValue()) === '3', 'applying sets the existing depth');
check((await page.getByRole('textbox', { name: 'Current R-value' }).inputValue()) === '8', 'applying sets current R from depth (3" × 2.5)');
check((await page.getByText('Suggested changes').count()) === 0, 'applied suggestions are cleared');
check((await page.getByLabel('Prep notes / obstructions').inputValue()).startsWith('From photo read:'), 'hazards and notes go into the prep notes');
const aiReq = JSON.parse(execSync(`cat ${process.env.E2E_STORAGE}/anthropic-last.json`).toString());
const imgs = aiReq.body.messages[0].content.filter((c) => c.type === 'image');
check(aiReq.body.model === 'claude-opus-5-5' && imgs.length === 1 && imgs[0].source.media_type === 'image/jpeg', 'the AI request carries the photo as a JPEG to claude-opus-5-5');
check(aiReq.body.stream === true && aiReq.body.fallbacks === 'default' && aiReq.body.output_config.effort === 'high' && aiReq.body.output_config.format?.type === 'json_schema', 'streamed, structured output, high effort, server-side fallback');
check(String(aiReq.headers.beta).includes('server-side-fallback-2026-07-01') && aiReq.headers.key, 'fallback beta header and API key sent');
await waitForDb(`select count(*) from photo_analyses where created_by = '${EST.id}' and cost_usd > 0`, '1', 'the read is logged with its cost');
await waitForDb(`select count(*) > 0 from photo_corrections where corrected_by = '${EST.id}' and accepted`, 't', 'applied suggestions are recorded for calibration');
const checkNoKey = await fetch(BASE + '/api/photos/read/check?key=wrong');
check(checkNoKey.status === 401, 'AI self-check refuses without the cron secret');
const selfCheck = await (await fetch(BASE + '/api/photos/read/check?key=e2e-cron-secret')).json();
check(selfCheck.ok === true && selfCheck.backend === 'anthropic' && selfCheck.model === 'claude-opus-5-5' && selfCheck.costUsd > 0, 'AI self-check runs a real read: ' + JSON.stringify({ ok: selfCheck.ok, backend: selfCheck.backend, model: selfCheck.model }));
await page.getByRole('radio', { name: 'R-11' }).click();
await page.getByRole('radio', { name: 'Difficult' }).click();
await page.screenshot({ path: SHOTS + '03-area.png', fullPage: true });
await page.getByRole('button', { name: 'Next' }).click();

step('options');
await page.getByText('Better', { exact: true }).first().waitFor();
{
  // Better is the default recommendation until the estimator picks one; the card and the dock agree.
  const better = page.getByRole('group', { name: 'Better option' });
  check((await better.getByRole('button', { name: 'Recommended (default)' }).count()) === 1, 'Better shows as the default recommendation before one is picked');
  check((await page.getByRole('button', { name: 'Make recommended' }).count()) === 2, 'the other two options offer Make recommended');
  await better.getByRole('button', { name: 'Recommended (default)' }).click();
  await better.getByRole('button', { name: 'Recommended', exact: true }).waitFor();
  check((await page.getByRole('button', { name: 'Recommended', exact: true }).count()) === 1, 'picking Better makes it the one recommended option');
}
await page.waitForTimeout(800);
await page.screenshot({ path: SHOTS + '04-options.png', fullPage: true });
const prices = await page.locator('p.text-2xl').allTextContents();
console.log('  prices', prices);
const num = (t) => Number(t.replace(/[^0-9.]/g, ''));

step('a price change that hides an option can be taken back (OD6, review A F1)');
{
  // Good priced above Better is not shown to the customer; its card stays, collapsed, with the reason.
  const good = page.getByRole('group', { name: 'Good option' });
  await good.getByRole('button', { name: 'Change price' }).click();
  await good.getByLabel('Customer price').fill(String(num(prices[1]) + 100));
  await good.getByLabel('Reason (required)').fill('Checking an option the customer does not see');
  await good.getByRole('button', { name: 'Apply', exact: true }).click();
  await good.getByText('Not shown to the customer', { exact: true }).waitFor();
  check((await good.getByText(/^Good is not shown to the customer: it costs .*Change its price to show it\.$/).count()) === 1, 'the hidden Good card says why, and how to show it');
  check((await page.locator('p.text-2xl').count()) === 2, 'the customer is shown Better and Best only');
  await page.screenshot({ path: SHOTS + '04a-option-not-shown.png', fullPage: true });
  await good.getByRole('button', { name: 'Remove price change' }).click();
  await good.getByRole('button', { name: 'Make recommended' }).waitFor();
  const back = await page.locator('p.text-2xl').allTextContents();
  check(JSON.stringify(back) === JSON.stringify(prices), 'Remove price change brings Good back at its model price: ' + back.join(' / '));
}

step('change a line from the model and explain it');
await page.getByRole('button', { name: 'Details', exact: true }).first().click();
await page.getByRole('button', { name: /^Change Install / }).first().click();
const hoursInput = page.getByLabel('Person-hours');
const modelHours = Number(await hoursInput.inputValue());
// +20%: beyond the 15% deviation threshold, within the estimator's 10% price limit.
await hoursInput.fill(String(Math.round(modelHours * 1.2 * 10) / 10));
await page.getByLabel('Reason (required)').fill('Low clearance, long hose run');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
const notes = page.getByLabel('Explain this change (needed to send)');
await notes.first().waitFor();
check((await notes.count()) === 1, 'a 20% labor change raises one deviation flag (not one per option)');
while ((await notes.count()) > 0) await notes.first().fill('Knee walls and 2 ft clearance over the garage');
await page.screenshot({ path: SHOTS + '04b-line-override.png', fullPage: true });
const after = await page.locator('p.text-2xl').allTextContents();
console.log('  prices after the change', after);
check(after.every((p, i) => num(p) > num(prices[i])), 'more labor raises every option that has the line');

step('send: nothing about a business profile holds it back (OD12; review B flow-B1, review A DOC-3)');
await page.getByRole('button', { name: 'Next' }).click();
await page.waitForTimeout(3500); // let auto-sync run
await page.screenshot({ path: SHOTS + '05a-send-step.png', fullPage: true });
console.log('  send checklist:', (await page.locator('body').innerText()).split('\n').filter((l) => l.trim()).slice(0, 40).join(' | '));
// The seeded settings have no license, phone or state (and production's still hold the PLACEHOLDER
// warranty seed): no checklist item, sentence or link asks anyone to finish a business profile.
check((await page.locator('li[data-check="profile"]').count()) === 0, 'the Send checklist has no business-profile item');
check(!/business profile/i.test(await page.locator('main').innerText()), 'and nothing on the Send step mentions a business profile');
check(await page.getByRole('button', { name: /Send quote to customer/ }).isEnabled(), 'Send is ready with the seeded settings, nothing filled in');
const gateEst = psql("select id from estimates order by created_at desc limit 1");
{
  // The server goes straight past the settings to the price check (no 409 setup_incomplete).
  const res = await ctx.request.post(BASE + '/api/quotes', { data: { estimateId: gateEst, expectedPrices: {} } });
  const body = await res.json();
  check(res.status() === 409 && body.error === 'pricing_changed', `the server does not refuse it for the settings (wrong expected prices on purpose): ${res.status()} ${body.error}`);
  check(psql(`select count(*) from quotes where estimate_id = '${gateEst}'`) === '0', 'and no quote was made by that check');
}

step('the Business profile page is optional (OD12)');
const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@koala.test' };
{
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await bctx.addCookies([sessionCookie(OWNER)]);
  const bp = await bctx.newPage();
  bp.on('pageerror', (e) => logs.push('OWNER PAGEERROR ' + e.message));
  bp.on('console', (m) => m.type() === 'error' && logs.push(`${m.text()} (${m.location().url})`));
  await bp.goto(BASE + '/admin/business');
  const main = await bp.locator('main').innerText();
  check(main.includes('Optional. Quotes go out without it') && !/not finished|no quote can be sent/i.test(main), 'the page says it is optional, and names no gap');
  // By name: the license field's hint mentions "the company name", so a label match finds two.
  check((await bp.locator('input[name="branding.company"]').inputValue()) === 'Koala Insulation', 'the company quotes print is Koala Insulation');
  check((await bp.locator('textarea[name="warranty_text"]').inputValue()) === 'Limited lifetime warranty', 'the warranty quotes print is "Limited lifetime warranty"');
  check((await bp.locator('[name="default_state"], [name="default_city"]').count()) === 0, 'no town or state to fill in (OD14)');
  check(/KN-\d{4}-0001-v1/.test(main) && main.includes('New estimates start in: Newark, DE'), 'it shows how quote numbers read and where new estimates start (the shop address)');
  // Release review C FLOW-9: the number is a format example, never "the next quote" (always 0001).
  check(!main.includes('The next quote this year reads like') && /Quote numbers read like KN-\d{4}-0001-v1: the number counts up with each quote/.test(main), 'quote numbering is shown as a format, not as "the next quote this year"');
  await bp.screenshot({ path: SHOTS + '05b-business-profile-optional.png', fullPage: true });
  await bp.goto(BASE + '/admin/pricing');
  check(!/Business profile:/.test(await bp.locator('main').innerText()), 'the Pricing page lists nothing about the business profile to fill in');
  await bctx.close();
}

step('Send checklist: plain words, and a Fix button that goes to the item (L34)');
{
  // An area with no size is named, not "Too small: expected number to be >0", and Add size opens it.
  await page.getByRole('button', { name: /^2 Areas/ }).click();
  await page.getByRole('button', { name: '+ Crawlspace' }).click();
  await page.getByRole('button', { name: /^4 Send/ }).click();
  const item = page.locator('li[data-check^="area:"][data-ok="no"]');
  await item.waitFor();
  check((await item.innerText()).includes('Crawlspace has no size yet. It is not in the price.'), 'the checklist names the crawlspace with no size, in plain words');
  check(!(await page.locator('main').innerText()).includes('Too small'), 'and never says "Too small: expected number to be >0"');
  check(await page.getByRole('button', { name: /Send quote to customer/ }).isDisabled(), 'Send waits for it');
  await item.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + '05d-send-checklist-fix.png' });
  await item.getByRole('button', { name: 'Add size' }).click();
  await page.waitForFunction(() => /^area-.+-sqft$/.test(document.activeElement?.id ?? ''), null, { timeout: 5000 });
  const crawl = page.locator('section[id^="area-"]', { hasText: 'Crawlspace' });
  check((await crawl.count()) === 1 && (await page.evaluate(() => document.activeElement?.id)) === `${await crawl.getAttribute('id')}-sqft`, "Add size opens the Areas step at the crawlspace's square feet");
  await crawl.getByRole('button', { name: 'Delete area' }).click();
  await page.getByRole('button', { name: /^4 Send/ }).click();
  await page.locator('li[data-check="price"][data-ok="yes"]').waitFor();
  check((await page.locator('li[data-check^="area:"][data-ok="no"]').count()) === 0, 'with the crawlspace gone, every area is ready again');
}

step('a price beyond what the estimator may quote alone: Request approval (L34)');
let asked;
{
  await page.getByRole('button', { name: /^3 Options/ }).click();
  const good = page.getByRole('group', { name: 'Good option' });
  await good.getByRole('button', { name: 'Change price' }).click();
  const hint = await good.getByText(/^Estimators can move the price up to 10% from \$/).innerText();
  const modelGood = Number(hint.match(/from \$([\d,]+)/)[1].replace(/,/g, ''));
  asked = Math.round(modelGood * 1.3);
  await good.getByLabel('Customer price').fill(String(asked));
  await good.getByLabel('Reason (required)').fill('Extra baffles and a second hatch on Good');
  await good.getByRole('button', { name: 'Apply', exact: true }).click();
  const explain = page.getByLabel('Explain this change (needed to send)');
  await explain.first().waitFor();
  while ((await explain.count()) > 0) await explain.first().fill('Customer wants the extra baffles in Good');
  await page.getByRole('button', { name: /^4 Send/ }).click();
  const item = page.locator('li[data-check="price:good"]');
  await item.waitFor();
  const dollars = (n) => '$' + n.toLocaleString('en-US');
  // The range is 10% either way of the model price, and never under the floor margin (Good's changed
  // line raised its cost, so the floor can be above 90% of the model price).
  const max = Math.floor(modelGood * 1.1 + 1e-6);
  const text = await item.innerText();
  const said = text.match(/Good: .*Request approval to send \$[\d,]+\./)?.[0] ?? text;
  const range = said.match(/You can quote \$([\d,]+) to \$([\d,]+) on your own \(estimators may change it up to 10%\)\./);
  const lo = range ? Number(range[1].replace(/,/g, '')) : NaN;
  check(
    said.startsWith(`Good: ${dollars(asked)} is 30% above the model price of ${dollars(modelGood)}. You can quote `) &&
      said.endsWith(`Request approval to send ${dollars(asked)}.`) &&
      range && Number(range[2].replace(/,/g, '')) === max && lo >= Math.ceil(modelGood * 0.9 - 1e-6) && lo <= max,
    `the checklist names the price, the model price and the range: "${said}"`,
  );
  check((await item.getByRole('button', { name: 'Change the price' }).count()) === 1, 'with a Fix that goes back to the price');
  // Review B flow-B12: the Fix opens Good's price editor with the cursor in Customer price.
  await item.getByRole('button', { name: 'Change the price' }).click();
  await page.locator('#option-good-price').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.activeElement?.id === 'option-good-price', null, { timeout: 5000 }).catch(() => undefined);
  const focused = await page.evaluate(() => ({ id: document.activeElement?.id ?? '', tag: document.activeElement?.tagName ?? '', value: document.activeElement instanceof HTMLInputElement ? document.activeElement.value : '' }));
  check(focused.id === 'option-good-price' && focused.value === String(asked), `"Change the price" opens Good's price editor with the cursor in Customer price (${focused.tag}#${focused.id} = ${focused.value}; was BODY)`);
  await page.screenshot({ path: SHOTS + '05e0-change-the-price-focused.png' });
  await page.getByRole('button', { name: /^4 Send/ }).click();
  await item.waitFor();
  check(await page.getByRole('button', { name: /Send quote to customer/ }).isDisabled(), 'and Send waits');
  await item.getByLabel(/Why this price\?/).fill('Two hatches and baffles the model does not count');
  await item.getByRole('button', { name: 'Request approval' }).click();
  await item.getByText(`Waiting for the owner or the office to approve ${dollars(asked)}.`).waitFor({ timeout: 15000 });
  check(
    psql(`select status || ':' || price::int || ':' || model_price::int || ':' || below_floor || ':' || (requested_by = '${EST.id}') from price_approvals`) === `pending:${asked}:${modelGood}:false:true`,
    'the request is stored for this option, its exact price and the model price, as the estimator\'s',
  );
  await item.scrollIntoViewIfNeeded();
  await page.screenshot({ path: SHOTS + '05e-request-approval.png' });
  const id = psql('select id from price_approvals');
  const self = await ctx.request.patch(BASE + `/api/approvals/${id}`, { data: { decision: 'approved' } });
  check(self.status() === 403, `an estimator cannot approve it: ${self.status()}`);
  const again = await ctx.request.post(BASE + '/api/approvals', { data: { estimateId: psql('select estimate_id from price_approvals'), tier: 'good', price: asked } });
  check(again.ok() && (await again.json()).already === true && psql('select count(*) from price_approvals') === '1', 'asking twice keeps one request');
  // Review B database-B2: the request keeps the loaded cost it was asked at (the server's pricing).
  check(
    psql("select a.loaded_cost is not null and a.loaded_cost = o.loaded_cost from price_approvals a join estimate_options o on o.estimate_id = a.estimate_id and o.tier = a.tier") === 't',
    'the request keeps the loaded cost the option had when it was asked',
  );
  // Review B database-B4: the estimator's own token cannot write a request straight to the database.
  {
    const res = await ctx.request.post(`http://localhost:${process.env.MOCK_PORT}/rest/v1/price_approvals`, {
      headers: { apikey: 'anon', Authorization: `Bearer ${sign({ sub: EST.id, role: 'authenticated', aud: 'authenticated' })}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      data: { estimate_id: psql('select estimate_id from price_approvals'), tier: 'best', price: 1000, model_price: 9000, below_floor: false, requested_by: EST.id },
    });
    check(res.status() === 401 || res.status() === 403, `a request written straight to the database with the estimator's token is refused: ${res.status()}`);
    check(psql('select count(*) from price_approvals') === '1', 'and nothing was written');
  }
}

step('the owner approves it from the Estimates page (L34)');
{
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await actx.addCookies([sessionCookie(OWNER)]);
  const ap = await actx.newPage();
  ap.on('pageerror', (e) => logs.push('OWNER PAGEERROR ' + e.message));
  ap.on('console', (m) => m.type() === 'error' && logs.push(`${m.text()} (${m.location().url})`));
  await ap.goto(BASE + '/estimates');
  const queue = ap.getByRole('list', { name: 'Prices waiting for approval' });
  await queue.waitFor();
  const row = await queue.innerText();
  check(/1 price waiting for approval/.test(await ap.locator('main').innerText()), 'the owner sees one price waiting for approval');
  check(row.includes('Pat Lee') && row.includes(`Good: $${asked.toLocaleString('en-US')}, 30% above the model price of`) && row.includes('Asked by Eddie Estimator') && row.includes('Two hatches and baffles'), 'with the customer, the option, the price against the model price, who asked and why');
  await ap.screenshot({ path: SHOTS + '05f-approval-queue.png', fullPage: true });
  // Review B flow-B11: the customer link in the queue is a 48 px target.
  const qb = await queue.getByRole('link', { name: 'Pat Lee' }).boundingBox();
  check(qb && qb.height >= 48, `the queue's customer link is ${Math.round(qb?.width ?? 0)}x${Math.round(qb?.height ?? 0)} px (was 107x24)`);
  await queue.getByRole('button', { name: `Approve Good at $${asked.toLocaleString('en-US')} for Pat Lee` }).click();
  await queue.waitFor({ state: 'detached', timeout: 15000 });
  check(psql("select status || ':' || decided_role || ':' || (decided_by = '11111111-1111-4111-8111-111111111111') from price_approvals") === 'approved:owner:true', 'the approval is recorded with who decided and in which role');
  await actx.close();
}
{
  const item = page.locator('li[data-check^="price"]').first();
  await item.getByRole('button', { name: 'Check again' }).click();
  await page.locator('li[data-check="price"][data-ok="yes"]').getByText('Prices within your limits or approved').waitFor({ timeout: 15000 });
  check(await page.getByRole('button', { name: /Send quote to customer/ }).isEnabled(), 'once approved, the quote can be sent at that price');
}

step('send');
await page.getByRole('button', { name: /Send quote to customer/ }).click();
await page.getByText(/Quote v1 sent/).waitFor({ timeout: 30000 });
const link = await page.locator('a[href*="/q/"]').first().getAttribute('href');
const estId = psql("select id from estimates order by created_at desc limit 1");
check(
  psql(`select (snapshot->'approvals'->0->>'price')::int || ':' || (snapshot->'options' @> '[{"tier": "good", "price": ${asked}}]') from quotes where estimate_id = '${estId}'`) === `${asked}:true`,
  'the quote went out at the approved Good price, and keeps the approval it used',
);
await waitForDb(`select count(*) from photos where estimate_id = '${estId}' and uploaded_at is not null and area_id is not null`, '1', 'area photo uploaded after the estimate synced, linked to its area');
check(psql(`select client_doc->'measurements' ? (select id::text from estimate_areas where estimate_id = '${estId}' limit 1) from estimates where id = '${estId}'`) === 't', 'measurement saved with the estimate on the server');
const photoList = await page.evaluate((id) => fetch('/api/photos?estimateId=' + id).then((r) => r.json()), estId);
check(photoList.photos?.length === 1 && photoList.photos[0].url.includes('/object/sign/photos/'), 'photo list returns a signed link');
await page.screenshot({ path: SHOTS + '05-sent.png', fullPage: true });
console.log('  link', link);

step('back on the list, the sent quote stays Sent, and the waiting total is the sum of its rows');
await page.getByRole('button', { name: 'Back to estimates' }).click();
const sentRow = page.locator('button[data-status=sent]', { hasText: 'Pat Lee' });
await sentRow.getByText('Sent', { exact: true }).waitFor();
check((await sentRow.count()) === 1, 'the list shows the quote it just sent as Sent');
await page.getByRole('button', { name: 'Sync now' }).click();
await page.waitForTimeout(4000); // a full sync: push, then pull
check(psql(`select status from estimates where id = '${estId}'`) === 'sent', 'opening and leaving a sent quote without changes keeps it Sent on the server');
{
  const money = (t) => Number(t.replace(/[^0-9.]/g, ''));
  const waitingPrices = await page.locator('button[data-status=sent], button[data-status=viewed]').locator('[data-testid=row-price]').allInnerTexts();
  const total = await page.getByTestId('waiting-total').innerText();
  check(waitingPrices.length > 0 && money(total) === waitingPrices.reduce((s, p) => s + money(p), 0), `"Waiting to sign" ${total} is the sum of the sent rows' prices (${waitingPrices.join(' + ')})`);
}
await page.screenshot({ path: SHOTS + '05b-list-sent.png' });

step('a change on the phone while the customer signs, and another estimate made offline (L35)');
await ctx.setOffline(true);
offlineStep = true;
await page.locator('button[data-status=sent]', { hasText: 'Pat Lee' }).click();
await page.getByLabel('Notes for the quote').fill('Customer asked about the garage too');
await page.waitForTimeout(800); // saved on the phone
await page.getByRole('button', { name: 'Back to estimates' }).click();
await page.getByRole('button', { name: 'New estimate', exact: true }).click();
await page.getByLabel('First name').fill('Kim');
await page.getByLabel('Last name').fill('Pending');
await page.getByLabel('Street address').fill('5 Queue St');
await page.getByLabel('ZIP').fill('19711');
await page.getByRole('button', { name: 'Next' }).click();
await page.getByRole('button', { name: '+ Attic' }).click();
await page.getByLabel('Square feet').fill('500');
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Back to estimates' }).click();
check(psql("select count(*) from customers where last_name = 'Pending'") === '0', 'nothing reaches the office while the phone is offline');

step('customer signs');
const cust = await browser.newContext(phone);
const cp = await cust.newPage();
cp.on('pageerror', (e) => logs.push('CUSTOMER PAGEERROR ' + e.message));
await cp.goto(link);
await cp.screenshot({ path: SHOTS + '06-customer-quote.png', fullPage: true });
{
  // The number comes from the counter (L12), "Valid until" is the business-zone day the link stops (L13),
  // and the signing sentence names the profile's state (L31).
  const year = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 4);
  const number = psql(`select snapshot->'document'->>'quoteNumber' from quotes where estimate_id = '${estId}'`);
  check(number === `KN-${year}-0001-v1`, `the first quote of the year is number 0001: ${number}`);
  check((await cp.getByText(number, { exact: true }).count()) > 0, 'the customer sees that number');
  check(
    psql(`select (snapshot->'document'->>'validUntil') = to_char(expires_at at time zone 'America/New_York', 'YYYY-MM-DD') from quotes where estimate_id = '${estId}'`) === 't',
    '"Valid until" is the business-zone date the link stops working',
  );
  check((await cp.getByText(/\(ESIGN Act and Delaware UETA\)/).count()) === 1, "the signing sentence names the property's state (OD14)");
  // Built from the seeded settings (OD12, OD13): the brand, the warranty, nothing left blank.
  const quoteText = await cp.locator('body').innerText();
  check(quoteText.includes('Koala Insulation') && !/Koala Insulation of/.test(quoteText), 'the quote names Koala Insulation');
  check(quoteText.includes('Limited lifetime warranty'), 'its warranty reads "Limited lifetime warranty"');
  check(!/placeholder/i.test(quoteText) && !/\bLicen[sc]e\b/.test(quoteText) && !/\bCall\b/.test(quoteText), 'no PLACEHOLDER, no empty License line, no "Call" without a number');
  const accept = (await cp.getByText(/^You are accepting/).innerText()).trim();
  check(/ for \$[\d,]+\.$/.test(accept), `the accept sentence reads the price in whole dollars: "${accept}"`);
}
const signBar = cp.getByRole('complementary', { name: 'Your choice' });
check(/better/i.test(await signBar.innerText()) && (await cp.getByRole('radio', { checked: true }).innerText()).includes((await signBar.innerText()).match(/\$[\d,]+/)?.[0] ?? '?'), 'the sign bar shows the recommended option and its price');
await cp.getByRole('button', { name: 'Review and sign' }).click();
check(await cp.waitForFunction(() => document.activeElement?.getAttribute('autocomplete') === 'name', null, { timeout: 5000 }).then(() => true, () => false), 'Review and sign takes the customer to the name field');
await cp.getByLabel(/full name/i).fill('Pat Lee');
const canvas = cp.locator('canvas');
await canvas.scrollIntoViewIfNeeded();
const box = await canvas.boundingBox();
await cp.mouse.move(box.x + 20, box.y + box.height / 2);
await cp.mouse.down();
for (let i = 1; i <= 12; i++) await cp.mouse.move(box.x + 20 + i * 20, box.y + box.height / 2 + (i % 2 ? -15 : 15));
await cp.mouse.up();
await cp.getByRole('checkbox').check();
await cp.getByRole('button', { name: /^Sign and accept/ }).click();
// The thank-you heading (the quote's terms also say "signed", so plain text would match too early).
await cp.getByRole('heading', { name: /thank you/i }).waitFor({ timeout: 30000 });
await cp.screenshot({ path: SHOTS + '07-signed.png', fullPage: true });
{
  // Email is not set up in this stack, so nothing says it was emailed (L33); the price is whole dollars (L8).
  const thanks = await cp.locator('main').innerText();
  check(thanks.includes('Download your signed copy below.') && !/emailed/i.test(thanks), 'with email not set up, the thank-you page points to the download, not to an email');
  check(/You accepted .* for \$[\d,]+\. /.test(thanks) && !/\$[\d,]+\.\d\d/.test(thanks), 'and reads the price in whole dollars');
}

step('the phone hears of the signature: signed, read-only, the change not applied; the other estimate syncs (L35)');
signedPushStep = true;
await ctx.setOffline(false);
offlineStep = false;
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await waitForDb("select count(*) from estimates e join customers c on c.id = e.customer_id where c.last_name = 'Pending'", '1', 'the estimate made offline still syncs');
await page.locator('button[data-status=signed]', { hasText: 'Pat Lee' }).waitFor({ timeout: 15000 });
await page.locator('button[data-status=signed]', { hasText: 'Pat Lee' }).click();
await page.getByText('The customer signed this quote.').waitFor({ timeout: 15000 });
{
  const main = await page.locator('main').innerText();
  check(main.includes('It is read-only. Your unsent change was not applied.'), 'the phone shows the signed quote, read-only, and says the change was not applied');
  check(!main.includes('changed on another device') && !main.includes('Keep mine'), 'no false "changed on another device"');
  check(
    psql(`select status || ':' || (coalesce(notes, '') || coalesce(client_doc->>'notes', '') not like '%garage too%') from estimates where id = '${estId}'`) === 'signed:true',
    'the office copy stays as signed, without the unsent change',
  );
}
await page.screenshot({ path: SHOTS + '07b-phone-signed-locked.png' });
await page.getByRole('button', { name: 'Back to estimates' }).click();
signedPushStep = false;

step('db checks after signing');
check(psql("select count(*) from estimate_lines where is_overridden and override_reason like 'Low clearance%'") !== '0', 'overridden line synced with its reason');
check(psql("select count(*) from deviation_flags where ack_note like 'Knee walls%'") !== '0', 'deviation flag stored with the explanation');
check(psql("select count(*) from jobs") === '1', 'signing created a job');
console.log('  estimate:', psql("select status, selected_tier from estimates"));
console.log('  quote:', psql("select version, status, signed_tier, signed_price, signer_name, signed_pdf_path is not null from quotes"));
check(psql("select esign_audit->>'consentText' like '%(ESIGN Act and Delaware UETA)%' from quotes where status = 'signed'") === 't', 'the e-sign record keeps the sentence the customer agreed to');
{
  // Review B flow-B3: a request still waiting on an estimate the customer signed is not decided, and
  // the owner's queue does not show it.
  const signedEst = psql("select estimate_id from quotes where status = 'signed' limit 1");
  psql(`insert into price_approvals (estimate_id, tier, price, model_price, below_floor, loaded_cost, requested_by) values ('${signedEst}', 'best', 9999, 9000, false, 1000, '${EST.id}')`);
  const stale = psql(`select id from price_approvals where estimate_id = '${signedEst}' and status = 'pending'`);
  const octx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await octx3.addCookies([sessionCookie(OWNER)]);
  const res = await octx3.request.patch(BASE + `/api/approvals/${stale}`, { data: { decision: 'approved' } });
  const body = await res.json();
  check(res.status() === 409 && body.error === 'signed' && body.message === 'The customer already signed this quote.', `deciding a request on a signed estimate: ${res.status()} ${body.error}`);
  const qp = await octx3.newPage();
  await qp.goto(BASE + '/estimates');
  check((await qp.getByRole('list', { name: 'Prices waiting for approval' }).count()) === 0, "the owner's queue leaves it out (no 'Needs you' for a signed quote)");
  check(psql(`select status from price_approvals where id = '${stale}'`) === 'pending', 'and it was not decided');
  await octx3.close();
}
console.log('  events:', psql("select string_agg(event, ',' order by id) from quote_events"));
console.log('  audit:', psql("select string_agg(distinct action, ',') from audit_log where action like '%.%'"));

step('satellite roof lookup from the address');
/** Every lookup the Roof Takeoff stand-in was paid for, oldest first. */
const roofCalls = () => {
  try {
    return execSync(`cat ${process.env.E2E_STORAGE}/roof-calls.log`).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const roofImageLoaded = () => page.waitForFunction(() => { const i = document.querySelector('[role=dialog] img'); return i && i.complete && i.naturalWidth === 1280; });
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor();
await page.getByRole('button', { name: 'New estimate', exact: true }).click();
await page.getByLabel('First name').fill('Robin');
await page.getByLabel('Last name').fill('Roof');
await page.getByLabel('Street address').fill('12 Elkton Rd');
await page.getByRole('button', { name: 'Next' }).click();
await page.getByRole('button', { name: '+ Attic' }).click();
const lookupButton = page.getByRole('button', { name: /Look up from the address/ });
check(await lookupButton.isDisabled(), 'the lookup waits for a whole address');
check((await page.getByText(/Fill in the street, city, state and ZIP first/).count()) === 1, 'and says why');
await page.getByRole('button', { name: 'Customer' }).first().click();
await page.getByLabel('ZIP').fill('19711');
await page.getByRole('button', { name: 'Next' }).click();
await lookupButton.waitFor();
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Look up from the address') && !b.disabled));
await page.screenshot({ path: SHOTS + '03c-roof-button.png', fullPage: true });
await lookupButton.click();
const roof = page.getByRole('dialog', { name: /Roof lookup for / });
const focusIs = (fn) => page.waitForFunction(fn, null, { timeout: 3000 }).then(() => true, () => false);
check(await focusIs(() => document.activeElement?.getAttribute('role') === 'dialog'), 'focus moves into the sheet when it opens');
await roof.getByRole('button', { name: 'Stop' }).click();
await roof.getByRole('button', { name: 'Look up', exact: true }).waitFor();
check(true, 'Stop ends a lookup that is running');
check((await roof.locator('[role=status]').innerText()) === '', 'the status line is empty once stopped');
await roof.getByRole('button', { name: 'Look up', exact: true }).click();
await roof.getByRole('button', { name: 'Stop' }).waitFor();
check((await roof.locator('[role=status]').innerText()) === 'Looking up 12 Elkton Rd, Newark, DE 19711.', 'screen readers hear what is being looked up');
check((await roof.locator('[role=status]').evaluate((el) => getComputedStyle(el).display)) !== 'contents', 'the live region is a real box');
check(await roof.getByText(/^\d+s$/).evaluate((el) => el.closest('[aria-hidden=true]') !== null), 'the seconds counter is hidden from screen readers');
await page.screenshot({ path: SHOTS + '03d-roof-running.png' });
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
await roofImageLoaded();
check((await roof.locator('[role=status]').innerText()) === 'Found the roof.', 'and then that the roof was found (not every number)');
const roofLast = JSON.parse(execSync(`cat ${process.env.E2E_STORAGE}/roof-last.json`).toString());
check(roofLast.address === '12 Elkton Rd, Newark, DE 19711' && roofLast.key, 'Roof Takeoff is asked for the whole address with the partner key: ' + roofLast.address);
const paidOnce = roofCalls().length;
const roofText = await roof.innerText();
check(
  /ATTIC FLOOR\s+Blown-in, on the ceiling\s+1,970\s+SQUARE FEET/.test(roofText) && /ROOF DECK\s+Spray foam, under the roof\s+2,170\s+SQUARE FEET/.test(roofText),
  'readout tiles: attic floor 1,970 and roof deck 2,170 sq ft at a 12" overhang, porch left out',
);
check((await roof.getByRole('radio', { name: /Attic floor/ }).getAttribute('aria-checked')) === 'true', 'an attic measured on the floor starts on the attic floor');
check(roofText.includes('Finished attic rooms, cathedral ceilings and knee walls are not in these numbers. Measure them on site.'), 'says the attic numbers leave out finished rooms, cathedral ceilings and knee walls');
const moreDetails = roof.getByRole('button', { name: /^More details/ });
check((await moreDetails.getAttribute('aria-expanded')) === 'false' && !/Drip edge|Bundles|Order with/.test(roofText), 'roofing squares, bundles, edges and materials wait under More details, closed');
await moreDetails.click();
const roofTextMore = await roof.innerText();
check(/Roofing\s*2,560 sq ft · 24\.0 squares · order 27⅔ squares/.test(roofTextMore) && !/Bundles/.test(roofTextMore), 'Roofing starts closed, saying the roof surface, squares and the order (the 1/12 porch roof is not shingles)');
check(/PITCH\s+6\/12\s+ROOF OUTLINE\s+2,340 sq ft\s+WALL RUN\s+184 ft/.test(roofText), 'main pitch, roof outline and wall run (porch walls left out)');
check((await roof.getByText("Google placed this address roughly, so the white outline may be on a neighbour's house.").count()) === 1, 'warns when Google placed the address roughly');
check((await roof.getByText('Lower-detail imagery. Check the pitch on site.').count()) === 1, "Roof Takeoff's warnings are listed");
await roof.evaluate((d) => d.scrollTo(0, 0));
const photoBoxTop = await roof.locator('img').first().boundingBox();
const rightHouseBox = await roof.getByRole('button', { name: 'Right house', exact: true }).boundingBox();
const dockBox = await roof.getByRole('region', { name: 'Actions' }).boundingBox();
const tilesBox = await roof.getByRole('radiogroup', { name: 'Which number to use' }).boundingBox();
const warnBox = await roof.getByRole('heading', { name: 'Check on site' }).boundingBox();
const facesBox = await roof.getByRole('heading', { name: 'Roof faces' }).boundingBox();
check(photoBoxTop && rightHouseBox && dockBox && photoBoxTop.y < rightHouseBox.y && rightHouseBox.y + rightHouseBox.height <= dockBox.y, 'the photo and the house check come first: "Right house" is on the first screen, above the dock');
check(tilesBox && warnBox && facesBox && rightHouseBox.y < tilesBox.y && tilesBox.y < warnBox.y && warnBox.y < facesBox.y, 'then the numbers, then what to check on site, above the faces');
check((await roof.getByText('12 Elkton Rd, Newark, DE 19711, USA').count()) === 1 && (await roof.getByText('Aerial photo · Jun 2023').count()) === 1, "shows the address Google matched and the photo's month under the numbers");
check((await roof.getByText('Good photo', { exact: true }).count()) === 1, 'a medium-detail photo is a "Good photo"');
check((await roof.getByRole('switch', { name: 'Face 5: over the attic' }).getAttribute('aria-checked')) === 'false', 'the porch starts left out (Roof Takeoff’s choice)');
check((await roof.getByText('Lower roof: garage, porch or addition?').count()) === 3, 'lower roofs (garage and porch) are pointed out');
check((await roof.getByText('Low slope: not for shingles').count()) === 1, 'and the 1/12 porch roof as low slope');
const useFloor = roof.getByRole('button', { name: 'Use 1,970 sq ft' });
check(await useFloor.isDisabled(), 'Use waits until the estimator checks the house (Google placed it roughly)');
check((await roof.getByText('Check the house first: tap Right house.').count()) === 1, 'and says so');
check((await page.locator(`a[href*="${process.env.MOCK_PORT ?? 54321}"], a[href*="roof-takeoff"]`).count()) === 0 && !/Roof Takeoff site/.test(roofText), 'nothing sends anyone to the Roof Takeoff site any more');
await page.screenshot({ path: SHOTS + '03e-roof-result.png' });
await page.setViewportSize({ width: 390, height: 2600 });
await page.screenshot({ path: SHOTS + '03f-roof-result-full.png' });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: SHOTS + '03g-roof-result-dark.png' });
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize(phone.viewport);

step('roof takeoff on the area: edges on the photo, roofing, materials, print, copy');
/** Scrolls the sheet so `el` sits just under its sticky header (for screenshots). */
const showInSheet = (el) =>
  el.evaluate((node) => {
    const sheet = node.closest('[role=dialog]');
    const header = sheet.querySelector('.sticky');
    sheet.scrollBy(0, node.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 12);
  });
const PDF_PAGES = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const mapKey = roof.getByRole('list', { name: 'Map key' });
check(
  (await mapKey.innerText()).replace(/\s+/g, ' ').trim() === 'Roof outline Ridge 50 ft Valley 14 ft Eave 74 ft Pitch break 20 ft Left out',
  "the map key lists the outline, this roof's edge types with their feet (none it doesn't have), and the shading: " + (await mapKey.innerText()).replace(/\s+/g, ' '),
);
check(
  (await roof.locator('svg [data-edge]').count()) === 4 &&
    (await roof.locator('svg [data-edge="ridge"] polyline').nth(0).getAttribute('stroke')) === '#0C0E10' &&
    (await roof.locator('svg [data-edge="ridge"] polyline').nth(1).getAttribute('stroke')) === '#FF453A',
  'the four edges are drawn on the photo in their colours, each on an ink casing',
);
await roof.getByRole('switch', { name: 'Show roof edges' }).click();
check((await roof.locator('svg [data-edge]').count()) === 0 && !/Ridge/.test(await mapKey.innerText()), '"Show roof edges" hides them, and their key');
await roof.getByRole('switch', { name: 'Show roof edges' }).click();
await page.setViewportSize({ width: 375, height: 812 });
await showInSheet(roof.locator('img').first());
await page.screenshot({ path: SHOTS + '03e3-roof-edges-375.png' });
await roof.getByRole('button', { name: /^Roofing/ }).click();
const roofing = roof.locator('section', { has: page.getByRole('button', { name: /^Roofing/ }) });
const tilesText = async () => (await roofing.innerText()).replace(/\s+/g, ' ');
check(
  /Roof surface 2,560 sq ft .*Squares \(2\/12 and up\) 24\.0 .*Order with 15% waste 27⅔ squares Bundles 83 .*Low-slope roof \(under 2\/12, not shingles\): 160 sq ft\. Membrane or rolled roofing\./.test(await tilesText()),
  'Roofing: 2,560 sq ft of roof; 24.0 squares and 27⅔ squares (83 bundles) with 15% waste, without the 160 sq ft low-slope porch roof: ' + (await tilesText()).slice(0, 260),
);
check((await roofing.getByRole('radio', { name: 'Hip 15%' }).getAttribute('aria-checked')) === 'true' && /Main pitch: 6\/12/.test(await tilesText()), 'hip 15% waste to start, and the main pitch');
await roofing.getByRole('radio', { name: 'Cut-up 20%' }).click();
check(/Order with 20% waste 29 squares Bundles 87 /.test(await tilesText()), 'cut-up 20%: 29 squares, 87 bundles');
await roofing.getByLabel('Waste percent').fill('0');
check(/Order with 0% waste 24 squares Bundles 72 /.test(await tilesText()) && (await roofing.getByRole('radio', { checked: true }).count()) === 0, 'a typed 0%: 24 squares, 72 bundles, no chip chosen');
await roofing.getByLabel('Waste percent').fill('80');
check(/Order with 50% waste/.test(await tilesText()) && (await roofing.getByLabel('Waste percent').inputValue()) === '50', 'a typed waste over 50 is kept to 50');
await roofing.getByRole('radio', { name: 'Hip 15%' }).click();
await showInSheet(roof.getByRole('button', { name: /^Roofing/ }));
await page.waitForTimeout(300);
await page.screenshot({ path: SHOTS + '03e4-roof-roofing-375.png' });
await roof.getByRole('button', { name: /^Roof edges and materials/ }).click();
const edgesCard = roof.locator('section', { has: page.getByRole('button', { name: /^Roof edges and materials/ }) });
const edgesText = (await edgesCard.innerText()).replace(/\s+/g, ' ');
check(
  /Ridge Top line where two faces meet 50 ft Valley .* 14 ft Eave .* 74 ft Pitch break .* 20 ft Feet along the slope\./.test(edgesText),
  'the feet of each edge along the slope: ' + edgesText.slice(0, 200),
);
check(
  /Drip edge Eaves \+ rakes 75 ft Starter strip Eaves 75 ft Ridge cap Ridges \+ hips 50 ft Valley \(ice and water, flashing\) Valleys 15 ft Estimates from aerial data, rounded up to the next foot\. Check on site before ordering\./.test(edgesText),
  'the materials, each rounded up to the next foot, marked as estimates to check on site',
);
await showInSheet(roof.getByRole('button', { name: /^Roof edges and materials/ }));
await page.screenshot({ path: SHOTS + '03e5-roof-materials-375.png' });
await showInSheet(roof.getByRole('button', { name: /Print or save PDF/ }));
await page.screenshot({ path: SHOTS + '03e5b-roof-share-375.png' });
await page.setViewportSize(phone.viewport);

// Print: the one-page report is the only thing on the page.
const report = page.getByTestId('roof-report');
check(!(await report.isVisible()), 'the report is not on the screen');
await page.waitForFunction(() => document.querySelector('#roof-report img')?.getAttribute('src')?.startsWith('data:image/jpeg'), null, { timeout: 15000 });
await page.emulateMedia({ media: 'print' });
check((await report.isVisible()) && !(await roof.isVisible()), 'in print, only the report shows');
const reportText = (await report.innerText()).replace(/\s+/g, ' ');
for (const bit of [
  // The brand, every franchise (review B flow-B7, OD12).
  'KOALA INSULATION · ROOF TAKEOFF',
  '12 Elkton Rd, Newark, DE 19711, USA',
  'Medium-detail aerial photo from Jun 2023.',
  'Attic floor 1,970 sq ft',
  'Roof surface 2,560 sq ft',
  'Roof deck over the attic (spray foam) 2,170 sq ft',
  'Footprint (to the drip edge) 2,340 sq ft',
  'Wall run 184 ft',
  'Low slope (under 2/12, not shingles) 160 sq ft',
  'Squares (2/12 and up) 24.0',
  'Order with 15% waste 27⅔ sq · 83 bundles',
  'Main pitch 6/12',
  'Attic floor: Roof outline minus a 12" overhang all the way around, without face 5.',
  '5 1/12 (low slope) faces south 160 No',
  'Ridge 50',
  'Drip edge Eaves + rakes 75',
  "Not confirmed: Google placed this address roughly, so the outline may be on a neighbour's house.",
  'Estimates from Google aerial imagery. Verify on site.',
]) {
  check(reportText.includes(bit), `the report says "${bit}"`);
}
check(/Looked up [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M\./.test(reportText), 'and when it was looked up');
check(!/photo below|white outline/.test(reportText), 'in words for paper (no "photo below")');
check((await report.locator('img').evaluate((img) => img.complete && img.naturalWidth === 960)), 'the photo is painted into the report with its outline and edges');
await page.setViewportSize({ width: 816, height: 1056 });
await page.screenshot({ path: SHOTS + '03e6-roof-print-letter.png', fullPage: true });
await page.setViewportSize({ width: 375, height: 812 });
await page.screenshot({ path: SHOTS + '03e7-roof-print-375.png', fullPage: true });
await page.setViewportSize(phone.viewport);
const areaPdf = await page.pdf({ path: SHOTS + 'roof-report-area.pdf', format: 'Letter', printBackground: true });
check(PDF_PAGES(areaPdf) === 1, 'the report prints on one letter page');
await page.emulateMedia({ media: 'screen' });
check(!(await report.isVisible()) && (await roof.isVisible()), 'back on screen, the sheet shows again');
// Print or save PDF: the page is named after the house while printing (the saved PDF's file name), then back.
await page.evaluate(() => {
  window.print = () => {
    window.__printedAs = document.title;
    window.dispatchEvent(new Event('afterprint'));
  };
});
const titleBefore = await page.title();
await roof.getByRole('button', { name: /Print or save PDF/ }).click();
check((await page.evaluate(() => window.__printedAs)) === 'Roof takeoff - 12 Elkton Rd, Newark, DE 19711, USA' && (await page.title()) === titleBefore, 'Print names the PDF after the house, then puts the page title back');

await roof.getByRole('button', { name: /Copy summary/ }).click();
await roof.getByText('Summary copied. Paste it into a note, text or email.').waitFor();
const copied = await page.evaluate(() => navigator.clipboard.readText());
check(copied.startsWith('Koala Insulation: roof takeoff\n12 Elkton Rd, Newark, DE 19711, USA\n'), 'Copy summary copies the takeoff as text, under the brand (review B flow-B7)');
check(
  copied.includes('Order with 15% waste: 27⅔ squares (83 bundles)') &&
    copied.includes('Low-slope roof (under 2/12, not shingles): 160 sq ft') &&
    copied.includes('Materials (rounded up; estimates from aerial data, check on site): drip edge 75 ft') &&
    copied.endsWith('Estimates from Google aerial imagery. Verify on site.') &&
    !copied.includes('photo below'),
  'with the order, the low-slope roof, the materials and the footer, in words for paper',
);
await roof.getByRole('button', { name: 'Right house', exact: true }).click();
check(!(await useFloor.isDisabled()), 'Use works once the estimator says it is the house');
check((await roof.getByText(/Google placed this address roughly/).count()) === 0, 'and the rough-placement warning goes');
await roof.getByRole('radio', { name: /Roof deck/ }).click();
check(!(await roof.getByRole('button', { name: 'Use 2,170 sq ft' }).isDisabled()), 'choosing the roof deck: Use 2,170 sq ft');
await roof.getByRole('radio', { name: '18"' }).click();
await roof.getByRole('switch', { name: 'Face 3: over the attic' }).click();
await roof.getByRole('switch', { name: 'Face 4: over the attic' }).click();
const choiceText = await roof.innerText();
check(/ATTIC FLOOR\s+Blown-in, on the ceiling\s+1,370\s/.test(choiceText) && /ROOF DECK\s+Spray foam, under the roof\s+1,530\s/.test(choiceText), 'an 18" overhang with the garage left out: attic floor 1,370, roof deck 1,530');
await roof.getByRole('heading', { name: 'Roof faces' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + '03e2-roof-choices.png' });
await roof.getByRole('button', { name: 'Use 1,530 sq ft' }).click();
await roof.waitFor({ state: 'detached' });
check((await page.getByLabel('Square feet').inputValue()) === '1530', 'Use puts the roof deck into the area');
check((await page.getByText(/Square feet set to 1,530 \(roof deck\) from the satellite lookup/).count()) === 1, 'and says so');
check(await focusIs(() => document.activeElement?.textContent?.includes('Look up from the address')), 'focus goes back to the button that opened the sheet');
check(
  (await page.getByLabel('Prep notes / obstructions').inputValue()) ===
    'From satellite lookup:\n• Satellite (Google imagery Jun 2023): roof deck about 1,530 sq ft over the attic floor (18-inch eaves removed; left out faces 3 at 4/12, 4 at 4/12 and 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
  'a line goes into the prep notes: what the number is and what was left out',
);
await lookupButton.click();
check(
  /ATTIC FLOOR\s+Blown-in, on the ceiling\s+1,370\s/.test(await roof.innerText()) &&
    (await roof.getByRole('radio', { name: '18"' }).getAttribute('aria-checked')) === 'true' &&
    (await roof.getByRole('radio', { name: /Roof deck/ }).getAttribute('aria-checked')) === 'true',
  'reopening shows the last result, the choices and the number chosen, without another lookup',
);
await roof.getByRole('button', { name: 'Close' }).click();
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'done' and (result->>'footprintM2')::numeric = 217 and address_key = '12 elkton rd newark de 19711'`, '1', 'the lookup is logged with its result and match key');

step('satellite: another area of the same house shares the lookup');
await page.getByRole('button', { name: '+ Walls' }).click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 5000 });
check(roofCalls().length === paidOnce, 'no second paid lookup for the same house');
check((await roof.getByRole('radio', { name: '18"' }).getAttribute('aria-checked')) === 'true', 'the overhang chosen on the attic carries over');
check((await roof.getByRole('switch', { name: 'Face 3: count its walls' }).getAttribute('aria-checked')) === 'false', 'and so do the faces left out');
check(/^WALL RUN\s+Porch and garage walls count unless their faces are off\.\s+108\s+FEET$/.test((await roof.locator('[data-readout]').innerText()).trim()), 'walls show the wall run without the garage and porch: 108 ft');
check((await roof.getByText('Porch and garage walls count unless their faces are off.').count()) >= 1, 'and say which walls count');
await roof.getByRole('switch', { name: 'Face 3: count its walls' }).click();
await roof.getByRole('switch', { name: 'Face 4: count its walls' }).click();
await roof.getByRole('button', { name: 'Use 180 ft as the wall run' }).waitFor();
check(!(await roof.getByRole('button', { name: 'Use 180 ft as the wall run' }).isDisabled()), 'the house was already checked on the attic');
await page.screenshot({ path: SHOTS + '03h-roof-walls.png' });
await roof.getByRole('button', { name: 'Use 180 ft as the wall run' }).click();
await roof.waitFor({ state: 'detached' });
check((await page.getByText(/Wall run set to 180 ft. Add the wall height in Measure/).count()) === 1, 'the wall run goes into Measure, waiting for the height');
check((await page.getByText(/Walls: wall run, \? high/).count()) === 1, 'the walls measurement has the wall run');
await page.getByRole('button', { name: /Edit measurement/ }).click();
const wallSheet = page.getByRole('dialog', { name: /Measure/ });
check((await wallSheet.getByLabel('Total wall length (optional)').inputValue()) === '180', 'Measure shows the 180 ft wall run');
await wallSheet.getByLabel('Average wall height').fill('8');
await wallSheet.getByRole('button', { name: 'Use 1,440 sq ft' }).click();
check((await page.getByLabel('Square feet').inputValue()) === '1440', 'with an 8 ft height: 1,440 sq ft of wall');
await page.screenshot({ path: SHOTS + '03i-roof-walls-applied.png', fullPage: true });
// A broken measurement takes its size back (L26, RF-07): Incomplete, not priced, with Finish measuring.
{
  const wallsHeader = page.getByRole('button', { name: /^Exterior walls/ });
  check((await wallsHeader.getByText('Ready', { exact: true }).count()) === 1, 'the walls area is Ready at 1,440 sq ft');
  await page.getByRole('button', { name: /Edit measurement/ }).click();
  await wallSheet.getByLabel('Average wall height').fill('');
  await wallSheet.getByRole('button', { name: 'Done', exact: true }).click();
  await wallSheet.waitFor({ state: 'detached' });
  check((await page.getByLabel('Square feet').inputValue()) === '', 'height cleared: the 1,440 sq ft go back (the box is empty)');
  check((await wallsHeader.getByText('Incomplete', { exact: true }).count()) === 1 && /0 sq ft, measuring not finished/.test(await wallsHeader.innerText()), 'the area says Incomplete: 0 sq ft, measuring not finished');
  const unfinishedText = "Exterior walls: the measurement isn't finished, so this area isn't priced. Enter the average wall height.";
  check((await page.getByText(unfinishedText).count()) === 1, 'and why it is not priced');
  await page.screenshot({ path: SHOTS + '03i2-walls-measuring-not-finished.png', fullPage: true });
  await page.getByRole('button', { name: 'Finish measuring' }).click();
  // Review B flow-B12: the sheet opens with the cursor in the empty wall height.
  await wallSheet.getByLabel('Average wall height').waitFor();
  await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement && document.activeElement.closest('[data-measure-field="wallHeight"]') !== null, null, { timeout: 5000 }).catch(() => undefined);
  check(await page.evaluate(() => document.activeElement instanceof HTMLInputElement && document.activeElement.closest('[data-measure-field="wallHeight"]') !== null), '"Finish measuring" puts the cursor in Average wall height (was the page body)');
  await page.screenshot({ path: SHOTS + '03i3-finish-measuring-focused.png' });
  await wallSheet.getByLabel('Average wall height').fill('8');
  await wallSheet.getByRole('button', { name: 'Use 1,440 sq ft' }).click();
  check((await page.getByLabel('Square feet').inputValue()) === '1440' && (await page.getByText(unfinishedText).count()) === 0, '"Finish measuring" opens Measure; 8 ft again is 1,440 sq ft');
}

step('satellite: a garage starts with every face off');
await page.getByRole('button', { name: '+ Garage' }).click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 5000 });
check(roofCalls().length === paidOnce, 'still no second paid lookup');
const garageSwitches = await roof.getByRole('switch', { name: /: part of the garage$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')));
check(garageSwitches.length === 5 && garageSwitches.every((v) => v === 'false'), 'every face starts off for a garage');
check(/^GARAGE CEILING\s+Turn on the garage's roof faces\.\s+—$/.test((await roof.locator('[data-readout]').innerText()).trim()) && (await roof.getByText("Turn on the garage's roof faces.").count()) >= 1, "the garage ceiling waits: Turn on the garage's roof faces.");
check(await roof.getByRole('button', { name: 'Use', exact: true }).isDisabled(), 'nothing to use yet');
await page.screenshot({ path: SHOTS + '03k-roof-garage-empty.png' });
await roof.getByRole('switch', { name: 'Face 3: part of the garage' }).click();
await roof.getByRole('switch', { name: 'Face 4: part of the garage' }).click();
check(/^GARAGE CEILING\s+From the roof faces turned on below\.\s+490\s+SQUARE FEET$/.test((await roof.locator('[data-readout]').innerText()).trim()), 'garage ceiling from the two garage faces at 18": 490 sq ft');
check((await roof.getByRole('switch', { name: 'Face 1: part of the garage' }).getAttribute('aria-checked')) === 'false', "the house's faces stay off for the garage");
await page.screenshot({ path: SHOTS + '03k2-roof-garage.png' });
await roof.getByRole('button', { name: 'Use 490 sq ft' }).click();
await roof.waitFor({ state: 'detached' });
check((await page.getByLabel('Square feet').inputValue()) === '490', 'Use puts the garage ceiling into the garage');
check((await page.getByLabel('Prep notes / obstructions').inputValue()).includes('garage ceiling about 490 sq ft inside the walls (18-inch eaves removed; from faces 3 at 4/12 and 4 at 4/12)'), 'the note says which faces the garage ceiling came from');

step('satellite: a saved lookup of the same house after a reload');
await page.reload();
await page.getByRole('navigation', { name: 'Estimate steps' }).getByRole('button', { name: 'Areas' }).click();
const atticHeader = page.getByRole('button', { name: /^Attic/ });
await atticHeader.waitFor();
if ((await atticHeader.getAttribute('aria-expanded')) !== 'true') await atticHeader.click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByText(/Saved lookup from today/).waitFor({ timeout: 15000 });
check(roofCalls().length === paidOnce, 'the server sends back its saved lookup instead of paying Google again');
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'done' and address_key = '12 elkton rd newark de 19711'`, '1', 'and logs no second lookup');
check((await roof.locator('[role=status]').innerText()) === 'Found the roof: a saved lookup.', 'screen readers hear it is a saved lookup');
await page.screenshot({ path: SHOTS + '03l-roof-saved.png' });
await roof.getByRole('button', { name: 'Look up again' }).click();
await roof.getByRole('button', { name: 'Stop' }).waitFor();
await roof.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 30000 });
check(roofCalls().length === paidOnce + 1 && (await roof.getByText(/Saved lookup from/).count()) === 0, 'Look up again pays for a fresh lookup');
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'done' and address_key = '12 elkton rd newark de 19711'`, '2', 'which is logged');

step('satellite: wrong house, tap the right roof');
await roofImageLoaded();
// A fresh lookup asks about the house again: the second choice is to tap the right roof.
await roof.getByRole('button', { name: 'Tap the right roof', exact: true }).click();
const photo = roof.getByRole('button', { name: 'Tap the right roof on the photo' });
const photoBox = await photo.boundingBox();
await photo.click({ position: { x: photoBox.width * 0.72, y: photoBox.height * 0.3 } });
await roof.getByText('Look up this roof instead?').waitFor();
const pickButtons = await roof.getByRole('button', { name: 'Look up', exact: true }).boundingBox();
check(pickButtons && pickButtons.y + pickButtons.height <= 844 && (await roof.getByRole('button', { name: /^Use / }).count()) === 0, 'the tapped spot is marked and Cancel / Look up are in view (the Use bar steps aside)');
await page.screenshot({ path: SHOTS + '03m-roof-wrong-house-tap.png' });
await roof.getByRole('button', { name: 'Look up', exact: true }).click();
await roof.getByText('Looking up the roof you tapped', { exact: true }).waitFor();
await roof.getByText('The roof you tapped on the photo').waitFor({ timeout: 30000 });
const pinLast = JSON.parse(execSync(`cat ${process.env.E2E_STORAGE}/roof-last.json`).toString());
check(pinLast.pin && !pinLast.address && Math.abs(pinLast.pin.lat - 39.68347) < 0.0003 && Math.abs(pinLast.pin.lng + 75.75039) < 0.0003, `Roof Takeoff is asked for the tapped spot by lat and lng: ${JSON.stringify(pinLast.pin)}`);
check(roofCalls().length === paidOnce + 2, 'one paid lookup for the tapped roof');
const usePin = roof.getByRole('button', { name: /^Use / });
check(await usePin.isDisabled(), 'Use waits for the estimator to check the tapped roof too');
check((await roof.getByText('Is the white outline on the roof you tapped?').count()) === 1, 'and asks about the tapped roof');
await page.screenshot({ path: SHOTS + '03n-roof-wrong-house-result.png' });
await roof.getByRole('button', { name: 'Right house', exact: true }).click();
check(!(await usePin.isDisabled()), 'then Use works');
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'done' and address is null and pin_lat is not null and abs(pin_lat - ${pinLast.pin.lat}) < 1e-9`, '1', 'the tapped lookup is logged with its pin');
await roof.getByRole('button', { name: 'Close' }).click();

step('satellite: what an unknown address, a house with no roof data, an older Roof Takeoff and a carport look like');
const lookUpAddress = async (street) => {
  await page.getByRole('button', { name: 'Customer' }).first().click();
  await page.getByLabel('Street address').fill(street);
  await page.getByRole('button', { name: 'Next' }).click();
  await atticHeader.waitFor();
  if ((await atticHeader.getAttribute('aria-expanded')) !== 'true') await atticHeader.click();
  await page.getByRole('button', { name: /Look up from the address/ }).click();
};
roofNotFoundStep = true;
await lookUpAddress('1 Nowhere Ln');
await roof.getByRole('alert').waitFor({ timeout: 30000 });
check((await roof.getByRole('alert').innerText()).includes("Google couldn't find that address. Check the spelling, or add the town and state."), "Google's not-found message reaches the estimator");
check((await roof.getByRole('button', { name: 'Try again' }).count()) === 1 && (await roof.getByRole('button', { name: 'Measure by hand' }).count()) === 1, 'with two next steps: Measure by hand, and Try again');
check((await roof.locator('[role=status] [role=alert], [role=alert] [role=status]').count()) === 0, 'the alert is not inside the status line');
await page.screenshot({ path: SHOTS + '03j-roof-not-found.png' });
await roof.getByRole('button', { name: 'Close' }).click();
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'failed' and error like 'not_found:%'`, '1', 'the failed lookup is logged with its reason');
await lookUpAddress('5 No Roof Ln');
await roof.getByRole('alert').waitFor({ timeout: 30000 });
check((await roof.getByRole('alert').innerText()).trim() === 'Google has no roof data for this house. Measure it by hand.', "no roof data, in this app's words (no image to tap, no photo steps)");
await roof.getByRole('button', { name: 'Close' }).click();
roofNotFoundStep = false;
await lookUpAddress('7 Old Rd');
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
const v1Text = await roof.innerText();
check(/ATTIC FLOOR\s+Blown-in, on the ceiling\s+1,970\s/.test(v1Text) && /WALL RUN\s+220 ft/.test(v1Text), 'an older (v1) Roof Takeoff answer still works: attic floor 1,970, wall run 220 ft');
check((await roof.getByText('Lower roof: garage, porch or addition?').count()) === 0, 'with no lower-roof hints');
await roof.getByRole('button', { name: 'Close' }).click();
await lookUpAddress('9 Carport Ct');
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
check((await roof.getByRole('switch', { name: 'Parts with no roof data: over the attic' }).getAttribute('aria-checked')) === 'false', 'parts with no roof data are offered, and start off (L28, RF-15)');
check((await roof.getByText('Parts with no roof data (270 sq ft)').count()) === 1, 'with their size');
const withoutCarport = await roof.getByRole('radio', { name: /Attic floor/ }).innerText();
check(/\b1,990\b/.test(withoutCarport), 'the attic floor starts without the carport: 1,990 sq ft');
check((await roof.getByText('270 sq ft of the outline has no roof data (a carport or flat part?). It is left out. Turn it on below if it is over the attic.').count()) === 1, 'and the check says it is left out');
await roof.getByRole('switch', { name: 'Parts with no roof data: over the attic' }).click();
check(/\b2,230\b/.test(await roof.getByRole('radio', { name: /Attic floor/ }).innerText()), 'turning them on counts the carport: 2,230 sq ft');
await roof.getByRole('switch', { name: 'Parts with no roof data: over the attic' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + '03o-roof-carport.png' });
await roof.getByRole('button', { name: 'Close' }).click();

step('Roof lookup page: from the estimate list, filled in from a link without a lookup');
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor();
await page.getByRole('link', { name: /Roof lookup/ }).click();
await page.waitForURL(BASE + '/field/roof');
await page.getByRole('heading', { name: /Roof lookup/ }).waitFor();
const paidBeforePage = roofCalls().length;
await page.goto(BASE + '/field/roof?address=3%20Cross%20Gable%20Ct');
const addressBox = page.getByLabel('Address');
await page.waitForFunction(() => document.querySelector('input[autocomplete="street-address"]')?.value === '3 Cross Gable Ct');
await page.getByRole('heading', { name: 'Recent lookups' }).waitFor();
await page.waitForTimeout(1500);
check(roofCalls().length === paidBeforePage, '?address= fills in the box but never looks it up');
check((await page.getByText(/paid Google request|no new charge/).count()) === 0, 'an estimator is not told about Google costs (that note is for the owner)');
await page.setViewportSize({ width: 375, height: 812 });
await page.screenshot({ path: SHOTS + '03p-roof-page-prefilled-375.png' });

step('Roof lookup page: Look up');
await page.getByRole('button', { name: 'Look up', exact: true }).click();
await page.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
await page.waitForFunction(() => { const i = document.querySelector('main img'); return i && i.complete && i.naturalWidth === 1280; });
check(roofCalls().length === paidBeforePage + 1 && JSON.parse(execSync(`cat ${process.env.E2E_STORAGE}/roof-last.json`).toString()).address === '3 Cross Gable Ct', 'Look up pays for one lookup of what was typed');
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'done' and estimate_id is null and area_id is null and address = '3 Cross Gable Ct' and matched_key = '3 cross gable ct newark de 19711'`, '1', 'logged with no estimate, and with the key of the address Google matched');
check((await page.getByRole('button', { name: /^More details/ }).getAttribute('aria-expanded')) === 'false', 'roofing and materials wait under More details on the page too');
await page.getByRole('button', { name: /^More details/ }).click();
const pageText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
const pageDeck = /Roof deck over the attic \(spray foam\)\s*([\d,]+) sq ft/.exec(await page.getByTestId('roof-report').textContent())?.[1];
check(
  Boolean(pageDeck) && new RegExp(`ATTIC FLOOR Blown-in, on the ceiling 1,610 SQUARE FEET ROOF DECK Spray foam, under the roof ${pageDeck} SQUARE FEET`).test(pageText) && /Roof surface 2,140 sq ft/.test(pageText),
  `the page shows the same two numbers as an attic's sheet, attic floor 1,610 and roof deck ${pageDeck} (as the report says), and the roof surface under Roofing`,
);
check((await page.getByRole('button', { name: /^Use / }).count()) === 0 && (await page.getByRole('radiogroup', { name: 'Which number to use' }).count()) === 0, 'and no Use buttons');
check(/Order with 15% waste 23⅓ squares Bundles 70 /.test(pageText) && /Drip edge Eaves \+ rakes 238 ft Starter strip Eaves 137 ft Ridge cap Ridges \+ hips 81 ft Valley \(ice and water, flashing\) Valleys 31 ft Headwall \(apron\) flashing Headwalls 16 ft/.test(pageText), 'Roofing and the materials are open: 70 bundles (not the 1/12 porch), 238 ft of drip edge');
check((await page.locator('svg [data-edge]').count()) === 18 && (await page.locator('svg [data-edge="headwall"]').count()) === 1, "all of Roof Takeoff's edges are drawn, headwalls too");
check((await page.getByRole('list', { name: 'Map key' }).innerText()).replace(/\s+/g, ' ').trim() === 'Roof outline Ridge 80 ft Valley 30 ft Eave 136 ft Rake 101 ft Headwall 16 ft Left out', 'with their key');
await page.screenshot({ path: SHOTS + '03q-roof-page-result-375.png' });
await page.screenshot({ path: SHOTS + '03r-roof-page-full-375.png', fullPage: true });
await page.waitForFunction(() => document.querySelector('#roof-report img')?.getAttribute('src')?.startsWith('data:image/jpeg'), null, { timeout: 15000 });
await page.emulateMedia({ media: 'print' });
const pageReport = page.getByTestId('roof-report');
check((await pageReport.isVisible()) && !(await page.locator('main').isVisible()), 'printing from the page shows only the report');
check((await pageReport.innerText()).includes('Headwall (apron) flashing') && (await pageReport.innerText()).includes('3 Cross Gable Ct, Newark, DE 19711, USA'), 'with this house');
await page.screenshot({ path: SHOTS + '03s-roof-page-print-375.png', fullPage: true });
const pagePdf = await page.pdf({ path: SHOTS + 'roof-report-page.pdf', format: 'Letter', printBackground: true });
check(PDF_PAGES(pagePdf) === 1, 'on one letter page');
await page.emulateMedia({ media: 'screen' });
await page.getByRole('button', { name: /Copy summary/ }).click();
await page.getByText('Summary copied. Paste it into a note, text or email.').waitFor();
check((await page.evaluate(() => navigator.clipboard.readText())).includes('Order with 15% waste: 23⅓ squares (70 bundles)'), 'Copy summary works on the page too');
await page.setViewportSize(phone.viewport);

step('Roof lookup page: a recent lookup opens without a new lookup');
await page.reload();
const recent = page.locator('section', { has: page.getByRole('heading', { name: 'Recent lookups' }) });
await recent.getByRole('button', { name: /^12 Elkton Rd, Newark, DE 19711, USA/ }).waitFor({ timeout: 15000 });
const recentText = (await recent.innerText()).replace(/\s+/g, ' ');
check(/3 Cross Gable Ct, Newark, DE 19711, USA today .* attic floor 1,610 sq ft · roof 2,140 sq ft · 6\/12/.test(recentText), 'recent lookups list each house with when and its numbers: ' + recentText.slice(0, 220));
check(
  (recentText.match(/(?<!near )12 Elkton Rd, Newark, DE 19711, USA/g) ?? []).length === 1 && /Roof tapped near 12 Elkton Rd, Newark, DE 19711, USA today/.test(recentText) && !/Roof tapped at 39\.683/.test(recentText),
  'one row per house, and the roof tapped on the photo titled by the house it is near, not by its coordinates',
);
const paidBeforeRecent = roofCalls().length;
await recent.getByRole('button', { name: /^12 Elkton Rd, Newark, DE 19711, USA/ }).click();
await page.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 15000 });
await page.getByText(/Saved lookup from today/).waitFor();
check(roofCalls().length === paidBeforeRecent && (await addressBox.inputValue()) === '12 Elkton Rd, Newark, DE 19711, USA', 'opening one shows the saved lookup, with no new lookup');
await recent.getByRole('button', { name: /^3 Cross Gable Ct, Newark, DE 19711, USA/ }).click();
await page.getByText('A new estimate for 3 Cross Gable Ct, Newark, with an Attic area that already has these numbers.').waitFor({ timeout: 15000 });
check(roofCalls().length === paidBeforeRecent, 'nor for the next one');

step('Roof lookup page: Start an estimate here');
await page.getByRole('button', { name: 'Start an estimate here' }).click();
await page.waitForURL(/\/field\?e=[0-9a-f-]{36}$/, { timeout: 30000 });
await page.getByLabel('Street address').waitFor();
check(
  (await page.getByLabel('Street address').inputValue()) === '3 Cross Gable Ct' &&
    (await page.getByLabel('City').inputValue()) === 'Newark' &&
    (await page.getByLabel('State').inputValue()) === 'DE' &&
    (await page.getByLabel('ZIP').inputValue()) === '19711',
  'the new estimate has the address Google matched: street, city, state and ZIP',
);
await page.getByRole('navigation', { name: 'Estimate steps' }).getByRole('button', { name: 'Areas' }).click();
const crossAttic = page.getByRole('button', { name: /^Attic/ });
await crossAttic.waitFor();
check((await page.getByRole('button', { name: /^Attic/ }).count()) === 1, 'and an Attic area');
if ((await crossAttic.getAttribute('aria-expanded')) !== 'true') await crossAttic.click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 5000 });
check(roofCalls().length === paidBeforeRecent && (await roof.getByText(/Saved lookup from today/).count()) === 1, "the attic's lookup opens at once, with no new lookup");
check(/ATTIC FLOOR\s+Blown-in, on the ceiling\s+1,610\s+SQUARE FEET/.test(await roof.innerText()) && (await roof.getByRole('button', { name: 'Use 1,610 sq ft' }).isEnabled()), 'with the same numbers, ready to use (Google matched the house itself)');
await page.setViewportSize({ width: 375, height: 812 });
await page.screenshot({ path: SHOTS + '03t-roof-sheet-cross-gable-375.png' });
await roof.getByRole('button', { name: /^More details/ }).click();
await roof.getByRole('button', { name: /^Roof edges and materials/ }).click();
check(/Headwall \(apron\) flashing Headwalls 16 ft/.test((await roof.innerText()).replace(/\s+/g, ' ')), 'and the materials of this roof');
await page.setViewportSize(phone.viewport);
await roof.getByRole('button', { name: 'Close' }).click();
await page.reload();
await page.getByRole('navigation', { name: 'Estimate steps' }).getByRole('button', { name: 'Areas' }).click();
await crossAttic.waitFor();
if ((await crossAttic.getAttribute('aria-expanded')) !== 'true') await crossAttic.click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByText(/Saved lookup from today/).waitFor({ timeout: 15000 });
check(roofCalls().length === paidBeforeRecent, "after a reload the server finds the page's lookup by the address Google matched: still no new lookup");
await waitForDb(`select count(*) from roof_lookups where address_key = '3 cross gable ct newark de 19711'`, '0', 'and logs none');
await roof.getByRole('button', { name: 'Close' }).click();

step('Roof lookup page: an old map-pin link is looked up at the pin');
const paidBeforePin = roofCalls().length;
await page.goto(BASE + '/field/roof?address=39.6829%2C-75.7509');
await page.waitForFunction(() => document.querySelector('input[autocomplete="street-address"]')?.value === '39.6829,-75.7509');
await page.getByRole('button', { name: 'Look up', exact: true }).click();
await page.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
const pinCall = roofCalls().at(-1);
check(roofCalls().length === paidBeforePin + 1 && !pinCall.address && pinCall.pin?.lat === 39.6829 && pinCall.pin?.lng === -75.7509, `Roof Takeoff is asked for that spot, not for "39.6829,-75.7509" as an address: ${JSON.stringify(pinCall)}`);
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'done' and address is null and abs(pin_lat - 39.6829) < 1e-9 and abs(pin_lng + 75.7509) < 1e-9`, '1', 'logged as a pin lookup');
check((await page.getByText('Is the white outline on the roof you tapped?').count()) === 1, 'and the estimator is asked to check the roof');
check((await page.getByTestId('roof-report').textContent()).includes('Roof tapped at 39.68290, -75.75090'), 'the report names the spot');

step('Roof lookup page: the right roof tapped, then Start an estimate here');
await page.goto(BASE + '/field/roof');
await page.getByLabel('Address').fill('12 Elkton Rd, Newark, DE 19711');
await page.getByRole('button', { name: 'Look up', exact: true }).click();
await page.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
await page.waitForFunction(() => { const i = document.querySelector('main img'); return i && i.complete && i.naturalWidth === 1280; });
await page.getByRole('button', { name: 'Tap the right roof', exact: true }).click();
const pagePhoto = page.getByRole('button', { name: 'Tap the right roof on the photo' });
const pagePhotoBox = await pagePhoto.boundingBox();
await pagePhoto.click({ position: { x: pagePhotoBox.width * 0.72, y: pagePhotoBox.height * 0.3 } });
await page.getByText('Look up this roof instead?').locator('..').getByRole('button', { name: 'Look up', exact: true }).click();
await page.getByText('The roof you tapped on the photo').waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Right house', exact: true }).click();
await page.getByText('A new estimate for 12 Elkton Rd, Newark, with an Attic area that already has these numbers.').waitFor({ timeout: 15000 });
check(await page.getByRole('button', { name: 'Start an estimate here' }).isEnabled(), "a roof tapped on the photo can start an estimate, with the address the house was looked up by");
check((await page.getByTestId('roof-report').textContent()).includes('Roof tapped near 12 Elkton Rd, Newark, DE 19711 (39.683'), 'and the report says which house the tapped roof is');
const paidBeforeTappedStart = roofCalls().length;
await page.getByRole('button', { name: 'Start an estimate here' }).click();
await page.waitForURL(/\/field\?e=[0-9a-f-]{36}$/, { timeout: 30000 });
await page.getByLabel('Street address').waitFor();
check(
  (await page.getByLabel('Street address').inputValue()) === '12 Elkton Rd' && (await page.getByLabel('City').inputValue()) === 'Newark' && (await page.getByLabel('ZIP').inputValue()) === '19711',
  'the new estimate has the house address',
);
await page.getByRole('navigation', { name: 'Estimate steps' }).getByRole('button', { name: 'Areas' }).click();
const tappedAttic = page.getByRole('button', { name: /^Attic/ });
await tappedAttic.waitFor();
if ((await tappedAttic.getAttribute('aria-expanded')) !== 'true') await tappedAttic.click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByText('The roof you tapped on the photo').waitFor({ timeout: 5000 });
check(roofCalls().length === paidBeforeTappedStart && (await roof.getByRole('button', { name: /^Use / }).isEnabled()), "the attic opens on the tapped roof, already checked, with no new lookup");
await roof.getByRole('button', { name: 'Close' }).click();

step('Roof lookup page: a roof with 24 faces still prints on one page');
await page.goto(BASE + '/field/roof');
await page.setViewportSize({ width: 360, height: 780 });
await page.getByLabel('Address').fill('24 Many Faces Ln, Newark, DE 19711');
await page.getByRole('button', { name: 'Look up', exact: true }).click();
await page.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: /^More details/ }).click();
const tilesFit = (tiles) => tiles.every((tile) => [...tile.querySelectorAll('span')].every((s) => s.getBoundingClientRect().right <= tile.getBoundingClientRect().right + 0.5));
const readoutsFit = await page.locator('main [data-readout]').evaluateAll(tilesFit);
const roofingFits = await page.locator('main section', { has: page.getByRole('button', { name: /^Roofing/ }) }).locator('.grid-cols-2 > div').evaluateAll(tilesFit);
check(readoutsFit && roofingFits && /Roof surface 12,\d{3} sq ft/.test((await page.locator('main').innerText()).replace(/\s+/g, ' ')), 'the numbers and a five-digit roof surface stay inside their tiles on a 360 px phone');
await page.screenshot({ path: SHOTS + '03u-roof-page-many-faces-360.png' });
await page.setViewportSize(phone.viewport);
await page.waitForFunction(() => document.querySelector('#roof-report img')?.getAttribute('src')?.startsWith('data:image/jpeg'), null, { timeout: 15000 });
await page.emulateMedia({ media: 'print' });
const manyReport = page.getByTestId('roof-report');
check((await manyReport.locator('[data-columns]').getAttribute('data-columns')) === '2' && (await manyReport.locator('table').count()) >= 3, 'the 24 faces go in two tables side by side');
await page.setViewportSize({ width: 816, height: 1056 });
await page.screenshot({ path: SHOTS + '03v-roof-print-many-faces-letter.png', fullPage: true });
await page.setViewportSize(phone.viewport);
const manyPdf = await page.pdf({ path: SHOTS + 'roof-report-many-faces.pdf', format: 'Letter', printBackground: true });
check(PDF_PAGES(manyPdf) === 1, 'and the report still prints on one letter page');
await page.emulateMedia({ media: 'screen' });
await page.evaluate(() => {
  window.print = () => {
    window.__printedAs = document.title;
    window.dispatchEvent(new Event('afterprint'));
  };
});
await page.getByRole('button', { name: /Print or save PDF/ }).click();
check((await page.evaluate(() => window.__printedAs)) === 'Roof takeoff - 24 Many Faces Ln, Newark, DE 19711, USA', 'Print names the PDF after the house on the page too');

step('offline estimate');
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor();
await ctx.setOffline(true);
offlineStep = true;
await page.reload();
await page.getByRole('heading', { name: 'Estimates' }).waitFor({ timeout: 15000 });
await page.getByText(/Offline/).first().waitFor();
await page.getByRole('link', { name: /Roof lookup/ }).click();
await page.getByText('The roof lookup needs internet. Your estimates still work offline.').waitFor({ timeout: 15000 });
check(await page.getByRole('button', { name: 'Look up', exact: true }).isDisabled(), 'offline, the Roof lookup page opens and says it needs internet');
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(400); // the Look up button fades to grey
await page.screenshot({ path: SHOTS + '08a-roof-page-offline-375.png' });
await page.setViewportSize(phone.viewport);
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor({ timeout: 15000 });
await page.getByRole('button', { name: 'New estimate', exact: true }).click();
await page.getByLabel('First name').fill('Sam');
await page.getByLabel('Last name').fill('Offline');
await page.getByLabel('Street address').fill('99 Crawl Ln');
await page.getByLabel('ZIP').fill('19702');
await page.getByRole('button', { name: 'Next' }).click();
await page.getByRole('button', { name: '+ Crawlspace' }).click();
await page.getByLabel('Square feet').fill('800');
check(await page.getByRole('button', { name: /Look up from the address/ }).isDisabled(), 'the satellite lookup is off without signal');
check((await page.getByText('No signal. The satellite lookup needs a connection.').count()) === 1, 'and says why');
await page.getByRole('button', { name: 'Next' }).click();
await page.getByText('Good', { exact: true }).first().waitFor();
await page.screenshot({ path: SHOTS + '08-offline-options.png', fullPage: true });
console.log('  offline prices', await page.locator('p.text-2xl').allTextContents());
await page.getByRole('button', { name: 'Back to estimates' }).click();
await page.screenshot({ path: SHOTS + '09-offline-list.png' });
console.log('  db before reconnect:', psql("select count(*) from estimates"));
await ctx.setOffline(false);
offlineStep = false;
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(6000);
console.log('  db after reconnect:', psql("select count(*) || ' estimates; ' || string_agg(c.last_name || ':' || e.priced_offline, ',') from estimates e join customers c on c.id=e.customer_id"));
await page.screenshot({ path: SHOTS + '10-synced-list.png' });

step("Koala's database unreachable is not a sign-out (L36)");
{
  const rest = (down) => fetch(`http://localhost:${process.env.MOCK_PORT}/__e2e/rest`, { method: 'POST', body: JSON.stringify({ down }) });
  // Review B flow-B10: Pricing is open in the owner's browser when Koala stops answering.
  const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await pctx.addCookies([sessionCookie(OWNER)]);
  const pp = await pctx.newPage();
  await pp.goto(BASE + '/admin/pricing');
  await pp.getByRole('button', { name: 'Save', exact: true }).first().waitFor();
  unreachableStep = true;
  await rest(true);
  await page.goto(BASE + '/field');
  await page.getByRole('heading', { name: 'Estimates' }).waitFor({ timeout: 15000 });
  await page.getByText("Can't reach Koala right now.").waitFor({ timeout: 20000 });
  check(new URL(page.url()).pathname === '/field', 'opening /field with the database down opens the field app from the phone, not the sign-in page');
  check((await page.getByText('Pat Lee').count()) > 0 && (await page.getByText('Your work is saved on this phone. It syncs when Koala is back.').count()) === 1, "with the phone's estimates and \"Can't reach Koala right now\"");
  await page.screenshot({ path: SHOTS + '10b-field-unreachable.png' });
  {
    // Review B flow-B2: with signal but no Koala, the Send checklist does not say "Online", and Send waits.
    await page.getByRole('button', { name: /Kim Pending/ }).first().click();
    await page.getByRole('button', { name: /^4 Send/ }).click();
    const item = page.locator('li[data-check="online"]');
    await item.waitFor();
    check(
      (await item.getAttribute('data-ok')) === 'no' && (await item.innerText()).includes("Can't reach Koala right now. Sending needs Koala; your work is saved."),
      `the Send checklist says Koala cannot be reached, not "Online": "${(await item.innerText()).trim()}"`,
    );
    check(await page.getByRole('button', { name: /Send quote to customer/ }).isDisabled(), 'and Send waits while Koala cannot be reached');
    await page.screenshot({ path: SHOTS + '10b2-send-unreachable.png' });
    await page.getByRole('button', { name: 'Back to estimates' }).click();
  }
  const api = await ctx.request.get(BASE + '/api/estimates');
  const body = await api.json();
  check(api.status() === 503 && body.error === 'unreachable' && /Can't reach Koala right now/.test(body.message), `APIs answer 503, not "signed out": ${api.status()} ${body.error}`);
  {
    // Release review C FLOW-3: the server says so at once, not after the database client's retries
    // (1 + 2 + 4 s a read: /field took 14 s, /estimates and /api/bundle 7 s).
    const timed = async (path) => {
      const t0 = Date.now();
      const r = await ctx.request.get(BASE + path, { maxRedirects: 0 });
      return { status: r.status(), location: r.headers()['location'] ?? '', ms: Date.now() - t0 };
    };
    for (const path of ['/field', '/estimates']) {
      const r = await timed(path);
      check(r.status === 307 && r.location.includes('/unreachable') && r.ms < 2000, `${path} with the database down goes to /unreachable within 2 s: ${r.status} in ${r.ms} ms`);
    }
    const b = await timed('/api/bundle');
    check(b.status === 503 && b.ms < 2000, `/api/bundle with the database down answers 503 within 2 s: ${b.status} in ${b.ms} ms`);
  }
  {
    // Release, blower door under the accuracy rules: the tool opens from the phone's copy and says
    // Koala cannot be reached, never that the session expired or the estimate is not theirs.
    const leeId = psql("select e.id from estimates e join customers c on c.id = e.customer_id where c.last_name = 'Lee'");
    const toolPath = `/field/blower-door?estimate=${leeId}`;
    await page.goto(BASE + toolPath);
    await page.getByRole('heading', { name: 'Blower door' }).waitFor({ timeout: 15000 });
    await page.getByText("Can't reach Koala right now.").waitFor({ timeout: 20000 });
    check(
      new URL(page.url()).pathname === '/field/blower-door' && (await page.getByText('Your session expired.').count()) === 0 && (await page.getByText(/is not one you can save readings to/).count()) === 0,
      "the blower door tool, opened while Koala's database is down, opens from the phone and says \"Can't reach Koala right now\", not \"Your session expired\" or \"not one you can save readings to\"",
    );
    const bd = await ctx.request.post(BASE + '/api/blower-door/tests', { data: { mutationId: '0f000000-0000-4000-8000-0000000000e2', test: {} } });
    check(bd.status() === 503 && (await bd.json()).error === 'unreachable', `the blower door API answers 503 unreachable, not "Not signed in": ${bd.status()}`);
    await page.screenshot({ path: SHOTS + '10e-blower-door-unreachable.png' });
    const own = await ctx.newPage();
    await own.goto(BASE + `/unreachable?next=${encodeURIComponent(toolPath)}`);
    const offer = own.getByRole('link', { name: 'Open the blower door tool on this phone' });
    await offer.waitFor({ timeout: 15000 });
    check((await offer.getAttribute('href')) === toolPath && (await own.getByRole('link', { name: 'Open the estimates on this phone' }).count()) === 0, '/unreachable for the blower door tool offers the tool for the same estimate (was the estimates list)');
    await own.close();
    await page.goto(BASE + '/field');
    await page.getByRole('heading', { name: 'Estimates' }).waitFor({ timeout: 15000 });
    await page.getByText("Can't reach Koala right now.").waitFor({ timeout: 20000 });
  }
  {
    // Release review C FLOW-4: "All my estimates" (/estimates) with the database down is no dead end
    // on the phone: /unreachable offers the estimates saved on it (only "Try again" before, which
    // loops while Koala is down, and the home-screen app has no back button).
    await page.goto(BASE + '/estimates');
    await page.waitForURL(/\/unreachable\?next=%2Festimates/);
    const saved = page.getByRole('link', { name: 'Open the estimates on this phone' });
    await saved.waitFor({ timeout: 15000 });
    check((await saved.getAttribute('href')) === '/field', '/unreachable for All my estimates offers the estimates saved on this phone');
    await saved.click();
    await page.getByRole('heading', { name: 'Estimates' }).waitFor({ timeout: 15000 });
    await page.getByText("Can't reach Koala right now.").waitFor({ timeout: 20000 });
    check(new URL(page.url()).pathname === '/field', "and it opens the field app from the phone's copy");
  }
  const uctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await uctx.addCookies([sessionCookie(OWNER)]);
  const up = await uctx.newPage();
  await up.goto(BASE + '/estimates');
  const at = new URL(up.url());
  check(at.pathname === '/unreachable' && at.searchParams.get('next') === '/estimates', `an office page goes to /unreachable, keeping the page: ${at.pathname}${at.search}`);
  check((await up.getByRole('heading', { name: 'Can’t reach Koala right now' }).count()) === 1 && (await up.getByRole('link', { name: 'Try again' }).getAttribute('href')) === '/estimates', 'it says so, with Try again back to the page');
  await up.screenshot({ path: SHOTS + '10c-unreachable-page.png' });
  {
    await pp.getByRole('button', { name: 'Save', exact: true }).first().click();
    await pp.getByText("Can't reach Koala right now. Nothing was saved.").first().waitFor({ timeout: 20000 });
    check((await pp.getByText('Only the owner can change pricing.').count()) === 0, "saving Pricing while Koala is down says \"Can't reach Koala right now. Nothing was saved.\", not \"Only the owner can change pricing.\"");
    await pp.screenshot({ path: SHOTS + '10d-pricing-save-unreachable.png' });
    await pctx.close();
  }
  await up.goto(BASE + '/unreachable?next=//evil.example/x');
  check((await up.getByRole('link', { name: 'Try again' }).getAttribute('href')) === '/', 'next= is only ever a path on this site');
  // Review B database-B1: dot segments that resolve to "//host" do not leave the site either.
  await up.goto(BASE + '/unreachable?next=%2F.%2F%2Fevil.example%2Fx');
  check((await up.getByRole('link', { name: 'Try again' }).getAttribute('href')) === '/', 'next=/.//evil.example/x is not a way off the site (Try again goes to /)');
  {
    const res = await uctx.request.get(BASE + '/login?next=/a&next=/b', { maxRedirects: 0 });
    check(res.status() === 200, `a repeated next= on the sign-in page opens it (was a 500): ${res.status()}`);
  }
  const signedOut = await browser.newContext();
  const sp = await signedOut.newPage();
  await sp.goto(BASE + '/estimates');
  check(new URL(sp.url()).pathname === '/login', 'a request with no session still goes to sign in, never through');
  await signedOut.close();
  await uctx.close();
  await rest(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByText("Can't reach Koala right now.").waitFor({ state: 'detached', timeout: 20000 });
  check(true, 'when the database answers again, the banner goes');
  unreachableStep = false;
}

step('blower door: the tool opens with no signal, converts, shows the tier and copies the summary');
{
  // The field app's sync cached the franchise's rebate programs with the pricing bundle; the
  // service worker kept the tool's page when it installed.
  await ctx.setOffline(true);
  offlineStep = true;
  await page.goto(BASE + '/field/blower-door');
  await page.getByRole('heading', { name: 'Blower door' }).waitFor({ timeout: 15000 });
  await page.getByText('The calculator works with no signal.').waitFor();
  check((await page.getByRole('radio', { name: 'Home Performance' }).getAttribute('aria-checked')) === 'true', 'offline, the tool opens with the first rebate program chosen');
  const flow = page.getByLabel('Fan flow (CFM)');
  const pressure = page.getByLabel('House pressure (Pa)');
  await flow.nth(0).fill('6952');
  check((await page.getByTestId('bd-badge').innerText()).includes('TEST-IN ONLY'), 'with only the test-in it says so');
  // The 20% limit is 5,561.6 CFM50: the largest whole test-out that reaches it is 5,561 (BD-MATH-3).
  check((await page.getByText('The test-out must be at or below 5,561 CFM50 for the 20% tier.').count()) === 1, 'and what the first tier needs');
  await flow.nth(1).fill('3325');
  // Typing the gauge's minus sign first is not an error (BD-R8).
  await pressure.nth(1).fill('-');
  check((await page.getByText('House pressure: type a number.').count()) === 0, 'a lone minus sign, half typed, is not an error');
  await pressure.nth(1).fill('-50.8');
  await page.getByTestId('bd-big').filter({ hasText: '52.7%' }).waitFor();
  // No price typed yet: the most the tier pays, before the 75% cost cap (release review C DOC-4).
  check((await page.getByTestId('bd-badge').innerText()) === '40% TIER — UP TO $1,800 AIR SEAL REBATE', 'the worked example: 52.7% and the 40% tier, up to $1,800 on Home Performance before the cost cap');
  check((await page.getByTestId('bd-test_out-cfm50').innerText()) === '3,291', 'the test-out at 50.8 Pa (typed with the minus sign) is 3,291 CFM50');
  check((await page.getByText('Top tier reached with 880 CFM50 to spare.').count()) === 1, 'the tier table says how far past the top tier');
  await page.getByRole('radio', { name: 'Assisted' }).click();
  check((await page.getByTestId('bd-badge').innerText()) === '40% TIER — UP TO $2,000 AIR SEAL REBATE', 'Assisted pays its own amount');
  await page.getByRole('radio', { name: 'Home Performance' }).click();
  await page.getByLabel('House volume (ft³)').fill('20000');
  await page.getByLabel('Occupants').fill('3');
  await page.getByTestId('bd-ventilation').waitFor();
  check((await page.getByTestId('bd-ventilation').innerText()).startsWith('Ventilation OK: test-out is 1,495 CFM50 above the BAS of 1,796 (estimated).'), 'the ventilation check against the estimated BAS');
  await page.getByLabel('Air sealing price ($)').fill('$2,000');
  check((await page.getByTestId('bd-badge').innerText()) === '40% TIER — $1,500 AIR SEAL REBATE', 'the 75% cost cap below the tier lowers the rebate');
  // Release, OD4: the price is whole dollars, as on the quote; cents are refused, not rounded away.
  await page.getByLabel('Air sealing price ($)').fill('1999.50');
  await page.getByText('Air sealing price: whole dollars, as on the quote (no cents).').waitFor();
  check((await page.getByTestId('bd-badge').innerText()) === '40% TIER — UP TO $1,800 AIR SEAL REBATE', 'a price with cents is refused (whole dollars, as on the quote) and caps nothing');
  await page.getByLabel('Air sealing price ($)').fill('1999');
  check((await page.getByTestId('bd-badge').innerText()) === '40% TIER — $1,499 AIR SEAL REBATE', 'a capped rebate is whole dollars, never more than the program pays: $1,499 (was $1,499.25)');
  await page.getByLabel('Air sealing price ($)').fill('');
  await page.getByRole('button', { name: 'Copy summary' }).click();
  await page.getByRole('button', { name: 'Copied' }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(
    copied.startsWith('Blower Door Results (Retrotec Model 5000)\nProgram: Energize Delaware Home Performance with ENERGY STAR\nTest-in: 6,952 CFM50 (read 6,952 CFM at 50 Pa)\nTest-out: 3,291 CFM50 (read 3,325 CFM at 50.8 Pa)\nReduction: 52.7% (3,661 CFM50)\nAir sealing tier: 40% improvement — rebate up to $1,800 (before the 75% cost cap)') &&
      copied.includes('ACH50: 20.86 -> 9.87'),
    'Copy summary copies the same plain-text summary',
  );
  await page.screenshot({ path: SHOTS + '10a-blower-door-offline.png', fullPage: true });
  // What was typed is still there on the next visit.
  await page.waitForTimeout(500);
  await page.reload();
  await page.getByTestId('bd-big').filter({ hasText: '52.7%' }).waitFor({ timeout: 15000 });
  check((await page.getByLabel('Fan flow (CFM)').nth(1).inputValue()) === '3325', 'the readings are kept on the phone between visits');
  await page.getByRole('button', { name: 'Clear for new job' }).click();
  check((await page.getByLabel('Fan flow (CFM)').nth(0).inputValue()) === '' && (await page.getByTestId('bd-badge').innerText()) === '—', 'Clear for new job empties the readings');
  await ctx.setOffline(false);
  offlineStep = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

step('owner screens');
const octx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await octx.addCookies([sessionCookie(OWNER)]);
const op = await octx.newPage();
op.on('pageerror', (e) => logs.push('OWNER PAGEERROR ' + e.message));
await op.goto(BASE + '/estimates');
await op.screenshot({ path: SHOTS + '11-estimates.png', fullPage: true });
{
  // The office list shows the recommended option's price (OD1, L9): the pick, else Better (Sam
  // Offline has no pick), the same option the phone and the quote recommend. Its figures add up
  // exactly the rows they name.
  const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  const headline = Number(psql("select o.price from estimates e join customers c on c.id = e.customer_id join estimate_options o on o.estimate_id = e.id and o.tier = coalesce(e.selected_tier, 'better') where c.last_name = 'Offline'"));
  const offlineRow = op.getByRole('row', { name: /Sam Offline/ });
  check(psql("select selected_tier is null from estimates e join customers c on c.id = e.customer_id where c.last_name = 'Offline'") === 't', 'Sam Offline has no option picked');
  check((await offlineRow.innerText()).includes(money(headline)) && /better/i.test(await offlineRow.innerText()), `the office list shows Better's price ${money(headline)}, the recommended option`);
  check(
    psql("select e.model_total_price = o.model_price from estimates e join customers c on c.id = e.customer_id join estimate_options o on o.estimate_id = e.id and o.tier = 'better' where c.last_name = 'Offline'") === 't',
    'and the stored model total is the recommended option\'s model price',
  );
  const signedSum = Number(psql("select sum(signed_price) from quotes where status = 'signed'"));
  const figures = await op.getByRole('region', { name: 'Figures for this list' }).innerText();
  check(figures.includes(money(signedSum)) && /1 quote, signed by the customer/.test(figures), `the Signed figure is the signed quotes' total, ${money(signedSum)}`);
}
await op.getByRole('link', { name: 'Roof lookup' }).click();
await op.waitForURL(BASE + '/field/roof');
await op.getByText(/by Eddie Estimator/).first().waitFor({ timeout: 15000 });
check((await op.getByText("Everyone's lookups.", { exact: false }).count()) === 1, "the owner's menu has Roof lookup, with everyone's recent lookups and who looked each up");
check((await op.getByText('Each lookup is a paid Google request. A house looked up in the last day comes back free.').count()) === 1, 'the owner, who pays for lookups, is told what they cost');
await op.screenshot({ path: SHOTS + '11a-owner-roof-page.png', fullPage: true });
console.log('  estimates rows mention Lee/Offline:', (await op.content()).includes('Lee'), (await op.content()).includes('Offline'));
await op.goto(BASE + '/admin/pricing');
await op.screenshot({ path: SHOTS + '12-pricing.png', fullPage: true });
{
  // L10: the margin is labelled net, after overhead, with what it means in gross terms.
  check((await op.getByLabel('Target net margin (after overhead)').count()) === 1, 'Pricing labels the margin "Target net margin (after overhead)"');
  const preview = await op.locator('[data-margin-preview]').innerText();
  check(preview.startsWith('With 63% overhead, a 15% net margin is about a 48% gross margin: prices are 1.92 times the direct job cost.'), `and previews the gross margin: "${preview.split('.')[0]}"`);
  check(psql("select value #>> '{}' from app_settings where key = 'target_margin_pct'") === '0.15', 'the stored value is unchanged');
  // L38: the code banner comes from the data; the crawlspace placeholder is the floor priced.
  const codeText = await op.locator('section', { has: op.locator('#code') }).last().innerText();
  check(codeText.includes('these minimums come from 2018 IECC (local) and company default.') && !/Newark|New Castle|Delaware|climate zone/.test(codeText), 'the code banner names the editions in the data, no town or climate zone');
  const crawlTiers = op.locator('form', { has: op.locator('input[name="job_type"][value="crawlspace"]') });
  check((await crawlTiers.locator('input[placeholder="Code minimum (R-19)"]').count()) === 3, 'the crawlspace Target R placeholder shows the floor priced, R-19 (not the crawl wall R-10)');
}
// L11: a cost far outside the usual range waits for "This cost is right"; the step puts it back.
const cost = op.getByLabel(/cost per unit/i).first();
const costWas = await cost.inputValue();
const ocsfCost = () => psql("select m.cost_per_unit from materials m join products p on p.id = m.product_id where p.code = 'ocsf' and m.is_default");
const ocsfBefore = ocsfCost();
await cost.fill('15.25');
await cost.press('Tab');
const form = cost.locator('xpath=ancestor::form[1]');
await form.getByRole('button', { name: /save/i }).click();
await form.getByText(/Not saved\. \$15\.25 per board ft is 64 times the usual high of \$0\.24\. The usual range is \$0\.06 to \$0\.24 \(Starting range: half to twice/).waitFor({ timeout: 15000 });
check(ocsfCost() === ocsfBefore, `a cost 100 times the usual is refused, with the usual range and where it comes from (still ${ocsfBefore})`);
await form.scrollIntoViewIfNeeded();
await op.screenshot({ path: SHOTS + '12b-pricing-cost-range.png' });
await form.getByRole('switch', { name: /This cost is right/ }).click();
await form.getByRole('button', { name: /save/i }).click();
await form.getByText(/Saved/).first().waitFor({ timeout: 15000 });
check(Number(ocsfCost()) === 15.25, 'with "This cost is right" ticked it is saved');
console.log('  material audit:', psql("select count(*) from audit_log where table_name='materials' and action='UPDATE' and actor_id='11111111-1111-4111-8111-111111111111'"));
// Review B flow-B9: the confirmed cost widens the usual range, so the card saves again unticked.
{
  const ocsfRange = () => psql("select m.typical_min || ' ' || m.typical_max from materials m join products p on p.id = m.product_id where p.code = 'ocsf' and m.is_default").split(' ').map(Number);
  const [lo, hi] = ocsfRange();
  check(lo === 0.06 && hi === 15.25, `a confirmed $15.25 widens the stored usual range to $0.06 to $15.25 (was $0.06 to $0.24): ${lo} to ${hi}`);
  await op.reload();
  const again = op.getByLabel(/cost per unit/i).first().locator('xpath=ancestor::form[1]');
  check((await again.getByRole('switch', { name: /This cost is right/ }).getAttribute('aria-checked')) === 'false', 'after a reload "This cost is right" is not ticked');
  await again.getByRole('button', { name: /save/i }).click();
  await again.getByText(/Saved/).first().waitFor({ timeout: 15000 });
  check((await again.getByText(/Not saved/).count()) === 0 && Number(ocsfCost()) === 15.25, 'saving the card again without ticking is not refused (it was, every time)');
  // Put the usual range back with the cost.
  await again.getByLabel('Usual cost, high').fill('0.24');
}
const cost2 = op.getByLabel(/cost per unit/i).first();
const form2 = cost2.locator('xpath=ancestor::form[1]');
await cost2.fill(costWas);
await form2.getByRole('button', { name: /save/i }).click();
await form2.getByText(/Saved/).first().waitFor({ timeout: 15000 });
await waitForDb("select m.cost_per_unit from materials m join products p on p.id = m.product_id where p.code = 'ocsf' and m.is_default", ocsfBefore, `the step puts the open-cell cost back (${ocsfBefore})`);
await waitForDb("select m.typical_max::float8 from materials m join products p on p.id = m.product_id where p.code = 'ocsf' and m.is_default", '0.24', 'and its usual high back ($0.24)');
// A change that would break pricing must be refused and rolled back.
await op.goto(BASE + '/admin/team');
await op.screenshot({ path: SHOTS + '13-team.png', fullPage: true });
const est = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await est.addCookies([sessionCookie(EST)]);
const ep = await est.newPage();
await ep.goto(BASE + '/admin/pricing');
console.log('  estimator on /admin/pricing ends at:', new URL(ep.url()).pathname);
check((await ep.getByRole('heading', { name: 'This page is for the owner and the office' }).count()) === 1, 'an estimator on Pricing is told whose page it is, not sent home silently');


// ---------------------------------------------------------------- Phase 2
const jobId = psql("select j.id from jobs j join estimates e on e.id = j.estimate_id join customers c on c.id = e.customer_id where c.last_name = 'Lee'");
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

step('office schedules the job and assigns Crew A');
await op.goto(BASE + '/jobs');
await op.screenshot({ path: SHOTS + '14-jobs.png', fullPage: true });
await op.getByRole('link', { name: /Pat Lee/ }).first().click();
await op.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
await op.locator('select[name="crew_id"]').selectOption({ label: 'Crew A' });
await op.locator('input[name="scheduled_start"]').fill(today);
await op.getByRole('button', { name: 'Save schedule' }).click();
await waitForDb(`select (crew_id is not null)::text || ':' || scheduled_start from jobs where id = '${jobId}'`, `true:${today}`, 'job scheduled for Crew A today');

step('blower door: the estimator saves the test-in on the estimate');
const leeEstimate = psql("select e.id from estimates e join customers c on c.id = e.customer_id where c.last_name = 'Lee'");
{
  await page.goto(BASE + `/field?e=${leeEstimate}`);
  await page.getByRole('navigation', { name: 'Estimate steps' }).getByRole('button', { name: /Areas/ }).click();
  await page.getByRole('link', { name: 'Start the blower door test' }).click();
  await page.waitForURL(/\/field\/blower-door\?estimate=/);
  await page.getByText(/Readings you save go to this estimate: Pat Lee, 12 Elkton Rd/).waitFor({ timeout: 15000 });
  await page.getByLabel('Fan flow (CFM)').nth(0).fill('6952');
  await page.getByLabel('House pressure (Pa)').nth(0).fill('50');
  await page.getByLabel('House volume (ft³)').fill('20000');
  await page.getByLabel('Occupants').fill('3');
  // This customer is on the Assisted program, and the estimator knows the air sealing price.
  await page.getByRole('radio', { name: 'Assisted' }).click();
  await page.getByLabel('Air sealing price ($)').fill('1999');
  // A double tap (gloves, a slow phone): two clicks before the screen updates save one reading (BD-R6).
  await page.getByRole('button', { name: 'Save test-in' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await waitForDb(
    `select count(*) || ':' || min(cfm50) || ':' || min(volume) || ':' || bool_and(job_id is null) from blower_door_tests where estimate_id = '${leeEstimate}' and kind = 'test_in'`,
    '1:6952.00:20000.0:true',
    'the test-in is saved to the estimate, with the house, once after a double tap',
  );
  check(
    psql(`select program_key || ':' || air_sealing_cost || ':' || (program->'tiers'->2->>'rebate') from blower_door_tests where estimate_id = '${leeEstimate}' and kind = 'test_in'`) === 'assisted:1999.00:2000',
    'with the Assisted program (as the franchise has it) and the price',
  );
  await page.waitForTimeout(1500);
  check(psql(`select count(*) from blower_door_tests where estimate_id = '${leeEstimate}'`) === '1', 'and no second reading arrives later');
  await page.getByText('Saved to the estimate', { exact: true }).waitFor({ timeout: 15000 });
  check((await page.getByRole('button', { name: 'Retake test-in' }).count()) === 1, 'a saved reading shows as recorded, with Retake');
}

step('crew starts the job on a phone');
const cctx = await browser.newContext(phone);
await cctx.addCookies([sessionCookie(CREW)]);
const cpg = await cctx.newPage();
// The same rule as the estimator's phone: only the failures a step causes on purpose are expected.
cpg.on('console', (m) => m.type() === 'error' && !expected(m) && logs.push('CREW ' + m.text()));
cpg.on('pageerror', (e) => logs.push('CREW PAGEERROR ' + e.message));
await cpg.goto(BASE + '/crew');
await cpg.getByRole('heading', { name: 'Jobs' }).waitFor();
await cpg.screenshot({ path: SHOTS + '15-crew-jobs.png', fullPage: true });
await cpg.getByRole('button', { name: /Lee/ }).first().click();
await cpg.getByRole('button', { name: 'Start job' }).click();
await cpg.getByRole('button', { name: 'Complete job' }).waitFor({ timeout: 15000 });
await waitForDb(`select status from jobs where id = '${jobId}'`, 'in_progress', 'crew started the job');
const crewText = await cpg.locator('body').innerText();
check(!/\$\s?\d/.test(crewText), 'crew screens show no prices');
const crewApi = await cpg.evaluate(async () => (await fetch('/api/crew/jobs')).text());
check(!/price|revenue|cost/i.test(crewApi), 'crew jobs API returns no prices or costs');

step('crew enters actuals and completes the job');
const scope = cpg.locator('fieldset:has(legend:text("Job actuals")) input[placeholder]');
const n = await scope.count();
for (let i = 0; i < n; i++) {
  const ph = Number((await scope.nth(i).getAttribute('placeholder')).replace(/,/g, ''));
  if (Number.isFinite(ph) && ph > 0) await scope.nth(i).fill(String(Math.round(ph * 1.12 * 10) / 10));
}
await cpg.getByLabel('Drive, one way (min)').fill('25');
await cpg.getByLabel('Days on site').fill('1');
await cpg.getByLabel('Crew size').fill('2');
await cpg.getByLabel('Notes for the office (optional)').fill('Two extra bags for the knee walls');
await cpg.screenshot({ path: SHOTS + '16-crew-actuals.png', fullPage: true });
await cpg.getByRole('button', { name: 'Complete job' }).click();
await waitForDb(`select status from jobs where id = '${jobId}'`, 'completed', 'crew completed the job', 45000);
console.log('  actuals:', psql(`select count(*) || ' rows; ' || coalesce(sum(actual_hours), 0) || ' h' from job_actuals where job_id = '${jobId}'`));
check(psql(`select count(*) from job_actuals where job_id = '${jobId}' and area_id is null and actual_days = 1 and actual_crew_size = 2`) === '1', 'whole-job actuals synced');
await cpg.screenshot({ path: SHOTS + '17-crew-done.png', fullPage: true });
step('blower door: the crew lead saves the test-out on the job with no signal');
{
  await cpg.goto(BASE + `/crew?j=${jobId}`);
  await cpg.getByText('6,952 CFM50').waitFor({ timeout: 15000 });
  check(true, "the crew job page loads the estimator's test-in onto the phone before the tool is opened");
  await cpg.getByRole('link', { name: /blower door test/ }).click();
  await cpg.waitForURL(/\/field\/blower-door\?job=/);
  await cpg.getByTestId('bd-test_in-cfm50').filter({ hasText: '6,952' }).waitFor({ timeout: 15000 });
  check((await cpg.getByText(/by Eddie Estimator/).count()) === 1, "the crew sees the estimator's test-in, as recorded");
  check((await cpg.getByLabel('Air sealing price ($)').count()) === 0, 'a crew never types the air sealing price');
  // The program chosen with the test-in carries over to the crew's phone (BD-R2).
  await cpg.getByTestId('bd-program-from').waitFor();
  check(
    (await cpg.getByRole('radio', { name: 'Assisted' }).getAttribute('aria-checked')) === 'true' && (await cpg.getByTestId('bd-program-from').innerText()) === 'Chosen when the test-in was saved.',
    'the crew tool opens on the program the estimator saved with the test-in',
  );
  // The price the estimator saved never reaches the crew's phone (BD-R1).
  const crewContext = await cpg.evaluate(async (j) => (await fetch(`/api/blower-door/tests?job=${j}`)).json(), jobId);
  check(crewContext.tests.length === 1 && crewContext.tests.every((t) => t.air_sealing_cost === null), "the crew's copy of the readings carries no air sealing price");
  await cctx.setOffline(true);
  offlineStep = true;
  await cpg.getByLabel('Fan flow (CFM)').fill('3325');
  await cpg.getByLabel('House pressure (Pa)').fill('50.8');
  // The crew's phone has no price, so the tier amount is the most it pays (release review C DOC-4).
  check((await cpg.getByTestId('bd-badge').innerText()) === '40% TIER — UP TO $2,000 AIR SEAL REBATE', "the crew sees the tier with the saved test-in, under the test-in's program, as up to the tier amount");
  await cpg.getByRole('button', { name: 'Save test-out' }).click();
  await cpg.getByText('On this phone', { exact: true }).waitFor();
  check(psql(`select count(*) from blower_door_tests where job_id = '${jobId}'`) === '0', 'with no signal the test-out waits on the phone');
  await cpg.reload();
  await cpg.getByTestId('bd-test_out-cfm50').filter({ hasText: '3,291' }).waitFor({ timeout: 15000 });
  check((await cpg.getByText('On this phone', { exact: true }).count()) === 1, 'and is still there after a reload with no signal');
  await cpg.screenshot({ path: SHOTS + '17a-blower-door-job.png', fullPage: true });
  await cctx.setOffline(false);
  offlineStep = false;
  await cpg.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForDb(
    `select count(*) || ':' || min(cfm50) || ':' || min(pa) || ':' || min(estimate_id::text) from blower_door_tests where job_id = '${jobId}' and kind = 'test_out'`,
    `1:3290.87:50.80:${leeEstimate}`,
    'back online, the test-out syncs to the job (and its estimate)',
  );
  check(psql(`select program_key || ':' || (air_sealing_cost is null) from blower_door_tests where job_id = '${jobId}' and kind = 'test_out'`) === 'assisted:true', 'under the Assisted program, with no price from the crew');
  await cpg.locator('#bd-test_out').getByText('Saved to the job', { exact: true }).waitFor({ timeout: 15000 });
  check((await cpg.locator('#bd-test_in').getByText('Saved to the estimate', { exact: true }).count()) === 1, "the estimator's test-in says it is saved to the estimate");
  // Another sync (the crew app's own, and a reload) sends nothing twice.
  await cpg.goto(BASE + `/crew?j=${jobId}`);
  await cpg.getByText('6,952 CFM50').waitFor({ timeout: 15000 });
  await cpg.waitForTimeout(1500);
  check(psql(`select count(*) from blower_door_tests where estimate_id = '${leeEstimate}'`) === '2', 'no duplicate readings after more syncs');
  check(!/\$\s?\d/.test(await cpg.locator('body').innerText()), 'the crew job page still shows no prices');
}
await cpg.goto(BASE + '/field');
await cpg.getByRole('heading', { name: 'This page is for the owner, the office and estimators' }).waitFor();
check(new URL(cpg.url()).pathname === '/no-access', 'crew is kept out of the priced field app, and told whose page it is');
check(!/\$\s?\d/.test(await cpg.locator('body').innerText()), 'and sees no prices there');
await cpg.getByRole('link', { name: 'Go to Jobs' }).click();
await cpg.waitForURL(BASE + '/crew');

step('a phone an estimator used, then a crew member: offline, /field opens the crew app, not the priced field app');
{
  // BD-R4: the blower door tool is a shell every role opens; it must not count as "whose phone".
  const sctx = await browser.newContext(phone);
  await sctx.addCookies([sessionCookie(EST)]);
  const sp = await sctx.newPage();
  await sp.goto(BASE + '/field');
  await sp.getByRole('heading', { name: 'Estimates' }).waitFor();
  await sp.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
  await sp.waitForTimeout(2000);
  // The estimator's session ends without Sign out; a crew member signs in on the same phone.
  await sctx.clearCookies();
  await sctx.addCookies([sessionCookie(CREW)]);
  await sp.goto(BASE + '/crew');
  await sp.getByRole('heading', { name: 'Jobs' }).waitFor();
  await sp.goto(BASE + `/field/blower-door?job=${jobId}`);
  await sp.getByTestId('bd-test_in-cfm50').waitFor({ timeout: 15000 });
  await sp.waitForTimeout(1000);
  await sctx.setOffline(true);
  await sp.goto(BASE + '/field');
  await sp.getByRole('heading', { name: 'Jobs' }).waitFor({ timeout: 15000 });
  const offlineText = await sp.locator('body').innerText();
  check((await sp.getByRole('button', { name: 'New estimate', exact: true }).count()) === 0 && !/\$\s?\d/.test(offlineText), 'offline, the app opens the crew shell: no estimates, no prices');
  await sctx.close();
}

step('blower door: the office job page shows the readings, the tier and the ventilation check');
{
  await op.goto(BASE + '/jobs/' + jobId);
  await op.getByRole('heading', { name: 'Blower door test' }).waitFor();
  // Assisted's 40% tier is $2,000; the estimator's $1,999 price caps it at 75%, floored to whole
  // dollars (BD-MATH-1; release, OD4): $1,499 (was $1,499.25).
  check((await op.getByTestId('job-bd-badge').innerText()).includes('40% TIER — $1,499 AIR SEAL REBATE'), "the office sees the tier and rebate, capped by the estimator's price, in whole dollars");
  const figures = await op.getByRole('region', { name: 'Blower door figures' }).innerText();
  check(figures.includes('6,952 CFM50') && figures.includes('3,291 CFM50') && figures.includes('52.7%') && /Eddie Estimator/.test(figures) && /Carl Crew/.test(figures), 'both readings with who took them, and the reduction');
  check(figures.includes('(limited by 75% of $1,999)') && /Assisted/.test(figures), 'with the cap note and the program of each reading');
  check((await op.getByText('Energize Delaware Assisted Home Performance, as saved with the readings.').count()) === 1 && (await op.getByTestId('job-bd-mismatch').count()) === 0, 'the result is under the Assisted program both readings name');
  check((await op.getByTestId('job-bd-ventilation').innerText()).startsWith('Ventilation OK'), 'and the ventilation check from the house the estimator gave');
  await op.getByRole('heading', { name: 'Blower door test' }).scrollIntoViewIfNeeded();
  await op.screenshot({ path: SHOTS + '18a-job-blower-door.png', fullPage: true });
  // Release review C SEC-1: a crew member who crafts a test-out with an air sealing price cannot move
  // the cost cap the office sees: the price is not kept.
  const crafted = await cpg.evaluate(async (j) => {
    const res = await fetch('/api/blower-door/tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mutationId: crypto.randomUUID(),
        test: { id: crypto.randomUUID(), jobId: j, estimateId: null, kind: 'test_out', cfm: 3325, pa: 50.8, exponent: 0.65, cfm50: 3290.87, programKey: 'assisted', airSealingCost: 1000000, recordedAt: new Date().toISOString() },
      }),
    });
    return { status: res.status, body: await res.json() };
  }, jobId);
  check(crafted.status === 200 && crafted.body.status === 'applied', "a crew's crafted test-out with a price is saved as a reading");
  check(psql(`select count(*) from blower_door_tests where job_id = '${jobId}' and kind = 'test_out' and air_sealing_cost is not null`) === '0', 'without the price: a crew cannot set the air sealing price');
  await op.reload();
  await op.getByRole('heading', { name: 'Blower door test' }).waitFor();
  check(
    (await op.getByTestId('job-bd-badge').innerText()).includes('40% TIER — $1,499 AIR SEAL REBATE') &&
      (await op.getByRole('region', { name: 'Blower door figures' }).innerText()).includes('(limited by 75% of $1,999)'),
    "the office still sees the rebate capped by the estimator's price",
  );
}

step('office verifies the actuals');
await op.goto(BASE + '/jobs/' + jobId);
await op.screenshot({ path: SHOTS + '18-job-actuals.png', fullPage: true });
check((await op.getByRole('button', { name: 'Mark in progress' }).count()) === 1, 'a completed job not yet verified can still be moved back');
await op.getByRole('button', { name: 'Verify actuals' }).click();
await waitForDb(`select bool_and(verified_at is not null)::text from job_actuals where job_id = '${jobId}'`, 'true', 'all actuals verified');
// A verified job offers no status changes; the owner can Unverify (L37, RF-16).
await op.goto(BASE + '/jobs/' + jobId);
await op.getByRole('heading', { name: 'Status' }).waitFor();
check((await op.getByRole('button', { name: 'Mark in progress' }).count()) === 0 && (await op.getByRole('button', { name: 'Cancel job' }).count()) === 0, 'a verified job offers no status changes');
check((await op.getByText('Its actuals are verified, so the status stays as it is. To change it, Unverify the actuals below first.').count()) === 1, 'and the Status card says why');
check((await op.getByRole('button', { name: 'Unverify' }).count()) === 1, 'the owner can Unverify');
await op.screenshot({ path: SHOTS + '18b-job-verified.png', fullPage: true });
check(psql(`select count(*) from audit_log where table_name = 'job_actuals'`) !== '0', 'actuals changes are audited');

step('nightly learning run (cron)');
const unauth = await fetch(BASE + '/api/cron/nightly', { method: 'POST' });
check(unauth.status === 401, 'cron refuses a request without the secret');
const cron = await fetch(BASE + '/api/cron/nightly', { method: 'POST', headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
const summary = await cron.json();
console.log('  cron', cron.status, JSON.stringify(summary).slice(0, 600));
check(cron.status === 200, 'nightly run succeeded');
check(psql('select count(*) from learning_runs') !== '0', 'learning run recorded');

step('owner learning dashboard');
await op.goto(BASE + '/admin/learning');
await op.getByRole('heading', { name: 'Insights' }).waitFor();
await op.screenshot({ path: SHOTS + '19-learning.png', fullPage: true });
await op.getByRole('button', { name: 'Run learning now' }).click();
await op.getByRole('button', { name: 'Run learning now' }).waitFor({ timeout: 120000 });
await op.waitForTimeout(500);
await op.screenshot({ path: SHOTS + '20-learning-run.png', fullPage: true });
const runMsg = await op.locator('[aria-live="polite"]').allTextContents();
console.log('  run now:', runMsg.join(' | ').trim() || '(no message)');
await ep.goto(BASE + '/admin/learning');
console.log('  estimator on /admin/learning ends at:', new URL(ep.url()).pathname);
check(new URL(ep.url()).pathname !== '/admin/learning', 'estimators cannot open the learning dashboard');

step('office marks an estimate lost from its row menu');
{
  const lostId = psql("select e.id from estimates e join customers c on c.id = e.customer_id where c.last_name = 'Offline'");
  await op.goto(BASE + '/estimates');
  await op.getByRole('button', { name: 'More for Sam Offline' }).click();
  await op.getByRole('button', { name: 'Mark lost…' }).click();
  const sheet = op.getByRole('dialog', { name: 'Mark this estimate lost?' });
  await sheet.waitFor();
  check(psql(`select status from estimates where id = '${lostId}'`) !== 'lost', 'nothing changes until the confirm step');
  await sheet.getByLabel('Why was it lost?').fill('Went with a competitor');
  await sheet.getByRole('button', { name: 'Mark lost', exact: true }).click();
  await waitForDb(`select status || ':' || lost_reason from estimates where id = '${lostId}'`, 'lost:Went with a competitor', 'office marked the estimate lost from the row menu, with the reason');
  await op.getByRole('row', { name: /Sam Offline/ }).getByText('Lost: Went with a competitor').waitFor({ timeout: 15000 });
  check((await op.getByRole('button', { name: 'More for Sam Offline' }).count()) === 1 && (await op.getByRole('row', { name: /Sam Offline/ }).getByText('Lost', { exact: true }).count()) === 1, 'the row now says Lost');
  await op.screenshot({ path: SHOTS + '21-estimate-lost.png', fullPage: true });
}

step('review B screens: a first-open estimate, Better hidden with no pick, Sun+ placeholders, 48 px targets, /unreachable with no saved copy (flow-B13, B4, B6, B11, B9, B8)');
{
  const FIXB = SHOTS + 'fixb-';
  // Every visible control smaller than 48 x 48 px (the Daymark minimum, components/daymark/Button.tsx).
  const smallTargets = (p) =>
    p.evaluate(() =>
      [...document.querySelectorAll('a[href], button, select, [role=button], [role=switch], [role=radio]')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
        .filter(({ r }) => r.width < 48 || r.height < 48)
        .map(({ el, r }) => `${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)}`),
    );

  // flow-B13: a phone's first /field?new=1 runs before any bundle is on the phone.
  const fresh = await browser.newContext(phone);
  await fresh.addCookies([sessionCookie(EST)]);
  const fp = await fresh.newPage();
  fp.on('pageerror', (e) => logs.push('FIXB PAGEERROR ' + e.message));
  await fp.goto(BASE + '/field?new=1');
  await fp.getByLabel('City').waitFor({ timeout: 20000 });
  const town = [await fp.getByLabel('City').inputValue(), await fp.getByLabel('State').inputValue()];
  check(town[0] === 'Newark' && town[1] === 'DE', `a phone's first /field?new=1 starts in the shop address's town and state: "${town.join('", "')}" (was "", "")`);
  await fp.getByLabel('First name').fill('Rae');
  await fp.getByLabel('Last name').fill('Firstopen');
  await fp.getByLabel('Street address').fill('8 First Open Ln');
  await fp.getByLabel('ZIP').fill('19711');
  await fp.screenshot({ path: FIXB + 'b13-first-open-town.png' });
  await fp.getByRole('button', { name: 'Next' }).click();

  // flow-B6: in Sun+ an empty field's placeholder is grey and italic, never the black of typed text.
  await fp.getByRole('button', { name: '+ Attic' }).click();
  await fp.evaluate(() => document.documentElement.setAttribute('data-theme', 'sun'));
  const look = await fp.getByLabel('Square feet').evaluate((el) => {
    const ph = getComputedStyle(el, '::placeholder');
    return { text: getComputedStyle(el).color, placeholder: ph.color, italic: ph.fontStyle, shown: el.getAttribute('placeholder') };
  });
  check(look.text !== look.placeholder && look.italic === 'italic', `in Sun+ the empty Square feet's "${look.shown}" is ${look.placeholder} in italics, typed text ${look.text} (both rgb(0, 0, 0) before)`);
  await fp.screenshot({ path: FIXB + 'b6-sun-placeholders.png', fullPage: true });
  await fp.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  // flow-B11: "Use 1,200" under the mismatch sentence is a 48 px button.
  await fp.getByRole('button', { name: /Measure this area/ }).click();
  const msheet = fp.getByRole('dialog', { name: /Measure/ });
  await msheet.getByLabel('A · Width').fill('40');
  await msheet.getByLabel('B · Depth').fill('30');
  await msheet.getByRole('button', { name: 'Use 1,200 sq ft' }).click();
  await fp.getByLabel('Square feet').fill('1000');
  const use = fp.getByRole('button', { name: 'Use 1,200', exact: true });
  await use.waitFor();
  const ub = await use.boundingBox();
  check(ub && ub.width >= 48 && ub.height >= 48, `"Use 1,200" is ${Math.round(ub?.width ?? 0)}x${Math.round(ub?.height ?? 0)} px (was 71x21)`);
  const areaSmall = await smallTargets(fp);
  check(!areaSmall.some((t) => t.startsWith('Use 1,200 ')), 'the small-target scan at 390 px does not list "Use 1,200"');
  console.log('  other small targets on the Areas step:', areaSmall.join(' | ') || 'none');
  await use.scrollIntoViewIfNeeded();
  await fp.screenshot({ path: FIXB + 'b11-use-measured.png' });
  await use.click();
  check((await fp.getByLabel('Square feet').inputValue()) === '1200', '"Use 1,200" puts the measured size back');

  // flow-B4 (OD15): no pick, Better priced above Best so it is not shown: Best is recommended, not Good.
  await fp.getByRole('button', { name: 'Next' }).click();
  const better = fp.getByRole('group', { name: 'Better option' });
  await better.getByRole('button', { name: 'Change price' }).click();
  await better.getByLabel('Customer price').fill('99999');
  await better.getByLabel('Reason (required)').fill('Checking the recommendation when Better is hidden');
  await better.getByRole('button', { name: 'Apply', exact: true }).click();
  await better.getByText('Not shown to the customer', { exact: true }).waitFor();
  const best = fp.getByRole('group', { name: 'Best option' });
  check((await best.getByRole('button', { name: 'Recommended (default)' }).count()) === 1, 'with no pick and Better not shown, Best is the default recommendation (was Good, the cheapest)');
  check((await fp.getByRole('group', { name: 'Good option' }).getByRole('button', { name: 'Make recommended' }).count()) === 1, 'and Good is not');
  const dock = await fp.getByRole('region', { name: 'Estimate actions' }).innerText();
  const bestPrice = (await best.locator('p.text-2xl').first().innerText()).trim();
  check(dock.includes(bestPrice) && /best/i.test(dock), `the dock's headline is Best's ${bestPrice}: "${dock.replace(/\s+/g, ' ').slice(0, 60)}"`);
  await fp.screenshot({ path: FIXB + 'b4-best-recommended.png', fullPage: true });
  await fresh.close();

  // Release review C FLOW-8, FLOW-11, FLOW-12 at 390 px: a five-digit price keeps the option's name
  // whole in the dock, an area's header is a 48 px target, and a package's option cards say which
  // area each line prices, as the customer's quote does.
  {
    const rc = await browser.newContext(phone);
    await rc.addCookies([sessionCookie(EST)]);
    const rp = await rc.newPage();
    rp.on('pageerror', (e) => logs.push('REVIEWC PAGEERROR ' + e.message));
    await rp.goto(BASE + '/field?new=1');
    await rp.getByLabel('City').waitFor({ timeout: 20000 });
    await rp.getByLabel('First name').fill('Dee');
    await rp.getByLabel('Last name').fill('Dockwidth');
    await rp.getByLabel('Street address').fill('5 Wide Price Way');
    await rp.getByLabel('ZIP').fill('19711');
    await rp.getByRole('button', { name: 'Next' }).click();
    await rp.getByRole('button', { name: '+ Attic' }).click();
    await rp.getByLabel('Square feet').fill('6000');
    await rp.getByRole('button', { name: '+ Walls' }).click();
    await rp.getByLabel('Square feet').fill('800');
    const dockTier = async () => {
      const dock = rp.getByRole('region', { name: 'Estimate actions' });
      await dock.getByText(/^\$\d{2},\d{3}$/).first().waitFor({ timeout: 15000 });
      const tier = dock.getByText(/^(Good|Better|Best)$/i).first();
      return { text: (await dock.innerText()).replace(/\s+/g, ' '), fits: await tier.evaluate((el) => el.scrollWidth <= el.clientWidth), size: await tier.evaluate((el) => `${el.scrollWidth}/${el.clientWidth}`) };
    };
    const onAreas = await dockTier();
    check(onAreas.fits && /BETTER/i.test(onAreas.text), `on Areas the dock shows the recommended option's name whole with a five-digit price: "${onAreas.text}" (scroll/client ${onAreas.size}; 59/54 "BETT…" before)`);
    const small = await smallTargets(rp);
    check(!small.some((t) => t.startsWith('Exterior walls')), `the walls area's header is a 48 px target (322x45 before): ${small.filter((t) => t.startsWith('Exterior walls')).join(' | ') || 'not listed'}`);
    await rp.screenshot({ path: SHOTS + 'rc-areas-390.png', fullPage: true });
    await rp.getByRole('button', { name: 'Next' }).click();
    const good = rp.getByRole('group', { name: 'Good option' });
    await good.waitFor({ timeout: 15000 });
    const onOptions = await dockTier();
    check(onOptions.fits && /BETTER/i.test(onOptions.text), `and on Options: "${onOptions.text}" (scroll/client ${onOptions.size})`);
    const lines = await good.getByRole('list', { name: 'What the price is made of' }).getByRole('listitem').allInnerTexts();
    check(
      lines.some((l) => /^attic\b/i.test(l.trim())) && lines.some((l) => /^exterior walls\b/i.test(l.trim())),
      `the Good card names the area of each line, as the quote does: ${lines.map((l) => l.replace(/\s+/g, ' ').trim()).join(' | ')}`,
    );
    await rp.screenshot({ path: SHOTS + 'rc-options-390.png', fullPage: true });
    await rc.close();
  }

  // flow-B11: the estimator's email link on the customer's quote page.
  const cq = await browser.newContext(phone);
  const cqp = await cq.newPage();
  await cqp.goto(link);
  const contact = cqp.getByRole('region', { name: 'Questions about this quote?' }).first();
  await contact.waitFor({ timeout: 15000 });
  const mail = contact.locator('a[href^="mailto:"]').filter({ hasText: '@' }).first();
  if ((await mail.count()) === 1) {
    const mb = await mail.boundingBox();
    check(mb && mb.height >= 48, `the estimator's email link on the quote is ${Math.round(mb?.width ?? 0)}x${Math.round(mb?.height ?? 0)} px (was 100x20)`);
  } else check(false, "the customer's quote shows the estimator's email link");
  const quoteSmall = await smallTargets(cqp);
  console.log('  other small targets on the customer quote:', quoteSmall.join(' | ') || 'none');
  await contact.scrollIntoViewIfNeeded();
  await cqp.screenshot({ path: FIXB + 'b11-quote-contact.png' });
  await cq.close();

  // flow-B9: the refusal says how far the cost is from the nearest edge (office screen, 1280).
  const pc = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await pc.addCookies([sessionCookie(OWNER)]);
  const pp = await pc.newPage();
  await pp.goto(BASE + '/admin/pricing');
  const pcost = pp.getByLabel(/cost per unit/i).first();
  const pform = pcost.locator('xpath=ancestor::form[1]');
  const ocsfNow = psql("select m.cost_per_unit from materials m join products p on p.id = m.product_id where p.code = 'ocsf' and m.is_default");
  await pcost.fill('0.30');
  await pform.getByRole('button', { name: /save/i }).click();
  await pform.getByText(/Not saved\. \$0\.30 per board ft is 25% above the usual high of \$0\.24\. The usual range is \$0\.06 to \$0\.24/).waitFor({ timeout: 15000 });
  check(psql("select m.cost_per_unit from materials m join products p on p.id = m.product_id where p.code = 'ocsf' and m.is_default") === ocsfNow, '$0.30 is "25% above the usual high of $0.24" (was "2.0 times more than the usual"), and not saved');
  await pform.scrollIntoViewIfNeeded();
  await pp.screenshot({ path: FIXB + 'b9-cost-from-the-edge.png' });
  await pc.close();

  // flow-B8: with Koala unreachable, /unreachable offers the phone's copy only when the phone has one.
  const rest = (down) => fetch(`http://localhost:${process.env.MOCK_PORT}/__e2e/rest`, { method: 'POST', body: JSON.stringify({ down }) });
  unreachableStep = true;
  await rest(true);
  const none = await browser.newContext(phone);
  await none.addCookies([sessionCookie(EST)]);
  const np = await none.newPage();
  await np.goto(BASE + '/unreachable?next=%2Ffield');
  await np.getByText('This phone has no saved copy of the app yet; it needs Koala once.').waitFor({ timeout: 15000 });
  check((await np.getByRole('link', { name: 'Open the estimates on this phone' }).count()) === 0, 'a phone with no saved copy is not offered "Open the estimates on this phone" (it led back to /unreachable: count 1 before)');
  await np.screenshot({ path: FIXB + 'b8-unreachable-no-copy.png' });
  await none.close();
  const own = await ctx.newPage();
  await own.goto(BASE + '/unreachable?next=%2Ffield');
  await own.getByRole('link', { name: 'Open the estimates on this phone' }).waitFor({ timeout: 15000 });
  check((await own.getByText('This phone has no saved copy').count()) === 0, 'the phone that has its copy is offered it');
  await own.screenshot({ path: FIXB + 'b8-unreachable-with-copy.png' });
  await own.close();
  await rest(false);
  unreachableStep = false;
}

step('owner edits the rebate programs');
{
  await op.goto(BASE + '/admin/rebates');
  await op.getByRole('heading', { name: 'Rebate programs' }).waitFor();
  check((await op.getByRole('switch', { name: /Decide on whole-number CFM50/ }).getAttribute('aria-checked')) === 'false', 'the tool decides on the exact CFM50 until the owner says otherwise');
  const hp = op.getByRole('region', { name: 'Program: Home Performance' });
  const rebates = hp.getByLabel('Rebate ($, whole dollars)');
  await rebates.nth(0).fill('900.50');
  await op.getByText("Program 1: a tier's rebate must be whole dollars (no cents).").waitFor();
  await rebates.nth(0).fill('950');
  await hp.getByLabel('Reduction (%)').nth(1).fill('15');
  await op.getByText('Program 1: tiers must go up in reduction, lowest first (20% then 15%).').waitFor();
  await op.getByRole('button', { name: 'Save rebate programs' }).click();
  await op.getByText(/tiers must go up in reduction/).nth(1).waitFor();
  check(psql("select value->'programs'->0->'tiers'->0->>'rebate' from app_settings where key = 'blower_door'") === '900', 'a change that breaks a rule is refused and nothing is saved');
  await hp.getByLabel('Reduction (%)').nth(1).fill('30');
  await op.getByRole('button', { name: 'Save rebate programs' }).click();
  await op.getByText('Saved 2 programs. Phones get them the next time they sync.').waitFor({ timeout: 15000 });
  check(psql("select value->'programs'->0->'tiers'->0->>'rebate' from app_settings where key = 'blower_door'") === '950', 'the owner saves a new tier amount');
  check(psql("select count(*) from audit_log where table_name = 'app_settings' and row_id = 'blower_door' and actor_id = '11111111-1111-4111-8111-111111111111'") !== '0', 'and the change is audited with who made it');
  await op.screenshot({ path: SHOTS + '22-rebate-programs.png', fullPage: true });
  // Back to the seeded amount, for anyone looking at the stack afterwards.
  await rebates.nth(0).fill('900');
  await op.getByRole('button', { name: 'Save rebate programs' }).click();
  await waitForDb("select value->'programs'->0->'tiers'->0->>'rebate' from app_settings where key = 'blower_door'", '900', 'and puts the seeded amount back');
  // Release, review B flow-B10: saving while Koala's database is down says so.
  {
    const rest = (down) => fetch(`http://localhost:${process.env.MOCK_PORT}/__e2e/rest`, { method: 'POST', body: JSON.stringify({ down }) });
    await op.getByText('Saved 2 programs. Phones get them the next time they sync.').waitFor({ timeout: 15000 });
    unreachableStep = true;
    await rest(true);
    await rebates.nth(0).fill('925');
    await op.getByRole('button', { name: 'Save rebate programs' }).click();
    await op.getByText("Can't reach Koala right now. Nothing was saved.").first().waitFor({ timeout: 20000 });
    check(
      (await op.getByText('Only the owner can change the rebate programs.').count()) === 0,
      "saving the rebate programs while Koala is down says \"Can't reach Koala right now. Nothing was saved.\", not \"Only the owner can change the rebate programs.\"",
    );
    await op.screenshot({ path: SHOTS + '22b-rebates-unreachable.png' });
    await rest(false);
    unreachableStep = false;
    check(psql("select value->'programs'->0->'tiers'->0->>'rebate' from app_settings where key = 'blower_door'") === '900', 'and nothing was saved');
  }
}

console.log('console errors:', logs.length ? logs : 'none');
await browser.close();
