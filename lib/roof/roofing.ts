// The roofing side of a satellite lookup, as the Roof Takeoff page worked it out: roofing squares,
// waste and the order in squares and bundles, the feet of each roof edge type and the materials
// they come to, one colour per edge type (the photo and its legend), and everything a printed
// report or a copied summary says. Pure (no network, no DOM).
import {
  EDGE_TYPES,
  facing,
  FT_PER_M,
  imageryText,
  mainPitch,
  pitchText,
  roofFigures,
  roundFt,
  roundSqft,
  SQFT_PER_M2,
  type EdgeType,
  type LatLng,
  type RoofChoices,
  type RoofResult,
} from './lookup';

// ---------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------

/**
 * Each edge type's name and what it is in plain words (a pitch break is drawn dashed). The colours
 * the map, legend and printed report draw with are the Daymark map tokens in lib/roof/draw.ts
 * (MAP_COLORS, edgeColor); lib/roof/draw.test.ts pins them.
 */
export const EDGE_INFO: Record<EdgeType, { label: string; what: string; dash?: readonly [number, number] }> = {
  ridge: { label: 'Ridge', what: 'Top line where two faces meet' },
  hip: { label: 'Hip', what: 'Sloped outside corner between two faces' },
  valley: { label: 'Valley', what: 'Inside corner where two faces drain together' },
  eave: { label: 'Eave', what: 'Low, level edge at the gutter' },
  rake: { label: 'Rake', what: 'Sloped edge at a gable end' },
  step: { label: 'Step', what: 'Sloped side of a roof against a wall' },
  headwall: { label: 'Headwall', what: 'Level top of a roof against a wall' },
  break: { label: 'Pitch break', what: 'Pitch changes between two faces', dash: [7, 5] },
};

export const EDGES_NOT_MEASURED = "Roof edge lengths weren't measured for this house. Measure them on site.";

/** Feet of each edge type along the slope (unrounded). */
export function edgeFeet(r: Pick<RoofResult, 'edgeTotalsM'>): Record<EdgeType, number> {
  return Object.fromEntries(EDGE_TYPES.map((k) => [k, (Number(r.edgeTotalsM?.[k]) || 0) * FT_PER_M])) as Record<EdgeType, number>;
}

/** The edge types this roof has, in the contract's order (types with no length are left out). */
export function presentEdges(ft: Record<EdgeType, number>): EdgeType[] {
  return EDGE_TYPES.filter((k) => ft[k] > 0);
}

/** Whether Roof Takeoff measured the roof edges at all (an older answer, or no surface heights, has none). */
export const edgesMeasured = (r: Pick<RoofResult, 'edgeTotalsM'>) => presentEdges(edgeFeet(r)).length > 0;

export interface Material {
  item: string;
  /** Which edges it runs along. */
  from: string;
  /** Feet, rounded up to the next foot. */
  ft: number;
}

/**
 * Order quantities from the edge feet, each rounded up to the next foot; items with nothing to order
 * are left out. A roof with no shingle area (flat or low-slope) gets no starter strip or ridge cap.
 */
export function materials(ft: Record<EdgeType, number>, shingles = true): Material[] {
  const up = (v: number) => Math.ceil(v - 1e-9);
  return [
    { item: 'Drip edge', from: 'Eaves + rakes', ft: up(ft.eave + ft.rake) },
    { item: 'Starter strip', from: 'Eaves', ft: shingles ? up(ft.eave) : 0 },
    { item: 'Ridge cap', from: 'Ridges + hips', ft: shingles ? up(ft.ridge + ft.hip) : 0 },
    { item: 'Valley (ice and water, flashing)', from: 'Valleys', ft: up(ft.valley) },
    { item: 'Step flashing', from: 'Steps', ft: up(ft.step) },
    { item: 'Headwall (apron) flashing', from: 'Headwalls', ft: up(ft.headwall) },
  ].filter((m) => m.ft > 0);
}

// ---------------------------------------------------------------------------------------------
// Squares, waste and the order
// ---------------------------------------------------------------------------------------------

/** Waste choices by roof shape, and the range a typed waste is kept to. */
export const WASTE_CHOICES = [
  { pct: 10, label: 'Gable 10%' },
  { pct: 15, label: 'Hip 15%' },
  { pct: 20, label: 'Cut-up 20%' },
] as const;
export const DEFAULT_WASTE = 15;
export const MAX_WASTE = 50;
export const BUNDLES_PER_SQUARE = 3;

/** A typed waste percent kept within 0 to 50; anything that isn't a number is the default. */
export function clampWaste(pct: number): number {
  return Number.isFinite(pct) ? Math.max(0, Math.min(MAX_WASTE, pct)) : DEFAULT_WASTE;
}

/** The roof surface: every roof face along the slope, overhangs included. Null when Google has no roof faces. */
export function roofSurfaceSqft(r: Pick<RoofResult, 'segments'>): number | null {
  return r.segments.length ? r.segments.reduce((sum, s) => sum + s.areaM2, 0) * SQFT_PER_M2 : null;
}

/**
 * Roof surface of the faces under 2/12 (lowSlope): too flat for shingles (membrane or rolled
 * roofing), so they are kept out of the squares and the order. 0 when there are none.
 */
export function lowSlopeSqft(r: Pick<RoofResult, 'segments'>): number {
  return r.segments.filter((s) => s.lowSlope).reduce((sum, s) => sum + s.areaM2, 0) * SQFT_PER_M2;
}

/** Roof surface at 2/12 and steeper: what takes shingles. Null when Google has no roof faces. */
export function shingleSqft(r: Pick<RoofResult, 'segments'>): number | null {
  return r.segments.length ? r.segments.filter((s) => !s.lowSlope).reduce((sum, s) => sum + s.areaM2, 0) * SQFT_PER_M2 : null;
}

/** Roofing squares: 100 sq ft of roof surface each. */
export const roofingSquares = (roofSqft: number) => roofSqft / 100;

export interface Order {
  /** Bundles to order, at 3 per square, rounded up to the next bundle. */
  bundles: number;
  /** The same in squares (a third of a square per bundle). */
  squares: number;
  /** Squares as the roofer says them: "24", "24⅓", "24⅔". */
  text: string;
}

/** What to order for a roof surface with a waste allowance, rounded up to the next bundle. */
export function orderFor(roofSqft: number, wastePct: number): Order {
  const bundles = Math.max(0, Math.ceil((roofSqft / 100) * (1 + clampWaste(wastePct) / 100) * BUNDLES_PER_SQUARE - 1e-9));
  return { bundles, squares: bundles / BUNDLES_PER_SQUARE, text: `${Math.floor(bundles / 3)}${['', '⅓', '⅔'][bundles % 3]}` };
}

// ---------------------------------------------------------------------------------------------
// The takeoff as a report or a summary
// ---------------------------------------------------------------------------------------------

export const COMPANY = 'Koala Insulation of Newark';
export const LOW_SLOPE_LABEL = 'Low-slope roof (under 2/12, not shingles)';
export const NO_SHINGLES = 'No shingle area: flat or low-slope roof.';
/** "Squares", or "Squares (2/12 and up)" when low-slope faces were kept out. */
export const squaresLabel = (d: Pick<TakeoffData, 'lowSlopeSqft'>) => (d.lowSlopeSqft > 0 ? 'Squares (2/12 and up)' : 'Squares');
export const REPORT_FOOTER = 'Estimates from Google aerial imagery. Verify on site.';

const comma = (n: number) => n.toLocaleString('en-US');
const sqftText = (n: number | null) => (n === null ? '–' : `${comma(roundSqft(n))} sq ft`);
/** One decimal, always shown: "21.4". */
export const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const overhangText = (inches: number) => `${inches}"`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (items: readonly (string | number)[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const DETAIL: Record<string, string> = { HIGH: 'High-detail', MEDIUM: 'Medium-detail', LOW: 'Lower-detail' };
/** "High-detail aerial photo from May 2024". */
export function photoText(r: Pick<RoofResult, 'quality' | 'imagery'>): string {
  const when = imageryText(r);
  const detail = r.quality ? DETAIL[r.quality] : undefined;
  return `${detail ? `${detail} aerial photo` : 'Aerial photo'}${when ? ` from ${when}` : ', date unknown'}`;
}

/** "Nov 17, 2026, 2:05 PM" in the phone's time zone. */
export function lookedUpText(at: Date): string {
  return at.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ');
}

/** How the attic floor was worked out, in words: the overhang and what was left out. */
export function atticFloorNote(r: RoofResult, c: RoofChoices): string {
  const oh = c.overhangIn;
  let note: string;
  if (r.perimeterSource === 'outline') {
    note = oh ? `Roof outline minus a ${overhangText(oh)} overhang all the way around` : 'Roof outline, no overhang removed';
    if (oh && r.sharedWallM > 0) note += `, except along the ${comma(roundFt(r.sharedWallM * FT_PER_M))} ft shared wall`;
  } else if (r.perimeterSource === 'box') {
    note = oh ? `Google's building size minus a ${overhangText(oh)} overhang, with the roof edge estimated from the building's shape` : "Google's building size, no overhang removed";
  } else {
    note = "Google's building size. No overhang removed: the length of the roof edge isn't known";
  }
  const out = r.segments.filter((s) => c.excluded.includes(s.n)).map((s) => s.n);
  if (out.length) note += `, without ${out.length === 1 ? 'face' : 'faces'} ${list(out)}`;
  const noData = r.segments.length > 0 && c.unmatchedOut && r.unmatchedM2 > 0.05 * r.footprintM2 && r.unmatchedM2 > 5;
  if (noData) note += `${out.length ? ' and' : ', without'} the parts with no roof data`;
  return `${note}.`;
}

export interface TakeoffFace {
  n: number;
  pitch: string;
  /** Under 2/12: not for shingles. */
  lowSlope: boolean;
  /** "faces south" */
  direction: string;
  /** Roof surface of the face. */
  sqft: number;
  overAttic: boolean;
}

/** Everything the printed report and the copied summary say about a lookup. */
export interface TakeoffData {
  /** The address Google matched, or the roof tapped on the photo (near which house, and where). */
  title: string;
  lookedUp: string;
  photo: string;
  overhangIn: number;
  atticFloorSqft: number;
  atticNote: string;
  deckSqft: number | null;
  footprintSqft: number;
  wallRunFt: number | null;
  wallRunRough: boolean;
  /** Every face along the slope; null with no faces. */
  roofSqft: number | null;
  /** Faces under 2/12, kept out of the squares and the order (0 when none). */
  lowSlopeSqft: number;
  /** Squares and the order are for the faces at 2/12 and up; null with no faces, or none that steep. */
  squares: number | null;
  wastePct: number;
  order: Order | null;
  mainPitch: number | null;
  faces: TakeoffFace[];
  edgesMeasured: boolean;
  edges: Array<{ type: EdgeType; label: string; ft: number }>;
  materials: Material[];
  warnings: string[];
}

const at = (p: LatLng) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
/**
 * What a roof tapped on the photo (no address from Google) is called on paper: near which house it
 * was tapped, when that is known, and where.
 */
export function tappedTitle(point: LatLng, near: string | null): string {
  return near ? `Roof tapped near ${near} (${at(point)})` : `Roof tapped at ${at(point)}`;
}

/** Side-by-side face tables on the report, so a roof with many faces still fits the page: 1 up to 12 faces, 2 up to 26, then 3. */
export const reportFaceColumns = (faces: number) => (faces <= 12 ? 1 : faces <= 26 ? 2 : 3);

/** The name the browser gives a saved PDF of the report: the house, not the page. */
export const reportFileTitle = (d: Pick<TakeoffData, 'title'>) => `Roof takeoff - ${d.title}`;

/**
 * The takeoff for a result with the house's overhang, face choices and waste. `warnings` replaces
 * Roof Takeoff's own (the app's fuller "Check on site" list, in its words for paper); `near` is the
 * house a tapped roof belongs to (the address it was looked up by).
 */
export function takeoffData(
  r: RoofResult,
  c: RoofChoices,
  wastePct: number,
  lookedUpAt: Date,
  { warnings = r.warnings, near = null }: { warnings?: readonly string[]; near?: string | null } = {},
): TakeoffData {
  const f = roofFigures(r, c);
  const roofSqft = roofSurfaceSqft(r);
  const shingles = shingleSqft(r);
  const ft = edgeFeet(r);
  const waste = clampWaste(wastePct);
  const ordered = shingles !== null && shingles > 0 ? shingles : null;
  return {
    title: r.address ?? tappedTitle(r.point, near),
    lookedUp: lookedUpText(lookedUpAt),
    photo: photoText(r),
    overhangIn: c.overhangIn,
    atticFloorSqft: f.floorSqft,
    atticNote: atticFloorNote(r, c),
    deckSqft: f.deckSqft,
    footprintSqft: f.footprintSqft,
    wallRunFt: f.wallRunFt,
    wallRunRough: f.wallRunRough,
    roofSqft,
    lowSlopeSqft: lowSlopeSqft(r),
    squares: ordered === null ? null : roofingSquares(ordered),
    wastePct: waste,
    order: ordered === null ? null : orderFor(ordered, waste),
    mainPitch: mainPitch(r.segments),
    faces: r.segments.map((s) => ({
      n: s.n,
      pitch: pitchText(s.rise),
      lowSlope: s.lowSlope,
      direction: facing(s.azimuthDeg, s.rise),
      sqft: s.areaM2 * SQFT_PER_M2,
      overAttic: !c.excluded.includes(s.n),
    })),
    edgesMeasured: presentEdges(ft).length > 0,
    edges: presentEdges(ft).map((k) => ({ type: k, label: EDGE_INFO[k].label, ft: ft[k] })),
    materials: materials(ft, ordered !== null),
    warnings: [...warnings],
  };
}

/** The takeoff as plain text, to paste into a note, a text or an email. */
export function summaryText(d: TakeoffData): string {
  const L: string[] = [];
  L.push(`${COMPANY}: roof takeoff`, d.title, `Looked up ${d.lookedUp}. ${d.photo}.`, '');
  L.push(`Attic floor: ${sqftText(d.atticFloorSqft)} (${d.atticNote.replace(/\.$/, '')})`);
  if (d.deckSqft !== null) L.push(`Roof deck over the attic (spray foam): ${sqftText(d.deckSqft)}`);
  L.push(`Footprint: ${sqftText(d.footprintSqft)} (roof outline seen from above, to the drip edge)`);
  if (d.wallRunFt !== null) L.push(`Wall run: ${comma(roundFt(d.wallRunFt))} ft${d.wallRunRough ? " (rough: from the building's size)" : ''}`);
  L.push(`Roof surface: ${sqftText(d.roofSqft)}`);
  if (d.lowSlopeSqft > 0) L.push(`${LOW_SLOPE_LABEL}: ${sqftText(d.lowSlopeSqft)}`);
  if (d.squares !== null && d.order) {
    L.push(`${squaresLabel(d)}: ${oneDecimal(d.squares)}`, `Order with ${d.wastePct}% waste: ${d.order.text} squares (${plural(d.order.bundles, 'bundle')})`);
  } else if (d.roofSqft !== null) {
    L.push(NO_SHINGLES);
  }
  if (d.mainPitch !== null) L.push(`Main pitch: ${pitchText(d.mainPitch)}`);
  L.push(`Overhang used: ${d.overhangIn ? overhangText(d.overhangIn) : 'none'}`, '');
  if (d.faces.length) {
    L.push('Roof faces:');
    for (const f of d.faces) L.push(`  ${f.n}. ${f.pitch}${f.lowSlope ? ' (low slope)' : ''}, ${f.direction}, ${sqftText(f.sqft)}, ${f.overAttic ? 'over the attic' : 'not over the attic'}`);
    L.push('');
  }
  if (d.edgesMeasured) {
    L.push(`Roof edges (feet along the slope): ${d.edges.map((e) => `${e.label.toLowerCase()} ${comma(roundFt(e.ft))}`).join(', ')}`);
    L.push(`Materials (rounded up; estimates from aerial data, check on site): ${d.materials.map((m) => `${m.item.toLowerCase()} ${comma(m.ft)} ft`).join(', ')}`);
  } else {
    L.push(EDGES_NOT_MEASURED);
  }
  L.push('');
  if (d.warnings.length) L.push('Check on site:', ...d.warnings.map((w) => `  - ${w}`), '');
  L.push(REPORT_FOOTER);
  return L.join('\n');
}
