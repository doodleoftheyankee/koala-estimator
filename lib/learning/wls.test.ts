import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distinctCount, wlsLine } from './wls';

describe('wlsLine', () => {
  it('recovers an exact line', () => {
    const pts = [10, 20, 35, 80].map((x) => ({ x, y: 2.5 + 0.18 * x, w: 1 }));
    const line = wlsLine(pts)!;
    expect(line.intercept).toBeCloseTo(2.5, 10);
    expect(line.slope).toBeCloseTo(0.18, 12);
  });

  it('follows the weights', () => {
    // Two clusters disagree; the heavy one wins.
    const pts = [
      { x: 0, y: 0, w: 1 },
      { x: 10, y: 10, w: 1 },
      { x: 0, y: 5, w: 1e-9 },
      { x: 10, y: 0, w: 1e-9 },
    ];
    expect(wlsLine(pts)!.slope).toBeCloseTo(1, 6);
  });

  it('is null without spread in x, without weight, or with non-finite results', () => {
    expect(wlsLine([{ x: 5, y: 1, w: 1 }, { x: 5, y: 2, w: 1 }])).toBeNull();
    expect(wlsLine([{ x: 1, y: 1, w: 0 }, { x: 2, y: 2, w: 0 }])).toBeNull();
    expect(wlsLine([])).toBeNull();
    expect(wlsLine([{ x: 1, y: 1, w: 1 }, { x: 2, y: Number.POSITIVE_INFINITY, w: 1 }])).toBeNull();
  });

  it('recovers any line from three or more distinct x (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 3, maxLength: 30 }),
        (a, b, xs) => {
          const line = wlsLine(xs.map((x, i) => ({ x, y: a + b * x, w: 1 + (i % 3) })))!;
          expect(line.intercept).toBeCloseTo(a, 5);
          expect(line.slope).toBeCloseTo(b, 7);
        },
      ),
    );
  });
});

describe('distinctCount', () => {
  it('counts distinct values', () => {
    expect(distinctCount([1, 1, 2, 3, 3])).toBe(3);
    expect(distinctCount([])).toBe(0);
  });
});
