import { describe, expect, it } from 'vitest';
import { polygonArea, selfIntersects, solveCustom, solveShape } from './geometry';

const area = (kind: 'rect' | 'L' | 'T' | 'U', dims: Record<string, string>) => {
  const r = solveShape({ kind, dims });
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r.shape;
};

describe('presets', () => {
  it('rectangle', () => {
    const s = area('rect', { A: `24'6"`, B: '30' });
    expect(s.area).toBeCloseTo(735);
    expect(s.perimeter).toBeCloseTo(109);
    expect(s.edges.map((e) => e.label)).toEqual(['A', 'B', undefined, undefined]);
  });
  it('L = A·B − C·D', () => expect(area('L', { A: '40', B: '30', C: '15', D: '10' }).area).toBeCloseTo(1050));
  it('T = A·B + C·D', () => expect(area('T', { A: '40', B: '20', C: '16', D: '12' }).area).toBeCloseTo(992));
  it('U = A·B − C·D', () => expect(area('U', { A: '40', B: '30', C: '20', D: '18' }).area).toBeCloseTo(840));
  it('labelled sides carry their letter and length', () => {
    const s = area('L', { A: '40', B: '30', C: '15', D: '10' });
    for (const e of s.edges) {
      if (e.label) expect(e.length).toBeCloseTo({ A: 40, B: 30, C: 15, D: 10 }[e.label]!);
    }
  });
  it('reports bad input', () => {
    const r = solveShape({ kind: 'L', dims: { A: '20', B: 'abc', C: '25', D: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/B "abc"/);
  });
  it('rejects a notch wider than the shape', () => {
    expect(solveShape({ kind: 'U', dims: { A: '20', B: '20', C: '25', D: '5' } }).ok).toBe(false);
  });
});

describe('custom polygon', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];

  it('scales the drawing to typed lengths', () => {
    const r = solveCustom({ points: square, closed: true, sides: ['20', '20', '20', '20'] });
    expect(r.ok && r.shape.area).toBeCloseTo(400);
  });

  it('uses the drawing for blank sides', () => {
    // An L drawn on the grid; only some sides typed.
    const pts = [[0, 0], [40, 0], [40, 20], [20, 20], [20, 30], [0, 30]] as [number, number][];
    const r = solveCustom({ points: pts, closed: true, sides: ['40', '', '20', '', '20', '30'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shape.area).toBeCloseTo(1000, 3);
  });

  it('closes slightly inconsistent measurements with small adjustments', () => {
    const r = solveCustom({ points: square, closed: true, sides: ['20', '20.2', '20', '20'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(polygonArea(r.shape.points)).toBeCloseTo(402, 0);
      const last = r.shape.points.at(-1)!;
      expect(last[0]).toBeCloseTo(0, 6); // closes back on the first corner
    }
  });

  it('needs a closed outline of 3+ corners', () => {
    expect(solveCustom({ points: square.slice(0, 2), closed: true, sides: [] }).ok).toBe(false);
    expect(solveCustom({ points: square, closed: false, sides: [] }).ok).toBe(false);
  });

  it('rejects lengths that cannot form the drawing', () => {
    const r = solveCustom({ points: square, closed: true, sides: ['10', '1', '10', '50'] });
    expect(r.ok).toBe(false);
  });

  it('spots a crossed outline', () => {
    expect(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true);
    expect(selfIntersects(square)).toBe(false);
  });
});
