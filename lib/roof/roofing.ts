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
  type RoofChoices,
  type RoofResult,
} from './lookup';

// ---------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------

/**
 * Each edge type's name, what it is in plain words, and its colour on the photo and in the legend
 * (picked to read on an aerial photo; a pitch break is dashed). The Roof Takeoff page's colours.
 */
export const EDGE_INFO: Record<EdgeType, { label: string; what: string; color: string; dash?: readonly [number, number] }> = {
  ridge: { label: 'Ridge', what: 'Top line where two faces meet', color: '#FF5A5A' },
  hip: { label: 'Hip', what: 'Sloped outside corner between two faces', color: '#FFC21A' },
  valley: { label: 'Valley', what: 'Inside corner where two faces drain together', color: '#3FA9FF' },
  eave: { label: 'Eave', what: 'Low, level edge at the gutter', color: '#4CD07D' },
  rake: { label: 'Rake', what: 'Sloped edge at a gable end', color: '#FF7AD0' },
  step: { label: 'Step', what: 'Sloped side of a roof against a wall', color: '#B794FF' },
  headwall: { label: 'Headwall', what: 'Level top of a roof against a wall', color: '#4FE3E3' },
  break: { label: 'Pitch break', what: 'Pitch changes between two faces', color: '#FFFFFF', dash: [7, 5] },
};
/** The roof outline on the photo. */
export const OUTLINE_COLOR = '#FFFFFF';

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

/** Order quantities from the edge feet, each rounded up to the next foot; items with nothing to order are left out. */
export function materials(ft: Record<EdgeType, number>): Material[] {
  const up = (v: number) => Math.ceil(v - 1e-9);
  return [
    { item: 'Drip edge', from: 'Eaves + rakes', ft: up(ft.eave + ft.rake) },
    { item: 'Starter strip', from: 'Eaves', ft: up(ft.eave) },
    { item: 'Ridge cap', from: 'Ridges + hips', ft: up(ft.ridge + ft.hip) },
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
  /** "faces south" */
  direction: string;
  /** Roof surface of the face. */
  sqft: number;
  overAttic: boolean;
}

/** Everything the printed report and the copied summary say about a lookup. */
export interface TakeoffData {
  /** The address Google matched, or the roof tapped on the photo. */
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
  roofSqft: number | null;
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

/** The takeoff for a result with the house's overhang, face choices and waste. */
export function takeoffData(r: RoofResult, c: RoofChoices, wastePct: number, lookedUpAt: Date): TakeoffData {
  const f = roofFigures(r, c);
  const roofSqft = roofSurfaceSqft(r);
  const ft = edgeFeet(r);
  const waste = clampWaste(wastePct);
  return {
    title: r.address ?? 'The roof tapped on the photo',
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
    squares: roofSqft === null ? null : roofingSquares(roofSqft),
    wastePct: waste,
    order: roofSqft === null ? null : orderFor(roofSqft, waste),
    mainPitch: mainPitch(r.segments),
    faces: r.segments.map((s) => ({ n: s.n, pitch: pitchText(s.rise), direction: facing(s.azimuthDeg, s.rise), sqft: s.areaM2 * SQFT_PER_M2, overAttic: !c.excluded.includes(s.n) })),
    edgesMeasured: presentEdges(ft).length > 0,
    edges: presentEdges(ft).map((k) => ({ type: k, label: EDGE_INFO[k].label, ft: ft[k] })),
    materials: materials(ft),
    warnings: r.warnings,
  };
}

/** The takeoff as plain text, to paste into a note, a text or an email. */
export function summaryText(d: TakeoffData): string {
  const L: string[] = [];
  L.push(`${COMPANY}: roof takeoff`, d.title, `Looked up ${d.lookedUp}. ${d.photo}.`, '');
  L.push(`Attic floor: ${sqftText(d.atticFloorSqft)} (${d.atticNote.replace(/\.$/, '')})`);
  if (d.deckSqft !== null) L.push(`Roof deck over the attic floor: ${sqftText(d.deckSqft)} (spray foam under the roof)`);
  L.push(`Footprint: ${sqftText(d.footprintSqft)} (roof outline seen from above, to the drip edge)`);
  if (d.wallRunFt !== null) L.push(`Wall run: ${comma(roundFt(d.wallRunFt))} ft${d.wallRunRough ? " (rough: from the building's size)" : ''}`);
  L.push(`Roof surface: ${sqftText(d.roofSqft)}`);
  if (d.squares !== null && d.order) {
    L.push(`Squares: ${oneDecimal(d.squares)}`, `Order with ${d.wastePct}% waste: ${d.order.text} squares (${plural(d.order.bundles, 'bundle')})`);
  }
  if (d.mainPitch !== null) L.push(`Main pitch: ${pitchText(d.mainPitch)}`);
  L.push(`Overhang used: ${d.overhangIn ? overhangText(d.overhangIn) : 'none'}`, '');
  if (d.faces.length) {
    L.push('Roof faces:');
    for (const f of d.faces) L.push(`  ${f.n}. ${f.pitch}, ${f.direction}, ${sqftText(f.sqft)}, ${f.overAttic ? 'over the attic' : 'not over the attic'}`);
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
