// Measuring an estimate area (the AtticScan tools inside the field app): the saved inputs, and
// gross / cutouts / net square feet from them. Pure. The net becomes the area's sqft.
import { z } from 'zod';
import { solveShape, type ShapeInput, type SolvedShape } from './geometry';
import { formatFeet, parseFeet, readPitch, steepPitchNote, type PitchRead } from './units';

/** How the area is measured. */
export const MEASURE_MODES = ['floor', 'roofline', 'walls'] as const;
export type MeasureMode = (typeof MEASURE_MODES)[number];

export const MODE_INFO: Record<MeasureMode, { label: string; hint: string }> = {
  floor: { label: 'Floor', hint: 'Footprint minus cutouts (attic floor, crawlspace ground, garage ceiling).' },
  roofline: { label: 'Roofline', hint: 'Underside of the roof deck: footprint × pitch factor.' },
  walls: { label: 'Walls', hint: 'Wall run × average height minus windows, doors and vents.' },
};

/** The mode a new measurement starts in for each job type. */
export const DEFAULT_MODE: Record<string, MeasureMode> = {
  attic: 'floor',
  crawlspace: 'floor',
  garage: 'floor',
  commercial: 'floor',
  walls: 'walls',
  rim_joist: 'walls',
};

/** Quick-pick cutout names per mode. */
export const CUTOUT_NAMES: Record<MeasureMode, string[]> = {
  floor: ['Chimney', 'HVAC platform', 'Stairwell', 'Knee-wall void', 'Attic hatch'],
  roofline: ['Skylight', 'Chimney', 'Dormer'],
  walls: ['Window', 'Door', 'Vent', 'Garage door'],
};

/** Cutouts per measurement (the stored schema's limit). */
export const MAX_CUTOUTS = 30;

// Everything is kept as typed text (24'6", 6/12…) so the inputs show back exactly what was entered.
const len = z.string().max(40);
const shapeSchema = z.object({
  kind: z.enum(['rect', 'L', 'T', 'U', 'custom']),
  dims: z.partialRecord(z.enum(['A', 'B', 'C', 'D']), len),
  custom: z
    .object({
      points: z.array(z.tuple([z.number().finite(), z.number().finite()])).max(40),
      closed: z.boolean(),
      sides: z.array(len).max(40),
    })
    .optional(),
});

export const measurementSchema = z.object({
  mode: z.enum(MEASURE_MODES),
  shape: shapeSchema,
  cutouts: z
    .array(z.object({ id: z.string().max(64), label: z.string().max(60), shape: shapeSchema, qty: z.string().max(6) }))
    .max(MAX_CUTOUTS),
  pitch: z.string().max(12),
  twoSlope: z.boolean(),
  pitch2: z.string().max(12),
  splitPct: z.string().max(6),
  wallHeight: len,
  perimeter: len,
});
export type Measurement = z.infer<typeof measurementSchema>;
export type Cutout = Measurement['cutouts'][number];

export function newShape(): ShapeInput {
  return { kind: 'rect', dims: {} };
}

export function newMeasurement(jobType: string): Measurement {
  return {
    mode: DEFAULT_MODE[jobType] ?? 'floor',
    shape: newShape(),
    cutouts: [],
    pitch: '',
    twoSlope: false,
    pitch2: '',
    splitPct: '50',
    wallHeight: '',
    perimeter: '',
  };
}

export function newCutout(mode: MeasureMode, id: string = crypto.randomUUID()): Cutout {
  return { id, label: CUTOUT_NAMES[mode][0] ?? 'Cutout', shape: newShape(), qty: '1' };
}

/** Rise/12 → slope length per foot of run. 6/12 → 1.118. */
export function pitchFactor(rise: number): number {
  return Math.sqrt(1 + (rise / 12) ** 2);
}

export interface MeasureResult {
  gross: number;
  cutouts: number;
  net: number;
  /** Problems that stop the measurement from having a number. */
  errors: string[];
  /** How gross was worked out, e.g. "1,200 sq ft footprint × pitch (6/12 → ×1.118)". */
  basis: string;
  notes: string[];
  footprint?: SolvedShape;
  cutoutResults: Array<{ id: string; area: number; errors: string[] }>;
}

function cutoutArea(c: Cutout): { area: number; errors: string[] } {
  const r = solveShape(c.shape);
  const qtyText = c.qty.trim();
  const qty = qtyText ? Number(qtyText) : 1;
  const errors = r.ok ? [] : [...r.errors];
  if (!Number.isInteger(qty) || qty < 0) errors.push('Quantity must be a whole number.');
  if (!r.ok || errors.length) return { area: 0, errors };
  return { area: r.shape.area * qty, errors };
}

const sqftText = (n: number) => Math.round(n).toLocaleString('en-US');
const pitchText = (rise: number) => `${Math.round(rise * 100) / 100}/12`;
/** "6/12", or "30° = 6.93/12" for a pitch typed in degrees. */
const pitchWords = (p: Extract<PitchRead, { ok: true }>) => (p.degrees === null ? pitchText(p.rise) : `${p.degrees}° = ${pitchText(p.rise)}`);

/** Gross, cutouts and net square feet. Any error leaves all three at zero. */
export function computeMeasurement(m: Measurement): MeasureResult {
  const result: MeasureResult = { gross: 0, cutouts: 0, net: 0, errors: [], basis: '', notes: [], cutoutResults: [] };
  const shape = solveShape(m.shape);

  for (const c of m.cutouts) {
    const r = cutoutArea(c);
    result.cutoutResults.push({ id: c.id, area: r.area, errors: r.errors });
    if (r.errors.length) result.errors.push(`${c.label || 'Cutout'}: ${r.errors[0]}`);
    result.cutouts += r.area;
  }

  if (m.mode === 'walls') {
    // Wall area = run of wall × average height; the run is typed, or the outline's perimeter.
    let run = 0;
    if (m.perimeter.trim()) {
      const p = parseFeet(m.perimeter);
      if (p === null || p <= 0) result.errors.push(`Wall length "${m.perimeter}" isn't a length.`);
      else run = p;
    } else if (shape.ok) {
      run = shape.shape.perimeter;
      result.footprint = shape.shape;
    } else {
      result.errors.push(...shape.errors);
    }
    const h = parseFeet(m.wallHeight);
    if (!m.wallHeight.trim()) result.errors.push('Enter the average wall height.');
    else if (h === null || h <= 0) result.errors.push(`Wall height "${m.wallHeight}" isn't a length.`);
    if (result.errors.length || h === null) return zeroed(result);
    result.gross = run * h;
    result.basis = `${formatFeet(run)} of wall × ${formatFeet(h)} high`;
  } else {
    if (!shape.ok) {
      result.errors.push(...shape.errors);
      return zeroed(result);
    }
    result.footprint = shape.shape;
    result.notes.push(...shape.shape.notes);
    const footprint = shape.shape.area;

    if (m.mode === 'roofline') {
      // Rise per 12 or degrees, nothing steeper than 24/12 (lib/measure/units readPitch).
      const p1 = readPitch(m.pitch, 'Pitch');
      if (!p1) result.errors.push('Enter the roof pitch (e.g. 6/12 or 30°).');
      else if (!p1.ok) result.errors.push(p1.error);
      const r1 = p1?.ok ? p1 : null;
      let factor = r1 ? pitchFactor(r1.rise) : 0;
      let how = r1 ? `${pitchWords(r1)} → ×${factor.toFixed(3)}` : '';
      const steep1 = steepPitchNote(m.pitch, 'Pitch');
      if (steep1) result.notes.push(steep1);
      if (m.twoSlope) {
        const p2 = readPitch(m.pitch2, 'Second pitch');
        const split = m.splitPct.trim() ? Number(m.splitPct) : NaN;
        if (!p2) result.errors.push('Enter the second pitch.');
        else if (!p2.ok) result.errors.push(p2.error);
        if (!(split >= 0 && split <= 100)) result.errors.push('Split must be a percentage from 0 to 100.');
        const steep2 = steepPitchNote(m.pitch2, 'Second pitch');
        if (steep2) result.notes.push(steep2);
        if (r1 && p2?.ok && split >= 0 && split <= 100) {
          factor = (split / 100) * pitchFactor(r1.rise) + (1 - split / 100) * pitchFactor(p2.rise);
          how = `${split}% at ${pitchWords(r1)} + ${100 - split}% at ${pitchWords(p2)} → ×${factor.toFixed(3)}`;
        }
      }
      if (result.errors.length) return zeroed(result);
      result.gross = footprint * factor;
      result.basis = `${sqftText(footprint)} sq ft footprint × pitch (${how})`;
    } else {
      result.gross = footprint;
      result.basis = `${sqftText(footprint)} sq ft footprint`;
    }
  }

  if (result.errors.length) return zeroed(result);
  if (result.cutouts > result.gross) result.notes.push('Cutouts are larger than the area; net is 0.');
  result.net = Math.max(0, result.gross - result.cutouts);
  return result;
}

function zeroed(r: MeasureResult): MeasureResult {
  return { ...r, gross: 0, cutouts: 0, net: 0 };
}

/** The area's sqft from a measurement: whole square feet, or null when it isn't complete. */
export function measuredSqft(m: Measurement): number | null {
  const r = computeMeasurement(m);
  return r.errors.length || r.net <= 0 ? null : Math.round(r.net);
}

const SHAPE_WORDS: Record<ShapeInput['kind'], string> = { rect: 'rectangle', L: 'L-shape', T: 'T-shape', U: 'U-shape', custom: 'custom outline' };

/** One line for the area card, e.g. "Measured: L-shape, 2 cutouts". */
export function measurementSummary(m: Measurement): string {
  const parts = [m.mode === 'walls' && m.perimeter.trim() ? 'wall run' : SHAPE_WORDS[m.shape.kind]];
  if (m.mode === 'roofline') parts.push(`pitch ${m.pitch || '?'}${m.twoSlope ? ` + ${m.pitch2 || '?'}` : ''}`);
  if (m.mode === 'walls') parts.push(`${m.wallHeight || '?'} high`);
  if (m.cutouts.length) parts.push(`${m.cutouts.length} cutout${m.cutouts.length === 1 ? '' : 's'}`);
  return `${MODE_INFO[m.mode].label}: ${parts.join(', ')}`;
}
