// End-to-end (local only): estimator builds an estimate on a phone, sends it, customer signs; then offline flow.
// Run via scripts/e2e.sh. Needs the `playwright` package resolvable (NODE_PATH or local install).
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)('playwright');
import { sign } from './jwt.mjs';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:3000';
const SHOTS = process.env.E2E_SHOTS ?? new URL('./shots/', import.meta.url).pathname;
execSync(`mkdir -p ${SHOTS}`);
const psql = (sql) => execSync(`psql "${process.env.E2E_DB_URL}" -tA -c "${sql.replace(/"/g, '\\"')}"`).toString().trim();

function sessionCookie(user) {
  const access = sign({ sub: user.id, role: 'authenticated', email: user.email, aud: 'authenticated' });
  const session = { access_token: access, refresh_token: 'r', token_type: 'bearer', expires_in: 2592000, expires_at: Math.floor(Date.now() / 1000) + 2592000, user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } };
  return { name: 'sb-localhost-auth-token', value: 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'), domain: 'localhost', path: '/', httpOnly: false, sameSite: 'Lax' };
}
const EST = { id: '22222222-2222-4222-8222-222222222222', email: 'est@koala.test' };

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

step('send');
await page.getByRole('button', { name: 'Next' }).click();
await page.waitForTimeout(3500); // let auto-sync run
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

console.log('console errors:', logs.length ? logs : 'none');
await browser.close();
