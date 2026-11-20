// The pricing rows the accuracy checks price with, and how they are kept comparable.
//
// scripts/accuracy/bundle-rows.sql reads these rows (the same filters as loadPricingBundle in
// lib/server/bundle.ts). Fresh from the migrations they become lib/pricing/__fixtures__/seeded-rows.json
// (scripts/accuracy/seeded-rows.sh); from production they are the live golden set's rows.
// Row ids are random in every database, so the fixture gives each row an id made from what the
// row is (its natural key). Comparing two databases ignores ids the same way.
import { createHash } from 'node:crypto';
import type { SnapshotRows } from '@/lib/server/snapshot';

/**
 * The app_settings keys the pricing snapshot reads (parseSettings and default_crew_id in
 * lib/server/snapshot.ts). Nothing else is kept: no branding, terms or franchise text.
 * If the snapshot starts reading a new key, add it here and in scripts/accuracy/bundle-rows.sql.
 */
export const PRICING_SETTING_KEYS = [
  'overhead_pct',
  'target_margin_pct',
  'floor_margin_pct',
  'ceiling_margin_pct',
  'minimum_job_price',
  'price_rounding',
  'productive_hours_per_day',
  'vehicle_cost_per_trip',
  'disposal_cost_per_sqft',
  'estimator_override_limit_pct',
  'estimators_see_costs',
  'deviation_threshold',
  'quote_valid_days',
  'financing',
  'default_crew_id',
] as const;

/** A UUID-shaped id made from a natural key, so the same row always gets the same id. */
export function stableId(naturalKey: string): string {
  const h = createHash('md5').update(naturalKey).digest('hex');
  // Version 4 layout (8-4-4-4-12, version nibble 4, variant 8), so z.uuid() accepts it.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const byKey = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * The rows with every id replaced by a stable id made from what the row is, settings cut to
 * PRICING_SETTING_KEYS and everything sorted. Two databases with the same pricing give the same
 * result, whatever ids their rows were given.
 */
export function stableRows(rows: SnapshotRows): SnapshotRows {
  const productCode = new Map(rows.products.map((p) => [p.id, p.code]));
  const productId = new Map(rows.products.map((p) => [p.id, stableId(`product:${p.code}`)]));
  const crewId = new Map(rows.crews.map((c) => [c.id, stableId(`crew:${c.name}`)]));
  const keep = new Set<string>(PRICING_SETTING_KEYS);
  return {
    settings: byKey(
      rows.settings
        .filter((s) => keep.has(s.key))
        .map((s) => (s.key === 'default_crew_id' && typeof s.value === 'string' ? { key: s.key, value: crewId.get(s.value) ?? s.value } : s)),
      (s) => s.key,
    ),
    products: byKey(
      rows.products.map((p) => ({ ...p, id: productId.get(p.id)! })),
      (p) => p.code,
    ),
    materials: byKey(
      rows.materials.map((m) => ({
        ...m,
        id: stableId(`material:${productCode.get(m.product_id) ?? m.product_id}:${m.name}`),
        product_id: productId.get(m.product_id) ?? m.product_id,
      })),
      (m) => `${m.product_id}/${m.name}`,
    ),
    crews: byKey(
      rows.crews.map((c) => ({ ...c, id: crewId.get(c.id)! })),
      (c) => c.name,
    ),
    codeRequirements: byKey(rows.codeRequirements, (c) => `${c.job_type}/${c.assembly}`),
    tierTemplates: byKey(rows.tierTemplates, (t) => `${t.job_type}/${t.tier}`),
    coefficientSet: { id: stableId(`coefficient_set:v${rows.coefficientSet.version}`), version: rows.coefficientSet.version },
    coefficients: byKey(rows.coefficients, (c) => `${c.kind}/${c.product}/${c.job_type}/${c.access_level}`),
    winModel: rows.winModel ? { ...rows.winModel, id: stableId(`win_model:${rows.winModel.trained_at}`) } : null,
  };
}

/** What differs between two sets of pricing rows, ignoring ids (and, unless asked, the win model). */
export function diffRows(a: SnapshotRows, b: SnapshotRows, opts: { winModel?: boolean } = {}): string[] {
  const sa = stableRows(a);
  const sb = stableRows(b);
  const out: string[] = [];
  const parts = ['settings', 'products', 'materials', 'crews', 'codeRequirements', 'tierTemplates', 'coefficientSet', 'coefficients'] as const;
  for (const part of parts) {
    const xa = sa[part];
    const xb = sb[part];
    const la = Array.isArray(xa) ? xa.map((x) => JSON.stringify(normalize(x))) : [JSON.stringify(normalize(xa))];
    const lb = Array.isArray(xb) ? xb.map((x) => JSON.stringify(normalize(x))) : [JSON.stringify(normalize(xb))];
    for (const x of la) if (!lb.includes(x)) out.push(`${part}: only in the first: ${x}`);
    for (const x of lb) if (!la.includes(x)) out.push(`${part}: only in the second: ${x}`);
  }
  if (opts.winModel && JSON.stringify(sa.winModel ?? null) !== JSON.stringify(sb.winModel ?? null)) out.push('winModel differs');
  return out;
}

/** Numbers as numbers (PostgREST, psql and the SQL tool print numerics differently). */
function normalize(x: unknown): unknown {
  if (x === null || typeof x !== 'object') {
    if (typeof x === 'string' && x.trim() !== '' && /^-?\d+(\.\d+)?$/.test(x)) return Number(x);
    return x;
  }
  if (Array.isArray(x)) return x.map(normalize);
  return Object.fromEntries(
    Object.entries(x as Record<string, unknown>)
      .sort(([k1], [k2]) => (k1 < k2 ? -1 : 1))
      .map(([k, v]) => [k, normalize(v)]),
  );
}

/**
 * Live rows as they would read after the accuracy migration (supabase/migrations/
 * 20261119000001_accuracy.sql), from rows exported before it ran: the migration's new materials
 * (a job type's or a size, from `seeded`) at the live general material's current cost, and the
 * walls cellulose waste cell at the live shared value. Mirrors the migration's own inserts: a row
 * already there is kept as it is. For pricing the live golden set "after"; production is never
 * written.
 */
export function withAccuracyRows(live: SnapshotRows, seeded: SnapshotRows): SnapshotRows {
  const liveProduct = new Map(live.products.map((p) => [p.code, p.id]));
  const seededCode = new Map(seeded.products.map((p) => [p.id, p.code]));
  const liveCode = new Map(live.products.map((p) => [p.id, p.code]));
  const general = (code: string) => live.materials.find((m) => liveCode.get(m.product_id) === code && !m.job_type && m.r_value == null);
  const has = (code: string, m: SnapshotRows['materials'][number]) =>
    live.materials.some((x) => liveCode.get(x.product_id) === code && (m.job_type ? x.job_type === m.job_type : Number(x.r_value) === Number(m.r_value)));
  const materials = [...live.materials];
  for (const m of seeded.materials) {
    if (!m.job_type && m.r_value == null) continue;
    const code = seededCode.get(m.product_id);
    const productId = code ? liveProduct.get(code) : undefined;
    const base = code ? general(code) : undefined;
    if (!code || !productId || !base || has(code, m)) continue;
    materials.push({ ...m, id: stableId(`material:${code}:${m.name}`), product_id: productId, cost_per_unit: base.cost_per_unit });
  }
  const coefficients = [...live.coefficients];
  const cell = (c: SnapshotRows['coefficients'][number]) => `${c.kind}/${c.product}/${c.job_type}/${c.access_level}`;
  for (const c of seeded.coefficients) {
    if (!c.job_type || coefficients.some((x) => cell(x) === cell(c))) continue;
    const shared = live.coefficients.find((x) => x.kind === c.kind && x.product === c.product && !x.job_type && !x.access_level);
    if (!shared) continue;
    coefficients.push({ ...c, value: shared.value, sample_size: 0, n_eff: 0, confidence: 0 });
  }
  return { ...live, materials, coefficients };
}
