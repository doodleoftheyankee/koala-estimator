import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ageDays, DAY_MS, effectiveSampleSize, recencyWeight, weightedMean, weightedSd } from './weights';

const now = new Date('2026-10-20T12:00:00Z');

describe('ageDays', () => {
  it('counts fractional days back from now', () => {
    expect(ageDays('2026-10-19T12:00:00Z', now)).toBe(1);
    expect(ageDays(new Date(now.getTime() - 1.5 * DAY_MS).toISOString(), now)).toBe(1.5);
  });

  it('treats future dates as today and garbage as unknown', () => {
    expect(ageDays('2026-11-01T00:00:00Z', now)).toBe(0);
    expect(ageDays('not a date', now)).toBeNaN();
  });
});

describe('recencyWeight', () => {
  it('halves every half-life', () => {
    expect(recencyWeight(0, 180)).toBe(1);
    expect(recencyWeight(180, 180)).toBeCloseTo(0.5, 12);
    expect(recencyWeight(360, 180)).toBeCloseTo(0.25, 12);
  });

  it('gives unknown ages no weight and disables decay for a non-positive half-life', () => {
    expect(recencyWeight(Number.NaN, 180)).toBe(0);
    expect(recencyWeight(400, 0)).toBe(1);
    expect(recencyWeight(400, -5)).toBe(1);
    expect(recencyWeight(400, Number.POSITIVE_INFINITY)).toBe(1);
    expect(recencyWeight(-3, 10)).toBe(1);
  });
});

describe('effectiveSampleSize', () => {
  it('is n for equal weights and ~1 when one weight dominates', () => {
    expect(effectiveSampleSize([1, 1, 1, 1])).toBe(4);
    expect(effectiveSampleSize([0.3, 0.3])).toBeCloseTo(2, 12);
    expect(effectiveSampleSize([1, 1e-9, 1e-9])).toBeCloseTo(1, 6);
  });

  it('is 0 without weight', () => {
    expect(effectiveSampleSize([])).toBe(0);
    expect(effectiveSampleSize([0, 0])).toBe(0);
  });

  it('lies in [1, n] and ignores the scale of the weights (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 1e-6, max: 1, noNaN: true }), { minLength: 1, maxLength: 50 }), fc.double({ min: 1e-3, max: 1e3, noNaN: true }), (ws, k) => {
        const n = effectiveSampleSize(ws);
        expect(n).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(n).toBeLessThanOrEqual(ws.length + 1e-9);
        expect(effectiveSampleSize(ws.map((w) => w * k))).toBeCloseTo(n, 6);
      }),
    );
  });
});

describe('weighted mean and sd', () => {
  it('weights the mean', () => {
    expect(weightedMean([1, 3], [1, 1])).toBe(2);
    expect(weightedMean([1, 3], [3, 1])).toBe(1.5);
    expect(weightedMean([1, 3], [0, 0])).toBeNull();
    expect(weightedMean([], [])).toBeNull();
    expect(weightedMean([5, 7], [1])).toBe(5); // a missing weight counts as 0
  });

  it('computes the population sd about the weighted mean', () => {
    expect(weightedSd([2, 4, 4, 4, 5, 5, 7, 9], [1, 1, 1, 1, 1, 1, 1, 1])).toBe(2);
    expect(weightedSd([1, 3], [1, 1])).toBe(1);
    expect(weightedSd([5], [2])).toBe(0);
    expect(weightedSd([1, 2], [0, 0])).toBeNull();
    expect(weightedSd([1, 3, 100], [1, 1])).toBe(1); // a missing weight counts as 0
  });
});
