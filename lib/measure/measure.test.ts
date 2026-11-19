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

  it('a pitch typed in degrees is understood; nothing over 24/12 (L25, RF-06, S2-F13)', () => {
    // 40 x 30 = 1,200 sq ft of footprint.
    const deg = computeMeasurement(m({ mode: 'roofline', pitch: '30 deg' }));
    expect(deg.errors).toEqual([]);
    expect(deg.gross).toBeCloseTo(1200 / Math.cos(Math.PI / 6), 9);
    expect(Math.round(deg.net)).toBe(1386);
    expect(deg.basis).toBe('1,200 sq ft footprint × pitch (30° = 6.93/12 → ×1.155)');
    // A bare 100 was 100/12: 10,072 sq ft. It is refused, with a hint.
    const hundred = computeMeasurement(m({ mode: 'roofline', pitch: '100' }));
    expect([hundred.gross, hundred.net]).toEqual([0, 0]);
    expect(hundred.errors).toEqual(['Pitch "100" would be 100/12, steeper than 24/12. Type the rise per 12, e.g. 6/12, or degrees, e.g. 30°.']);
    expect(measuredSqft(m({ mode: 'roofline', pitch: '100' }))).toBeNull();
    // A bare 30 (30/12) is refused and offers 30°.
    const thirty = computeMeasurement(m({ mode: 'roofline', pitch: '30' }));
    expect(thirty.net).toBe(0);
    expect(thirty.errors).toEqual(['Pitch "30" would be 30/12, steeper than 24/12. For degrees, type 30°.']);
    expect(computeMeasurement(m({ mode: 'roofline', pitch: '30/12' })).errors).toEqual(['Pitch "30/12" is steeper than 24/12. Check the numbers.']);
    // The second pitch follows the same rules.
    const two = computeMeasurement(m({ mode: 'roofline', pitch: '6/12', twoSlope: true, pitch2: '45°', splitPct: '50' }));
    expect(two.gross).toBeCloseTo(1200 * (0.5 * Math.sqrt(1.25) + 0.5 * Math.SQRT2), 9);
    expect(two.basis).toBe('1,200 sq ft footprint × pitch (50% at 6/12 + 50% at 45° = 12/12 → ×1.266)');
    expect(computeMeasurement(m({ mode: 'roofline', pitch: '6/12', twoSlope: true, pitch2: '40', splitPct: '50' })).errors).toEqual([
      'Second pitch "40" would be 40/12, steeper than 24/12. For degrees, type 40°.',
    ]);
  });

  it('a bare number that reads as a very steep roof says how it was read (L25)', () => {
    const r = computeMeasurement(m({ mode: 'roofline', pitch: '18' }));
    expect(r.errors).toEqual([]);
    expect(r.notes).toContain('Pitch 18 is read as 18/12, a very steep roof (56.3°). If you meant 18°, type 18°.');
    expect(computeMeasurement(m({ mode: 'roofline', pitch: '6' })).notes).toEqual([]);
    expect(computeMeasurement(m({ mode: 'roofline', pitch: '18/12' })).notes).toEqual([]);
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
