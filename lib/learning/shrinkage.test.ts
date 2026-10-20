import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { shrink, shrinkWeight } from './shrinkage';

describe('shrinkage', () => {
  it('blends cell and parent by n_eff : k', () => {
    // (n_eff · mean + k · parent) / (n_eff + k) = (5·1.2 + 5·1.0) / 10
    expect(shrink(1.2, 5, 1.0, 5)).toBeCloseTo(1.1, 12);
    expect(shrink(2, 15, 1, 5)).toBeCloseTo(1.75, 12);
    expect(shrinkWeight(15, 5)).toBe(0.75);
  });

  it('falls back to the parent without evidence and trusts the cell when k = 0', () => {
    expect(shrink(null, 10, 1.08, 5)).toBe(1.08);
    expect(shrink(1.5, 0, 1.08, 5)).toBe(1.08);
    expect(shrink(1.5, 0, 1.08, 0)).toBe(1.08);
    expect(shrink(1.5, 3, 1.08, 0)).toBe(1.5);
    expect(shrinkWeight(0, 0)).toBe(0);
  });

  it('always lands between the cell mean and the parent (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 100, noNaN: true }),
        fc.double({ min: 0.001, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (mean, parent, nEff, k) => {
          const v = shrink(mean, nEff, parent, k);
          expect(v).toBeGreaterThanOrEqual(Math.min(mean, parent) - 1e-9);
          expect(v).toBeLessThanOrEqual(Math.max(mean, parent) + 1e-9);
        },
      ),
    );
  });
});
