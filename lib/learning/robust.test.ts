import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MIN_WINSOR_N, winsorize, winsorLimits } from './robust';

const ones = (n: number) => Array.from({ length: n }, () => 1);
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('winsorLimits', () => {
  it('clips pct x n values at each end with equal weights', () => {
    expect(winsorLimits(range(20), ones(20), 0.05)).toEqual({ lo: 2, hi: 19 });
    expect(winsorLimits(range(40), ones(40), 0.05)).toEqual({ lo: 3, hi: 38 });
    expect(winsorLimits(range(10), ones(10), 0.05)).toEqual({ lo: 1, hi: 10 });
    expect(winsorLimits([7], [1], 0.2)).toEqual({ lo: 7, hi: 7 });
  });

  it('never interpolates: an outlier is pulled to a real neighbouring value', () => {
    const xs = [...range(19), 1000];
    expect(winsorLimits(xs, ones(20), 0.05)!.hi).toBe(19);
  });

  it('follows the weights', () => {
    // 90% of the weight on 1: both limits sit on it.
    expect(winsorLimits([1, 10], [9, 1], 0.2)).toEqual({ lo: 1, hi: 1 });
    expect(winsorLimits([1, 2, 3], [1, 1, 8], 0.15)).toEqual({ lo: 2, hi: 3 });
  });

  it('ignores zero weights and non-finite values; null when nothing is left or pct is nonsense', () => {
    expect(winsorLimits([1, 100, 2, Number.NaN, 3], [1, 0, 1, 1, 1], 0)).toEqual({ lo: 1, hi: 3 });
    expect(winsorLimits([1, 2], [0, 0], 0.1)).toBeNull();
    expect(winsorLimits([], [], 0.1)).toBeNull();
    expect(winsorLimits([1, 2], [1, 1], 0.5)).toBeNull();
    expect(winsorLimits([1, 2], [1, 1], -0.1)).toBeNull();
    expect(winsorLimits([1, 2, 99], [1, 1], 0)).toEqual({ lo: 1, hi: 2 }); // a missing weight counts as 0
  });

  it('is symmetric and ordered (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: -1e3, max: 1e3, noNaN: true }), fc.double({ min: 0.01, max: 5, noNaN: true })), { minLength: 1, maxLength: 30 }),
        fc.double({ min: 0, max: 0.49, noNaN: true }),
        (pts, pct) => {
          const xs = pts.map((p) => p[0]);
          const ws = pts.map((p) => p[1]);
          const a = winsorLimits(xs, ws, pct)!;
          const b = winsorLimits(xs.map((x) => -x), ws, pct)!;
          expect(a.lo).toBe(-b.hi);
          expect(a.hi).toBe(-b.lo);
          expect(a.lo).toBeLessThanOrEqual(a.hi);
          expect(xs).toContain(a.lo);
          expect(xs).toContain(a.hi);
        },
      ),
    );
  });
});

describe('winsorize', () => {
  it('leaves groups smaller than the minimum alone', () => {
    const xs = [1, 2, 3, 100];
    const out = winsorize(xs, ones(4), 0.25);
    expect(out).toEqual(xs);
    expect(out).not.toBe(xs);
    expect(MIN_WINSOR_N).toBe(5);
  });

  it('does nothing at pct 0 or when no weight is left', () => {
    const xs = range(10);
    expect(winsorize(xs, ones(10), 0)).toEqual(xs);
    expect(winsorize(xs, xs.map(() => 0), 0.1)).toEqual(xs);
  });

  it('pulls a mis-keyed outlier in to its neighbour', () => {
    const xs = [...Array.from({ length: 19 }, (_, i) => 1 + i / 100), 30];
    const out = winsorize(xs, ones(20), 0.05);
    expect(out[19]).toBe(1.18);
    expect(out[0]).toBe(1.01); // the low end is clipped too
    expect(out.slice(1, 19)).toEqual(xs.slice(1, 19));
  });

  it('keeps every value within the original range and preserves order (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e3, max: 1e3, noNaN: true }), { minLength: 5, maxLength: 40 }),
        fc.double({ min: 0, max: 0.45, noNaN: true }),
        (xs, pct) => {
          const out = winsorize(xs, xs.map(() => 1), pct);
          const lo = Math.min(...xs);
          const hi = Math.max(...xs);
          out.forEach((v, i) => {
            expect(v).toBeGreaterThanOrEqual(lo);
            expect(v).toBeLessThanOrEqual(hi);
            for (let j = 0; j < xs.length; j++) if (xs[i]! < xs[j]!) expect(v).toBeLessThanOrEqual(out[j]!);
          });
        },
      ),
    );
  });
});
