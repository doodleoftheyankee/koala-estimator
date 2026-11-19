// Phase 1 accuracy: the engine's money lines and option rules (docs/accuracy/ledger.txt, stage
// "money": L1-L7, L14-L17). Examples use the pricing a new database starts with
// (__fixtures__/migrationSeed.ts), so the numbers here are the numbers a quote gets today.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDeviationFlags } from '@/lib/learning/deviation';
import { observationsFromJob } from '@/lib/learning/observations';
import { priceEstimate, stepUp, workSignature } from './engine';
import {
  ACCESS_LEVELS,
  JOB_TYPES,
  lineKey,
  type AreaInput,
  type EstimateInput,
  type PricedEstimate,
  type PricedOption,
  type PricingSnapshot,
  type Tier,
} from './types';
import { seededArea as area, seededCoefficients as coeffs, seededEstimate as estimate, seededSnapshot as snapshot } from './__fixtures__/migrationSeed';
import * as hand from './__fixtures__/seed';

const all = (input: EstimateInput, s: PricingSnapshot = snapshot) => priceEstimate(input, s, coeffs, { showAll: true });
const shown = (input: EstimateInput, s: PricingSnapshot = snapshot) => priceEstimate(input, s, coeffs);
const tier = (r: PricedEstimate, t: Tier): PricedOption => {
  const o = r.options.find((x) => x.tier === t);
  if (!o) throw new Error(`no ${t} option`);
  return o;
};
const tiers = (r: PricedEstimate) => r.options.map((o) => o.tier);
/** [kind, description, price] for each customer line. */
const items = (o: PricedOption) => o.customerItems.map((i) => [i.kind, i.description, i.price] as const);
const work = (o: PricedOption) => o.customerItems.filter((i) => i.kind === 'work');
const total = (o: PricedOption) => o.customerItems.reduce((a, i) => a + i.price, 0);

describe('L1 (S1-F3, OD2): each item is priced from its own cost; the rest is Travel and setup', () => {
  // Attic 1,200 sq ft at R-19, old insulation to come out, 20 min drive.
  const r = shown(estimate({ areas: [area({ sqft: 1200, currentR: 19, existingMaterial: 'fiberglass', removalNeeded: true })] }));
  const good = tier(r, 'good');
  const better = tier(r, 'better');

  it('the same removal costs the same in every option; travel and setup is its own line', () => {
    // Before: the removal was $2,720.15 in Good and $2,735.84 in Better (a share of each total).
    const removal = (o: PricedOption) => work(o).find((i) => i.description.startsWith('Remove'))!.price;
    expect(removal(good)).toBe(2483); // ($875 labor + $420 disposal) x 1.63 / 0.85, to the dollar
    expect(removal(better)).toBe(2483);
    expect(items(good)).toEqual([
      ['work', 'Remove and dispose of existing insulation (1,200 sq ft)', 2483],
      ['work', 'Blown Cellulose to R-49 (~13.6" added), 1,200 sq ft', 3345],
      ['travel', 'Travel and setup', 557],
    ]);
    // The totals do not move.
    expect(good.price).toBe(6385);
    expect(better.price).toBe(8010);
  });

  it('the same insulation and air sealing cost the same in Better and Best', () => {
    const best = tier(all(estimate({ areas: [area({ sqft: 1200, currentR: 19, existingMaterial: 'fiberglass', removalNeeded: true })] })), 'best');
    expect(work(best)).toEqual(work(better));
    expect(work(better).map((i) => i.price)).toEqual([2483, 4040, 746]);
  });
});

describe('L2 (OD2): the minimum job charge is its own line', () => {
  const walls = (s: PricingSnapshot = snapshot) => tier(shown(estimate({ areas: [area({ name: 'Walls', jobType: 'walls', sqft: 1000, depthIn: 3.5 })] }), s), 'good');

  it('a job under the minimum shows its work, travel and the top-up to the minimum', () => {
    // Before: one item, $1,500.
    expect(items(walls())).toEqual([
      ['work', 'Blown Cellulose to R-12.6 (~3.5" added), 1,000 sq ft', 820],
      ['travel', 'Travel and setup', 190],
      ['minimum', 'Minimum job charge', 490],
    ]);
    expect(walls().price).toBe(1500);
  });

  it('with the dense-pack wall coverage of 122.5 sq ft x in per bag, the record example reads $1,254 + $186 + $60', () => {
    // The accuracy record priced walls with the dense-pack bag (31 bags, a later stage's row).
    const dense = { ...snapshot, materials: snapshot.materials.map((m) => (m.productCode === 'cellulose' ? { ...m, coverageSqftIn: 122.5 } : m)) };
    expect(walls(dense).customerItems.map((i) => [i.kind, i.price])).toEqual([
      ['work', 1254],
      ['travel', 186],
      ['minimum', 60],
    ]);
  });
});

describe('L3 (OD3): an estimator price is a Price adjustment line; items keep their prices', () => {
  it('Better set to $3,000 keeps its items and shows the change', () => {
    // Attic 900 sq ft at R-19. Before: items $2,373.44 + $626.56 (the $3,000 shared out).
    const better = tier(shown(estimate({ areas: [area({ sqft: 900, currentR: 19 })], overrides: { better: { price: 3000, reason: 'Matched a competitor' } } })), 'better');
    expect(items(better)).toEqual([
      ['work', 'Blown Cellulose to R-60 (~11.4" added), 900 sq ft', 2153],
      ['work', 'Air sealing of top plates, penetrations and bypasses (900 sq ft)', 568],
      ['travel', 'Travel and setup', 374],
      ['adjustment', 'Price adjustment', -95],
    ]);
    expect(better.adjustedPrice).toBe(3095);
    expect(better.price).toBe(3000);
    expect(total(better)).toBe(3000);
  });

  it('a price raised by hand shows a positive adjustment', () => {
    const good = tier(shown(estimate({ overrides: { good: { price: 3100, reason: 'Steep roof' } } })), 'good');
    expect(good.adjustedPrice).toBe(2995);
    expect(good.customerItems.at(-1)).toEqual({ kind: 'adjustment', areaId: null, areaName: '', description: 'Price adjustment', price: 105 });
    expect(total(good)).toBe(3100);
  });
});

describe('L4 (S1-F2): printed whole-dollar items add up to the printed total', () => {
  it('printed items add up to the printed total (S1-F2)', () => {
    // Garage 1,002 sq ft (difficult) + crawlspace 368 sq ft, Best. Before: $6,154 + $2,072 + $283
    // = $8,509 printed under an $8,510 total.
    const input = estimate({
      areas: [area({ id: 'g1', name: 'Garage', jobType: 'garage', sqft: 1002, accessLevel: 'difficult' }), area({ id: 'c1', name: 'Crawlspace', jobType: 'crawlspace', sqft: 368 })],
    });
    const best = tier(shown(input), 'best');
    expect(best.customerItems.map((i) => [i.kind, i.price])).toEqual([
      ['work', 5482],
      ['work', 1846],
      ['work', 252],
      ['travel', 930],
    ]);
    expect(best.price).toBe(8510);
    expect(total(best)).toBe(8510);
  });

  const areaArb: fc.Arbitrary<AreaInput> = fc.record({
    id: fc.uuid(),
    name: fc.constant('Area'),
    jobType: fc.constantFrom(...JOB_TYPES),
    sqft: fc.double({ min: 0.3, max: 20000, noNaN: true }),
    currentR: fc.constantFrom(0, 0, 11, 19, 30, 38, 60),
    targetR: fc.option(fc.constantFrom(13, 19, 30, 38, 49, 60), { nil: null }),
    existingMaterial: fc.constant(null),
    existingDepthIn: fc.constant(null),
    depthIn: fc.option(fc.constantFrom(3.5, 5.5, 7.25), { nil: null }),
    accessLevel: fc.constantFrom(...ACCESS_LEVELS),
    removalNeeded: fc.boolean(),
    prepNotes: fc.constant(null),
  });
  const priceArb = fc.option(fc.record({ price: fc.double({ min: 0, max: 60000, noNaN: true }), reason: fc.constant('typed') }), { nil: undefined });
  const inputArb: fc.Arbitrary<EstimateInput> = fc.record({
    areas: fc.array(areaArb, { minLength: 1, maxLength: 4 }),
    crewId: fc.constant(null),
    driveMinutesOneWay: fc.option(fc.integer({ min: 0, max: 180 }), { nil: null }),
    overrides: fc.record({ good: priceArb, better: priceArb, best: priceArb }, { requiredKeys: [] }).map((o) =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
    ),
  });

  it('every customer line is whole dollars, only the adjustment can be negative, and the lines add up', () => {
    fc.assert(
      fc.property(inputArb, fc.constantFrom(0, 1, 5, 25), (input, rounding) => {
        const s = { ...snapshot, settings: { ...snapshot.settings, priceRounding: rounding } };
        for (const o of all(input, s).options) {
          expect(Number.isInteger(o.price)).toBe(true);
          for (const i of o.customerItems) {
            expect(Number.isInteger(i.price)).toBe(true);
            if (i.kind !== 'adjustment') expect(i.price).toBeGreaterThanOrEqual(0);
            expect(i.price).not.toBe(0);
          }
          expect(total(o)).toBe(o.price);
          expect(o.customerItems.filter((i) => i.kind === 'work').length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('the same work is the same price in every option, whatever the drive and the overrides', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const seen = new Map<string, number>();
        for (const o of all(input).options) {
          for (const i of work(o)) {
            // The description names the product, the R-value and the size: the same text is the same work.
            const key = `${i.areaId}|${i.description}`;
            if (seen.has(key)) expect(i.price).toBe(seen.get(key));
            else seen.set(key, i.price);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('L5 (S1-F1, OD4): prices are whole dollars', () => {
  it('a price change is whole dollars (S1-F1, OD4)', () => {
    const good = tier(shown(estimate({ overrides: { good: { price: 4321.5, reason: 'Matched a competitor' } } })), 'good');
    expect(good.price).toBe(4322); // before: $4,321.50
    expect(good.customerItems.at(-1)).toMatchObject({ kind: 'adjustment', price: 1327 }); // from the $2,995 model price
    expect(total(good)).toBe(4322);
  });

  it('the deviation note quotes the whole-dollar price', () => {
    // Attic 800 sq ft at R-19: Best (removal, air sealing, cellulose) is $5,480 by the model.
    const input = estimate({ areas: [area({ sqft: 800, currentR: 19, existingMaterial: 'fiberglass' })], overrides: { best: { price: 7224.5, reason: 'Two trips' } } });
    const flag = computeDeviationFlags(shown(input), input, { snapshot, coefficientSet: coeffs }).find((f) => f.metric === 'total_price')!;
    expect(flag.message).toBe('Best option price 32% above model: you are quoting $7,225, the model price is $5,480.'); // before: $7,224.50
  });

  it('the price step is at least $1: a rounding of 0 prices to the dollar', () => {
    const s = { ...snapshot, settings: { ...snapshot.settings, priceRounding: 0 } };
    const good = tier(shown(estimate(), s), 'good');
    expect(good.price).toBe(2991); // before: $2,990.92 ($2,542.28 loaded cost / 0.85, up to the cent)
    expect(total(good)).toBe(2991);
  });
});

describe('L6 (R7): a price under $1 is not used', () => {
  it('a price under $1 is not used; the estimator is told (R7)', () => {
    const r = shown(estimate({ areas: [area({ sqft: 900 })], overrides: { good: { price: 0.4, reason: 'typo' } } }));
    const good = tier(r, 'good');
    expect(good.price).toBe(2735); // before: $0.40, printed "$0"
    expect(good.isOverridden).toBe(false);
    expect(good.customerItems.some((i) => i.kind === 'adjustment')).toBe(false);
    expect(r.warnings.find((w) => w.code === 'override_too_low')).toEqual({
      code: 'override_too_low',
      areaId: null,
      tier: 'good',
      message: 'Good price $0.40 is under $1, so it is not used. The price stays $2,735.',
    });
  });

  it('$1 is a price', () => {
    const good = tier(all(estimate({ overrides: { good: { price: 1, reason: 'gift' } } })), 'good');
    expect(good.price).toBe(1);
    expect(good.isOverridden).toBe(true);
  });
});

describe('L7 (S1-F3, R3): install labor is priced for the quantity priced', () => {
  const FG_MAT = lineKey('a1', 'fiberglass_blown', 'material');

  it('more bags take more install hours; the model hours stay the model', () => {
    // Hand-made fixture: 1,000 sq ft attic, Good blown fiberglass, 58 bags and 10 h by the model.
    const before = tier(priceEstimate(hand.estimate(), hand.snapshot, hand.coefficients, { showAll: true }), 'good');
    const r = priceEstimate(hand.estimate({ lineOverrides: { [FG_MAT]: { qty: 70, reason: 'Deep bays', tier: 'good' } } }), hand.snapshot, hand.coefficients, { showAll: true });
    const labor = tier(r, 'good').lines.find((l) => l.key === lineKey('a1', 'fiberglass_blown', 'labor'))!;
    expect(labor).toMatchObject({ hours: 11.72, modelHours: 10, cost: 468.8, modelCost: 400, isOverridden: false }); // before: 10 h
    expect(tier(r, 'good').directCost).toBeCloseTo(before.directCost + 456 + 68.8, 6); // 12 bags x $38, 1.72 h x $40
  });

  it('the estimator’s own hours still win', () => {
    const r = priceEstimate(
      hand.estimate({ lineOverrides: { [FG_MAT]: { qty: 70, reason: 'Deep bays', tier: 'good' }, [lineKey('a1', 'fiberglass_blown', 'labor')]: { hours: 9, reason: 'Two blowers' } } }),
      hand.snapshot,
      hand.coefficients,
      { showAll: true },
    );
    expect(tier(r, 'good').lines.find((l) => l.kind === 'labor')).toMatchObject({ hours: 9, modelHours: 10, isOverridden: true });
  });

  it('the learning loop reads the hours priced for the estimator’s bags', () => {
    // 1,000 sq ft attic, difficult access, Better cellulose: 90 bags and 18.88 h by the model.
    const input = hand.estimate({ areas: [hand.area({ accessLevel: 'difficult' })], lineOverrides: { [lineKey('a1', 'cellulose', 'material')]: { qty: 95, reason: 'Uneven joists' } } });
    const options = priceEstimate(input, hand.snapshot, hand.coefficients).options;
    const { observations } = observationsFromJob({
      jobId: 'j1',
      completedAt: '2026-10-01T16:00:00Z',
      signedTier: 'better',
      snapshot: { options },
      areasFallback: [{ id: 'a1', name: 'Main attic', jobType: 'attic', accessLevel: 'difficult', sqft: 1000 }],
      actuals: [{ areaId: 'a1', product: 'cellulose', actualMaterialQty: 92, actualHours: 20, actualDriveMinutes: null }],
      driveMinutesEstFallback: null,
    });
    expect(observations[0]).toMatchObject({ estQty: 95, modelHours: 18.88, estHours: 19.81 }); // before: estHours 18.88
  });

  it('an air-sealing quantity moves the air-sealing labor the same way', () => {
    const key = lineKey('a1', 'air_sealing', 'material');
    const r = all(estimate({ lineOverrides: { [key]: { qty: 1500, reason: 'Knee walls' } } }));
    expect(tier(r, 'better').lines.find((l) => l.key === lineKey('a1', 'air_sealing', 'labor'))).toMatchObject({ modelHours: 6.5, hours: 9.5 });
  });
});

describe('L14 (OD6, S1-F7, RF-03): only options that step up are shown', () => {
  it('Best that repeats Better is not shown, and the estimator is told', () => {
    // Attic 1,200 sq ft at R-0: Best's removal has nothing to remove, so Best is Better again.
    const input = estimate({ areas: [area({ sqft: 1200 })] });
    const r = shown(input);
    expect(tiers(r)).toEqual(['good', 'better']); // before: Best $5,160 shown next to Better $5,160
    expect(r.warnings.filter((w) => w.code === 'option_hidden')).toEqual([
      { code: 'option_hidden', areaId: null, tier: 'best', message: 'Best is not shown to the customer: it is the same work as Better.' },
    ]);
    // Asked for, every option is there, at the same prices.
    const every = all(input);
    expect(tiers(every)).toEqual(['good', 'better', 'best']);
    expect(tier(every, 'best').price).toBe(5160);
    expect(tier(every, 'better').price).toBe(tier(r, 'better').price);
  });

  it('options that all cost the same show only the one that does the most', () => {
    // A small rim joist: all three options sit at the $1,500 minimum.
    const r = shown(estimate({ areas: [area({ name: 'Rim', jobType: 'rim_joist', sqft: 150 })] }));
    expect(tiers(r)).toEqual(['best']);
    expect(r.warnings.filter((w) => w.code === 'option_hidden').map((w) => w.message)).toEqual([
      'Better is not shown to the customer: it costs the same as Best ($1,500), the next option up.',
      'Good is not shown to the customer: it costs the same as Best ($1,500), the next option up.',
    ]);
  });

  it('an option the estimator priced above the next one up is hidden, and says how to show it', () => {
    const r = shown(estimate({ overrides: { good: { price: 4500, reason: 'Hard access' } } }));
    expect(tiers(r)).toEqual(['better']);
    expect(r.warnings.find((w) => w.code === 'option_hidden' && w.tier === 'good')!.message).toBe(
      'Good is not shown to the customer: it costs $4,500, more than Better ($4,390), the next option up. Change its price to show it.',
    );
  });

  it('of two options with the same work, the cheaper one is shown', () => {
    const r = shown(estimate({ overrides: { better: { price: 5000, reason: 'x' }, best: { price: 4800, reason: 'y' } } }));
    expect(tiers(r)).toEqual(['good', 'best']);
    expect(r.warnings.find((w) => w.tier === 'better')!.message).toBe(
      'Better is not shown to the customer: it is the same work as Best for more ($5,000 against $4,800). Change its price or its work to show it.',
    );
  });

  it('stepUp and workSignature say what a step up is', () => {
    const every = all(estimate({ areas: [area({ sqft: 1200 })] }));
    const [good, better, best] = [tier(every, 'good'), tier(every, 'better'), tier(every, 'best')];
    expect(workSignature(better)).toBe(workSignature(best));
    expect(workSignature(good)).not.toBe(workSignature(better));
    expect(stepUp(good, better)).toBe(true);
    expect(stepUp(better, best)).toBe(false); // same work
    expect(stepUp(good, { ...better, price: good.price })).toBe(false); // same price
    expect(stepUp(good, { ...better, price: good.price + 1 })).toBe(true);
  });

  it('the price the phone shows is the price the server keeps: hiding never changes a price', () => {
    fc.assert(
      fc.property(fc.constantFrom(...JOB_TYPES), fc.integer({ min: 1, max: 5000 }), fc.constantFrom(0, 11, 19, 30, 49), fc.boolean(), (jobType, sqft, currentR, removalNeeded) => {
        const input = estimate({ areas: [area({ jobType, sqft, currentR, removalNeeded })] });
        const every = all(input);
        const visible = shown(input);
        for (const o of visible.options) expect(o).toEqual(tier(every, o.tier));
        expect(visible.options.length > 0).toBe(every.options.length > 0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('L15 (S1-F7, R2, R6): titles and bullets come from the work priced', () => {
  it('a target below code is not called "to Code"', () => {
    // Attic at R-11, the estimator's target R-30 (code R-49).
    const good = tier(shown(estimate({ areas: [area({ currentR: 11, targetR: 30 })] })), 'good');
    expect(good.label).toBe('Blown Cellulose to R-30'); // before: "Blown Cellulose to Code"
    expect(good.bullets).toEqual(['Dense cellulose fills gaps and blocks air movement']); // the code bullet is gone
  });

  it('at code it is still "to Code"', () => {
    expect(tier(shown(estimate()), 'good').label).toBe('Blown Cellulose to Code');
  });

  it('an option that only air seals says so (R2, E2 and E3)', () => {
    // An attic already at R-60: Better's cellulose adds nothing, only the air sealing is priced.
    const better = tier(shown(estimate({ areas: [area({ currentR: 60, existingMaterial: 'cellulose' })] })), 'better');
    expect(better.label).toBe('Air Sealing'); // before: "Air Seal + Blown Cellulose"
    expect(better.bullets).toEqual(['Seals the leaks that drive drafts and high bills']);
    // A crawlspace already at R-19: Best's closed-cell foam adds nothing.
    const best = tier(shown(estimate({ areas: [area({ name: 'Crawl', jobType: 'crawlspace', sqft: 800, currentR: 19 })] })), 'best');
    expect(best.label).toBe('Air Sealing'); // before: "Closed-Cell Foam + Air Sealing"
    expect(best.bullets).toEqual(['Every penetration sealed']);
  });

  it('"Remove" is said only when removal is priced', () => {
    const best = tier(all(estimate()), 'best'); // nothing to remove
    expect(best.label).toBe('Air Sealing + Blown Cellulose'); // before: "Remove, Air Seal + Cellulose"
    expect(best.bullets).toEqual(['Full air sealing before new insulation', 'Best comfort and efficiency']);
    const withRemoval = tier(shown(estimate({ areas: [area({ currentR: 19, existingMaterial: 'fiberglass' })] })), 'best');
    expect(withRemoval.label).toBe('Remove, Air Seal + Cellulose');
    expect(withRemoval.bullets[0]).toBe('Old, dirty or damaged insulation removed');
  });

  it('a package only carries bullets of areas with work in it (R2)', () => {
    // The attic is already at R-60: Good has work only in the walls.
    const good = tier(
      shown(estimate({ areas: [area({ currentR: 60, existingMaterial: 'cellulose' }), area({ id: 'w1', name: 'Walls', jobType: 'walls', depthIn: 3.5 })] })),
      'good',
    );
    expect(good.label).toBe('Good package');
    expect(good.bullets).toEqual(['Installed from outside or inside with minimal disruption', 'Fills the full cavity']); // before: the attic's two bullets too
  });
});

describe('L16 (S3-F20): air sealing says where it is done', () => {
  it('air sealing says where it is done (S3-F20)', () => {
    const best = tier(shown(estimate({ areas: [area({ name: 'Crawl', jobType: 'crawlspace', sqft: 800 })] })), 'best');
    // before: "Air sealing of top plates, penetrations and bypasses (800 sq ft)"
    expect(work(best)[1]!.description).toBe('Air sealing of the rim, penetrations and gaps in the floor above (800 sq ft)');
    expect(work(tier(shown(estimate()), 'better'))[1]!.description).toBe('Air sealing of top plates, penetrations and bypasses (1,000 sq ft)');
  });
});

describe('L17 (S3-F23): areas under 10 sq ft keep one decimal', () => {
  it('a tiny area never reads "0 sq ft" (S3-F23)', () => {
    const better = tier(shown(estimate({ areas: [area({ sqft: 0.3 })] })), 'better');
    expect(work(better).map((i) => i.description)).toEqual([
      'Blown Cellulose to R-60 (~16.7" added), 0.3 sq ft', // before: "0 sq ft"
      'Air sealing of top plates, penetrations and bypasses (0.3 sq ft)',
    ]);
    expect(work(tier(all(estimate({ areas: [area({ sqft: 12.4, removalNeeded: true })] })), 'good'))[0]!.description).toBe(
      'Remove and dispose of existing insulation (12 sq ft)',
    );
  });
});
