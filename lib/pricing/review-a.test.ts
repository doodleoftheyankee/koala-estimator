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

describe('F9: an option never removes what is there to leave the area with less R (unless removal is required)', () => {
  it('target R-30 typed on an attic at R-38: Best no longer removes R-38 to install R-30; it keeps what is there', () => {
    const a = area({ id: 'a1', currentR: 38, existingMaterial: 'Cellulose', targetR: 30 });
    const r = all(estimate({ areas: [a] }));
    const best = tier(r, 'best');
    // Before: "Remove and dispose of existing insulation (1,000 sq ft)" + "Blown Cellulose to R-30 …", $5,025.
    expect(work(best).some((d) => /^Remove/.test(d))).toBe(false);
    expect(work(best).some((d) => /Blown Cellulose to R-30/.test(d))).toBe(false);
    expect(r.warnings.find((w) => w.code === 'removal_kept' && w.tier === 'best')!.message).toBe(
      'Attic: Best would remove the R-38 there and end at R-30, so it keeps what is there.',
    );
    // Best is then the same work as Better (air sealing over the R-38), so the customer sees Better only.
    expect(shown(estimate({ areas: [a] })).options.map((o) => o.tier)).toEqual(['better']);
    expect(violations(estimate({ areas: [a] }))).toEqual([]);
  });

  it('attic 1,000 sq ft, 7.25 in joists, R-49 blown fiberglass: Best no longer removes R-49 to end at R-26.1', () => {
    const a = area({ id: 'a1', currentR: 49, existingMaterial: 'Blown fiberglass', depthIn: 7.25 });
    const best = tier(all(estimate({ areas: [a] })), 'best');
    expect(work(best)).not.toContain('Blown Cellulose to R-26.1 (fills the 7.25 in cavity), 1,000 sq ft');
    expect(work(best).some((d) => /^Remove/.test(d))).toBe(false);
  });

  it('removal the estimator requires (damaged, wet) is kept, whatever R the option ends at', () => {
    const a = area({ id: 'a1', currentR: 38, existingMaterial: 'Cellulose', targetR: 30, removalNeeded: true });
    const best = tier(all(estimate({ areas: [a] })), 'best');
    expect(work(best)[0]).toBe('Remove and dispose of existing insulation (1,000 sq ft)');
  });

  it('a removal that ends above what is there is kept: attic at R-19 to R-60', () => {
    const a = area({ id: 'a1', currentR: 19, existingMaterial: 'Fiberglass batts' });
    const best = tier(all(estimate({ areas: [a] })), 'best');
    expect(work(best)[0]).toBe('Remove and dispose of existing insulation (1,000 sq ft)');
    expect(best.label).toBe('Remove, Air Seal + Cellulose');
  });
});

describe('F4: a product priced at 0 is not sold as work', () => {
  const walls = area({ id: 'w1', jobType: 'walls', name: 'Walls', depthIn: 3.5 });
  const zeroBags = estimate({ areas: [walls], lineOverrides: { [lineKey('w1', 'cellulose', 'material')]: { qty: 0, reason: 'Counted on site', tier: 'good' } } });

  it('walls 2x4, Good dense-pack set to 0 bags: Good is not "Dense-Pack Cellulose … to R-0"; it is kept for the estimator but not shown to the customer', () => {
    const good = tier(all(zeroBags), 'good');
    // Before: label "Dense-Pack Cellulose", item "Blown Cellulose to R-0 (~0" added), 1,000 sq ft" $134, total $1,500.
    expect(good.label).not.toBe('Dense-Pack Cellulose');
    expect(good.bullets).toEqual([]);
    expect(work(good)).toEqual([]);
    // The line stays, so the estimator can change it back in Details.
    expect(good.lines.find((l) => l.key === lineKey('w1', 'cellulose', 'material'))!.qty).toBe(0);
    expect(good.lines.find((l) => l.key === lineKey('w1', 'cellulose', 'labor'))!.hours).toBe(0);
    const r = shown(zeroBags);
    expect(r.options.map((o) => o.tier)).toEqual(['better', 'best']);
    expect(r.warnings.find((w) => w.code === 'product_zero')!.message).toBe('Walls: Good installs no blown cellulose (its quantity is 0).');
    expect(r.warnings.find((w) => w.code === 'option_hidden' && w.tier === 'good')!.message).toBe(
      'Good is not shown to the customer: it installs nothing. Change the quantity in Details to show it.',
    );
    expect(violations(zeroBags)).toEqual([]);
  });

  it('0 bags and 0 hours on every option: no $0 work item; the options that still air seal say only that', () => {
    const a = area({ id: 'a1' });
    const input = estimate({
      areas: [a],
      lineOverrides: {
        [lineKey('a1', 'cellulose', 'material')]: { qty: 0, reason: 'Counted on site', tier: null },
        [lineKey('a1', 'cellulose', 'labor')]: { hours: 0, reason: 'Crew estimate', tier: null },
      },
    });
    const items = all(input).options.flatMap((o) => o.customerItems.filter((i) => i.kind === 'work'));
    expect(items.filter((i) => i.price === 0)).toEqual([]);
    expect(tier(all(input), 'better').label).toBe('Air Sealing');
    expect(violations(input)).toEqual([]);
  });

  it('rim joist 200 sq ft, Best set to 0 board ft: no "Closed-Cell Spray Foam to R-0" for $1,500', () => {
    const rim = area({ id: 'r1', jobType: 'rim_joist', name: 'Rim', sqft: 200 });
    const input = estimate({ areas: [rim], lineOverrides: { [lineKey('r1', 'ccsf', 'material')]: { qty: 0, reason: 'Counted on site', tier: 'best' } } });
    const r = shown(input);
    for (const o of r.options) expect(work(o).join(' ')).not.toMatch(/R-0\b/);
    expect(r.options.map((o) => o.tier)).not.toContain('best');
    expect(violations(input)).toEqual([]);
  });
});

describe('F5 (OD6): two options with different materials are not "the same work"', () => {
  // The owner sets the crawlspace Better template to R-30 batts and prices them above the R-19 batt.
  const snap: PricingSnapshot = structuredClone(snapshot);
  Object.assign(snap.tierTemplates.find((x) => x.jobType === 'crawlspace' && x.tier === 'better')!, {
    label: 'Fiberglass Batts R-30',
    primaryProduct: 'batts',
    targetR: 30,
    includeAirSealing: false,
  });
  snap.materials.find((m) => m.rValue === 30)!.costPerUnit = 1.1;
  const input = estimate({ areas: [area({ id: 'c1', jobType: 'crawlspace', name: 'Crawlspace', sqft: 800 })] });

  it('Good (R-19 batts) and Better (R-30 batts) are both shown; Better is no longer hidden as the same work', () => {
    expect(work(tier(all(input, snap), 'good'))[0]).toContain('R-19');
    expect(work(tier(all(input, snap), 'better'))[0]).toContain('R-30');
    const r = shown(input, snap);
    // Before: "Better is not shown to the customer: it is the same work as Good for more ($2,830 against $2,270)."
    expect(r.warnings.filter((w) => w.code === 'option_hidden')).toEqual([]);
    expect(r.options.map((o) => [o.tier, o.price])).toEqual([
      ['good', 2270],
      ['better', 2830],
      ['best', 4660],
    ]);
  });
});

describe('F6 (L7): install hours are the model hours, multiplied in the same order as before the money stage', () => {
  it('attic 2,625 sq ft extreme to R-49 + attic 275 sq ft difficult, 67 min: Good 44.88 h and $10,815, as daymark priced it', () => {
    const areas = [area({ id: 'a1', sqft: 2625, targetR: 49, accessLevel: 'extreme' }), area({ id: 'a2', name: 'Attic 2', sqft: 275, accessLevel: 'difficult' })];
    const good = tier(all(estimate({ areas, driveMinutesOneWay: 67 })), 'good');
    // 2 h setup + 178.6458 bags x 0.15 h x 1.6 = 44.875 h: 44.88 h. Multiplied as 178.6458 x (0.15 x 1.6) it
    // came to 44.874999… h, 44.87 h and $10,810.
    expect(good.lines.find((l) => l.kind === 'labor' && l.areaId === 'a1')!.hours).toBe(44.88);
    expect(good.price).toBe(10815);
  });
});

describe('F11 (L23b): an R the cavity caps is never stated above what the cavity holds', () => {
  it('commercial 16,032.4 sq ft, 10.7 in cavity with 8.6 in of vermiculite (R-19), Best closed-cell: R-32.6, not R-32.7', () => {
    // The cavity holds 19 + 2.1 in x 6.5 = R-32.65; rounding half up stated R-32.7 (random quote 8ebd36f3, seed 99999).
    const a = area({ id: 'm1', jobType: 'commercial', name: 'Commercial area', sqft: 16032.4, currentR: 19, targetR: 38, existingMaterial: 'Vermiculite', existingDepthIn: 8.6, depthIn: 10.7 });
    const input = estimate({ areas: [a] });
    expect(work(tier(all(input), 'best'))).toEqual(['Closed-Cell Spray Foam to R-32.6 (~2.1 in added, fills the 10.7 in cavity), 16,032 sq ft']);
    expect(violations(input)).toEqual([]);
  });

  it('walls 2x4, open-cell fills the 3.5 in cavity: 3.5 in x 3.7 = R-12.95 reads R-12.9 (was R-13)', () => {
    const walls = area({ id: 'w1', jobType: 'walls', name: 'Walls', depthIn: 3.5 });
    expect(work(tier(all(estimate({ areas: [walls] })), 'better'))).toEqual(['Open-Cell Spray Foam to R-12.9 (fills the 3.5 in cavity), 1,000 sq ft']);
  });

  it('an R the cavity does not cap still rounds to the nearest 0.1: attic Good 37 bags reads R-24.7', () => {
    const r = all(estimate({ lineOverrides: { [lineKey('a1', 'cellulose', 'material')]: { qty: 37, reason: 'Counted on site', tier: 'good' } } }));
    expect(work(tier(r, 'good'))).toEqual(['Blown Cellulose to R-24.7 (~6.9" added), 1,000 sq ft']);
  });
});
