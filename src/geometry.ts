// Plane geometry for floor plans: preset shapes, the custom-polygon solver, and the shoelace
// area. Coordinates are in feet with y pointing up; polygons run counter-clockwise.

import { parseFeet } from './units';

export type Point = [number, number];

export type ShapeKind = 'rect' | 'L' | 'T' | 'U' | 'custom';

/** What the user entered for one shape. Lengths stay as typed text so the inputs show it back. */
export interface ShapeInput {
  kind: ShapeKind;
  /** Preset dimensions by letter (A, B, C, D). */
  dims: Record<string, string>;
  /** Custom polygon: tapped grid points (feet), whether closed, and typed side lengths. */
  custom?: CustomShape;
}

export interface CustomShape {
  points: Point[];
  closed: boolean;
  /** One entry per side; side i runs from point i to point i+1 (wrapping). Blank = use the drawing. */
  sides: string[];
}

/** One side of a solved polygon, for labelling the drawing. */
export interface Edge {
  from: Point;
  to: Point;
  length: number;
  /** Input letter for preset sides that carry a dimension (A–D); custom sides use their number. */
  label?: string;
}

export interface SolvedShape {
  points: Point[];
  edges: Edge[];
  area: number;
  perimeter: number;
  /** Notes worth showing (e.g. custom sides adjusted so the shape closes). */
  notes: string[];
}

export type ShapeResult = { ok: true; shape: SolvedShape } | { ok: false; errors: string[] };

/** The dimension letters each preset needs, with a description for the input label. */
export const PRESET_DIMS: Record<Exclude<ShapeKind, 'custom'>, Array<{ key: string; label: string }>> = {
  rect: [
    { key: 'A', label: 'Width' },
    { key: 'B', label: 'Depth' },
  ],
  L: [
    { key: 'A', label: 'Overall width' },
    { key: 'B', label: 'Overall depth' },
    { key: 'C', label: 'Notch width' },
    { key: 'D', label: 'Notch depth' },
  ],
  T: [
    { key: 'A', label: 'Top width' },
    { key: 'B', label: 'Top depth' },
    { key: 'C', label: 'Stem width' },
    { key: 'D', label: 'Stem depth' },
  ],
  U: [
    { key: 'A', label: 'Overall width' },
    { key: 'B', label: 'Overall depth' },
    { key: 'C', label: 'Opening width' },
    { key: 'D', label: 'Opening depth' },
  ],
};

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  L: 'L-shape',
  T: 'T-shape',
  U: 'U-shape',
  custom: 'Custom',
};

/** Shoelace formula: signed area, positive for counter-clockwise polygons. */
export function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function polygonArea(points: Point[]): number {
  return Math.abs(signedArea(points));
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function edgesOf(points: Point[], labels: Array<string | undefined> = []): Edge[] {
  return points.map((p, i) => {
    const q = points[(i + 1) % points.length]!;
    return { from: p, to: q, length: dist(p, q), label: labels[i] };
  });
}

function solved(points: Point[], labels: Array<string | undefined>, notes: string[] = []): SolvedShape {
  const edges = edgesOf(points, labels);
  return {
    points,
    edges,
    area: polygonArea(points),
    perimeter: edges.reduce((s, e) => s + e.length, 0),
    notes,
  };
}

/** Reads the preset letters, collecting a message for each missing or unreadable one. */
function readDims(input: ShapeInput, kind: Exclude<ShapeKind, 'custom'>, errors: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key, label } of PRESET_DIMS[kind]) {
    const raw = input.dims[key] ?? '';
    const v = parseFeet(raw);
    if (!raw.trim()) errors.push(`Enter ${key} (${label.toLowerCase()}).`);
    else if (v === null) errors.push(`${key} "${raw}" isn't a length. Try 24'6", 24.5 or 294".`);
    else if (v <= 0) errors.push(`${key} must be more than zero.`);
    else out[key] = v;
  }
  return out;
}

/**
 * Builds the polygon for a shape. Preset sides are labelled with their letter so the drawing
 * shows which input is which; the other sides show their computed length.
 */
export function solveShape(input: ShapeInput): ShapeResult {
  if (input.kind === 'custom') return solveCustom(input.custom);
  const errors: string[] = [];
  const d = readDims(input, input.kind, errors);
  if (errors.length) return { ok: false, errors };
  const { A = 0, B = 0, C = 0, D = 0 } = d;

  switch (input.kind) {
    case 'rect':
      return { ok: true, shape: solved([[0, 0], [A, 0], [A, B], [0, B]], ['A', 'B']) };
    case 'L': {
      // Notch C × D cut from the top-right corner.
      if (C >= A) errors.push('Notch width C must be less than overall width A.');
      if (D >= B) errors.push('Notch depth D must be less than overall depth B.');
      if (errors.length) return { ok: false, errors };
      return {
        ok: true,
        shape: solved([[0, 0], [A, 0], [A, B - D], [A - C, B - D], [A - C, B], [0, B]], ['A', undefined, 'C', 'D', undefined, 'B']),
      };
    }
    case 'T': {
      // Top bar A × B sitting on a centred stem C × D.
      if (C >= A) errors.push('Stem width C must be less than top width A.');
      if (errors.length) return { ok: false, errors };
      const x0 = (A - C) / 2;
      return {
        ok: true,
        shape: solved(
          [[x0, 0], [x0 + C, 0], [x0 + C, D], [A, D], [A, D + B], [0, D + B], [0, D], [x0, D]],
          ['C', 'D', undefined, 'B', 'A'],
        ),
      };
    }
    case 'U': {
      // A × B with a centred opening C × D cut down from the top edge.
      if (C >= A) errors.push('Opening width C must be less than overall width A.');
      if (D >= B) errors.push('Opening depth D must be less than overall depth B.');
      if (errors.length) return { ok: false, errors };
      const x0 = (A - C) / 2;
      return {
        ok: true,
        shape: solved(
          [[0, 0], [A, 0], [A, B], [x0 + C, B], [x0 + C, B - D], [x0, B - D], [x0, B], [0, B]],
          ['A', 'B', undefined, 'D', 'C'],
        ),
      };
    }
  }
}

/**
 * Solves a custom polygon from its drawing and typed side lengths.
 *
 * The taps give each side's direction; the typed lengths give its size. Real measurements
 * rarely close perfectly, so the lengths are adjusted as little as possible (weighted least
 * squares with the closure as a constraint) until the outline closes. Typed sides are held
 * tight; blank sides take their length from the drawing and absorb most of any gap.
 */
export function solveCustom(custom: CustomShape | undefined): ShapeResult {
  if (!custom || custom.points.length < 3) return { ok: false, errors: ['Tap at least 3 corners on the grid.'] };
  if (!custom.closed) return { ok: false, errors: ['Close the shape: tap the first corner again, or tap "Close".'] };

  const pts = custom.points;
  const n = pts.length;
  const errors: string[] = [];
  const dirs: Point[] = [];
  const target: number[] = [];
  const sigma: number[] = [];
  const typed: boolean[] = [];

  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const drawn = dist(a, b);
    if (drawn === 0) return { ok: false, errors: [`Side ${i + 1} has no length in the drawing. Undo and re-tap.`] };
    dirs.push([(b[0] - a[0]) / drawn, (b[1] - a[1]) / drawn]);
    const raw = custom.sides[i] ?? '';
    const v = raw.trim() ? parseFeet(raw) : null;
    if (raw.trim() && v === null) errors.push(`Side ${i + 1}: "${raw}" isn't a length.`);
    else if (v !== null && v <= 0) errors.push(`Side ${i + 1} must be more than zero.`);
    const isTyped = v !== null && v > 0;
    typed.push(isTyped);
    target.push(isTyped ? v : drawn);
    // Typed sides may move ~1%, drawn sides ~100%: blank sides soak up the closure gap.
    sigma.push(Math.max(target[i]!, 0.1) * (isTyped ? 0.01 : 1));
  }
  if (errors.length) return { ok: false, errors };

  // Minimise Σ((l−L)/σ)² subject to Σ l·dir = 0.  With A = [dirs] (2×n), S = diag(σ²):
  //   l = L − S Aᵀ (A S Aᵀ)⁻¹ (A L)
  let m00 = 0, m01 = 0, m11 = 0, gx = 0, gy = 0;
  for (let i = 0; i < n; i++) {
    const [dx, dy] = dirs[i]!;
    const s = sigma[i]! ** 2;
    m00 += s * dx * dx;
    m01 += s * dx * dy;
    m11 += s * dy * dy;
    gx += target[i]! * dx;
    gy += target[i]! * dy;
  }
  const det = m00 * m11 - m01 * m01;
  if (Math.abs(det) < 1e-9) return { ok: false, errors: ['All corners are in a straight line. Tap a real outline.'] };
  const lx = (m11 * gx - m01 * gy) / det;
  const ly = (-m01 * gx + m00 * gy) / det;
  const lengths = target.map((L, i) => L - sigma[i]! ** 2 * (dirs[i]![0] * lx + dirs[i]![1] * ly));

  if (lengths.some((l) => l <= 0)) {
    return { ok: false, errors: ["These side lengths can't make the drawn shape. Check the numbers or redraw the outline."] };
  }
  // A typed side that has to stretch more than 10% means the numbers disagree, not rounding.
  const worst = lengths.reduce((w, l, i) => {
    const off = typed[i] ? Math.abs(l - target[i]!) / target[i]! : 0;
    return off > w.off ? { off, i } : w;
  }, { off: 0, i: -1 });
  if (worst.off > 0.1) {
    return {
      ok: false,
      errors: [`The side lengths don't close the drawn shape (side ${worst.i + 1} would be off by ${Math.round(worst.off * 100)}%). Check the numbers or redraw the outline.`],
    };
  }

  // Walk the sides from the first tapped corner.
  const points: Point[] = [[pts[0]![0], pts[0]![1]]];
  for (let i = 0; i < n - 1; i++) {
    const [x, y] = points[i]!;
    points.push([x + lengths[i]! * dirs[i]![0], y + lengths[i]! * dirs[i]![1]]);
  }

  const notes: string[] = [];
  lengths.forEach((l, i) => {
    const off = Math.abs(l - target[i]!);
    if (typed[i] && off > 1 / 12) notes.push(`Side ${i + 1} adjusted by ${Math.round(off * 12)}" so the shape closes.`);
  });
  const untyped = typed.filter((t) => !t).length;
  if (untyped) notes.push(`${untyped} side${untyped > 1 ? 's' : ''} taken from the drawing (no length typed).`);

  const shape = solved(points, points.map((_, i) => `#${i + 1}`), notes);
  if (selfIntersects(points)) shape.notes.unshift('The outline crosses itself; the area may be wrong. Redraw it.');
  return { ok: true, shape };
}

/** True when two non-adjacent sides cross. */
export function selfIntersects(points: Point[]): boolean {
  const n = points.length;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the wrap
      const a = points[i]!, b = points[(i + 1) % n]!, c = points[j]!, d = points[(j + 1) % n]!;
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) return true;
    }
  }
  return false;
}
