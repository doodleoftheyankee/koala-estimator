import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { confidenceScore, standardError } from './confidence';

describe('standardError', () => {
  it('is the weighted sd over sqrt(n_eff)', () => {
    expect(standardError([1, 3], [1, 1], 2)).toBeCloseTo(1 / Math.SQRT2, 12);
    expect(standardError([2, 2, 2], [1, 1, 1], 3)).toBe(0);
  });

  it('is null without evidence', () => {
    expect(standardError([], [], 0)).toBeNull();
    expect(standardError([1, 2], [1, 1], 0)).toBeNull();
    expect(standardError([1, 2], [0, 0], 1)).toBeNull();
  });
});

describe('confidenceScore', () => {
  it('follows 100 (1 - e^(-n_eff/8)) clamp(1 - SE/|value|)', () => {
    expect(confidenceScore(8, 1, 0.1)).toBeCloseTo(100 * (1 - Math.exp(-1)) * 0.9, 10);
    expect(confidenceScore(1, 2, 0)).toBeCloseTo(100 * (1 - Math.exp(-1 / 8)), 10);
    expect(confidenceScore(1000, 1, 0)).toBeCloseTo(100, 10);
  });

  it('scores 0 for no evidence, an unknown SE, a zero value or SE >= |value|', () => {
    expect(confidenceScore(0, 1, 0.1)).toBe(0);
    expect(confidenceScore(5, 1, null)).toBe(0);
    expect(confidenceScore(5, 0, 0.1)).toBe(0);
    expect(confidenceScore(5, Number.NaN, 0.1)).toBe(0);
    expect(confidenceScore(5, 1, 2)).toBe(0);
    expect(confidenceScore(5, 1, Number.NaN)).toBe(0);
  });

  it('stays within [0, 100] (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: null }),
        (n, v, se) => {
          const c = confidenceScore(n, v, se);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(100);
        },
      ),
    );
  });
});
