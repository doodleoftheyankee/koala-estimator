import { describe, expect, it } from 'vitest';
import { computeMeasurement, measuredSqft, measurementSchema, measurementSummary, newCutout, newMeasurement, pitchFactor, type Measurement } from './measure';

function m(patch: Partial<Measurement> = {}): Measurement {
  return { ...newMeasurement('attic'), shape: { kind: 'rect', dims: { A: '40', B: '30' } }, ...patch };
}
const rect = (A: string, B: string) => ({ kind: 'rect' as const, dims: { A, B } });

describe('computeMeasurement', () => {
  it('floor: footprint minus cutouts × qty', () => {
    const r = computeMeasurement(m({ cutouts: [{ ...newCutout('floor', 'c1'), shape: rect('3', '4'), qty: '2' }] }));
    expect([r.gross, r.cutouts, r.net]).toEqual([1200, 24, 1176]);
    expect(r.basis).toBe('1,200 sq ft footprint');
  });

  it('roofline: footprint × pitch factor, one or two slopes', () => {
    expect(pitchFactor(6)).toBeCloseTo(1.118, 3);
    expect(computeMeasurement(m({ mode: 'roofline', pitch: '6/12' })).gross).toBeCloseTo(1200 * Math.sqrt(1.25));
    const two = computeMeasurement(m({ mode: 'roofline', pitch: '12', twoSlope: true, pitch2: '0', splitPct: '50' }));
    expect(two.gross).toBeCloseTo(1200 * (0.5 * Math.SQRT2 + 0.5));
    expect(computeMeasurement(m({ mode: 'roofline' })).errors[0]).toMatch(/pitch/);
  });

  it('walls: outline perimeter (or typed run) × height minus openings', () => {
    const vents = { ...newCutout('walls', 'v'), shape: rect(`16"`, `8"`), qty: '4' };
    const r = computeMeasurement(m({ mode: 'walls', wallHeight: `3'6"`, cutouts: [vents] }));
    expect(r.gross).toBeCloseTo(140 * 3.5);
    expect(r.cutouts).toBeCloseTo(4 * (16 / 12) * (8 / 12));
    expect(computeMeasurement(m({ mode: 'walls', wallHeight: '8', perimeter: '150' })).gross).toBe(1200);
    expect(computeMeasurement(m({ mode: 'walls' })).errors).toContain('Enter the average wall height.');
  });

  it('errors zero everything', () => {
    const r = computeMeasurement(m({ shape: { kind: 'rect', dims: { A: '40' } } }));
    expect([r.gross, r.net]).toEqual([0, 0]);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('flags a bad cutout quantity', () => {
    const r = computeMeasurement(m({ cutouts: [{ ...newCutout('floor', 'c'), shape: rect('1', '1'), qty: '1.5' }] }));
    expect(r.errors[0]).toMatch(/whole number/);
  });
});

describe('measuredSqft / summary / schema', () => {
  it('rounds the net, null when incomplete', () => {
    expect(measuredSqft(m({ shape: rect(`24'6"`, '30') }))).toBe(735);
    expect(measuredSqft(newMeasurement('attic'))).toBeNull();
  });

  it('summarises for the area card', () => {
    expect(measurementSummary(m({ cutouts: [newCutout('floor', 'a'), newCutout('floor', 'b')] }))).toBe('Floor: rectangle, 2 cutouts');
    expect(measurementSummary(m({ mode: 'roofline', pitch: '6/12' }))).toBe('Roofline: rectangle, pitch 6/12');
    expect(measurementSummary(m({ mode: 'walls', wallHeight: `8'`, perimeter: '120' }))).toBe(`Walls: wall run, 8' high`);
  });

  it('starts in the right mode for the job type', () => {
    expect(newMeasurement('walls').mode).toBe('walls');
    expect(newMeasurement('crawlspace').mode).toBe('floor');
  });

  it('round-trips through the draft schema', () => {
    const value = m({ shape: { kind: 'custom', dims: {}, custom: { points: [[0, 0], [10, 0], [0, 10]], closed: true, sides: ['10', '', ''] } } });
    expect(measurementSchema.parse(value)).toEqual(value);
    expect(measurementSchema.safeParse({ ...value, mode: 'roof' }).success).toBe(false);
  });
});
