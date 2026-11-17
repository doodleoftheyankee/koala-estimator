// Satellite roof lookup: what the field app takes from the Roof Takeoff site's GET /api/takeoff
// (its CONTRACT.md, v1), the attic-floor formula from that contract recomputed for the estimator's
// own overhang and roof faces, and the map math for drawing the roof on the aerial photo. Pure (no
// network, no DOM): app/api/roof calls Roof Takeoff, app/field/measure/RoofLookup shows the result.
// Roof Takeoff sends meters and square meters; everything the estimator sees is in feet.
import { z } from 'zod';
import type { JobType } from '@/lib/pricing';
import type { Measurement } from '@/lib/measure/measure';

export const FT_PER_M = 3.28084;
export const SQFT_PER_M2 = 10.7639;
export const M_PER_IN = 0.0254;

/** Lookups per person per hour: each one costs several Google calls, so cap it if something loops. */
export const LOOKUPS_PER_HOUR = 30;
/** Give up on Roof Takeoff a little before the route's 60 s limit, so the phone gets a clear answer. */
export const LOOKUP_TIMEOUT_MS = 55_000;
/** Roof overhang choices in inches: the attic floor and wall run come in from the roof edge by this. */
export const OVERHANG_CHOICES = [0, 6, 12, 18, 24] as const;
export const DEFAULT_OVERHANG_IN = 12;
/** Satellite views are 640 x 640 logical pixels at scale 2, as on the Roof Takeoff site. */
export const MAP_SIZE = 640;
export const MIN_ZOOM = 16;
export const MAX_ZOOM = 20;

/** Job types the lookup gives a number for: floor area (attic floor or roof surface) or wall run. */
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

/**
 * The subset of Roof Takeoff's answer the app needs. Unknown fields are ignored (and dropped), so
 * Roof Takeoff can add to its answer freely; the numbers the attic floor is worked out from are
 * required and checked, so a changed or broken answer fails here instead of giving a wrong number.
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
  }),
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
  /** Under 2/12: a porch or a flat addition, usually with no attic under it. */
  lowSlope: boolean;
}

/** What the app keeps from a lookup (returned to the phone and logged in roof_lookups.result). */
export interface RoofResult {
  /** The address Google matched, or null when it placed a pin. */
  address: string | null;
  /** Where Google placed the address. */
  point: LatLng;
  /** ROOFTOP when Google matched the house itself. */
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
  perimeterSource: string;
  /** The whole sloped roof: every face. */
  roofM2: number;
  segments: RoofSegment[];
  /** Faces left out of the attic floor unless the estimator ticks them (low slope). */
  defaultExcluded: number[];
  /** Roof outline rings, for drawing. */
  outline: LatLng[][];
  /** Each face's shape seen from above, for drawing its number. */
  faces: Array<{ n: number; poly: LatLng[] }>;
  warnings: string[];
  /** Roof Takeoff's own figures at its overhang, kept for the record. */
  takeoff: { overhangM: number; floorM2: number; wallRunM: number };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const point = (p: LatLng): LatLng => ({ lat: round(p.lat, 7), lng: round(p.lng, 7) });
const MAX_RING_POINTS = 600;
/** Keeps a ring drawable: every k-th point when Google's outline is very detailed. */
function thin(ring: LatLng[], max = MAX_RING_POINTS): LatLng[] {
  const k = Math.ceil(ring.length / max);
  return (k > 1 ? ring.filter((_, i) => i % k === 0) : ring).map(point);
}

/** Rise per 12 from a pitch in degrees. */
export const riseFromDegrees = (deg: number) => 12 * Math.tan((deg * Math.PI) / 180);

/** The compact result kept from a validated takeoff. */
export function compactTakeoff(t: Takeoff): RoofResult {
  const segments: RoofSegment[] = t.segments.map((s) => {
    const rise = s.rise ?? round(riseFromDegrees(s.pitchDeg), 1);
    return { n: s.n, rise, azimuthDeg: s.azimuthDeg, areaM2: s.areaM2, groundM2: s.groundM2, lowSlope: s.lowSlope ?? rise < 2 };
  });
  const known = new Set(segments.map((s) => s.n));
  const roofM2 = segments.length ? segments.reduce((sum, s) => sum + s.areaM2, 0) : (t.building.faces?.areaM2 ?? t.building.whole?.areaM2 ?? 0);
  const date = t.building.imageryDate ?? t.photo?.imageryDate ?? null;
  return {
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
    roofM2,
    segments,
    defaultExcluded: [...new Set(t.attic.excluded)].filter((n) => known.has(n)),
    outline: (t.outline?.polys ?? []).filter((r) => r.length >= 3).slice(0, 20).map((r) => thin(r)),
    faces: (t.faces ?? []).filter((f) => known.has(f.n) && f.poly.length >= 3).map((f) => ({ n: f.n, poly: thin(f.poly, 200) })),
    warnings: (t.warnings ?? []).map((w) => w.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 10),
    takeoff: { overhangM: t.attic.overhangM, floorM2: t.attic.floorM2, wallRunM: t.attic.wallRunM },
  };
}

// ---------------------------------------------------------------------------------------------
// Attic floor, roof surface, wall run (the contract's formula)
// ---------------------------------------------------------------------------------------------

/**
 * The contract's attic floor in m²: footprint A less the overhang d all the way round (exact for
 * any right-angled outline), then less the share of the footprint over faces left out. With no
 * perimeter (no outline and no box) the overhang can't be taken off, so the footprint is used.
 */
export function atticFloorM2(footprintM2: number, perimeterM: number, overhangM: number, excludedM2: number): number {
  const A = footprintM2;
  if (!(A > 0)) return 0;
  const d = Math.max(0, overhangM);
  const floorAll = perimeterM > 0 ? Math.max(0, A - perimeterM * d + 4 * d * d) : A;
  return floorAll * Math.max(0, 1 - excludedM2 / A);
}

/** The contract's wall run in m: the outline's perimeter inset by the overhang. Null with no perimeter. */
export function wallRunM(perimeterM: number, overhangM: number): number | null {
  return perimeterM > 0 ? Math.max(0, perimeterM - 8 * Math.max(0, overhangM)) : null;
}

/** The main pitch: the whole-number rise whose faces cover the most ground. Null with no faces. */
export function mainPitch(segments: readonly RoofSegment[]): number | null {
  const ground = new Map<number, number>();
  for (const s of segments) {
    const r = Math.round(s.rise);
    ground.set(r, (ground.get(r) ?? 0) + s.groundM2);
  }
  let best: number | null = null;
  for (const [rise, g] of ground) if (best === null || g > ground.get(best)!) best = rise;
  return best;
}

export interface RoofChoices {
  overhangIn: number;
  /** Face numbers left out of the attic floor. */
  excluded: readonly number[];
}

export interface RoofFigures {
  atticFloorSqft: number;
  /** The whole sloped roof, eaves included. */
  roofSqft: number;
  footprintSqft: number;
  /** Null when there was no outline or box to take a perimeter from. */
  wallRunFt: number | null;
  /** Rise per 12, whole number. */
  mainPitch: number | null;
  /** Ground area of the faces left out. */
  excludedSqft: number;
  overhangIn: number;
}

/** The estimator's numbers for a result: exact (unrounded) feet and square feet. */
export function roofFigures(r: RoofResult, c: RoofChoices): RoofFigures {
  const d = c.overhangIn * M_PER_IN;
  const out = new Set(c.excluded);
  const excludedM2 = r.segments.filter((s) => out.has(s.n)).reduce((sum, s) => sum + s.groundM2, 0);
  const run = wallRunM(r.perimeterM, d);
  return {
    atticFloorSqft: atticFloorM2(r.footprintM2, r.perimeterM, d, excludedM2) * SQFT_PER_M2,
    roofSqft: r.roofM2 * SQFT_PER_M2,
    footprintSqft: r.footprintM2 * SQFT_PER_M2,
    wallRunFt: run === null ? null : run * FT_PER_M,
    mainPitch: mainPitch(r.segments),
    excludedSqft: excludedM2 * SQFT_PER_M2,
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

export const QUALITY_WORDS: Record<string, { label: string; tone: 'green' | 'amber' | 'slate' }> = {
  HIGH: { label: 'Sharp photo', tone: 'green' },
  MEDIUM: { label: 'Fair photo', tone: 'amber' },
  LOW: { label: 'Blurry photo', tone: 'slate' },
};

// ---------------------------------------------------------------------------------------------
// Applying a result to an area
// ---------------------------------------------------------------------------------------------

/** What a lookup fills in for an area: its floor, its roof surface (roofline jobs) or its wall run. */
export type RoofUse = 'floor' | 'roof' | 'walls';

export function roofUse(jobType: JobType, measurement: Pick<Measurement, 'mode'> | undefined): RoofUse | null {
  if (!ROOF_LOOKUP_JOBS.has(jobType)) return null;
  if (jobType === 'walls') return 'walls';
  return measurement?.mode === 'roofline' ? 'roof' : 'floor';
}

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

export const NOTES_HEADER = 'From satellite lookup:';
const LINE_START = '• Satellite (';

const overhangWords = (inches: number) => (inches > 0 ? `with a ${inches}-inch overhang` : 'with no overhang');

/** The prep-note line for what was applied, e.g. "• Satellite (Google, Jun 2023): attic floor about …". */
export function noteLine(r: RoofResult, f: RoofFigures, use: RoofUse): string {
  const when = imageryText(r);
  const head = `${LINE_START}Google${when ? `, ${when}` : ''}):`;
  const roof = `roof surface about ${comma(roundSqft(f.roofSqft))} sq ft${f.mainPitch !== null ? ` at ${pitchText(f.mainPitch)}` : ''}`;
  const floor = `attic floor about ${comma(roundSqft(f.atticFloorSqft))} sq ft ${overhangWords(f.overhangIn)}`;
  if (use === 'walls' && f.wallRunFt !== null) {
    return `${head} wall run about ${comma(roundFt(f.wallRunFt))} ft ${overhangWords(f.overhangIn)}; footprint about ${comma(roundSqft(f.footprintSqft))} sq ft.`;
  }
  return use === 'roof' ? `${head} ${roof}; ${floor}.` : `${head} ${floor}; ${roof}.`;
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

/** POST /api/roof */
export const roofRequestSchema = z.object({
  estimateId: z.uuid(),
  areaId: z.uuid(),
  address: z.string().trim().min(5).max(200),
});
export type RoofRequest = z.infer<typeof roofRequestSchema>;

const coordinate = (limit: number) =>
  z.string().trim().min(1).max(24).regex(/^-?\d+(\.\d+)?$/).transform(Number).pipe(z.number().finite().min(-limit).max(limit));

/** GET /api/roof/satellite?lat=&lng=&zoom= */
export const satelliteQuerySchema = z.object({
  lat: coordinate(90),
  lng: coordinate(180),
  zoom: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(MIN_ZOOM).max(MAX_ZOOM)),
});
