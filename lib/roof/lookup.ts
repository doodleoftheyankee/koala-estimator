// Satellite roof lookup: what the field app takes from the Roof Takeoff service's GET /api/takeoff
// (its CONTRACT.md, v1 with the v1.1 and v1.2 additions), the contract's formulas (attic floor, roof
// deck, wall run) recomputed for the estimator's own overhang and roof faces, and the map math for
// drawing the roof on the aerial photo. Pure (no network, no DOM): app/api/roof calls Roof Takeoff,
// app/field/measure/RoofLookup and app/field/roof show the result (lib/roof/roofing has the roofing
// numbers from the edges). Roof Takeoff sends meters and square meters; everything the estimator
// sees is in feet.
import { z } from 'zod';
import type { JobType } from '@/lib/pricing';
import type { Measurement } from '@/lib/measure/measure';

export const FT_PER_M = 3.28084;
export const SQFT_PER_M2 = 10.7639;
export const M_PER_IN = 0.0254;

/** Lookups per person per hour: each one costs several Google calls, so cap it if something loops. */
export const LOOKUPS_PER_HOUR = 30;
/** A finished lookup of the same house is used again for this long instead of paying Google again. */
export const REUSE_HOURS = 24;
/** Two map pins this close (meters) are the same spot. */
export const SAME_PIN_M = 2;
/** Give up on Roof Takeoff a little before the route's 60 s limit, so the phone gets a clear answer. */
export const LOOKUP_TIMEOUT_MS = 55_000;
/** Roof overhang choices in inches: the attic floor and wall run come in from the roof edge by this. */
export const OVERHANG_CHOICES = [0, 6, 12, 18, 24] as const;
export const DEFAULT_OVERHANG_IN = 12;
/** Satellite views are 640 x 640 logical pixels at scale 2, as on the Roof Takeoff site. */
export const MAP_SIZE = 640;
export const MIN_ZOOM = 16;
export const MAX_ZOOM = 20;

export const NOT_CONFIGURED_MESSAGE = "Satellite lookup isn't set up yet. Ask the office.";
/** The estimator measures by hand instead: the "Measure by hand" step beside the message. */
export const NO_ROOF_MESSAGE = 'Google has no roof data for this house. Measure it by hand.';

/** Job types the lookup gives a number for: floor area (attic floor or roof deck) or wall run. */
export const ROOF_LOOKUP_JOBS: ReadonlySet<JobType> = new Set<JobType>(['attic', 'crawlspace', 'garage', 'commercial', 'walls']);

// ---------------------------------------------------------------------------------------------
// The takeoff response (the parts used here)
// ---------------------------------------------------------------------------------------------

const finite = z.number().finite();
const nonNegative = finite.min(0);
const latLngSchema = z.object({ lat: finite.min(-90).max(90), lng: finite.min(-180).max(180) });
const boxSchema = z.object({ sw: latLngSchema, ne: latLngSchema });
const monthSchema = z.object({ year: z.number().int().min(1990).max(2100), month: z.number().int().min(1).max(12) });
const areasSchema = z.object({ areaM2: nonNegative, groundM2: nonNegative });
/** For the parts that only help (map, dates, labels): a broken one is dropped, not fatal. */
const extra = <T extends z.ZodType>(s: T) => s.nullish().catch(null);

/** Roof edge types, in the order the contract lists them. */
export const EDGE_TYPES = ['ridge', 'hip', 'valley', 'eave', 'rake', 'step', 'headwall', 'break'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** One roof edge: a broken one (unknown type, bad length, a path of fewer than two points) is dropped on its own. */
const edgeSchema = z.object({
  type: z.enum(EDGE_TYPES),
  faces: z.array(z.number().int().min(1)).max(8).catch([]),
  lengthM: nonNegative,
  planM: nonNegative.nullish().catch(null),
  path: z.array(latLngSchema).min(2),
});
/** A total that is missing or broken counts as 0. */
const edgeTotal = nonNegative.nullish().catch(null);
const edgeTotalsSchema = z.object(Object.fromEntries(EDGE_TYPES.map((k) => [k, edgeTotal])) as Record<EdgeType, typeof edgeTotal>);

/**
 * The subset of Roof Takeoff's answer the app needs. Unknown fields are ignored (and dropped), so
 * Roof Takeoff can add to its answer freely; the numbers the attic floor is worked out from are
 * required and checked, so a changed or broken answer fails here instead of giving a wrong number.
 * The v1.1 additions (lower, sharedWallM, unmatchedM2, perimeterByFaceM, deckM2) are optional, so a
 * v1 answer still works; when they are sent they are checked like the rest.
 */
export const takeoffSchema = z.object({
  version: z.literal(1),
  place: z.object({
    address: z.string().max(300).nullable(),
    lat: latLngSchema.shape.lat,
    lng: latLngSchema.shape.lng,
    precision: z.string().max(40),
  }),
  building: z.object({
    center: extra(latLngSchema),
    box: extra(boxSchema),
    quality: extra(z.string().max(20)),
    imageryDate: extra(monthSchema),
    faces: extra(areasSchema),
    whole: extra(areasSchema),
  }),
  segments: z
    .array(
      z.object({
        n: z.number().int().min(1),
        pitchDeg: finite.min(0).max(90),
        azimuthDeg: finite,
        areaM2: nonNegative,
        groundM2: nonNegative,
        rise: nonNegative.nullish(),
        lowSlope: z.boolean().nullish(),
        lower: z.boolean().nullish(),
        center: extra(latLngSchema),
      }),
    )
    .max(200),
  photo: extra(z.object({ imageryDate: extra(monthSchema) })),
  outline: extra(z.object({ polys: z.array(z.array(latLngSchema)), areaM2: nonNegative, perimeterM: nonNegative })),
  faces: z
    .array(z.object({ n: z.number().int().min(1), poly: z.array(latLngSchema) }))
    .nullish()
    .catch(null),
  attic: z.object({
    overhangM: nonNegative,
    footprintM2: nonNegative,
    perimeterM: nonNegative,
    perimeterSource: z.string().max(20),
    excluded: z.array(z.number().int().min(1)),
    excludedM2: nonNegative,
    floorM2: nonNegative,
    wallRunM: nonNegative,
    sharedWallM: nonNegative.nullish(),
    unmatchedM2: nonNegative.nullish(),
    perimeterByFaceM: z.record(z.string().regex(/^\d{1,4}$/), nonNegative).nullish(),
    deckM2: nonNegative.nullish(),
  }),
  /** Roof edges and their totals (meters along the slope). Optional: an answer without them still works. */
  edges: z.array(edgeSchema.nullable().catch(null)).max(2000).nullish().catch(null),
  edgeTotalsM: extra(edgeTotalsSchema),
  warnings: z.array(z.string()).nullish().catch(null),
});
export type Takeoff = z.infer<typeof takeoffSchema>;

export type LatLng = z.infer<typeof latLngSchema>;
export type Box = z.infer<typeof boxSchema>;

export interface RoofSegment {
  n: number;
  /** Rise per 12 inches of run. */
  rise: number;
  azimuthDeg: number;
  /** Sloped (roof surface) area. */
  areaM2: number;
  /** Area seen from above. */
  groundM2: number;
  /** Under 2/12. */
  lowSlope: boolean;
  /** Well below the main roof: a garage, porch or addition (a hint only; v1 answers say false). */
  lower: boolean;
  /** Middle of the face, for its number on the map when there is no face shape. */
  center: LatLng | null;
}

export interface RoofEdge {
  type: EdgeType;
  /** The faces on each side (one face for an outer edge). */
  faces: number[];
  /** True length along the slope. */
  lengthM: number;
  /** Length seen from above; null when not sent. */
  planM: number | null;
  path: LatLng[];
}

/** Bumped whenever RoofResult changes shape, so a saved lookup in the old shape isn't used again. */
export const RESULT_FORMAT = 3;

/** What the app keeps from a lookup (returned to the phone and logged in roof_lookups.result). */
export interface RoofResult {
  format: typeof RESULT_FORMAT;
  /** The address Google matched, or null when it placed a pin. */
  address: string | null;
  /** Where Google placed the address (or the pin that was looked up). */
  point: LatLng;
  /** ROOFTOP when Google matched the house itself; PIN for a spot picked on the map. */
  precision: string;
  /** Map center (the building's center). */
  center: LatLng;
  box: Box | null;
  /** HIGH, MEDIUM or LOW detail aerial photo. */
  quality: string | null;
  imagery: { year: number; month: number } | null;
  /** The roof seen from above, to the drip edge (the contract's A). */
  footprintM2: number;
  /** The contract's P: the outline's perimeter, or estimated from the box. */
  perimeterM: number;
  /** outline, box (estimated from the building's size) or none. */
  perimeterSource: string;
  /** The contract's S: outline length along a neighbour's roof (twins, rowhouses). */
  sharedWallM: number;
  /** Outline with no roof data (carports, flat bits): max(0, A − Σ groundM2). */
  unmatchedM2: number;
  /** Each face's outer sides on the outline, by face number ({} when not measured). */
  perimeterByFaceM: Record<string, number>;
  /** The whole sloped roof, overhangs included: every face. */
  roofM2: number;
  segments: RoofSegment[];
  /** Faces Roof Takeoff leaves out of the attic floor by default (attic.excluded). */
  defaultExcluded: number[];
  /** Roof outline rings, for drawing. */
  outline: LatLng[][];
  /** Each face's shape seen from above, for drawing its number. */
  faces: Array<{ n: number; poly: LatLng[] }>;
  /** Roof edges, for drawing ([] when not measured). */
  edges: RoofEdge[];
  /** Meters of each edge type along the slope (every type; 0 when none or not measured). */
  edgeTotalsM: Record<EdgeType, number>;
  warnings: string[];
  /** Roof Takeoff's own figures at its overhang, kept for the record. */
  takeoff: { overhangM: number; floorM2: number; wallRunM: number; deckM2: number | null };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const point = (p: LatLng): LatLng => ({ lat: round(p.lat, 7), lng: round(p.lng, 7) });
const MAX_RING_POINTS = 600;
const MAX_EDGES = 400;
/** Keeps a ring drawable: every k-th point when Google's outline is very detailed. */
function thin(ring: LatLng[], max = MAX_RING_POINTS): LatLng[] {
  const k = Math.ceil(ring.length / max);
  return (k > 1 ? ring.filter((_, i) => i % k === 0) : ring).map(point);
}

/** Rise per 12 from a pitch in degrees. */
export const riseFromDegrees = (deg: number) => 12 * Math.tan((deg * Math.PI) / 180);

/**
 * Roof Takeoff's warnings are written for its own page (tap the image, measure from photos); this
 * says the same in terms of what this app has.
 */
export function koalaWording(text: string): string {
  return text
    .replace(/Tap the right roof on the (?:image|photo)(?:, or measure it from photos)?\.?/gi, 'Wrong house? Tap the right roof under the photo.')
    .replace(/measure (?:it|this one) from photos/gi, 'measure it by hand');
}

/**
 * Each edge type's total in meters: the answer's own totals (a type it left out is 0), or, when it
 * sent no totals, the edges added up. Rounded to the millimeter.
 */
function edgeTotals(t: Pick<Takeoff, 'edgeTotalsM'>, edges: readonly RoofEdge[]): Record<EdgeType, number> {
  const sent = t.edgeTotalsM;
  return Object.fromEntries(
    EDGE_TYPES.map((k) => [k, round(sent ? (sent[k] ?? 0) : edges.reduce((sum, e) => sum + (e.type === k ? e.lengthM : 0), 0), 3)]),
  ) as Record<EdgeType, number>;
}

/** The compact result kept from a validated takeoff. */
export function compactTakeoff(t: Takeoff): RoofResult {
  const segments: RoofSegment[] = t.segments.map((s) => {
    const rise = s.rise ?? round(riseFromDegrees(s.pitchDeg), 1);
    return { n: s.n, rise, azimuthDeg: s.azimuthDeg, areaM2: s.areaM2, groundM2: s.groundM2, lowSlope: s.lowSlope ?? rise < 2, lower: s.lower ?? false, center: s.center ? point(s.center) : null };
  });
  const known = new Set(segments.map((s) => s.n));
  const roofM2 = segments.length ? segments.reduce((sum, s) => sum + s.areaM2, 0) : (t.building.faces?.areaM2 ?? t.building.whole?.areaM2 ?? 0);
  const groundM2 = segments.reduce((sum, s) => sum + s.groundM2, 0);
  const date = t.building.imageryDate ?? t.photo?.imageryDate ?? null;
  // v1 answers don't send these: the contract's definitions give the same from what v1 sends.
  const unmatchedM2 = t.attic.unmatchedM2 ?? (segments.length ? Math.max(0, t.attic.footprintM2 - groundM2) : 0);
  const perimeterByFaceM = Object.fromEntries(Object.entries(t.attic.perimeterByFaceM ?? {}).filter(([n]) => known.has(Number(n))));
  const edges: RoofEdge[] = (t.edges ?? [])
    .filter((e) => e !== null)
    .slice(0, MAX_EDGES)
    .map((e) => ({ type: e.type, faces: e.faces, lengthM: e.lengthM, planM: e.planM ?? null, path: thin(e.path, 100) }));
  return {
    format: RESULT_FORMAT,
    address: t.place.address,
    point: point({ lat: t.place.lat, lng: t.place.lng }),
    precision: t.place.precision,
    center: point(t.building.center ?? { lat: t.place.lat, lng: t.place.lng }),
    box: t.building.box ? { sw: point(t.building.box.sw), ne: point(t.building.box.ne) } : null,
    quality: t.building.quality ?? null,
    imagery: date ? { year: date.year, month: date.month } : null,
    footprintM2: t.attic.footprintM2,
    perimeterM: t.attic.perimeterM,
    perimeterSource: t.attic.perimeterSource,
    sharedWallM: t.attic.sharedWallM ?? 0,
    unmatchedM2,
    perimeterByFaceM,
    roofM2,
    segments,
    defaultExcluded: [...new Set(t.attic.excluded)].filter((n) => known.has(n)),
    outline: (t.outline?.polys ?? []).filter((r) => r.length >= 3).slice(0, 20).map((r) => thin(r)),
    faces: (t.faces ?? []).filter((f) => known.has(f.n) && f.poly.length >= 3).map((f) => ({ n: f.n, poly: thin(f.poly, 200) })),
    edges,
    edgeTotalsM: edgeTotals(t, edges),
    warnings: (t.warnings ?? [])
      .map((w) => koalaWording(w.replace(/\s+/g, ' ').trim()).slice(0, 300))
      .filter(Boolean)
      .slice(0, 10),
    takeoff: { overhangM: t.attic.overhangM, floorM2: t.attic.floorM2, wallRunM: t.attic.wallRunM, deckM2: t.attic.deckM2 ?? null },
  };
}

/** Whether a saved roof_lookups result is one this version of the app can show (used before reusing it). */
export function isRoofResult(v: unknown): v is RoofResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<RoofResult>;
  return (
    r.format === RESULT_FORMAT &&
    Array.isArray(r.segments) &&
    Array.isArray(r.edges) &&
    !!r.edgeTotalsM &&
    typeof r.edgeTotalsM === 'object' &&
    typeof r.footprintM2 === 'number' &&
    typeof r.perimeterM === 'number' &&
    !!r.center &&
    !!r.point
  );
}

// ---------------------------------------------------------------------------------------------
// Attic floor, roof deck, wall run (the contract's formulas)
// ---------------------------------------------------------------------------------------------

/**
 * The contract's attic floor in m²: footprint A less the overhang d all the way round except along
 * a neighbour's roof (S), exact for any right-angled outline, then less the share of the footprint
 * over the parts left out. With no perimeter (no outline and no box) no overhang is taken off; the
 * formula is still used as written, as Roof Takeoff does, so both give the same number.
 */
export function atticFloorM2(footprintM2: number, perimeterM: number, overhangM: number, excludedM2: number, sharedWallM = 0): number {
  const A = footprintM2;
  if (!(A > 0)) return 0;
  const d = Math.max(0, overhangM);
  const P = Math.max(0, perimeterM);
  const floorAll = Math.max(0, A - (P - Math.min(P, Math.max(0, sharedWallM))) * d + 4 * d * d);
  return floorAll * Math.max(0, 1 - excludedM2 / A);
}

/**
 * The contract's exterior wall run in m: the perimeter less any shared wall and the outer sides of
 * the faces left out, inset by the overhang. Null with no perimeter.
 */
export function wallRunM(perimeterM: number, overhangM: number, sharedWallM = 0, excludedPerimM = 0): number | null {
  return perimeterM > 0 ? Math.max(0, perimeterM - Math.max(0, sharedWallM) - Math.max(0, excludedPerimM) - 8 * Math.max(0, overhangM)) : null;
}

/** The contract's roof deck over the attic floor: the floor times the pitch factor of the faces kept. Null with no face kept. */
export function deckM2(floorM2: number, included: readonly Pick<RoofSegment, 'areaM2' | 'groundM2'>[]): number | null {
  const ground = included.reduce((sum, s) => sum + s.groundM2, 0);
  const area = included.reduce((sum, s) => sum + s.areaM2, 0);
  return ground > 0 ? floorM2 * (area / ground) : null;
}

/**
 * The main pitch: the rise whose faces cover the most ground, as pitchText says it (whole numbers
 * from 2/12 up, tenths below, so a nearly flat roof is 0.3/12, not 0/12). Null with no faces.
 */
export function mainPitch(segments: readonly RoofSegment[]): number | null {
  const ground = new Map<number, number>();
  for (const s of segments) {
    const r = s.rise >= 2 ? Math.round(s.rise) : round(s.rise, 1);
    ground.set(r, (ground.get(r) ?? 0) + s.groundM2);
  }
  let best: number | null = null;
  for (const [rise, g] of ground) if (best === null || g > ground.get(best)!) best = rise;
  return best;
}

/** Whether to offer the "Parts with no roof data" switch: over 5% of the footprint and over 5 m². */
export function showUnmatched(r: Pick<RoofResult, 'unmatchedM2' | 'footprintM2' | 'segments'>): boolean {
  return r.segments.length > 0 && r.unmatchedM2 > 0.05 * r.footprintM2 && r.unmatchedM2 > 5;
}

export interface RoofChoices {
  overhangIn: number;
  /** Face numbers left out. */
  excluded: readonly number[];
  /** Leave out the parts of the outline with no roof data. */
  unmatchedOut: boolean;
}

export interface RoofFigures {
  /** Attic floor (or crawlspace floor, garage ceiling): the footprint inside the walls over the parts kept. */
  floorSqft: number;
  /** The roof deck over that floor (spray foam under the roof); null with no face kept. */
  deckSqft: number | null;
  /** The whole sloped roof, overhangs included (information only). */
  wholeRoofSqft: number;
  /** The roof outline seen from above, to the drip edge. */
  footprintSqft: number;
  /** Null when there was no outline or box to take a perimeter from. */
  wallRunFt: number | null;
  /** The perimeter is estimated from the building's size, not traced. */
  wallRunRough: boolean;
  /** Rise per 12, whole number. */
  mainPitch: number | null;
  /** Ground area of the faces left out (and the parts with no roof data, when left out). */
  excludedSqft: number;
  /** The parts with no roof data. */
  unmatchedSqft: number;
  /** How many faces are kept. */
  facesKept: number;
  overhangIn: number;
}

/** The estimator's numbers for a result: exact (unrounded) feet and square feet. */
export function roofFigures(r: RoofResult, c: RoofChoices): RoofFigures {
  const d = c.overhangIn * M_PER_IN;
  const out = new Set(c.excluded);
  const kept = r.segments.filter((s) => !out.has(s.n));
  const left = r.segments.filter((s) => out.has(s.n));
  const excludedM2 = left.reduce((sum, s) => sum + s.groundM2, 0) + (c.unmatchedOut ? r.unmatchedM2 : 0);
  const excludedPerimM = left.reduce((sum, s) => sum + (r.perimeterByFaceM[String(s.n)] ?? 0), 0);
  const floor = atticFloorM2(r.footprintM2, r.perimeterM, d, excludedM2, r.sharedWallM);
  const deck = deckM2(floor, kept);
  const run = wallRunM(r.perimeterM, d, r.sharedWallM, excludedPerimM);
  return {
    floorSqft: floor * SQFT_PER_M2,
    deckSqft: deck === null ? null : deck * SQFT_PER_M2,
    wholeRoofSqft: r.roofM2 * SQFT_PER_M2,
    footprintSqft: r.footprintM2 * SQFT_PER_M2,
    wallRunFt: run === null ? null : run * FT_PER_M,
    wallRunRough: r.perimeterSource === 'box',
    mainPitch: mainPitch(r.segments),
    excludedSqft: excludedM2 * SQFT_PER_M2,
    unmatchedSqft: r.unmatchedM2 * SQFT_PER_M2,
    facesKept: kept.length,
    overhangIn: c.overhangIn,
  };
}

/** Satellite figures are good to about ten square feet; say so by rounding to it. */
export const roundSqft = (sqft: number) => Math.round(sqft / 10) * 10;
export const roundFt = (ft: number) => Math.round(ft);
const comma = (n: number) => n.toLocaleString('en-US');

/** Rise as the estimator says it: 6/12, or 1.5/12 for a low slope. */
export function pitchText(rise: number): string {
  return `${rise >= 2 ? Math.round(rise) : round(rise, 1)}/12`;
}

const DIRECTIONS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;
/** Which way a face slopes down, in words ("faces south"); "flat" for a roof with almost no pitch. */
export function facing(azimuthDeg: number, rise: number): string {
  if (rise < 0.5) return 'flat';
  const i = Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8;
  return `faces ${DIRECTIONS[i]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jun 2023", or null. */
export function imageryText(r: Pick<RoofResult, 'imagery'>): string | null {
  return r.imagery ? `${MONTHS[r.imagery.month - 1]} ${r.imagery.year}` : null;
}

/** The photo badge. The worst photo is never shown calmer than a fair one. */
export const QUALITY_WORDS: Record<string, { label: string; tone: 'green' | 'amber' | 'slate' }> = {
  HIGH: { label: 'Sharp photo', tone: 'green' },
  MEDIUM: { label: 'Good photo', tone: 'slate' },
  LOW: { label: 'Blurry photo: check on site', tone: 'amber' },
};

/** "today 2:05 PM", "yesterday 9:40 AM" or "Nov 14, 9:40 AM", in the phone's time zone. */
export function whenText(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ');
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
}

// ---------------------------------------------------------------------------------------------
// What the lookup is for on an area, and the defaults
// ---------------------------------------------------------------------------------------------

/** The kind of number an area takes from a lookup. Attic and commercial areas choose floor or deck. */
export type RoofJob = 'attic' | 'crawlspace' | 'garage' | 'walls';
/** For attic and commercial areas: the attic floor (blown-in) or the roof deck (spray foam under the roof). */
export type RoofPick = 'floor' | 'deck';
/** Face choices are shared by the areas of an estimate, except a garage's (its faces start off). */
export type FaceGroup = 'house' | 'garage';

export function roofJob(jobType: JobType): RoofJob | null {
  if (!ROOF_LOOKUP_JOBS.has(jobType)) return null;
  if (jobType === 'attic' || jobType === 'commercial') return 'attic';
  return jobType as RoofJob;
}

/** Roof deck when the area is measured on the roofline, else the attic floor. */
export function startPick(measurement: Pick<Measurement, 'mode'> | undefined): RoofPick {
  return measurement?.mode === 'roofline' ? 'deck' : 'floor';
}

export const faceGroup = (job: RoofJob): FaceGroup => (job === 'garage' ? 'garage' : 'house');

/**
 * The starting face choices: Roof Takeoff's own (attic.excluded) for the house; for a garage every
 * face starts off, as do the parts with no roof data, so the number is only what the estimator turns on.
 */
export function defaultFaces(r: Pick<RoofResult, 'segments' | 'defaultExcluded'>, group: FaceGroup): Pick<RoofChoices, 'excluded' | 'unmatchedOut'> {
  return group === 'garage' ? { excluded: r.segments.map((s) => s.n), unmatchedOut: true } : { excluded: [...r.defaultExcluded], unmatchedOut: false };
}

/** What each kind of area calls the number, and what the face switches mean for it. */
export const JOB_WORDS: Record<RoofJob, { number: string; space: string; facesHint: string }> = {
  attic: {
    number: 'Attic floor',
    space: 'attic',
    facesHint: 'Turn off faces with no attic under them, like a porch or a garage. The attic floor and roof deck count only the faces turned on.',
  },
  crawlspace: { number: 'Crawlspace floor', space: 'crawlspace', facesHint: 'Turn off the garage and porch: there is no crawlspace under them.' },
  garage: { number: 'Garage ceiling', space: 'garage', facesHint: "Turn on the garage's roof faces." },
  walls: { number: 'Wall run', space: 'house', facesHint: 'Porch and garage walls count unless their faces are off.' },
};

/** The two numbers an attic or commercial area can use. */
export const PICK_WORDS: Record<RoofPick, { label: string; note: string }> = {
  floor: { label: 'Attic floor (blown-in)', note: 'attic floor' },
  deck: { label: 'Roof deck (spray foam under the roof)', note: 'roof deck' },
};

/**
 * Things to check on site, shown right under the numbers (before the faces and the Use button).
 * `paper`: in the words of the printed report and the copied summary, which have no photo below
 * and nothing to turn off.
 */
export function checkOnSite(r: RoofResult, f: RoofFigures, job: RoofJob, confirmed: boolean, paper = false): string[] {
  const out: string[] = [];
  if (r.precision !== 'ROOFTOP' && !confirmed) {
    if (paper) {
      out.push(
        r.precision === 'PIN'
          ? 'Not confirmed: a roof picked on the photo, not checked as the house.'
          : "Not confirmed: Google placed this address roughly, so the outline may be on a neighbour's house.",
      );
    } else {
      out.push(
        r.precision === 'PIN'
          ? 'Check the white outline is on the roof you tapped.'
          : "Google placed this address roughly, so the outline may be on a neighbour's house. Check it on the photo below.",
      );
    }
  }
  if (r.quality === 'LOW') out.push('Blurry photo: check the sizes and the pitch on site.');
  if (r.perimeterSource === 'none') out.push("No outline was found, so the overhang can't be taken off. Check the size on site.");
  if (job === 'walls' && f.wallRunRough) out.push("No outline was traced, so the wall run is rough: from the building's size. Measure it on site.");
  if (!r.segments.length) out.push('Google has no roof faces for this house, so no faces can be left out.');
  if (showUnmatched(r) && job !== 'walls') {
    const what = `${comma(roundSqft(f.unmatchedSqft))} sq ft of the outline has no roof data (a carport or flat part?).`;
    out.push(paper ? what : job === 'garage' ? `${what} Turn it on below if it is part of the garage.` : `${what} Turn it off below if it isn't over the ${JOB_WORDS[job].space}.`);
  }
  // Roof Takeoff says "Lower-detail imagery. Check the pitch on site." for the same blurry photo: once is enough.
  const theirs = r.quality === 'LOW' ? r.warnings.filter((w) => !/^lower-detail imagery\b/i.test(w)) : r.warnings;
  return [...out, ...theirs];
}

/** Whether the "Parts with no roof data" switch matters for this kind of area (the wall run doesn't use it). */
export const offersUnmatched = (r: Pick<RoofResult, 'unmatchedM2' | 'footprintM2' | 'segments'>, job: RoofJob) => job !== 'walls' && showUnmatched(r);

// ---------------------------------------------------------------------------------------------
// Applying a result to an area
// ---------------------------------------------------------------------------------------------

/** The address to look up: street, city, state and ZIP, or null while any is missing. */
export function lookupAddress(p: { street: string; city: string; state: string; zip: string }): string | null {
  const street = p.street.trim().replace(/\s+/g, ' ');
  const city = p.city.trim().replace(/\s+/g, ' ');
  const state = p.state.trim().toUpperCase();
  const zip = p.zip.trim();
  if (!street || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}(-\d{4})?$/.test(zip)) return null;
  const address = `${street}, ${city}, ${state} ${zip}`;
  return address.length <= 200 ? address : null;
}

/** The same address however it was typed: trimmed, lower case, runs of spaces and commas as one space. */
export function addressKey(address: string): string {
  return address.toLowerCase().replace(/[\s,]+/g, ' ').trim();
}

/** Distance in meters between two nearby points (equirectangular; good to well under a meter at this range). */
export function metersBetween(a: LatLng, b: LatLng): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return R * Math.hypot(x, y);
}

/** Degrees of latitude and longitude around a point that hold every spot within `meters` of it. */
export function pinBox(p: LatLng, meters = SAME_PIN_M): { dLat: number; dLng: number } {
  const dLat = (meters / 6_371_008.8) * (180 / Math.PI) * 1.01;
  return { dLat, dLng: dLat / Math.max(0.01, Math.cos((p.lat * Math.PI) / 180)) };
}

/** A saved lookup row as the server reads it for reuse. */
export interface SavedLookup {
  id: string;
  created_at: string;
  result: unknown;
  pin_lat?: number | null;
  pin_lng?: number | null;
}

/**
 * The saved lookup to use again instead of paying Google: the newest one (rows come newest first)
 * that this app can read, for a pin within SAME_PIN_M of the one asked for.
 */
export function pickSaved(rows: readonly SavedLookup[], pin: LatLng | null): (SavedLookup & { result: RoofResult }) | null {
  for (const row of rows) {
    if (!isRoofResult(row.result)) continue;
    if (pin && !(row.pin_lat != null && row.pin_lng != null && metersBetween(pin, { lat: row.pin_lat, lng: row.pin_lng }) <= SAME_PIN_M)) continue;
    return row as SavedLookup & { result: RoofResult };
  }
  return null;
}

export const NOTES_HEADER = 'From satellite lookup:';
const LINE_START = '• Satellite (';

const faceWords = (r: RoofResult, ns: readonly number[]) => {
  const items = r.segments.filter((s) => ns.includes(s.n)).map((s) => `${s.n} at ${pitchText(s.rise)}`);
  if (!items.length) return '';
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `${items.length === 1 ? 'face' : 'faces'} ${list}`;
};

/**
 * The prep-note line for what was applied: what the number is, what was taken off and left out,
 * and the whole roof for reference, e.g. "• Satellite (Google imagery Jun 2023): attic floor about
 * 1,970 sq ft inside the walls (12-inch eaves removed; left out face 5 at 1/12). Whole roof 2,560
 * sq ft incl. overhangs, main pitch 6/12. Check on site."
 */
export function noteLine(r: RoofResult, f: RoofFigures, choices: Pick<RoofChoices, 'excluded' | 'unmatchedOut'>, job: RoofJob, pick: RoofPick = 'floor'): string {
  const when = imageryText(r);
  const head = `${LINE_START}Google imagery${when ? ` ${when}` : ''}):`;
  const showsUnmatched = offersUnmatched(r, job);
  const what: string[] = [f.overhangIn > 0 ? `${f.overhangIn}-inch eaves removed` : 'no overhang removed'];
  if (r.sharedWallM > 0) what.push('no overhang along the neighbour');
  if (job === 'garage') {
    const kept = r.segments.filter((s) => !choices.excluded.includes(s.n)).map((s) => s.n);
    what.push(`from ${faceWords(r, kept) || 'no faces'}${showsUnmatched && !choices.unmatchedOut ? ` plus ${comma(roundSqft(f.unmatchedSqft))} sq ft with no roof data` : ''}`);
  } else {
    const leftOut = [faceWords(r, choices.excluded), showsUnmatched && choices.unmatchedOut ? `${comma(roundSqft(f.unmatchedSqft))} sq ft with no roof data` : ''].filter(Boolean);
    if (leftOut.length) what.push(`left out ${leftOut.join(' and ')}`);
  }
  let number: string;
  if (job === 'walls') {
    number = `wall run about ${comma(roundFt(f.wallRunFt ?? 0))} ft${f.wallRunRough ? ", rough: from the building's size" : ''}`;
  } else if (job === 'attic' && pick === 'deck') {
    number = `roof deck about ${comma(roundSqft(f.deckSqft ?? 0))} sq ft over the attic floor`;
  } else {
    number = `${JOB_WORDS[job].number.toLowerCase()} about ${comma(roundSqft(f.floorSqft))} sq ft inside the walls`;
  }
  const whole = `Whole roof ${comma(roundSqft(f.wholeRoofSqft))} sq ft incl. overhangs${f.mainPitch !== null ? `, main pitch ${pitchText(f.mainPitch)}` : ''}.`;
  return `${head} ${number} (${what.join('; ')}). ${whole} Check on site.`;
}

/**
 * Prep notes with a satellite line merged in under "From satellite lookup:". An earlier satellite
 * line is replaced (the notes should match the number applied last), the header appears once,
 * the estimator's own lines are kept, and the result stays within the notes' 2,000 characters.
 */
export function mergeNotes(existing: string | null, line: string): string {
  const lines = (existing ?? '').split('\n').filter((l) => !l.trim().startsWith(LINE_START));
  const at = lines.findIndex((l) => l.trim() === NOTES_HEADER);
  if (at >= 0) lines.splice(at + 1, 0, line);
  else {
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    lines.push(NOTES_HEADER, line);
  }
  return lines.join('\n').trim().slice(0, 2000);
}

// ---------------------------------------------------------------------------------------------
// The map: Web Mercator, as Google's static maps draw it
// ---------------------------------------------------------------------------------------------

/** World pixel position of a point at a zoom level (256 px world at zoom 0). */
export function project(p: LatLng, zoom: number): { x: number; y: number } {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin((p.lat * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

export function unproject(x: number, y: number, zoom: number): LatLng {
  const size = 256 * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / size) * 360 - 180 };
}

/** Zoom so the building fills about half the view (as the Roof Takeoff site does), 16 to 20. */
export function mapZoom(box: Box | null): number {
  let z = MAX_ZOOM;
  if (box) {
    const a = project(box.sw, 0);
    const b = project(box.ne, 0);
    const span = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    if (span > 0) z = Math.floor(Math.log2((MAP_SIZE * 0.55) / span));
  }
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Converts points to positions on the 640 x 640 view centered on `center`. */
export function mapFrame(center: LatLng, zoom: number) {
  const c = project(center, zoom);
  return {
    toPx: (p: LatLng) => {
      const q = project(p, zoom);
      return { x: q.x - c.x + MAP_SIZE / 2, y: q.y - c.y + MAP_SIZE / 2 };
    },
    toLatLng: (x: number, y: number) => unproject(c.x + x - MAP_SIZE / 2, c.y + y - MAP_SIZE / 2, zoom),
  };
}

// ---------------------------------------------------------------------------------------------
// Requests to the app's own routes
// ---------------------------------------------------------------------------------------------

const lookupIds = { estimateId: z.uuid().optional(), areaId: z.uuid().optional(), fresh: z.boolean().optional() };

/**
 * POST /api/roof: an address, or a spot on the map (the estimator tapped the right roof).
 * estimateId and areaId say which area it is for; both are left out on the Roof lookup page.
 * `fresh` skips a saved lookup of the same house and pays for a new one ("Look up again").
 */
export const roofRequestSchema = z.union([
  z.strictObject({ ...lookupIds, address: z.string().trim().min(5).max(200) }),
  z.strictObject({ ...lookupIds, lat: finite.min(-90).max(90), lng: finite.min(-180).max(180) }),
]);
export type RoofRequest = z.infer<typeof roofRequestSchema>;

/**
 * A spot typed or linked as "39.6834,-75.7504" (an old Roof Takeoff map-pin link comes over as
 * ?address=lat,lng), or null for anything else.
 */
export function parseLatLng(text: string): LatLng | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const coordinate = (limit: number) =>
  z.string().trim().min(1).max(24).regex(/^-?\d+(\.\d+)?$/).transform(Number).pipe(z.number().finite().min(-limit).max(limit));

/** GET /api/roof/satellite?lat=&lng=&zoom= */
export const satelliteQuerySchema = z.object({
  lat: coordinate(90),
  lng: coordinate(180),
  zoom: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(MIN_ZOOM).max(MAX_ZOOM)),
});
