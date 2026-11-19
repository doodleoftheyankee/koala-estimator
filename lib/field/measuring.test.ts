import { describe, expect, it } from 'vitest';
import { newMeasurement, type Measurement } from '@/lib/measure/measure';
import { priceEstimate } from '@/lib/pricing';
import { seededCoefficients, seededSnapshot } from '@/lib/pricing/__fixtures__/seeded';
import { areaSchema, newArea, newDraft, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { measurementChecks, withMeasurement } from './measuring';

const walls = (wallHeight: string): Measurement => ({ ...newMeasurement('walls'), perimeter: '120', wallHeight });
function wallsDraft(): { d: EstimateDraft; id: string } {
  const a = { ...newArea('walls'), name: 'Exterior walls' };
  return { d: { ...newDraft(new Date('2026-11-19T15:00:00Z')), areas: [a] }, id: a.id };
}
const priced = (d: EstimateDraft) => {
  const areas = priceableAreas(d);
  return areas.length ? priceEstimate({ ...toEstimateInput(d), areas }, seededSnapshot, seededCoefficients).options : [];
};

describe('a broken measurement takes its size back (L26, RF-07, S2-F14)', () => {
  it('walls 960 sq ft, height cleared: 0 sq ft, Incomplete, not priced, with a Finish measuring fix', () => {
    const start = wallsDraft();
    let d = withMeasurement(start.d, start.id, walls('8'));
    expect(d.areas[0]!.sqft).toBe(960);
    expect(areaSchema.safeParse(d.areas[0]).success).toBe(true); // Ready
    expect(priced(d).length).toBeGreaterThan(0);
    expect(measurementChecks(d)).toEqual([]);

    d = withMeasurement(d, start.id, walls(''));
    expect(d.areas[0]!.sqft).toBe(0);
    expect(d.measurements[start.id]!.wallHeight).toBe('');
    expect(areaSchema.safeParse(d.areas[0]).success).toBe(false); // Incomplete
    expect(priceableAreas(d)).toEqual([]);
    expect(priced(d)).toEqual([]);
    expect(measurementChecks(d)).toEqual([
      {
        id: `measure:${start.id}`,
        areaId: start.id,
        ok: false,
        label: "Exterior walls: the measurement isn't finished, so this area isn't priced. Enter the average wall height.",
        fix: { label: 'Finish measuring', target: { step: 'areas', areaId: start.id, open: 'measure' } },
      },
    ]);

    // Finished again, the area is back at 960 sq ft and the check is gone.
    d = withMeasurement(d, start.id, walls('8'));
    expect(d.areas[0]!.sqft).toBe(960);
    expect(measurementChecks(d)).toEqual([]);
  });

  it('a size typed by hand stays, and an area with no measurement is not a measuring problem', () => {
    const start = wallsDraft();
    const typed = { ...start.d, areas: [{ ...start.d.areas[0]!, sqft: 900 }] };
    // Opening Measure on a typed size starts an empty measurement: the 900 stays and is priced.
    const opened = withMeasurement(typed, start.id, newMeasurement('walls'));
    expect(opened.areas[0]!.sqft).toBe(900);
    expect(priceableAreas(opened)).toHaveLength(1);
    expect(measurementChecks(opened)).toEqual([]);
    expect(measurementChecks(start.d)).toEqual([]);
  });

  it('names the first thing to finish, or a measurement that comes to nothing', () => {
    const start = wallsDraft();
    const outline: Measurement = { ...newMeasurement('attic'), shape: { kind: 'custom', dims: {}, custom: { points: [[0, 0], [10, 10], [10, 0], [0, 10]], closed: true, sides: ['', '', '', ''] } } };
    const crossed = withMeasurement(start.d, start.id, outline);
    expect(measurementChecks(crossed)[0]!.label).toBe(
      "Exterior walls: the measurement isn't finished, so this area isn't priced. The outline crosses itself, so its area can't be measured. Redraw it so the sides don't cross.",
    );
    const allCutouts: Measurement = { ...newMeasurement('attic'), shape: { kind: 'rect', dims: { A: '10', B: '10' } }, cutouts: [{ id: 'c', label: 'Stairwell', shape: { kind: 'rect', dims: { A: '20', B: '20' } }, qty: '1' }] };
    expect(measurementChecks(withMeasurement(start.d, start.id, allCutouts))[0]!.label).toBe(
      "Exterior walls: the measurement isn't finished, so this area isn't priced. Cutouts are larger than the area; net is 0.",
    );
  });
});
