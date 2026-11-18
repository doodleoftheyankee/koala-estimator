// The Roof lookup page's "Recent lookups": finished lookups from roof_lookups (the caller's own; the
// owner's RLS shows everyone's) turned into short rows with the headline numbers. Pure: app/api/roof
// reads the rows with the person's own client and maps them here.
import { addressKey, mainPitch, metersBetween, SQFT_PER_M2, type LatLng, type RoofSegment } from './lookup';
import { tappedTitle } from './roofing';

/** How many recent lookups the page lists. */
export const RECENT_LIMIT = 10;

/**
 * A roof tapped on the photo has no address of its own. It is titled by the nearest house looked
 * up by its address (the one the estimator was checking, or its neighbour) when that house is
 * this close: a lot or two away.
 */
export const NEAR_M = 60;

/** One roof_lookups row as GET /api/roof?recent=1 reads it (parts of the stored result only). */
export interface RecentRow {
  id: string;
  created_at: string;
  created_by: string;
  /** The address as typed (null for a spot tapped on the photo). */
  address: string | null;
  pin_lat: number | null;
  pin_lng: number | null;
  /** result.address: the address Google matched. */
  matched: unknown;
  /** result.roofM2 */
  roof: unknown;
  /** result.takeoff.floorM2: the attic floor at a 12" overhang with Roof Takeoff's face choices. */
  floor: unknown;
  /** result.segments */
  segments: unknown;
  /** result.point: where Google placed the address (or the spot looked up). */
  point?: unknown;
}

export interface RecentLookup {
  id: string;
  lookedUpAt: string;
  /**
   * The address Google matched, the address as typed, or for a roof tapped on the photo "Roof
   * tapped near <the nearest house looked up>" (or "Roof tapped at <lat>, <lng>" with none near).
   */
  label: string;
  /** A roof tapped on the photo (no address). */
  tapped: boolean;
  /** Who looked it up when it wasn't the caller (the owner sees everyone's); null for the caller. */
  by: string | null;
  atticFloorSqft: number | null;
  roofSqft: number | null;
  mainPitch: number | null;
}

const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function pitchOf(segments: unknown): number | null {
  if (!Array.isArray(segments)) return null;
  const ok = segments.filter(
    (s): s is Pick<RoofSegment, 'rise' | 'groundM2'> => !!s && typeof s === 'object' && number((s as RoofSegment).rise) !== null && number((s as RoofSegment).groundM2) !== null,
  );
  return mainPitch(ok as RoofSegment[]);
}

function latLng(v: unknown): LatLng | null {
  if (!v || typeof v !== 'object') return null;
  const { lat, lng } = v as Record<string, unknown>;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

const matchedOf = (row: RecentRow) => (typeof row.matched === 'string' && row.matched.trim() ? row.matched.trim() : null);

/** The address of the house looked up nearest a tapped spot, within NEAR_M; null when none is that close. */
export function nearestHouse(rows: readonly RecentRow[], at: LatLng): string | null {
  let best: { name: string; m: number } | null = null;
  for (const row of rows) {
    const name = matchedOf(row) ?? row.address?.trim() ?? null;
    const p = latLng(row.point);
    if (!name || !p) continue;
    const m = metersBetween(at, p);
    if (m <= NEAR_M && (!best || m < best.m)) best = { name, m };
  }
  return best?.name ?? null;
}

/**
 * Newest first, one row per house (the newest lookup of it), at most `limit`. `names` are the
 * people the caller may see (by profile id); someone else's lookup without a name says "Someone else".
 */
export function recentLookups(rows: readonly RecentRow[], me: string, names: Readonly<Record<string, string>> = {}, limit = RECENT_LIMIT): RecentLookup[] {
  const seen = new Set<string>();
  const out: RecentLookup[] = [];
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const row of sorted) {
    const matched = matchedOf(row);
    const pin = row.pin_lat !== null && row.pin_lng !== null ? `${row.pin_lat.toFixed(5)},${row.pin_lng.toFixed(5)}` : null;
    const house = matched ? `a:${addressKey(matched)}` : row.address ? `a:${addressKey(row.address)}` : pin ? `p:${pin}` : `id:${row.id}`;
    if (seen.has(house)) continue;
    seen.add(house);
    const floor = number(row.floor);
    const roof = number(row.roof);
    const spot = row.pin_lat !== null && row.pin_lng !== null ? { lat: row.pin_lat, lng: row.pin_lng } : null;
    const near = !matched && !row.address && spot ? nearestHouse(rows, spot) : null;
    out.push({
      id: row.id,
      lookedUpAt: row.created_at,
      label: matched ?? row.address ?? (near ? `Roof tapped near ${near}` : spot ? tappedTitle(spot, null) : 'Roof tapped on the photo'),
      tapped: !matched && !row.address,
      by: row.created_by === me ? null : (names[row.created_by] ?? 'Someone else'),
      atticFloorSqft: floor === null ? null : floor * SQFT_PER_M2,
      roofSqft: roof === null ? null : roof * SQFT_PER_M2,
      mainPitch: pitchOf(row.segments),
    });
    if (out.length >= limit) break;
  }
  return out;
}
