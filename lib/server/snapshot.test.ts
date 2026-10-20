import { describe, expect, it } from 'vitest';
import { makeBundle, parseSettings, stableStringify, type SnapshotRows } from './snapshot';

const settings = [
  { key: 'overhead_pct', value: 0.18 },
  { key: 'target_margin_pct', value: 0.4 },
  { key: 'floor_margin_pct', value: 0.25 },
  { key: 'ceiling_margin_pct', value: 0.6 },
  { key: 'minimum_job_price', value: 995 },
  { key: 'price_rounding', value: 5 },
  { key: 'productive_hours_per_day', value: 7 },
  { key: 'vehicle_cost_per_trip', value: 45 },
  { key: 'disposal_cost_per_sqft', value: 0.35 },
  { key: 'estimator_override_limit_pct', value: 0.1 },
  { key: 'estimators_see_costs', value: false },
  { key: 'deviation_threshold', value: 0.15 },
  { key: 'quote_valid_days', value: 30 },
  { key: 'financing', value: { provider: null, apr: 0.0999, term_months: 120, show: true } },
  { key: 'default_crew_id', value: 'c1' },
];

const rows: SnapshotRows = {
  settings,
  products: [{ id: 'p1', code: 'cellulose', label: 'Blown Cellulose', unit: 'bag', r_per_inch: '3.600', is_r_bearing: true }],
  materials: [
    { id: 'm1', product_id: 'p1', name: 'Bag', unit: 'bag', cost_per_unit: '14.0000', coverage_sqft_in: '200' },
    { id: 'm2', product_id: 'missing', name: 'Orphan', unit: 'bag', cost_per_unit: 1, coverage_sqft_in: 1 },
  ],
  crews: [{ id: 'c1', name: 'Crew A', size: 2, blended_hourly_cost: '38.00' }],
  codeRequirements: [
    { job_type: 'crawlspace', assembly: 'crawl_wall', min_r: '10', code_edition: '2021 IECC' },
    { job_type: 'crawlspace', assembly: 'floor', min_r: '19', code_edition: '2021 IECC' },
    { job_type: 'garage', assembly: 'other', min_r: '30', code_edition: 'x' },
  ],
  tierTemplates: [
    { job_type: 'attic', tier: 'good', label: 'L', primary_product: 'cellulose', target_r: null, include_air_sealing: false, include_removal: false, marketing_bullets: null },
  ],
  coefficientSet: { id: 's1', version: 3 },
  coefficients: [{ kind: 'drive_time_factor', product: null, job_type: null, access_level: null, value: '1.100000' }],
};

describe('snapshot mapping', () => {
  it('parses settings with numeric coercion', () => {
    const s = parseSettings(settings);
    expect(s.overheadPct).toBe(0.18);
    expect(s.financing).toEqual({ provider: null, apr: 0.0999, termMonths: 120, show: true });
  });

  it('rejects missing settings', () => {
    expect(() => parseSettings(settings.filter((s) => s.key !== 'overhead_pct'))).toThrow();
  });

  it('converts numeric strings, maps materials to product codes and drops orphans', () => {
    const b = makeBundle(rows);
    expect(b.snapshot.materials).toEqual([
      { id: 'm1', productCode: 'cellulose', name: 'Bag', unit: 'bag', costPerUnit: 14, coverageSqftIn: 200 },
    ]);
    expect(b.snapshot.products[0]!.rPerInch).toBe(3.6);
    expect(b.snapshot.crews[0]!.blendedHourlyCost).toBe(38);
    expect(b.snapshot.defaultCrewId).toBe('c1');
    expect(b.snapshot.tierTemplates[0]!.bullets).toEqual([]);
    expect(b.coefficientSet.coefficients[0]!.value).toBe(1.1);
  });

  it('uses the primary assembly code minimum, falling back to any for that job type', () => {
    const b = makeBundle(rows);
    expect(b.snapshot.codeRequirements.find((c) => c.jobType === 'crawlspace')!.minR).toBe(19);
    expect(b.snapshot.codeRequirements.find((c) => c.jobType === 'garage')!.minR).toBe(30);
    expect(b.snapshot.codeRequirements.find((c) => c.jobType === 'attic')).toBeUndefined();
  });

  it('hash is stable across row order and changes with content', () => {
    const a = makeBundle(rows);
    const b = makeBundle({ ...rows, codeRequirements: [...rows.codeRequirements].reverse() });
    expect(a.hash).toBe(b.hash);
    const c = makeBundle({ ...rows, crews: [{ ...rows.crews[0]!, blended_hourly_cost: 40 }] });
    expect(c.hash).not.toBe(a.hash);
  });

  it('stableStringify sorts keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: [2, { d: undefined, c: null }] })).toBe('{"a":[2,{"c":null}],"b":1}');
  });
});
