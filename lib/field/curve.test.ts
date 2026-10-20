import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scaleCurve, type ChartBox } from './curve';

const BOX: ChartBox = { width: 300, height: 120, pad: { top: 10, right: 10, bottom: 20, left: 30 } };

/** Every "x y" pair in an "M x y L x y ..." path. */
const coords = (path: string) =>
  path
    .split(/[ML]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(' ').map(Number) as [number, number]);

describe('scaleCurve', () => {
  it('maps the cheapest price to the left edge, the dearest to the right, and 100% to the top', () => {
    const c = scaleCurve(
      [
        { price: 2000, winProbability: 0.25 },
        { price: 1000, winProbability: 1 },
        { price: 1500, winProbability: 0.5 },
      ],
      BOX,
    )!;
    expect(c.domain).toEqual({ min: 1000, max: 2000 });
    expect(c.plot).toEqual({ left: 30, right: 290, top: 10, bottom: 100 });
    // Sorted by price: 1000 -> (30, 10), 1500 -> (160, 55), 2000 -> (290, 77.5)
    expect(c.path).toBe('M30 10 L160 55 L290 77.5');
    expect(c.x(1500)).toBe(160);
    expect(c.y(0)).toBe(100);
    expect(c.y(1)).toBe(10);
  });

  it('widens the domain to keep extra prices (the estimator price) on the chart', () => {
    const c = scaleCurve([{ price: 1000, winProbability: 0.5 }, { price: 2000, winProbability: 0.3 }], BOX, [3000, Number.NaN])!;
    expect(c.domain).toEqual({ min: 1000, max: 3000 });
    expect(c.x(3000)).toBe(290);
    expect(c.x(2000)).toBe(160);
  });

  it('clamps out-of-range inputs to the plot instead of drawing outside it', () => {
    const c = scaleCurve([{ price: 1000, winProbability: 0.5 }, { price: 2000, winProbability: 0.3 }], BOX)!;
    expect(c.x(0)).toBe(30);
    expect(c.x(99_999)).toBe(290);
    expect(c.x(Number.NaN)).toBe(30);
    expect(c.y(2)).toBe(10);
    expect(c.y(-1)).toBe(100);
    expect(c.y(Number.NaN)).toBe(100);
  });

  it('a single price gets a small range instead of dividing by zero', () => {
    const c = scaleCurve([{ price: 1000, winProbability: 0.4 }], BOX)!;
    expect(c.domain).toEqual({ min: 950, max: 1050 });
    expect(c.path).toBe('M160 64');
    const tiny = scaleCurve([{ price: 0, winProbability: 0.4 }], BOX)!;
    expect(tiny.domain).toEqual({ min: -1, max: 1 });
    expect(tiny.path).not.toContain('NaN');
  });

  it('skips unusable points and is null when none are left', () => {
    expect(scaleCurve([], BOX)).toBeNull();
    expect(scaleCurve([{ price: Number.NaN, winProbability: 0.5 }, { price: 10, winProbability: Number.POSITIVE_INFINITY }], BOX)).toBeNull();
    const c = scaleCurve([{ price: Number.NaN, winProbability: 0.5 }, { price: 1000, winProbability: 0.5 }, { price: 2000, winProbability: 0 }], BOX)!;
    expect(coords(c.path)).toHaveLength(2);
  });

  it('writes zero coordinates as plain 0', () => {
    const c = scaleCurve([{ price: 1, winProbability: 1 }, { price: 2, winProbability: 0 }], { width: 100, height: 50, pad: { top: 0, right: 0, bottom: 0, left: 0 } })!;
    expect(c.path).toBe('M0 0 L100 50');
  });

  it('a box smaller than its padding collapses to a line instead of inverting', () => {
    const c = scaleCurve([{ price: 1, winProbability: 0.5 }, { price: 2, winProbability: 0.2 }], { width: 10, height: 10, pad: { top: 8, right: 8, bottom: 8, left: 8 } })!;
    expect(c.plot).toEqual({ left: 8, right: 8, top: 8, bottom: 8 });
    expect(c.path).toBe('M8 8 L8 8');
  });

  it('stays inside the plot, rises left to right in x and never emits NaN or -0 (property)', () => {
    const point = fc.record({ price: fc.double({ min: -1e7, max: 1e7, noNaN: true }), winProbability: fc.double({ min: -1, max: 2, noNaN: true }) });
    fc.assert(
      fc.property(fc.array(point, { minLength: 1, maxLength: 40 }), fc.array(fc.double({ min: -1e7, max: 1e7, noNaN: true }), { maxLength: 2 }), (curve, extra) => {
        const c = scaleCurve(curve, BOX, extra)!;
        expect(c).not.toBeNull();
        expect(c.path).not.toMatch(/NaN|Infinity|-0(?![.\d])/);
        const xy = coords(c.path);
        expect(xy).toHaveLength(curve.length);
        let prevX = -Infinity;
        for (const [x, y] of xy) {
          expect(x).toBeGreaterThanOrEqual(c.plot.left - 0.01);
          expect(x).toBeLessThanOrEqual(c.plot.right + 0.01);
          expect(y).toBeGreaterThanOrEqual(c.plot.top - 0.01);
          expect(y).toBeLessThanOrEqual(c.plot.bottom + 0.01);
          expect(x).toBeGreaterThanOrEqual(prevX);
          prevX = x;
        }
        for (const p of [...curve.map((q) => q.price), ...extra]) {
          expect(p).toBeGreaterThanOrEqual(c.domain.min);
          expect(p).toBeLessThanOrEqual(c.domain.max);
        }
      }),
    );
  });
});
