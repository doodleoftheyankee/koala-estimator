// What a measurement does to its area (L26, RF-07): a finished one sets the square feet; one that
// breaks takes back the size it gave, so the area is Incomplete and not priced until it is finished,
// and the estimator is shown where to finish it. Pure; app/field/AreasStep uses it.
import { sqftAfterMeasurement, unfinishedReason, type Measurement } from '@/lib/measure/measure';
import { areaSchema, type EstimateDraft } from '@/lib/sync/draft';
import type { Fix } from './fix';

/** The draft with an area's measurement saved, and its square feet as the measurement leaves them. */
export function withMeasurement(d: EstimateDraft, areaId: string, m: Measurement): EstimateDraft {
  const before = d.measurements[areaId];
  return {
    ...d,
    measurements: { ...d.measurements, [areaId]: m },
    areas: d.areas.map((a) => (a.id === areaId ? { ...a, sqft: sqftAfterMeasurement(a.sqft, before, m) } : a)),
  };
}

export interface MeasurementCheck {
  id: string;
  areaId: string;
  ok: false;
  label: string;
  fix: Fix;
}

/**
 * Areas left with no size by a measurement that is not finished: they are not priced. One check
 * per area, naming it and the first thing to finish, with a "Finish measuring" fix. An area priced
 * on a size typed by hand, or with no measurement, is not a measuring problem.
 */
export function measurementChecks(d: Pick<EstimateDraft, 'areas' | 'measurements'>): MeasurementCheck[] {
  const out: MeasurementCheck[] = [];
  for (const a of d.areas) {
    const m = d.measurements[a.id];
    if (!m || areaSchema.shape.sqft.safeParse(a.sqft).success) continue;
    const why = unfinishedReason(m);
    if (why === null) continue;
    out.push({
      id: `measure:${a.id}`,
      areaId: a.id,
      ok: false,
      label: `${a.name.trim() || 'This area'}: the measurement isn't finished, so this area isn't priced. ${why}`,
      fix: { label: 'Finish measuring', target: { step: 'areas', areaId: a.id, open: 'measure' } },
    });
  }
  return out;
}
