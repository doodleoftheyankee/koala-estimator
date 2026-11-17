// End-to-end (local only): estimator builds an estimate on a phone (with a line changed from the
// model and the deviation explained), sends it, customer signs; then the offline flow; owner and
// estimator access; then Phase 2: the office schedules the job, the crew starts it, enters actuals
// and completes it on a phone, the office verifies, the nightly learning run, the learning dashboard.
// Run via scripts/e2e.sh. Needs the `playwright` package resolvable (NODE_PATH or local install).
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)('playwright');
import { sign } from './jwt.mjs';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:3000';
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
const page = await ctx.newPage();
const logs = [];
let roofNotFoundStep = false; // the lookup of an unknown address answers 404 on purpose
page.on('console', (m) => m.type() === 'error' && !(roofNotFoundStep && m.location().url.endsWith('/api/roof')) && logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
const step = (s) => console.log('•', s);

step('open /field');
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor();
await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready, null, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOTS + '01-list.png' });

step('create estimate');
await page.getByRole('button', { name: '+ New estimate' }).click();
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

step('AI photo read');
await page.getByRole('button', { name: /Read this photo/ }).click();
await page.getByText('✨ Photo read').waitFor({ timeout: 60000 });
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
await page.getByRole('button', { name: 'Recommend this' }).nth(1).click();
await page.waitForTimeout(800);
await page.screenshot({ path: SHOTS + '04-options.png', fullPage: true });
const prices = await page.locator('p.text-2xl').allTextContents();
console.log('  prices', prices);
const num = (t) => Number(t.replace(/[^0-9.]/g, ''));

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

step('send');
await page.getByRole('button', { name: 'Next' }).click();
await page.waitForTimeout(3500); // let auto-sync run
await page.screenshot({ path: SHOTS + '05a-send-step.png', fullPage: true });
console.log('  send checklist:', (await page.locator('body').innerText()).split('\n').filter((l) => l.trim()).slice(0, 40).join(' | '));
await page.getByRole('button', { name: /Send quote to customer/ }).click();
await page.getByText(/Quote v1 sent/).waitFor({ timeout: 30000 });
const link = await page.locator('a[href*="/q/"]').first().getAttribute('href');
const estId = psql("select id from estimates order by created_at desc limit 1");
await waitForDb(`select count(*) from photos where estimate_id = '${estId}' and uploaded_at is not null and area_id is not null`, '1', 'area photo uploaded after the estimate synced, linked to its area');
check(psql(`select client_doc->'measurements' ? (select id::text from estimate_areas where estimate_id = '${estId}' limit 1) from estimates where id = '${estId}'`) === 't', 'measurement saved with the estimate on the server');
const photoList = await page.evaluate((id) => fetch('/api/photos?estimateId=' + id).then((r) => r.json()), estId);
check(photoList.photos?.length === 1 && photoList.photos[0].url.includes('/object/sign/photos/'), 'photo list returns a signed link');
await page.screenshot({ path: SHOTS + '05-sent.png', fullPage: true });
console.log('  link', link);

step('customer signs');
const cust = await browser.newContext(phone);
const cp = await cust.newPage();
cp.on('pageerror', (e) => logs.push('CUSTOMER PAGEERROR ' + e.message));
await cp.goto(link);
await cp.screenshot({ path: SHOTS + '06-customer-quote.png', fullPage: true });
await cp.getByLabel(/full name/i).fill('Pat Lee');
const canvas = cp.locator('canvas');
await canvas.scrollIntoViewIfNeeded();
const box = await canvas.boundingBox();
await cp.mouse.move(box.x + 20, box.y + box.height / 2);
await cp.mouse.down();
for (let i = 1; i <= 12; i++) await cp.mouse.move(box.x + 20 + i * 20, box.y + box.height / 2 + (i % 2 ? -15 : 15));
await cp.mouse.up();
await cp.getByRole('checkbox').check();
await cp.getByRole('button', { name: /sign/i }).last().click();
await cp.getByText(/thank you|signed/i).first().waitFor({ timeout: 30000 });
await cp.screenshot({ path: SHOTS + '07-signed.png', fullPage: true });

step('db checks after signing');
check(psql("select count(*) from estimate_lines where is_overridden and override_reason like 'Low clearance%'") !== '0', 'overridden line synced with its reason');
check(psql("select count(*) from deviation_flags where ack_note like 'Knee walls%'") !== '0', 'deviation flag stored with the explanation');
check(psql("select count(*) from jobs") === '1', 'signing created a job');
console.log('  estimate:', psql("select status, selected_tier from estimates"));
console.log('  quote:', psql("select version, status, signed_tier, signed_price, signer_name, signed_pdf_path is not null from quotes"));
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
await page.getByRole('button', { name: '+ New estimate' }).click();
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
const roof = page.getByRole('dialog', { name: /Satellite lookup/ });
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
  /Attic floor \(blown-in\)\s*1,970\s*sq ft/.test(roofText) && /Roof deck \(spray foam under the roof\)\s*2,170\s*sq ft/.test(roofText),
  'attic floor 1,970 and roof deck 2,170 sq ft at a 12" overhang, porch left out',
);
check((await roof.getByRole('radio', { name: /Attic floor/ }).getAttribute('aria-checked')) === 'true', 'an attic measured on the floor starts on the attic floor');
check(roofText.includes('Top-floor ceiling seen from above. Finished attic rooms, cathedral ceilings and knee walls need measuring on site.'), 'says the attic floor is one level');
check(/Whole roof incl\. overhangs:\s*2,560 sq ft/.test(roofText) && !/ROOF SURFACE/i.test(roofText), 'the whole roof with overhangs is only an info line');
check(/Main pitch:\s*6\/12/.test(roofText) && /Roof outline \(to the drip edge\):\s*2,340 sq ft/.test(roofText) && /Wall run:\s*184 ft/.test(roofText), 'main pitch, roof outline and wall run (porch walls left out)');
check((await roof.getByText("Google placed this address roughly, so the outline may be on a neighbour's house. Check it on the photo below.").count()) === 1, 'warns when Google placed the address roughly');
check((await roof.getByText('Lower-detail imagery. Check the pitch on site.').count()) === 1, "Roof Takeoff's warnings are listed");
const warnBox = await roof.getByRole('heading', { name: 'Check on site' }).boundingBox();
const facesBox = await roof.getByRole('heading', { name: 'Roof faces' }).boundingBox();
check(warnBox && facesBox && warnBox.y < facesBox.y && warnBox.y + warnBox.height < 844, 'the things to check sit under the numbers, above the faces, on the first screen');
check((await roof.getByText('12 Elkton Rd, Newark, DE 19711, USA').count()) === 1 && (await roof.getByText('Aerial photo from Jun 2023').count()) === 1, "shows the address Google matched and the photo's month");
check((await roof.getByText('Good photo', { exact: true }).count()) === 1, 'a medium-detail photo is a "Good photo"');
check((await roof.getByRole('switch', { name: 'Face 5: over the attic' }).getAttribute('aria-checked')) === 'false', 'the porch starts left out (Roof Takeoff’s choice)');
check((await roof.getByText('Lower roof: garage, porch or addition?').count()) === 3, 'lower roofs (garage and porch) are pointed out');
const useFloor = roof.getByRole('button', { name: 'Use 1,970 sq ft' });
check(await useFloor.isDisabled(), 'Use waits until the estimator checks the house (Google placed it roughly)');
check((await roof.getByText('Check the house on the photo first: tap “Yes, this is the house”.').count()) === 1, 'and says so');
check((await roof.getByRole('link', { name: 'Open the Roof Takeoff site ↗' }).getAttribute('href')) === 'http://localhost:54321/?address=12%20Elkton%20Rd%2C%20Newark%2C%20DE%2019711', 'links to the Roof Takeoff site for the address');
check((await roof.getByText('A separate site with the roof edges for roofing. It fills in this address; it looks the house up again only if you press Look up there.').count()) === 1, 'and says it is a separate site that looks up only on Look up');
await page.screenshot({ path: SHOTS + '03e-roof-result.png' });
await page.setViewportSize({ width: 390, height: 2600 });
await page.screenshot({ path: SHOTS + '03f-roof-result-full.png' });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: SHOTS + '03g-roof-result-dark.png' });
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize(phone.viewport);
await roof.getByRole('button', { name: 'Yes, this is the house' }).click();
check(!(await useFloor.isDisabled()), 'Use works once the estimator says it is the house');
check((await roof.getByText(/Google placed this address roughly/).count()) === 0, 'and the rough-placement warning goes');
await roof.getByRole('radio', { name: /Roof deck/ }).click();
check(!(await roof.getByRole('button', { name: 'Use 2,170 sq ft' }).isDisabled()), 'choosing the roof deck: Use 2,170 sq ft');
await roof.getByRole('radio', { name: '18"' }).click();
await roof.getByRole('switch', { name: 'Face 3: over the attic' }).click();
await roof.getByRole('switch', { name: 'Face 4: over the attic' }).click();
const choiceText = await roof.innerText();
check(/Attic floor \(blown-in\)\s*1,370/.test(choiceText) && /Roof deck \(spray foam under the roof\)\s*1,530/.test(choiceText), 'an 18" overhang with the garage left out: attic floor 1,370, roof deck 1,530');
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
  /Attic floor \(blown-in\)\s*1,370/.test(await roof.innerText()) &&
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
check(/WALL RUN\s*108\s*ft/i.test(await roof.innerText()), 'walls show the wall run without the garage and porch: 108 ft');
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

step('satellite: a garage starts with every face off');
await page.getByRole('button', { name: '+ Garage' }).click();
await page.getByRole('button', { name: /Look up from the address/ }).click();
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 5000 });
check(roofCalls().length === paidOnce, 'still no second paid lookup');
const garageSwitches = await roof.getByRole('switch', { name: /: part of the garage$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')));
check(garageSwitches.length === 5 && garageSwitches.every((v) => v === 'false'), 'every face starts off for a garage');
check(/GARAGE CEILING\s*—/i.test(await roof.innerText()) && (await roof.getByText("Turn on the garage's roof faces.").count()) >= 1, "the garage ceiling waits: Turn on the garage's roof faces.");
check(await roof.getByRole('button', { name: 'Use', exact: true }).isDisabled(), 'nothing to use yet');
await page.screenshot({ path: SHOTS + '03k-roof-garage-empty.png' });
await roof.getByRole('switch', { name: 'Face 3: part of the garage' }).click();
await roof.getByRole('switch', { name: 'Face 4: part of the garage' }).click();
check(/GARAGE CEILING\s*490\s*sq ft/i.test(await roof.innerText()), 'garage ceiling from the two garage faces at 18": 490 sq ft');
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
await roof.getByRole('button', { name: 'Wrong house? Tap the right roof' }).click();
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
check((await roof.getByText('Is the yellow outline on the roof you tapped?').count()) === 1, 'and asks about the tapped roof');
await page.screenshot({ path: SHOTS + '03n-roof-wrong-house-result.png' });
await roof.getByRole('button', { name: 'Yes, this is the house' }).click();
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
check((await roof.getByRole('button', { name: 'Try again' }).count()) === 1, 'with Try again');
check((await roof.locator('[role=status] [role=alert], [role=alert] [role=status]').count()) === 0, 'the alert is not inside the status line');
await page.screenshot({ path: SHOTS + '03j-roof-not-found.png' });
await roof.getByRole('button', { name: 'Close' }).click();
await waitForDb(`select count(*) from roof_lookups where created_by = '${EST.id}' and status = 'failed' and error like 'not_found:%'`, '1', 'the failed lookup is logged with its reason');
await lookUpAddress('5 No Roof Ln');
await roof.getByRole('alert').waitFor({ timeout: 30000 });
check((await roof.getByRole('alert').innerText()).trim() === 'Google has no roof data for this house. Measure it with 📐 Measure this area.', "no roof data, in this app's words (no image to tap, no photo steps)");
await roof.getByRole('button', { name: 'Close' }).click();
roofNotFoundStep = false;
await lookUpAddress('7 Old Rd');
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
const v1Text = await roof.innerText();
check(/Attic floor \(blown-in\)\s*1,970/.test(v1Text) && /Wall run:\s*220 ft/.test(v1Text), 'an older (v1) Roof Takeoff answer still works: attic floor 1,970, wall run 220 ft');
check((await roof.getByText('Lower roof: garage, porch or addition?').count()) === 0, 'with no lower-roof hints');
await roof.getByRole('button', { name: 'Close' }).click();
await lookUpAddress('9 Carport Ct');
await roof.getByRole('heading', { name: 'Roof faces' }).waitFor({ timeout: 30000 });
check((await roof.getByRole('switch', { name: 'Parts with no roof data: over the attic' }).getAttribute('aria-checked')) === 'true', 'parts with no roof data are offered, and start on');
check((await roof.getByText('Parts with no roof data (270 sq ft)').count()) === 1, 'with their size');
const withCarport = await roof.getByRole('radio', { name: /Attic floor/ }).innerText();
await roof.getByRole('switch', { name: 'Parts with no roof data: over the attic' }).click();
check((await roof.getByRole('radio', { name: /Attic floor/ }).innerText()) !== withCarport, 'turning them off changes the attic floor');
await roof.getByRole('switch', { name: 'Parts with no roof data: over the attic' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + '03o-roof-carport.png' });
await roof.getByRole('button', { name: 'Close' }).click();

step('offline estimate');
await page.goto(BASE + '/field');
await page.getByRole('heading', { name: 'Estimates' }).waitFor();
await ctx.setOffline(true);
await page.reload();
await page.getByRole('heading', { name: 'Estimates' }).waitFor({ timeout: 15000 });
await page.getByText(/Offline/).first().waitFor();
await page.getByRole('button', { name: '+ New estimate' }).click();
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
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(6000);
console.log('  db after reconnect:', psql("select count(*) || ' estimates; ' || string_agg(c.last_name || ':' || e.priced_offline, ',') from estimates e join customers c on c.id=e.customer_id"));
await page.screenshot({ path: SHOTS + '10-synced-list.png' });

step('owner screens');
const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@koala.test' };
const octx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await octx.addCookies([sessionCookie(OWNER)]);
const op = await octx.newPage();
op.on('pageerror', (e) => logs.push('OWNER PAGEERROR ' + e.message));
await op.goto(BASE + '/estimates');
await op.screenshot({ path: SHOTS + '11-estimates.png', fullPage: true });
console.log('  estimates rows mention Lee/Offline:', (await op.content()).includes('Lee'), (await op.content()).includes('Offline'));
await op.goto(BASE + '/admin/pricing');
await op.screenshot({ path: SHOTS + '12-pricing.png', fullPage: true });
const cost = op.getByLabel(/cost per unit/i).first();
await cost.fill('15.25');
await cost.press('Tab');
const form = cost.locator('xpath=ancestor::form[1]');
await form.getByRole('button', { name: /save/i }).click();
await op.getByText(/Saved/).first().waitFor({ timeout: 15000 });
console.log('  material audit:', psql("select count(*) from audit_log where table_name='materials' and action='UPDATE' and actor_id='11111111-1111-4111-8111-111111111111'"));
// A change that would break pricing must be refused and rolled back.
await op.goto(BASE + '/admin/team');
await op.screenshot({ path: SHOTS + '13-team.png', fullPage: true });
const est = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await est.addCookies([sessionCookie(EST)]);
const ep = await est.newPage();
await ep.goto(BASE + '/admin/pricing');
console.log('  estimator on /admin/pricing ends at:', new URL(ep.url()).pathname);


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

step('crew starts the job on a phone');
const cctx = await browser.newContext(phone);
await cctx.addCookies([sessionCookie(CREW)]);
const cpg = await cctx.newPage();
cpg.on('console', (m) => m.type() === 'error' && logs.push('CREW ' + m.text()));
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
await cpg.goto(BASE + '/field');
check(new URL(cpg.url()).pathname === '/crew', 'crew is kept out of the priced field app');

step('office verifies the actuals');
await op.goto(BASE + '/jobs/' + jobId);
await op.screenshot({ path: SHOTS + '18-job-actuals.png', fullPage: true });
await op.getByRole('button', { name: 'Verify actuals' }).click();
await waitForDb(`select bool_and(verified_at is not null)::text from job_actuals where job_id = '${jobId}'`, 'true', 'all actuals verified');
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
await op.getByRole('heading', { name: 'Learning' }).waitFor();
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

console.log('console errors:', logs.length ? logs : 'none');
await browser.close();
