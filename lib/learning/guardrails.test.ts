import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyGuardrails, clampToBounds, isSaneValue, stepLimit } from './guardrails';

const s = { minNEff: 3, maxStepPct: 0.1 };
const g = (estimate: number | null, nEff = 10, active = 1, lowerBound = 0.5, upperBound = 2) => ({
  active,
  estimate,
  nEff,
  lowerBound,
  upperBound,
});

describe('stepLimit and clampToBounds', () => {
  it('clamps to ±maxStep of v0', () => {
    expect(stepLimit(1.05, 1, 0.1)).toEqual({ value: 1.05, limited: false });
    expect(stepLimit(1.5, 1, 0.1)).toEqual({ value: 1.1, limited: true });
    expect(stepLimit(0.5, 1, 0.1).value).toBeCloseTo(0.9, 12);
    expect(stepLimit(Number.POSITIVE_INFINITY, 1, 0.1)).toEqual({ value: 1.1, limited: true });
  });

  it('has nothing to limit against without a positive v0, and passes NaN through', () => {
    expect(stepLimit(5, 0, 0.1)).toEqual({ value: 5, limited: false });
    expect(stepLimit(5, Number.NaN, 0.1)).toEqual({ value: 5, limited: false });
    expect(stepLimit(Number.NaN, 1, 0.1).value).toBeNaN();
  });

  it('clamps to bounds', () => {
    expect(clampToBounds(3, 1, 2)).toEqual({ value: 2, clamped: true });
    expect(clampToBounds(0.5, 1, 2)).toEqual({ value: 1, clamped: true });
    expect(clampToBounds(1.5, 1, 2)).toEqual({ value: 1.5, clamped: false });
    expect(clampToBounds(Number.NaN, 1, 2).clamped).toBe(false);
  });

  it('isSaneValue demands finite, positive, within bounds', () => {
    expect(isSaneValue(1, 0.5, 2)).toBe(true);
    expect(isSaneValue(2, 0.5, 2)).toBe(true);
    expect(isSaneValue(2.01, 0.5, 2)).toBe(false);
    expect(isSaneValue(0, -1, 2)).toBe(false);
    expect(isSaneValue(Number.NaN, 0, 2)).toBe(false);
  });
});

describe('applyGuardrails', () => {
  it('holds the active value below the minimum evidence or without an estimate', () => {
    expect(applyGuardrails(g(1.5, 2.9), s)).toEqual({ value: 1, held: true, wasStepLimited: false, wasClamped: false, sane: true });
    expect(applyGuardrails(g(null, 50), s).held).toBe(true);
    expect(applyGuardrails(g(1.5, Number.NaN), s).held).toBe(true);
  });

  it('step-limits before clamping to bounds', () => {
    expect(applyGuardrails(g(1.05), s)).toEqual({ value: 1.05, held: false, wasStepLimited: false, wasClamped: false, sane: true });
    expect(applyGuardrails(g(5), s)).toMatchObject({ value: 1.1, wasStepLimited: true, wasClamped: false });
    // Step limit allows 1.65, the bound stops at 1.6.
    expect(applyGuardrails(g(5, 10, 1.5, 1, 1.6), s)).toMatchObject({ value: 1.6, wasStepLimited: true, wasClamped: true });
    expect(applyGuardrails(g(1.7, 10, 1.6, 1, 1.6), { ...s, maxStepPct: 1 })).toMatchObject({ value: 1.6, wasStepLimited: false, wasClamped: true });
  });

  it('keeps the active value and reports insanity for a non-finite or non-positive result', () => {
    expect(applyGuardrails(g(Number.NaN), s)).toEqual({ value: 1, held: false, wasStepLimited: false, wasClamped: false, sane: false });
    // A step limit of 100% and a bound at 0 let a negative estimate reach 0.
    expect(applyGuardrails(g(-1, 10, 1, 0, 2), { ...s, maxStepPct: 1 })).toMatchObject({ value: 1, sane: false });
  });

  it('never leaves the bounds or the step limit (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 10, noNaN: true }),
        fc.option(fc.double({ noNaN: false }), { nil: null }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 3, noNaN: true }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        fc.double({ min: 1, max: 5, noNaN: true }),
        (v0, estimate, nEff, maxStepPct, loF, hiF) => {
          const lo = v0 * loF;
          const hi = v0 * hiF;
          const r = applyGuardrails({ active: v0, estimate, nEff, lowerBound: lo, upperBound: hi }, { minNEff: 3, maxStepPct });
          expect(Number.isFinite(r.value)).toBe(true);
          expect(r.value).toBeGreaterThan(0);
          expect(r.value).toBeGreaterThanOrEqual(lo);
          expect(r.value).toBeLessThanOrEqual(hi);
          expect(Math.abs(r.value - v0)).toBeLessThanOrEqual(maxStepPct * v0 * (1 + 1e-12) + 1e-12);
        },
      ),
    );
  });
});
