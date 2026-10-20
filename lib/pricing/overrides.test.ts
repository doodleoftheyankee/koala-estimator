// Phase 2 engine behaviour: estimator line overrides (qty on material lines, hours on
// labor/removal lines), and the three prices: modelPrice (pure model), adjustedPrice (with line
// overrides) and price (the customer price override, else adjustedPrice).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { priceEstimate } from './engine';
import { canSendQuote } from './policy';
import { ACCESS_LEVELS, JOB_TYPES, lineKey, type EstimateInput, type LineOverride, type PricedEstimate, type Tier } from './types';
import { area, coefficients, estimate, snapshot } from './__fixtures__/seed';

const price = (input: EstimateInput) => priceEstimate(input, snapshot, coefficients);
const tier = (r: PricedEstimate, t: Tier) => {
  const o = r.options.find((x) => x.tier === t);
  if (!o) throw new Error(`no ${t} option`);
  return o;
};
const withLines = (lineOverrides: Record<string, LineOverride>, base: Partial<EstimateInput> = {}) =>
  estimate({ ...base, lineOverrides });

const FG_MAT = lineKey('a1', 'fiberglass_blown', 'material'); // good: 58 bags x $38
const FG_LABOR = lineKey('a1', 'fiberglass_blown', 'labor'); // good: 10 h x $40
const CEL_LABOR = lineKey('a1', 'cellulose', 'labor'); // better and best: 14.5 h
const REMOVAL = lineKey('a1', 'removal', 'removal');

const plain = price(estimate());

describe('lineKey', () => {
  it('is area|product|kind', () => {
    expect(lineKey('a1', 'cellulose', 'labor')).toBe('a1|cellulose|labor');
  });

  it('keys every area line and no job-level line', () => {
    const r = price(estimate({ areas: [area({ removalNeeded: true }), area({ id: 'a2', name: 'Walls', jobType: 'walls' })] }));
    for (const o of r.options) {
      for (const l of o.lines) {
        if (l.kind === 'drive' || l.kind === 'disposal') expect(l.key).toBeNull();
        else expect(l.key).toBe(lineKey(l.areaId!, l.product!, l.kind));
      }
    }
  });
});

describe('line overrides change cost and price', () => {
  it('a qty override on a material line', () => {
    const r = price(withLines({ [FG_MAT]: { qty: 70, reason: 'Deep joist bays' } }));
    const good = tier(r, 'good');
    const mat = good.lines.find((l) => l.key === FG_MAT)!;
    expect(mat).toMatchObject({ qty: 70, cost: 2660, modelQty: 58, modelCost: 2204, designQty: 53.33, isOverridden: true, overrideReason: 'Deep joist bays' });
    expect(good.materialCost).toBe(2660);
    expect(good.directCost).toBe(tier(plain, 'good').directCost + 456);
    expect(good.modelPrice).toBe(5420);
    expect(good.adjustedPrice).toBeGreaterThan(5420);
    expect(good.price).toBe(good.adjustedPrice);
    expect(good.hasLineOverrides).toBe(true);
    expect(good.isOverridden).toBe(false);
    // Other tiers have no fiberglass line and are untouched.
    expect(tier(r, 'better')).toEqual(tier(plain, 'better'));
  });

  it('an hours override on a labor line', () => {
    const good = tier(price(withLines({ [FG_LABOR]: { hours: 15, reason: 'Low clearance' } })), 'good');
    const labor = good.lines.find((l) => l.key === FG_LABOR)!;
    expect(labor).toMatchObject({ hours: 15, qty: 15, cost: 600, modelHours: 10, modelCost: 400, isOverridden: true });
    expect(good.laborHours).toBe(tier(plain, 'good').laborHours + 5);
    expect(good.laborCost).toBe(600);
    expect(good.modelPrice).toBe(5420);
    expect(good.price).toBeGreaterThan(5420);
  });

  it('an hours override on a removal line, in every tier that has it', () => {
    const base = { areas: [area({ removalNeeded: true })] };
    const before = price(estimate(base));
    const r = price(withLines({ [REMOVAL]: { hours: 40, reason: 'Wet insulation' } }, base));
    for (const t of ['good', 'better', 'best'] as const) {
      const o = tier(r, t);
      const line = o.lines.find((l) => l.key === REMOVAL)!;
      expect(line).toMatchObject({ hours: 40, modelHours: 21, cost: 1600, isOverridden: true });
      expect(o.modelPrice).toBe(tier(before, t).price);
      expect(o.adjustedPrice).toBeGreaterThan(o.modelPrice);
    }
  });

  it('applies one override to the same line in every tier', () => {
    const r = price(withLines({ [CEL_LABOR]: { hours: 20, reason: 'r' } }));
    expect(tier(r, 'better').lines.find((l) => l.key === CEL_LABOR)!.hours).toBe(20);
    expect(tier(r, 'best').lines.find((l) => l.key === CEL_LABOR)!.hours).toBe(20);
    expect(tier(r, 'good').hasLineOverrides).toBe(false);
  });

  it('rounds override hours to hundredths', () => {
    const good = tier(price(withLines({ [FG_LABOR]: { hours: 12.3456, reason: 'r' } })), 'good');
    expect(good.lines.find((l) => l.key === FG_LABOR)!.hours).toBe(12.35);
  });

  it('a zero override is valid (e.g. materials already on site)', () => {
    const good = tier(price(withLines({ [FG_MAT]: { qty: 0, reason: 'Customer supplied' } })), 'good');
    expect(good.lines.find((l) => l.key === FG_MAT)).toMatchObject({ qty: 0, cost: 0, isOverridden: true });
  });
});

describe('modelPrice, adjustedPrice and price', () => {
  it('modelPrice is the pure model price for every tier, whatever the overrides', () => {
    const r = price(withLines({ [FG_MAT]: { qty: 90, reason: 'r' }, [CEL_LABOR]: { hours: 30, reason: 'r' } }, { overrides: { best: { price: 9999, reason: 'r' } } }));
    for (const o of r.options) expect(o.modelPrice).toBe(tier(plain, o.tier).price);
  });

  it('adjustedPrice includes the line overrides; price = price override ?? adjustedPrice', () => {
    const lines = { [CEL_LABOR]: { hours: 30, reason: 'r' } };
    const linesOnly = tier(price(withLines(lines)), 'better');
    const both = tier(price(withLines(lines, { overrides: { better: { price: 7000, reason: 'Rush' } } })), 'better');
    expect(both.adjustedPrice).toBe(linesOnly.adjustedPrice);
    expect(both.price).toBe(7000);
    expect(both.isOverridden).toBe(true);
    expect(both.overrideReason).toBe('Rush');
    expect(both.modelPrice).toBe(tier(plain, 'better').price);
    expect(linesOnly.price).toBe(linesOnly.adjustedPrice);
  });

  it('without any override all three prices agree', () => {
    for (const o of plain.options) {
      expect(o.modelPrice).toBe(o.adjustedPrice);
      expect(o.price).toBe(o.adjustedPrice);
      expect(o.hasLineOverrides).toBe(false);
      expect(o.lines.every((l) => !l.isOverridden && l.overrideReason === null)).toBe(true);
    }
  });
});

describe('invalid line overrides are ignored', () => {
  const cases: Array<[string, LineOverride]> = [
    ['negative qty', { qty: -5, reason: 'r' }],
    ['NaN qty', { qty: NaN, reason: 'r' }],
    ['infinite qty', { qty: Infinity, reason: 'r' }],
    ['null qty', { qty: null, reason: 'r' }],
    ['no value at all', { reason: 'r' }],
    ['hours on a material line', { hours: 99, reason: 'r' }],
  ];
  for (const [name, ov] of cases) {
    it(name, () => {
      expect(price(withLines({ [FG_MAT]: ov }))).toEqual(plain);
    });
  }

  it('qty on a labor line, negative hours, and unknown keys', () => {
    expect(price(withLines({ [FG_LABOR]: { qty: 99, reason: 'r' } }))).toEqual(plain);
    expect(price(withLines({ [FG_LABOR]: { hours: -1, reason: 'r' } }))).toEqual(plain);
    expect(price(withLines({ [FG_LABOR]: { hours: NaN, reason: 'r' } }))).toEqual(plain);
    expect(price(withLines({ 'zz|cellulose|labor': { hours: 50, reason: 'r' } }))).toEqual(plain);
  });
});

describe('an override equal to the model value changes nothing (property-based)', () => {
  const areaArb = fc.record({
    jobType: fc.constantFrom(...JOB_TYPES),
    sqft: fc.double({ min: 10, max: 20000, noNaN: true }),
    currentR: fc.constantFrom(0, 11, 19, 30),
    accessLevel: fc.constantFrom(...ACCESS_LEVELS),
    removalNeeded: fc.boolean(),
  });

  it('keeps every price and cost, only marks the lines as overridden', () => {
    fc.assert(
      fc.property(fc.array(areaArb, { minLength: 1, maxLength: 3 }), fc.integer({ min: 0, max: 90 }), (areas, drive) => {
        const base = estimate({ areas: areas.map((a, i) => area({ ...a, id: `a${i}`, name: `Area ${i}` })), driveMinutesOneWay: drive });
        const before = price(base);
        for (const o of before.options) {
          // The same key can carry different model values in different tiers, so check one tier at a time.
          const lineOverrides: Record<string, LineOverride> = {};
          for (const l of o.lines) {
            if (!l.key) continue;
            lineOverrides[l.key] = l.kind === 'material' ? { qty: l.modelQty, reason: 'same' } : { hours: l.modelHours, reason: 'same' };
          }
          const after = tier(price({ ...base, lineOverrides }), o.tier);
          expect(after.price).toBe(o.price);
          expect(after.adjustedPrice).toBe(o.adjustedPrice);
          expect(after.modelPrice).toBe(o.modelPrice);
          expect(after.directCost).toBe(o.directCost);
          expect(after.hasLineOverrides).toBe(o.lines.some((l) => l.key !== null));
          expect(after.lines.map((l) => l.cost)).toEqual(o.lines.map((l) => l.cost));
        }
      }),
    );
  });
});

describe('canSendQuote with line overrides', () => {
  const settings = snapshot.settings; // estimators may move the price 10% from the model

  it('applies the estimator limit against the pure model price when only line overrides exist', () => {
    // +6 bags = +$228 direct -> about +8% price: within the limit.
    const near = price(withLines({ [FG_MAT]: { qty: 64, reason: 'Deep bays' } })).options;
    expect(tier({ options: near, warnings: [], crewId: '' }, 'good').hasLineOverrides).toBe(true);
    expect(canSendQuote('estimator', near, settings).ok).toBe(true);

    // +30 bags: well past 10% from the model price.
    const far = price(withLines({ [FG_MAT]: { qty: 88, reason: 'Deep bays' } })).options;
    const good = far.find((o) => o.tier === 'good')!;
    expect(Math.abs(good.price - good.modelPrice) / good.modelPrice).toBeGreaterThan(0.1);
    const r = canSendQuote('estimator', far, settings);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([expect.stringMatching(/^good: price is \d+\.\d% from the model price; estimators may change it up to 10%/)]);
    expect(canSendQuote('office', far, settings).ok).toBe(true);
    expect(canSendQuote('owner', far, settings).ok).toBe(true);
  });

  it('measures a price override against the pure model price, not the line-adjusted one', () => {
    // +12 bags pushes the adjusted price ~17% over the model: blocked on its own...
    const lines = { [FG_MAT]: { qty: 70, reason: 'r' } };
    expect(canSendQuote('estimator', price(withLines(lines)).options, settings).ok).toBe(false);
    // ...but a price override back near the model price (still above the floor margin) is fine.
    const opts = price(withLines(lines, { overrides: { good: { price: 5600, reason: 'Match model' } } })).options;
    expect(tier({ options: opts, warnings: [], crewId: '' }, 'good').belowFloor).toBe(false);
    expect(canSendQuote('estimator', opts, settings).ok).toBe(true);
  });

  it('reports a line override without a reason', () => {
    const opts = price(withLines({ [FG_MAT]: { qty: 60, reason: '  ' } })).options;
    const r = canSendQuote('owner', opts, settings);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['good: "Blown fiberglass bag" was changed without a reason.']);
  });
});
