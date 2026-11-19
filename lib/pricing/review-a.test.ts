// Review A of the pricing engine (docs/accuracy/review/review-a.json): each finding's case, with
// the pricing a new database starts with (__fixtures__/seeded.ts). Each test failed before its fix;
// the ledger's "Review A fixes" section gives the before -> after numbers.
import { describe, expect, it } from 'vitest';
import { priceEstimate } from './engine';
import { lineKey, type EstimateInput, type PricedEstimate, type PricedOption, type PricingSnapshot, type Tier } from './types';
import { seededArea as area, seededCoefficients as coeffs, seededEstimate as estimate, seededSnapshot as snapshot } from './__fixtures__/seeded';
import { checkPricedQuote } from './invariants';

const all = (input: EstimateInput, s: PricingSnapshot = snapshot) => priceEstimate(input, s, coeffs, { showAll: true });
const shown = (input: EstimateInput, s: PricingSnapshot = snapshot) => priceEstimate(input, s, coeffs);
const tier = (r: PricedEstimate, t: Tier): PricedOption => {
  const o = r.options.find((x) => x.tier === t);
  if (!o) throw new Error(`no ${t} option`);
  return o;
};
const work = (o: PricedOption) => o.customerItems.filter((i) => i.kind === 'work').map((i) => i.description);
const violations = (input: EstimateInput, s: PricingSnapshot = snapshot) =>
  checkPricedQuote({ input, priced: shown(input, s), snapshot: s, coefficients: coeffs });

describe('F3 (R3): a batt or air-sealing quantity says the area it covers', () => {
  const crawl = area({ id: 'c1', jobType: 'crawlspace', name: 'Crawlspace', sqft: 800, depthIn: 5.5 });
  const batts = (qty: number) => estimate({ areas: [crawl], lineOverrides: { [lineKey('c1', 'batts', 'material')]: { qty, reason: 'Counted on site', tier: 'good' } } });

  it('crawlspace 800 sq ft, Good batts set to 100 sq ft: "95 of 800 sq ft" (100 / 1.05 waste), the price as before', () => {
    const good = tier(all(batts(100)), 'good');
    expect(good.lines.find((l) => l.product === 'batts' && l.kind === 'material')!.qty).toBe(100);
    expect(work(good)).toEqual(['Fiberglass Batts to R-21 (5.5 in thick), 95 of 800 sq ft']);
    expect(violations(batts(100))).toEqual([]);
  });

  it('the model quantity, or one typed equal to it, still reads the whole area', () => {
    expect(work(tier(all(estimate({ areas: [crawl] })), 'good'))).toEqual(['Fiberglass Batts to R-21 (5.5 in thick), 800 sq ft']);
    expect(work(tier(all(batts(840)), 'good'))).toEqual(['Fiberglass Batts to R-21 (5.5 in thick), 800 sq ft']);
  });

  it('1,600 sq ft of batts for an 800 sq ft area is cut to the whole area (840 with waste), with a warning', () => {
    const r = all(batts(1600));
    const good = tier(r, 'good');
    expect(good.lines.find((l) => l.product === 'batts' && l.kind === 'material')!.qty).toBe(840);
    expect(work(good)).toEqual(['Fiberglass Batts to R-21 (5.5 in thick), 800 sq ft']);
    expect(good.price).toBe(tier(all(estimate({ areas: [crawl] })), 'good').price);
    expect(r.warnings.find((w) => w.code === 'override_capped')!.message).toBe(
      'Crawlspace: 1,600 sq ft of fiberglass batts is more than the 800 sq ft area. Good is priced with 840 sq ft, the whole area.',
    );
  });

  it('attic 1,000 sq ft, air sealing set to 500 sq ft: "(500 of 1,000 sq ft)"', () => {
    const a = area({ id: 'a1' });
    const input = estimate({ areas: [a], lineOverrides: { [lineKey('a1', 'air_sealing', 'material')]: { qty: 500, reason: 'Counted on site', tier: 'better' } } });
    const better = tier(all(input), 'better');
    expect(better.lines.find((l) => l.product === 'air_sealing' && l.kind === 'material')!.qty).toBe(500);
    expect(work(better)).toContain('Air sealing of top plates, penetrations and bypasses (500 of 1,000 sq ft)');
    // Best air seals the same 500 of 1,000 sq ft, so "Full air sealing before new insulation" goes.
    const best = tier(all(input), 'best');
    expect(work(best)).toContain('Air sealing of top plates, penetrations and bypasses (500 of 1,000 sq ft)');
    expect(best.bullets).not.toContain('Full air sealing before new insulation');
    expect(violations(input)).toEqual([]);
  });

  it('air sealing set above the area (knee walls, L7) is not cut: the item states the 1,500 sq ft priced', () => {
    const input = estimate({ lineOverrides: { [lineKey('a1', 'air_sealing', 'material')]: { qty: 1500, reason: 'Knee walls' } } });
    const better = tier(all(input), 'better');
    expect(better.lines.find((l) => l.key === lineKey('a1', 'air_sealing', 'labor'))).toMatchObject({ modelHours: 6.5, hours: 9.5 });
    expect(work(better)).toContain('Air sealing of top plates, penetrations and bypasses (1,500 sq ft)');
    expect(violations(input)).toEqual([]);
  });
});
