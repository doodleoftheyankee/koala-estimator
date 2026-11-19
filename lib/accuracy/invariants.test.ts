// The accuracy checks themselves: the seeded pricing fixture they price with, and each rule
// (lib/pricing/invariants.ts, lib/quotes/invariants.ts) on hand-made good and bad quotes.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { priceEstimate, type AreaInput, type EstimateInput } from '@/lib/pricing';
import { bundleFromRows, seededBundle, seededRows } from '@/lib/pricing/__fixtures__/seeded';
import { parseSettings } from '@/lib/server/snapshot';
import { diffRows, PRICING_SETTING_KEYS, stableId, stableRows } from './rows';

const root = path.resolve(import.meta.dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

const area = (o: Partial<AreaInput> = {}): AreaInput => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Attic',
  jobType: 'attic',
  sqft: 1000,
  currentR: 0,
  targetR: null,
  existingMaterial: null,
  existingDepthIn: null,
  depthIn: null,
  accessLevel: 'easy',
  removalNeeded: false,
  prepNotes: null,
  ...o,
});
const estimate = (areas: AreaInput[], o: Partial<EstimateInput> = {}): EstimateInput => ({
  areas,
  crewId: null,
  driveMinutesOneWay: 20,
  overrides: {},
  ...o,
});
const priceSeeded = (input: EstimateInput) => priceEstimate(input, seededBundle.snapshot, seededBundle.coefficientSet);

describe('seeded pricing fixture (the rows every migration leaves in a new database)', () => {
  it('is a valid pricing setup that keeps only the pricing settings', () => {
    expect(seededRows.settings.map((s) => s.key).sort()).toEqual([...PRICING_SETTING_KEYS].sort());
    expect(() => parseSettings(seededRows.settings)).not.toThrow();
    expect(JSON.stringify(seededRows)).not.toMatch(/branding|Newark|Delaware|\(302\)/);
    expect(seededBundle.snapshot.defaultCrewId).toBe(seededRows.crews[0]!.id);
    // A fixed build time: the bundle and its hash are the same on every run.
    expect(bundleFromRows(seededRows).hash).toBe(seededBundle.hash);
  });

  it('bundle-rows.sql reads the same rows as loadPricingBundle, and only the pricing settings', () => {
    const sql = read('scripts/accuracy/bundle-rows.sql');
    const keys = /where key in \(([^)]*)\)/.exec(sql)![1]!.match(/'([a-z_]+)'/g)!.map((k) => k.slice(1, -1));
    expect(keys.sort()).toEqual([...PRICING_SETTING_KEYS].sort());
    for (const filter of ['from products where active', 'where m.active and m.is_default', 'from crews where active', 'from code_requirements where is_default', 'from tier_templates where active', "where status = 'active'", 'from win_models where is_active']) {
      expect(sql).toContain(filter);
    }
    const loader = read('lib/server/bundle.ts');
    for (const filter of [".from('products')", ".eq('active', true)", ".eq('is_default', true)", ".eq('status', 'active')", ".eq('is_active', true)"]) {
      expect(loader).toContain(filter);
    }
  });

  it('prices the examples in the round 1 record exactly as the record says (drive 20 min, seeded pricing)', () => {
    // L1: attic 1,200 sq ft at R-19 with removal.
    const l1 = priceSeeded(estimate([area({ sqft: 1200, currentR: 19, removalNeeded: true })]));
    expect(l1.options.map((o) => o.price)).toEqual([6385, 8010, 8010]);
    expect(l1.options[0]!.customerItems[0]!.price).toBe(2720.15);
    expect(l1.options[1]!.customerItems[0]!.price).toBe(2735.84);
    // L18: walls 1,000 sq ft, no depth: Better $3,580.
    expect(priceSeeded(estimate([area({ jobType: 'walls', name: 'Walls' })])).options[1]!.price).toBe(3580);
    // L14: attic 1,200 sq ft at R-0: Best $5,160, the same as Better.
    expect(priceSeeded(estimate([area({ sqft: 1200 })])).options.map((o) => o.price)).toEqual([3720, 5160, 5160]);
    // L19: walls 1,000 sq ft 2x4 full of R-11 batts: $1,500 / $1,740 / $2,505.
    const l19 = priceSeeded(estimate([area({ jobType: 'walls', depthIn: 3.5, currentR: 11, existingMaterial: 'Fiberglass batts' })]));
    expect(l19.options.map((o) => o.price)).toEqual([1500, 1740, 2505]);
    // L22: crawlspace 800 sq ft 2x6, target R-38: Good batts $2,270.
    expect(priceSeeded(estimate([area({ jobType: 'crawlspace', sqft: 800, depthIn: 5.5, targetR: 38 })])).options[0]!.price).toBe(2270);
  });

  it('gives every row an id made from what it is, so two databases compare row for row', () => {
    expect(stableId('crew:Crew A')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableRows(seededRows)).toEqual(seededRows);
    // The same rows with other ids (another database) are the same rows.
    const crew = seededRows.crews[0]!;
    const other = structuredClone(seededRows);
    other.crews[0]!.id = '11111111-1111-4111-8111-111111111111';
    other.settings = other.settings.map((s) => (s.key === 'default_crew_id' ? { ...s, value: other.crews[0]!.id } : s));
    other.products = other.products.map((p, i) => ({ ...p, id: `p${i}` }));
    other.materials = other.materials.map((m) => ({ ...m, product_id: `p${seededRows.products.findIndex((p) => p.id === m.product_id)}` }));
    other.coefficientSet = { ...other.coefficientSet, id: 'another-set' };
    expect(stableRows(other)).toEqual(seededRows);
    // PostgREST and psql print numerics differently ("0.7500" or 0.75); a comparison ignores that.
    other.materials = other.materials.map((m) => ({ ...m, cost_per_unit: Number(m.cost_per_unit).toFixed(4) }));
    expect(diffRows(other, seededRows)).toEqual([]);
    // A changed value is a difference.
    other.crews[0]!.blended_hourly_cost = Number(crew.blended_hourly_cost) + 1;
    expect(diffRows(other, seededRows)).toEqual([
      expect.stringContaining('crews: only in the first'),
      expect.stringContaining('crews: only in the second'),
    ]);
  });
});
