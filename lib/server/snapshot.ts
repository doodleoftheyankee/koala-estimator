// Maps database rows to the pricing engine's PricingSnapshot / CoefficientSet.
// Pure (no I/O) so it can be tested; loadPricingBundle in bundle.ts does the queries.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CoefficientSet,
  PricingBundle,
  WinModel,
  PricingSettings,
  PricingSnapshot,
  ProductUnit,
} from '@/lib/pricing';

const num = z.coerce.number();

const settingsSchema = z.object({
  overhead_pct: num,
  target_margin_pct: num,
  floor_margin_pct: num,
  ceiling_margin_pct: num,
  minimum_job_price: num,
  price_rounding: num,
  productive_hours_per_day: num,
  vehicle_cost_per_trip: num,
  disposal_cost_per_sqft: num,
  estimator_override_limit_pct: num,
  estimators_see_costs: z.coerce.boolean(),
  deviation_threshold: num,
  quote_valid_days: num,
  financing: z.object({
    provider: z.string().nullable().optional(),
    apr: num,
    term_months: num,
    show: z.boolean(),
  }),
});

export interface SettingRow {
  key: string;
  value: unknown;
}

export function parseSettings(rows: SettingRow[]): PricingSettings {
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const s = settingsSchema.parse(map);
  return {
    overheadPct: s.overhead_pct,
    targetMarginPct: s.target_margin_pct,
    floorMarginPct: s.floor_margin_pct,
    ceilingMarginPct: s.ceiling_margin_pct,
    minimumJobPrice: s.minimum_job_price,
    priceRounding: s.price_rounding,
    productiveHoursPerDay: s.productive_hours_per_day,
    vehicleCostPerTrip: s.vehicle_cost_per_trip,
    disposalCostPerSqft: s.disposal_cost_per_sqft,
    estimatorOverrideLimitPct: s.estimator_override_limit_pct,
    estimatorsSeeCosts: s.estimators_see_costs,
    deviationThreshold: s.deviation_threshold,
    quoteValidDays: s.quote_valid_days,
    financing: {
      provider: s.financing.provider ?? null,
      apr: s.financing.apr,
      termMonths: s.financing.term_months,
      show: s.financing.show,
    },
  };
}

/** Reads a string setting (stored as a JSON string). */
export function settingString(rows: SettingRow[], key: string): string | null {
  const v = rows.find((r) => r.key === key)?.value;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface SnapshotRows {
  settings: SettingRow[];
  products: Array<{ id: string; code: string; label: string; unit: string; r_per_inch: number | string | null; is_r_bearing: boolean }>;
  materials: Array<{ id: string; product_id: string; name: string; unit: string; cost_per_unit: number | string; coverage_sqft_in: number | string | null }>;
  crews: Array<{ id: string; name: string; size: number; blended_hourly_cost: number | string }>;
  codeRequirements: Array<{ job_type: string; min_r: number | string; code_edition: string; assembly: string }>;
  tierTemplates: Array<{
    job_type: string;
    tier: string;
    label: string;
    primary_product: string;
    target_r: number | string | null;
    include_air_sealing: boolean;
    include_removal: boolean;
    marketing_bullets: string[] | null;
  }>;
  coefficientSet: { id: string; version: number };
  coefficients: Array<{
    kind: string;
    product: string | null;
    job_type: string | null;
    access_level: string | null;
    value: number | string;
    sample_size?: number | null;
    n_eff?: number | string | null;
    confidence?: number | string | null;
  }>;
  winModel?: { id: string; trained_at: string; n_quotes: number; params: unknown; metrics: unknown } | null;
}

const winParamsSchema = z.object({
  weights: z.record(z.string(), z.number()),
  jobTypes: z.array(z.string()),
  sources: z.array(z.string()),
});
const winMetricsSchema = z.object({ logLoss: z.number(), auc: z.number().nullable(), baseRate: z.number() });

/** Maps an active win_models row to the WinModel the phone uses; null if malformed. */
export function parseWinModel(row: SnapshotRows['winModel']): WinModel | null {
  if (!row) return null;
  const params = winParamsSchema.safeParse(row.params);
  const metrics = winMetricsSchema.safeParse(row.metrics);
  if (!params.success || !metrics.success) return null;
  return { id: row.id, trainedAt: row.trained_at, nQuotes: row.n_quotes, ...params.data, metrics: metrics.data };
}

const n = (v: number | string) => Number(v);
const nn = (v: number | string | null) => (v === null ? null : Number(v));

// Which assembly's code minimum drives the default target for each job type.
const PRIMARY_ASSEMBLY: Record<string, string> = {
  attic: 'ceiling',
  walls: 'wood_frame_wall',
  crawlspace: 'floor',
  rim_joist: 'basement_wall',
  garage: 'ceiling',
  commercial: 'ceiling',
};

export function buildSnapshot(rows: SnapshotRows): { snapshot: PricingSnapshot; coefficientSet: CoefficientSet } {
  const settings = parseSettings(rows.settings);
  const productCodeById = new Map(rows.products.map((p) => [p.id, p.code]));
  const defaultCrewId = settingString(rows.settings, 'default_crew_id');

  const snapshot: PricingSnapshot = {
    settings,
    products: rows.products.map((p) => ({
      code: p.code as PricingSnapshot['products'][number]['code'],
      label: p.label,
      unit: p.unit as ProductUnit,
      rPerInch: nn(p.r_per_inch),
      isRBearing: p.is_r_bearing,
    })),
    materials: rows.materials
      .filter((m) => productCodeById.has(m.product_id))
      .map((m) => ({
        id: m.id,
        productCode: productCodeById.get(m.product_id) as PricingSnapshot['materials'][number]['productCode'],
        name: m.name,
        unit: m.unit as ProductUnit,
        costPerUnit: n(m.cost_per_unit),
        coverageSqftIn: nn(m.coverage_sqft_in),
      })),
    crews: rows.crews.map((c) => ({ id: c.id, name: c.name, size: c.size, blendedHourlyCost: n(c.blended_hourly_cost) })),
    defaultCrewId,
    codeRequirements: Object.entries(PRIMARY_ASSEMBLY).flatMap(([jobType, assembly]) => {
      const r =
        rows.codeRequirements.find((c) => c.job_type === jobType && c.assembly === assembly) ??
        rows.codeRequirements.find((c) => c.job_type === jobType);
      return r
        ? [{ jobType: jobType as PricingSnapshot['codeRequirements'][number]['jobType'], minR: n(r.min_r), edition: r.code_edition }]
        : [];
    }),
    tierTemplates: rows.tierTemplates.map((t) => ({
      jobType: t.job_type as PricingSnapshot['tierTemplates'][number]['jobType'],
      tier: t.tier as PricingSnapshot['tierTemplates'][number]['tier'],
      label: t.label,
      primaryProduct: t.primary_product as PricingSnapshot['tierTemplates'][number]['primaryProduct'],
      targetR: nn(t.target_r),
      includeAirSealing: t.include_air_sealing,
      includeRemoval: t.include_removal,
      bullets: t.marketing_bullets ?? [],
    })),
  };

  const coefficientSet: CoefficientSet = {
    id: rows.coefficientSet.id,
    version: rows.coefficientSet.version,
    coefficients: rows.coefficients.map((c) => ({
      kind: c.kind as CoefficientSet['coefficients'][number]['kind'],
      product: c.product as CoefficientSet['coefficients'][number]['product'],
      jobType: c.job_type as CoefficientSet['coefficients'][number]['jobType'],
      accessLevel: c.access_level as CoefficientSet['coefficients'][number]['accessLevel'],
      value: n(c.value),
      ...(c.sample_size != null ? { sampleSize: Number(c.sample_size) } : {}),
      ...(c.n_eff != null ? { nEff: Number(c.n_eff) } : {}),
      ...(c.confidence != null ? { confidence: Number(c.confidence) } : {}),
    })),
  };
  return { snapshot, coefficientSet };
}

/** JSON.stringify with sorted object keys, so equal content always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function bundleHash(snapshot: PricingSnapshot, coefficientSet: CoefficientSet, winModel: WinModel | null = null): string {
  return createHash('sha256').update(stableStringify({ snapshot, coefficientSet, winModel })).digest('hex').slice(0, 16);
}

export function makeBundle(rows: SnapshotRows, now = new Date()): PricingBundle {
  const { snapshot, coefficientSet } = buildSnapshot(rows);
  // Sort for a stable hash regardless of query order.
  snapshot.products.sort((a, b) => a.code.localeCompare(b.code));
  snapshot.materials.sort((a, b) => a.productCode.localeCompare(b.productCode));
  snapshot.crews.sort((a, b) => a.name.localeCompare(b.name));
  snapshot.tierTemplates.sort((a, b) => `${a.jobType}/${a.tier}`.localeCompare(`${b.jobType}/${b.tier}`));
  coefficientSet.coefficients.sort((a, b) =>
    `${a.kind}/${a.product}/${a.jobType}/${a.accessLevel}`.localeCompare(`${b.kind}/${b.product}/${b.jobType}/${b.accessLevel}`),
  );
  const winModel = parseWinModel(rows.winModel ?? null);
  return { hash: bundleHash(snapshot, coefficientSet, winModel), builtAt: now.toISOString(), snapshot, coefficientSet, winModel };
}
