import { describe, expect, it } from 'vitest';
import { computeSpace, newCutout, newJob, newSpace, pitchFactor, totalsByType, type Space } from './model';

function space(type: Space['type'], patch: Partial<Space> = {}): Space {
  return { ...newSpace(type, []), shape: { kind: 'rect', dims: { A: '40', B: '30' } }, ...patch };
}

describe('computeSpace', () => {
  it('attic floor: footprint minus cutouts × qty', () => {
    const chimney = { ...newCutout('attic_floor'), shape: { kind: 'rect' as const, dims: { A: '3', B: '4' } }, qty: '2' };
    const r = computeSpace(space('attic_floor', { cutouts: [chimney] }));
    expect([r.gross, r.cutouts, r.net]).toEqual([1200, 24, 1176]);
  });

  it('roofline: footprint × pitch factor', () => {
    const r = computeSpace(space('roofline', { pitch: '6/12' }));
    expect(pitchFactor(6)).toBeCloseTo(1.118, 3);
    expect(r.gross).toBeCloseTo(1200 * Math.sqrt(1.25));
  });

  it('roofline: two slopes blend by split', () => {
    const r = computeSpace(space('roofline', { pitch: '12', twoSlope: true, pitch2: '0', splitPct: '50' }));
    expect(r.gross).toBeCloseTo(1200 * (0.5 * Math.SQRT2 + 0.5));
  });

  it('roofline needs a pitch', () => {
    expect(computeSpace(space('roofline')).errors[0]).toMatch(/pitch/);
  });

  it('crawl walls: perimeter × height minus openings', () => {
    const vent = { ...newCutout('crawl_walls'), shape: { kind: 'rect' as const, dims: { A: `16"`, B: `8"` } }, qty: '4' };
    const r = computeSpace(space('crawl_walls', { wallHeight: `3'6"`, cutouts: [vent] }));
    expect(r.gross).toBeCloseTo(140 * 3.5);
    expect(r.cutouts).toBeCloseTo(4 * (16 / 12) * (8 / 12));
  });

  it('crawl walls: typed perimeter overrides the outline', () => {
    const r = computeSpace(space('crawl_walls', { wallHeight: '4', perimeter: '100' }));
    expect(r.gross).toBe(400);
  });

  it('errors zero the numbers', () => {
    const r = computeSpace(space('attic_floor', { shape: { kind: 'rect', dims: { A: '40' } } }));
    expect(r.net).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('totals by type', () => {
    const job = newJob();
    job.spaces = [space('attic_floor'), space('attic_floor'), space('crawl_floor')];
    expect(totalsByType(job)).toEqual([
      { type: 'attic_floor', net: 2400, spaces: 2 },
      { type: 'crawl_floor', net: 1200, spaces: 1 },
    ]);
  });
});
