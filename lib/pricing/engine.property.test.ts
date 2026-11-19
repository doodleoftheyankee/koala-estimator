import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { priceEstimate as priceShown, stepUp, workSignature } from './engine';
import { ACCESS_LEVELS, JOB_TYPES, type AreaInput, type EstimateInput, type PricedEstimate } from './types';
import { coefficients, snapshot } from './__fixtures__/seed';

// Pricing math: every priced option, including those the customer is not shown (OD6).
const priceEstimate = (...args: Parameters<typeof priceShown>) => priceShown(args[0], args[1], args[2], { showAll: true });

const areaArb: fc.Arbitrary<AreaInput> = fc.record({
  id: fc.uuid(),
  name: fc.constant('Area'),
  jobType: fc.constantFrom(...JOB_TYPES),
  sqft: fc.double({ min: 10, max: 20000, noNaN: true }),
  currentR: fc.constantFrom(0, 0, 11, 19, 30, 38),
  targetR: fc.option(fc.constantFrom(13, 19, 30, 38, 49, 60), { nil: null }),
  existingMaterial: fc.constant(null),
  existingDepthIn: fc.constant(null),
  depthIn: fc.option(fc.constantFrom(3.5, 5.5, 7.25, 9.25), { nil: null }),
  accessLevel: fc.constantFrom(...ACCESS_LEVELS),
  removalNeeded: fc.boolean(),
  prepNotes: fc.constant(null),
});

const estimateArb: fc.Arbitrary<EstimateInput> = fc.record({
  areas: fc.array(areaArb, { minLength: 1, maxLength: 4 }),
  crewId: fc.constantFrom(null, 'crew-a', 'crew-b'),
  driveMinutesOneWay: fc.option(fc.integer({ min: 0, max: 120 }), { nil: null }),
  overrides: fc.constant({}),
});

const price = (r: PricedEstimate, tier: string) => r.options.find((o) => o.tier === tier)?.price;

describe('pricing invariants (property-based)', () => {
  it('is deterministic', () => {
    fc.assert(
      fc.property(estimateArb, (input) => {
        expect(priceEstimate(input, snapshot, coefficients)).toEqual(priceEstimate(input, snapshot, coefficients));
      }),
    );
  });

  it('never produces NaN/negative numbers, and every option meets minimum price and target margin', () => {
    fc.assert(
      fc.property(estimateArb, (input) => {
        const r = priceEstimate(input, snapshot, coefficients);
        for (const o of r.options) {
          for (const n of [o.price, o.modelPrice, o.directCost, o.loadedCost, o.laborHours, o.crewDays, o.marginPct]) {
            expect(Number.isFinite(n)).toBe(true);
            expect(n).toBeGreaterThanOrEqual(0);
          }
          for (const l of o.lines) {
            expect(Number.isFinite(l.cost)).toBe(true);
            expect(l.cost).toBeGreaterThanOrEqual(0);
          }
          expect(o.price).toBeGreaterThanOrEqual(snapshot.settings.minimumJobPrice);
          expect(o.marginPct).toBeGreaterThanOrEqual(snapshot.settings.targetMarginPct - 1e-4);
          expect(o.belowFloor).toBe(false);
          expect(o.price % snapshot.settings.priceRounding).toBe(0);
        }
      }),
    );
  });

  it('customer items always sum exactly to the price', () => {
    fc.assert(
      fc.property(estimateArb, (input) => {
        for (const o of priceEstimate(input, snapshot, coefficients).options) {
          const cents = o.customerItems.reduce((a, b) => a + Math.round(b.price * 100), 0);
          expect(cents).toBe(Math.round(o.price * 100));
        }
      }),
    );
  });

  it('OD6: the options shown step up, each one different work for at least $1 more, and every one left out is explained', () => {
    const withPrices = fc.record({
      input: estimateArb,
      prices: fc.array(fc.option(fc.integer({ min: 500, max: 30000 }), { nil: null }), { minLength: 3, maxLength: 3 }),
    });
    fc.assert(
      fc.property(withPrices, ({ input, prices }) => {
        const overrides = Object.fromEntries(
          (['good', 'better', 'best'] as const).flatMap((t, i) => (prices[i] === null ? [] : [[t, { price: prices[i]!, reason: 'typed' }]])),
        );
        const typed = { ...input, overrides };
        const every = priceEstimate(typed, snapshot, coefficients);
        const shown = priceShown(typed, snapshot, coefficients);
        for (let i = 1; i < shown.options.length; i++) {
          expect(stepUp(shown.options[i - 1]!, shown.options[i]!)).toBe(true);
          expect(shown.options[i]!.price).toBeGreaterThanOrEqual(shown.options[i - 1]!.price + 1);
        }
        expect(new Set(shown.options.map(workSignature)).size).toBe(shown.options.length);
        const hidden = every.options.filter((o) => !shown.options.some((s) => s.tier === o.tier)).map((o) => o.tier);
        expect(shown.warnings.filter((w) => w.code === 'option_hidden').map((w) => w.tier).sort()).toEqual([...hidden].sort());
        expect(shown.options.length > 0).toBe(every.options.length > 0);
        expect(shown.warnings.some((w) => w.code === 'tier_price_order')).toBe(false);
      }),
    );
  });

  it('price is monotonic in square footage', () => {
    fc.assert(
      fc.property(estimateArb, fc.double({ min: 1, max: 3, noNaN: true }), (input, factor) => {
        const bigger = { ...input, areas: input.areas.map((a) => ({ ...a, sqft: a.sqft * factor })) };
        const r1 = priceEstimate(input, snapshot, coefficients);
        const r2 = priceEstimate(bigger, snapshot, coefficients);
        for (const o of r1.options) expect(price(r2, o.tier)).toBeGreaterThanOrEqual(o.price);
      }),
    );
  });

  it('price is monotonic in target R', () => {
    fc.assert(
      fc.property(estimateArb, (input) => {
        const low = { ...input, areas: input.areas.map((a) => ({ ...a, targetR: 30 })) };
        const high = { ...input, areas: input.areas.map((a) => ({ ...a, targetR: 60 })) };
        const r1 = priceEstimate(low, snapshot, coefficients);
        const r2 = priceEstimate(high, snapshot, coefficients);
        for (const o of r1.options) {
          const p2 = price(r2, o.tier);
          if (p2 !== undefined) expect(p2).toBeGreaterThanOrEqual(o.price);
        }
      }),
    );
  });

  it('price is monotonic in access difficulty', () => {
    fc.assert(
      fc.property(estimateArb, (input) => {
        let prev: PricedEstimate | null = null;
        for (const level of ACCESS_LEVELS) {
          const r = priceEstimate({ ...input, areas: input.areas.map((a) => ({ ...a, accessLevel: level })) }, snapshot, coefficients);
          if (prev) for (const o of prev.options) expect(price(r, o.tier)).toBeGreaterThanOrEqual(o.price);
          prev = r;
        }
      }),
    );
  });

  it('price is monotonic in drive time', () => {
    fc.assert(
      fc.property(estimateArb, fc.integer({ min: 0, max: 60 }), (input, extra) => {
        const base = { ...input, driveMinutesOneWay: input.driveMinutesOneWay ?? 0 };
        const r1 = priceEstimate(base, snapshot, coefficients);
        const r2 = priceEstimate({ ...base, driveMinutesOneWay: base.driveMinutesOneWay + extra }, snapshot, coefficients);
        for (const o of r1.options) expect(price(r2, o.tier)).toBeGreaterThanOrEqual(o.price);
      }),
    );
  });
});
