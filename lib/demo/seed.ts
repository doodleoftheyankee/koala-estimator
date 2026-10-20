// Demo history for showing the app: ~9 months of estimates priced with the real engine, quotes
// won and lost, finished jobs with verified crew actuals (so learning and win rates have data),
// this week's crew schedule and an open pipeline. Produces SQL batches (run by app/api/demo/seed
// through a temporary database function, or by scripts/demo-seed.ts). Deterministic for a seed.
import { priceEstimate, type PricedEstimate, type PricingBundle, type Tier } from '@/lib/pricing';
import { buildQuoteDocument } from '@/lib/quotes/model';
import { newArea, newDraft, priceableAreas, toEstimateInput, type AreaDraft, type EstimateDraft } from '@/lib/sync/draft';
import { buildSyncPayload } from '@/lib/sync/payload';
import { DEMO_USER_IDS as DEMO } from './accounts';

export function buildDemoSeed(args: { bundle: PricingBundle; settings: Array<{ key: string; value: unknown }>; now: Date }): { batches: string[]; summary: string } {
  const { bundle } = args;
  const NOW = args.now;
  const setting = (k: string) => args.settings.find((s) => s.key === k)?.value;
  let seed = 20261020;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const between = (a: number, b: number) => a + rand() * (b - a);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let idn = 0;
  const uuid = () => `de000000-0000-4000-8000-${(++idn).toString(16).padStart(12, '0')}`;

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'David', 'Jennifer', 'William', 'Susan', 'Joseph', 'Karen', 'Thomas', 'Nancy', 'Daniel', 'Lisa', 'Mark', 'Betty', 'Paul', 'Sandra', 'Kevin', 'Donna', 'Brian', 'Carol', 'George', 'Michelle', 'Ed', 'Amanda', 'Ron', 'Melissa'];
const LAST = ['Smith', 'Johnson', 'Brown', 'Miller', 'Davis', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia', 'Martinez', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Carter'];
const STREETS = ['Elkton Rd', 'Main St', 'Paper Mill Rd', 'Kirkwood Hwy', 'Polly Drummond Hill Rd', 'Capitol Trl', 'Chestnut Hill Rd', 'Old Baltimore Pike', 'Possum Park Rd', 'Barksdale Rd', 'Red Mill Rd', 'Salem Church Rd', 'Pike Creek Rd', 'Limestone Rd', 'Delaware Ave'];
const TOWNS: Array<[string, string, number]> = [['Newark', '19711', 12], ['Newark', '19702', 16], ['Bear', '19701', 22], ['Hockessin', '19707', 25], ['Wilmington', '19808', 28], ['Middletown', '19709', 35]];
const SOURCES = ['Website', 'Google Local Services', 'Referral', 'Energize Delaware', 'Angi / HomeAdvisor', 'Facebook'];
const LOST_REASONS = ['Price too high', 'Went with another contractor', 'Decided to wait', 'No response after follow-ups', 'Financing not available'];

// What jobs really take (the "truth" the learning loop should discover; the seed coefficients are
// starting guesses). Cellulose uses more bags and less time per bag than assumed, difficult
// attics take longer, and drives run ~20% over the map estimate.
const TRUE_WASTE: Record<string, number> = { cellulose: 1.16, fiberglass_blown: 1.1, batts: 1.04, ocsf: 1.33, ccsf: 1.19 };
const TRUE_RATE: Record<string, number> = { cellulose: 0.13, fiberglass_blown: 0.14, batts: 0.016, ocsf: 0.0045, ccsf: 0.0066, air_sealing: 0.0055 };
const TRUE_SETUP: Record<string, number> = { cellulose: 2.5, fiberglass_blown: 2, batts: 1, ocsf: 3, ccsf: 3, air_sealing: 0.5, removal: 1 };
const TRUE_ACCESS: Record<string, number> = { easy: 1, moderate: 1.18, difficult: 1.48, extreme: 1.7 };
const TRUE_REMOVAL = 0.022;
const TRUE_DRIVE = 1.22;

const q = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const s = (v: string | null) => (v === null ? 'null' : `'${v.replace(/'/g, "''")}'`);
const ts = (d: Date) => `'${d.toISOString()}'::timestamptz`;
const DAY = 86_400_000;

function makeAreas(): AreaDraft[] {
  const r = rand();
  const areas: AreaDraft[] = [];
  const attic = () => {
    const a = newArea('attic', uuid);
    a.name = pick(['Main attic', 'Attic', 'Attic over garage']);
    a.sqft = Math.round(between(700, 1900) / 10) * 10;
    a.currentR = pick([0, 11, 13, 19, 19, 22, 30]);
    a.existingMaterial = a.currentR ? pick(['fiberglass batts', 'blown fiberglass', 'cellulose']) : null;
    a.accessLevel = pick(['easy', 'moderate', 'moderate', 'difficult', 'difficult', 'extreme']);
    return a;
  };
  if (r < 0.62) areas.push(attic());
  else if (r < 0.75) {
    const c = newArea('crawlspace', uuid);
    c.sqft = Math.round(between(500, 1300) / 10) * 10;
    c.accessLevel = pick(['moderate', 'difficult', 'extreme']);
    areas.push(c);
  } else if (r < 0.88) {
    const w = newArea('rim_joist', uuid);
    w.sqft = Math.round(between(120, 260));
    w.accessLevel = pick(['easy', 'moderate']);
    areas.push(w);
  } else {
    areas.push(attic());
    const c = newArea('rim_joist', uuid);
    c.sqft = Math.round(between(120, 240));
    c.accessLevel = 'moderate';
    areas.push(c);
  }
  return areas;
}

interface Planned {
  draft: EstimateDraft;
  priced: PricedEstimate;
  createdAt: Date;
  source: string;
  outcome: 'won' | 'lost' | 'open' | 'draft';
  signedTier: Tier | null;
  priceRatio: number;
  stage?: 'verified' | 'awaiting' | 'scheduled_today' | 'scheduled_soon' | 'unscheduled';
}

function plan(createdAt: Date, outcome: Planned['outcome'], stage?: Planned['stage']): Planned {
  const d = newDraft(createdAt, uuid);
  const [town, zip, drive] = pick(TOWNS);
  d.customer = { ...d.customer, firstName: pick(FIRST), lastName: pick(LAST), email: '', phone: `302-555-${String(Math.floor(between(1000, 9999)))}` };
  d.customer.email = `${d.customer.firstName}.${d.customer.lastName}@example.com`.toLowerCase();
  d.property = { ...d.property, street: `${Math.floor(between(10, 999))} ${pick(STREETS)}`, city: town, zip, yearBuilt: Math.floor(between(1955, 2008)) };
  d.areas = makeAreas();
  d.driveMinutesOneWay = Math.round(drive * between(0.85, 1.2));
  d.selectedTier = 'better';
  d.status = 'ready';
  // The estimator prices around the model; the win model learns how price moves the close rate.
  const priceRatio = outcome === 'draft' ? 1 : Math.round(between(0.92, 1.15) * 100) / 100;
  let priced = priceEstimate(toEstimateInput(d), bundle.snapshot, bundle.coefficientSet);
  if (Math.abs(priceRatio - 1) > 0.015) {
    for (const o of priced.options) {
      d.overrides[o.tier] = { price: Math.round((o.modelPrice * priceRatio) / 5) * 5, reason: priceRatio > 1 ? 'Complex job, premium crew time' : 'Matched competing bid' };
    }
    priced = priceEstimate(toEstimateInput(d), bundle.snapshot, bundle.coefficientSet);
  }
  const tiers = priced.options.map((o) => o.tier);
  const r = rand();
  const signedTier: Tier | null = outcome === 'won' ? (r < 0.3 && tiers.includes('good') ? 'good' : r < 0.85 && tiers.includes('better') ? 'better' : (tiers.at(-1) ?? 'good')) : null;
  return { draft: d, priced, createdAt, source: pick(SOURCES), outcome, signedTier, priceRatio, stage };
}

// ---------------------------------------------------------------------------------------------
// The demo book: history (won ~55%, more when priced low), this week's work, the open pipeline.
const planned: Planned[] = [];
for (let i = 0; i < 64; i++) {
  const created = new Date(NOW.getTime() - between(20, 280) * DAY);
  const p = plan(created, 'won');
  const winP = 1 / (1 + Math.exp(-(0.35 - 9 * (p.priceRatio - 1) + (p.source === 'Referral' ? 0.8 : 0))));
  if (rand() > winP) {
    p.outcome = 'lost';
    p.signedTier = null;
  } else p.stage = 'verified';
  planned.push(p);
}
planned.push(plan(new Date(NOW.getTime() - 12 * DAY), 'won', 'awaiting'));
planned.push(plan(new Date(NOW.getTime() - 10 * DAY), 'won', 'awaiting'));
planned.push(plan(new Date(NOW.getTime() - 6 * DAY), 'won', 'scheduled_today'));
planned.push(plan(new Date(NOW.getTime() - 5 * DAY), 'won', 'scheduled_soon'));
planned.push(plan(new Date(NOW.getTime() - 3 * DAY), 'won', 'unscheduled'));
for (let i = 0; i < 5; i++) planned.push(plan(new Date(NOW.getTime() - between(1, 9) * DAY), 'open'));
for (let i = 0; i < 2; i++) planned.push(plan(new Date(NOW.getTime() - between(0, 2) * DAY), 'draft'));

// ---------------------------------------------------------------------------------------------
function actualsFor(p: Planned, jobRef: string): string[] {
  const option = p.priced.options.find((o) => o.tier === p.signedTier)!;
  const out: string[] = [];
  const area = new Map(p.draft.areas.map((a) => [a.id, a]));
  const products = new Map<string, { areaId: string; product: string; design: number | null; unit: string | null }>();
  for (const l of option.lines) {
    if (!l.areaId || !l.product) continue;
    const key = `${l.areaId}|${l.product}`;
    const cur = products.get(key) ?? { areaId: l.areaId, product: l.product, design: null, unit: null };
    if (l.kind === 'material') {
      cur.design = l.designQty;
      cur.unit = l.unit;
    }
    products.set(key, cur);
  }
  const noise = (sd: number) => Math.max(0.6, 1 + sd * normal());
  for (const { areaId, product, design, unit } of products.values()) {
    const a = area.get(areaId)!;
    const access = TRUE_ACCESS[a.accessLevel]!;
    let qty: number | null = null;
    let hours: number;
    if (product === 'removal') hours = (TRUE_SETUP.removal! + a.sqft * TRUE_REMOVAL * access) * noise(0.08);
    else {
      const units = design ?? a.sqft;
      if (design !== null && TRUE_WASTE[product]) qty = design * TRUE_WASTE[product] * noise(0.05);
      hours = ((TRUE_SETUP[product] ?? 1) + units * (TRUE_RATE[product] ?? 0.01) * access) * noise(0.08);
    }
    if (qty !== null && unit === 'bag') qty = Math.ceil(qty);
    else if (qty !== null) qty = Math.round(qty);
    out.push(
      `insert into job_actuals (id, job_id, area_id, product, actual_material_qty, actual_material_unit, actual_hours, entered_by, entered_at, verified_by, verified_at) ` +
        `select ${s(uuid())}, ${jobRef}, ${s(areaId)}, ${s(product)}, ${qty ?? 'null'}, ${qty === null ? 'null' : s(unit)}, ${Math.round(hours * 10) / 10}, ${s(DEMO.crew)}, j.completed_at, ${s(DEMO.owner)}, j.completed_at + interval '1 day' from jobs j where j.id = ${jobRef};`,
    );
  }
  const drive = Math.round((p.draft.driveMinutesOneWay ?? 20) * TRUE_DRIVE * noise(0.1));
  out.push(
    `insert into job_actuals (id, job_id, actual_drive_minutes, actual_days, actual_crew_size, notes, entered_by, entered_at, verified_by, verified_at) ` +
      `select ${s(uuid())}, ${jobRef}, ${drive}, ${Math.max(0.5, Math.round(option.crewDays * 2 * noise(0.1)) / 2)}, 2, null, ${s(DEMO.crew)}, j.completed_at, ${s(DEMO.owner)}, j.completed_at + interval '1 day' from jobs j where j.id = ${jobRef};`,
  );
  return out;
}

function sqlFor(p: Planned): string {
  const d = p.draft;
  const payload = buildSyncPayload(d, p.priced, bundle, { pricedOffline: false, uuid });
  const est = s(d.id);
  const out: string[] = [];
  out.push(`select set_config('request.jwt.claim.sub', ${s(DEMO.estimator)}, true);`);
  out.push(
    `select sync_upsert_estimate(${s(uuid())}, null, jsonb_set(jsonb_set(${q(payload)}, '{estimate,crew_id}', to_jsonb((select id from crews where name = 'Crew A'))), '{estimate,coefficient_set_id}', to_jsonb((select id from coefficient_sets where status = 'active'))));`,
  );
  const leadId = uuid();
  out.push(
    `insert into leads (id, customer_id, property_id, source_id, status, created_at) values (${s(leadId)}, ${s(d.customer.id)}, ${s(d.property.id)}, (select id from lead_sources where name = ${s(p.source)}), ${s(p.outcome === 'won' ? 'won' : p.outcome === 'lost' ? 'lost' : 'estimated')}, ${ts(p.createdAt)});`,
  );
  out.push(`update estimates set lead_id = ${s(leadId)}, created_at = ${ts(p.createdAt)} where id = ${est};`);
  if (p.outcome === 'draft') return out.join('\n');

  const sentAt = new Date(p.createdAt.getTime() + between(0.1, 1.5) * DAY);
  const quoteId = uuid();
  const document = buildQuoteDocument({
    draft: d,
    options: p.priced.options,
    version: 1,
    issuedAt: sentAt,
    validDays: Number(setting('quote_valid_days') ?? 30),
    branding: setting('branding') as never,
    estimator: { name: 'Erin Estimator', email: null },
    terms: String(setting('quote_terms') ?? ''),
    warranty: String(setting('warranty_text') ?? ''),
  });
  const snapshot = {
    document,
    options: p.priced.options,
    bundleHash: bundle.hash,
    coefficientSetId: bundle.coefficientSet.id,
    input: { areas: priceableAreas(d).map((a) => ({ id: a.id, name: a.name, jobType: a.jobType, accessLevel: a.accessLevel, sqft: a.sqft })), driveMinutesOneWay: d.driveMinutesOneWay },
    flags: [],
  };
  const expires = new Date(sentAt.getTime() + 30 * DAY);
  out.push(
    `insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_at, sent_by, sent_to_email) values ` +
      `(${s(quoteId)}, ${est}, 1, 'sent', ${s(`${d.id}/v1.pdf`)}, 'demo', ${q(snapshot)}, ${s(`demo-${quoteId}`)}, ${ts(expires)}, ${ts(sentAt)}, ${s(DEMO.estimator)}, ${s(d.customer.email)});`,
  );
  out.push(`insert into quote_events (quote_id, event, at) values (${s(quoteId)}, 'sent', ${ts(sentAt)}), (${s(quoteId)}, 'viewed', ${ts(new Date(sentAt.getTime() + 0.3 * DAY))});`);

  if (p.outcome === 'open') {
    out.push(`update quotes set status = 'viewed' where id = ${s(quoteId)};`);
    out.push(`update estimates set status = 'viewed' where id = ${est};`);
    return out.join('\n');
  }
  const decided = new Date(sentAt.getTime() + between(1, 12) * DAY);
  if (p.outcome === 'lost') {
    out.push(`update quotes set status = 'declined' where id = ${s(quoteId)};`);
    out.push(`insert into quote_events (quote_id, event, at) values (${s(quoteId)}, 'declined', ${ts(decided)});`);
    out.push(`update estimates set status = 'lost', decided_at = ${ts(decided)}, lost_reason = ${s(pick(LOST_REASONS))} where id = ${est};`);
    return out.join('\n');
  }

  const option = p.priced.options.find((o) => o.tier === p.signedTier)!;
  const signer = `${d.customer.firstName} ${d.customer.lastName}`;
  out.push(
    `update quotes set status = 'signed', signed_tier = ${s(p.signedTier)}, signed_price = ${option.price}, signed_at = ${ts(decided)}, signer_name = ${s(signer)} where id = ${s(quoteId)};`,
  );
  out.push(`insert into quote_events (quote_id, event, at) values (${s(quoteId)}, 'signed', ${ts(decided)});`);
  out.push(`update estimates set status = 'signed', selected_tier = ${s(p.signedTier)}, decided_at = ${ts(decided)} where id = ${est};`);
  const jobRef = `(select id from jobs where quote_id = ${s(quoteId)})`;
  const crew = `(select id from crews where name = 'Crew A')`;
  const today = new Date(NOW.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) + 'T12:00:00Z');
  if (p.stage === 'verified' || p.stage === 'awaiting') {
    const start = new Date(Math.min(decided.getTime() + between(5, 20) * DAY, NOW.getTime() - 2 * DAY));
    const done = new Date(Math.min(start.getTime() + Math.max(1, Math.ceil(option.crewDays)) * DAY * 0.8, NOW.getTime() - 0.5 * DAY));
    out.push(
      `update jobs set crew_id = ${crew}, scheduled_start = ${s(start.toISOString().slice(0, 10))}, status = 'completed', started_at = ${ts(start)}, completed_at = ${ts(done)} where id = ${jobRef};`,
    );
    const acts = actualsFor(p, jobRef);
    out.push(...(p.stage === 'verified' ? acts : acts.map((a) => a.replace(/, \S+, j\.completed_at \+ interval '1 day' from/, ', null, null from'))));
  } else if (p.stage === 'scheduled_today' || p.stage === 'scheduled_soon') {
    const start = p.stage === 'scheduled_today' ? today : new Date(today.getTime() + 2 * DAY);
    out.push(`update jobs set crew_id = ${crew}, scheduled_start = ${s(start.toISOString().slice(0, 10))} where id = ${jobRef};`);
  }
  return out.join('\n');
}


  const batches: string[] = [];
  for (let i = 0; i < planned.length; i += 8) batches.push(planned.slice(i, i + 8).map(sqlFor).join('\n\n'));
  const won = planned.filter((p) => p.outcome === 'won').length;
  const lost = planned.filter((p) => p.outcome === 'lost').length;
  return { batches, summary: `${planned.length} estimates (${won} won, ${lost} lost)` };
}
