// The job data model and the square-footage calculation for each kind of space.

import { solveShape, type ShapeInput, type SolvedShape } from './geometry';
import { parseFeet, parseNumber, parsePitch, formatFeet } from './units';

export type SpaceType = 'attic_floor' | 'roofline' | 'crawl_floor' | 'crawl_walls';

export const SPACE_TYPES: Array<{ type: SpaceType; name: string; hint: string }> = [
  { type: 'attic_floor', name: 'Attic Floor', hint: 'Floor of the attic: footprint minus cutouts.' },
  { type: 'roofline', name: 'Roofline', hint: 'Underside of the roof deck: footprint × pitch factor.' },
  { type: 'crawl_floor', name: 'Crawl Floor', hint: 'Crawlspace ground or ceiling: footprint minus cutouts.' },
  { type: 'crawl_walls', name: 'Crawl Walls', hint: 'Foundation walls: perimeter × average height minus vents and doors.' },
];

export const SPACE_NAME: Record<SpaceType, string> = Object.fromEntries(SPACE_TYPES.map((s) => [s.type, s.name])) as Record<SpaceType, string>;

/** Quick-pick names for cutouts, per space type. Anything else can be typed. */
export const CUTOUT_PRESETS: Record<SpaceType, string[]> = {
  attic_floor: ['Chimney', 'HVAC platform', 'Stairwell', 'Knee-wall void', 'Attic hatch'],
  roofline: ['Skylight', 'Chimney', 'Dormer', 'Vent'],
  crawl_floor: ['Chimney base', 'Pier', 'Sump', 'HVAC pad'],
  crawl_walls: ['Vent', 'Access door', 'Window'],
};

export interface Cutout {
  id: string;
  label: string;
  shape: ShapeInput;
  /** How many identical cutouts (e.g. 4 vents). */
  qty: string;
}

export interface Space {
  id: string;
  name: string;
  type: SpaceType;
  /** Footprint (plan view). For crawl walls, the outline whose perimeter is the wall run. */
  shape: ShapeInput;
  cutouts: Cutout[];
  /** Roofline: pitch as X/12, an optional second pitch, and the % of footprint at the first pitch. */
  pitch: string;
  twoSlope: boolean;
  pitch2: string;
  splitPct: string;
  /** Crawl walls: average wall height, and an optional typed perimeter that overrides the outline. */
  wallHeight: string;
  perimeter: string;
  notes: string;
}

export interface Job {
  id: string;
  customer: string;
  address: string;
  spaces: Space[];
  createdAt: number;
  updatedAt: number;
}

export function uid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newShape(): ShapeInput {
  return { kind: 'rect', dims: {} };
}

export function newJob(): Job {
  const now = Date.now();
  return { id: uid(), customer: '', address: '', spaces: [], createdAt: now, updatedAt: now };
}

export function newSpace(type: SpaceType, existing: Space[]): Space {
  const count = existing.filter((s) => s.type === type).length;
  return {
    id: uid(),
    name: count ? `${SPACE_NAME[type]} ${count + 1}` : SPACE_NAME[type],
    type,
    shape: newShape(),
    cutouts: [],
    pitch: '',
    twoSlope: false,
    pitch2: '',
    splitPct: '50',
    wallHeight: '',
    perimeter: '',
    notes: '',
  };
}

export function newCutout(type: SpaceType): Cutout {
  return { id: uid(), label: CUTOUT_PRESETS[type][0] ?? 'Cutout', shape: newShape(), qty: '1' };
}

/** Rise/12 → slope length per foot of run. 6/12 → 1.118. */
export function pitchFactor(rise: number): number {
  return Math.sqrt(1 + (rise / 12) ** 2);
}

export interface SpaceResult {
  gross: number;
  cutouts: number;
  net: number;
  /** Problems that stop the space from having a number. */
  errors: string[];
  /** Short explanation of how gross was worked out, e.g. "1,200 sq ft footprint × 1.118 (6/12)". */
  basis: string;
  notes: string[];
  footprint?: SolvedShape;
  cutoutResults: Array<{ id: string; area: number; errors: string[] }>;
}

/** Area of one cutout × its quantity. */
function cutoutArea(c: Cutout): { area: number; errors: string[] } {
  const r = solveShape(c.shape);
  const qty = c.qty.trim() ? parseNumber(c.qty) : 1;
  const errors = r.ok ? [] : r.errors;
  if (qty === null || qty < 0 || !Number.isInteger(qty)) errors.push('Quantity must be a whole number.');
  if (errors.length) return { area: 0, errors };
  return { area: (r as { ok: true; shape: SolvedShape }).shape.area * (qty ?? 1), errors };
}

/** Gross, cutouts and net square feet for one space. Errors leave the numbers at zero. */
export function computeSpace(space: Space): SpaceResult {
  const result: SpaceResult = { gross: 0, cutouts: 0, net: 0, errors: [], basis: '', notes: [], cutoutResults: [] };
  const shape = solveShape(space.shape);

  for (const c of space.cutouts) {
    const r = cutoutArea(c);
    result.cutoutResults.push({ id: c.id, area: r.area, errors: r.errors });
    if (r.errors.length) result.errors.push(`${c.label || 'Cutout'}: ${r.errors[0]}`);
    result.cutouts += r.area;
  }

  if (space.type === 'crawl_walls') {
    // Wall area = run of wall × average height. The run comes from a typed perimeter, or the outline.
    const typedPerimeter = space.perimeter.trim() ? parseFeet(space.perimeter) : null;
    let perimeter = 0;
    if (space.perimeter.trim()) {
      if (typedPerimeter === null || typedPerimeter <= 0) result.errors.push(`Perimeter "${space.perimeter}" isn't a length.`);
      else perimeter = typedPerimeter;
    } else if (shape.ok) {
      perimeter = shape.shape.perimeter;
      result.footprint = shape.shape;
    } else {
      result.errors.push(...shape.errors);
    }
    const h = parseFeet(space.wallHeight);
    if (!space.wallHeight.trim()) result.errors.push('Enter the average wall height.');
    else if (h === null || h <= 0) result.errors.push(`Wall height "${space.wallHeight}" isn't a length.`);
    if (result.errors.length) return result;
    result.gross = perimeter * h!;
    result.basis = `${formatFeet(perimeter)} perimeter × ${formatFeet(h!)} avg height`;
  } else {
    if (!shape.ok) {
      result.errors.push(...shape.errors);
      return result;
    }
    result.footprint = shape.shape;
    result.notes.push(...shape.shape.notes);
    const footprint = shape.shape.area;

    if (space.type === 'roofline') {
      const p1 = parsePitch(space.pitch);
      if (!space.pitch.trim()) result.errors.push('Enter the roof pitch (e.g. 6/12).');
      else if (p1 === null) result.errors.push(`Pitch "${space.pitch}" isn't valid. Use rise/12, e.g. 6/12.`);
      let factor = p1 === null ? 0 : pitchFactor(p1);
      let pitchText = `${fmtPitch(p1)} → ×${factor.toFixed(3)}`;
      if (space.twoSlope) {
        const p2 = parsePitch(space.pitch2);
        const split = parseNumber(space.splitPct);
        if (!space.pitch2.trim()) result.errors.push('Enter the second pitch.');
        else if (p2 === null) result.errors.push(`Second pitch "${space.pitch2}" isn't valid.`);
        if (split === null || split < 0 || split > 100) result.errors.push('Split must be a percentage from 0 to 100.');
        if (p1 !== null && p2 !== null && split !== null && split >= 0 && split <= 100) {
          const f2 = pitchFactor(p2);
          factor = (split / 100) * pitchFactor(p1) + (1 - split / 100) * f2;
          pitchText = `${split}% at ${fmtPitch(p1)} + ${100 - split}% at ${fmtPitch(p2)} → ×${factor.toFixed(3)}`;
        }
      }
      if (result.errors.length) return result;
      result.gross = footprint * factor;
      result.basis = `${Math.round(footprint).toLocaleString('en-US')} sq ft footprint × pitch (${pitchText})`;
    } else {
      result.gross = footprint;
      result.basis = `${Math.round(footprint).toLocaleString('en-US')} sq ft footprint`;
    }
  }

  if (result.errors.length) {
    result.gross = 0;
    result.cutouts = 0;
    return result;
  }
  if (result.cutouts > result.gross) result.notes.push('Cutouts are larger than the space; net is shown as 0.');
  result.net = Math.max(0, result.gross - result.cutouts);
  return result;
}

function fmtPitch(rise: number | null): string {
  if (rise === null) return '?/12';
  return `${Math.round(rise * 100) / 100}/12`;
}

/** Net square feet per space type for a whole job (only types that appear). */
export function totalsByType(job: Job): Array<{ type: SpaceType; net: number; spaces: number }> {
  return SPACE_TYPES.map(({ type }) => {
    const spaces = job.spaces.filter((s) => s.type === type);
    return { type, spaces: spaces.length, net: spaces.reduce((sum, s) => sum + computeSpace(s).net, 0) };
  }).filter((t) => t.spaces > 0);
}
