import { describe, expect, it } from 'vitest';
import { buildGoogleExport, type EstimateRow, type JobRow, type PricingRefs } from './export';

const refs: PricingRefs = {
  products: [{ code: 'blown_cellulose', label: 'Blown cellulose', r_per_inch: '3.7' }],
  tiers: [
    { job_type: 'attic', tier: 'good', label: 'Top-up', primary_product: 'blown_cellulose', target_r: 38, include_removal: false },
    { job_type: 'attic', tier: 'best', label: 'Remove and replace', primary_product: 'blown_cellulose', target_r: null, include_removal: true },
  ],
  codeMins: [{ job_type: 'attic', min_r: '49' }],
};

const estimate: EstimateRow = {
  id: 'e1',
  status: 'signed',
  created_at: '2026-09-01T12:00:00Z',
  decided_at: '2026-09-03T12:00:00Z',
  selected_tier: 'best',
  lost_reason: null,
  customer: { first_name: 'Ann', last_name: 'Lee', phone: '302-555-0101', email: null },
  property: { street: '1 Main St', city: 'Newark', zip: '19711' },
  estimator: { full_name: 'Erin' },
  lead: { source: { name: 'Google' } },
  options: [{ tier: 'good', price: '1800' }, { tier: 'best', price: 3200 }],
  areas: [{ id: 'a1', name: 'Main attic', job_type: 'attic', sqft: '1000', current_r: '11', target_r: null, access_level: 'easy', removal_needed: false }],
  quotes: [{ status: 'signed', signed_price: '3200', signed_tier: 'best' }],
};

const job: JobRow = {
  id: 'j1',
  status: 'completed',
  scheduled_start: '2026-09-10',
  scheduled_days: '1',
  started_at: null,
  completed_at: '2026-09-10T20:00:00Z',
  revenue: '3200',
  crew: { name: 'Crew A' },
  quote: {
    signed_tier: 'best',
    options: [{ tier: 'best', lines: [
      { kind: 'material', product: 'blown_cellulose', qty: 40.04, unit: 'bag' },
      { kind: 'labor', hours: 6 },
      { kind: 'removal', hours: 4 },
    ] }],
  },
  estimate: { customer: estimate.customer, property: estimate.property },
  actuals: [{ area_id: 'a1', product: 'blown_cellulose', actual_material_qty: 42, actual_hours: '12', verified_at: '2026-09-11T00:00:00Z' }],
};

describe('buildGoogleExport', () => {
  const out = buildGoogleExport({ estimates: [estimate], jobs: [job], refs, now: new Date('2026-10-01T00:00:00Z') });

  it('flattens estimates with outcome, prices and source', () => {
    expect(out.estimates[0]).toMatchObject({
      customer: 'Ann Lee', address: '1 Main St, Newark 19711', source: 'Google', estimator: 'Erin',
      outcome: 'Won', good: 1800, better: null, best: 3200, signedPrice: 3200, sqft: 1000, created: '2026-09-01',
    });
  });

  it('compares planned and actual hours from the signed snapshot', () => {
    expect(out.jobs[0]).toMatchObject({ crew: 'Crew A', estHours: 10, actualHours: 12, hoursVariance: 0.2, verified: true, completed: '2026-09-10' });
    expect(out.jobs[0]!.scope).toContain('40 bags');
  });

  it('gives each area option a target R, falling back to the code minimum', () => {
    const area = out.areas[0]!;
    expect(area).toMatchObject({ area: 'Main attic', currentR: 11 });
    expect(area.options.map((o) => [o.targetR, o.removesOld, o.price])).toEqual([[38, false, 1800], [49, true, 3200]]);
    expect(area.options[0]!.rPerInch).toBe(3.7);
  });

  it('marks jobs without actuals as unverified with no variance', () => {
    const [j] = buildGoogleExport({ estimates: [], jobs: [{ ...job, actuals: [] }], refs, now: new Date() }).jobs;
    expect(j).toMatchObject({ actualHours: null, hoursVariance: null, verified: false });
  });
});
