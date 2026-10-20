import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatVariance, varianceTone, variancePct } from './variance';

describe('variancePct', () => {
  it('is (actual - estimate) / estimate', () => {
    expect(variancePct(100, 110)).toBeCloseTo(0.1);
    expect(variancePct(10, 7.5)).toBeCloseTo(-0.25);
    expect(variancePct(8, 8)).toBe(0);
  });
  it('is null when it cannot be computed', () => {
    expect(variancePct(null, 5)).toBeNull();
    expect(variancePct(5, null)).toBeNull();
    expect(variancePct(undefined, 5)).toBeNull();
    expect(variancePct(0, 5)).toBeNull();
    expect(variancePct(-3, 5)).toBeNull();
    expect(variancePct(Number.NaN, 5)).toBeNull();
    expect(variancePct(5, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('varianceTone', () => {
  it('is green within 10%, amber within 25%, red beyond', () => {
    expect(varianceTone(0)).toBe('green');
    expect(varianceTone(variancePct(1, 1.1))).toBe('green'); // 1.1/1 - 1 is a hair over 0.1 in floating point
    expect(varianceTone(-0.1)).toBe('green');
    expect(varianceTone(0.1001)).toBe('amber');
    expect(varianceTone(-0.25)).toBe('amber');
    expect(varianceTone(0.2501)).toBe('red');
    expect(varianceTone(-0.9)).toBe('red');
  });
  it('has no tone without a variance', () => {
    expect(varianceTone(null)).toBeNull();
    expect(varianceTone(Number.NaN)).toBeNull();
  });
  it('depends only on the size of the miss', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 5, noNaN: true }), (p) => {
        expect(varianceTone(p)).toBe(varianceTone(-p));
      }),
    );
  });
  it('never gets better as the miss grows', () => {
    const rank = { green: 0, amber: 1, red: 2 } as const;
    fc.assert(
      fc.property(fc.double({ min: 0, max: 3, noNaN: true }), fc.double({ min: 0, max: 3, noNaN: true }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(rank[varianceTone(lo)!]).toBeLessThanOrEqual(rank[varianceTone(hi)!]);
      }),
    );
  });
});

describe('formatVariance', () => {
  it('shows a signed whole percent', () => {
    expect(formatVariance(0.123)).toBe('+12%');
    expect(formatVariance(-0.08)).toBe('−8%');
    expect(formatVariance(0.004)).toBe('0%');
    expect(formatVariance(null)).toBe('—');
    expect(formatVariance(Number.NaN)).toBe('—');
  });
});
