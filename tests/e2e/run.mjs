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
page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
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

step('add attic area');
await page.getByRole('button', { name: '+ Attic' }).click();
await page.getByLabel('Square feet').fill('1200');
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
