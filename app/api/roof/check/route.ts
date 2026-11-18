import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env';
import { fetchTakeoff, RoofLookupError } from '@/lib/roof/takeoff';

// Self-check for the satellite lookup: GET /api/roof/check?key=<CRON_SECRET> runs one real lookup
// of a fixed spot (ROOF_CHECK_SPOT="lat,lng", else downtown Newark, DE; by lat/lng so no address is sent) through Roof Takeoff with the
// partner key, and reports whether it worked and the main numbers. For the owner or support, not
// the field app; each call is a paid Google lookup (about 10 cents). Nothing is logged to roof_lookups.

export const runtime = 'nodejs';
export const maxDuration = 60;

const DEFAULT_SPOT = { lat: 39.6831656, lng: -75.7543045 };

/** The spot to check: ROOF_CHECK_SPOT ("39.68,-75.75") when it is a valid point, else the default. */
function spot(): { lat: number; lng: number } {
  const [lat, lng] = (serverEnv.roofCheckSpot() ?? '').split(',').map((v) => Number(v.trim()));
  return lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
    ? { lat, lng }
    : DEFAULT_SPOT;
}

function keyMatches(given: string | null, secret: string | null): boolean {
  if (!given || !secret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!keyMatches(request.nextUrl.searchParams.get('key'), serverEnv.cronSecret())) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  }
  const key = serverEnv.roofTakeoffKey();
  const baseUrl = serverEnv.roofTakeoffUrl();
  if (!key) return NextResponse.json({ ok: false, url: baseUrl, error: 'ROOF_TAKEOFF_KEY is not set.' });

  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    const r = await fetchTakeoff(spot(), { baseUrl, key }, request.signal);
    return NextResponse.json({
      ok: true,
      url: baseUrl,
      seconds: seconds(),
      quality: r.quality,
      imagery: r.imagery,
      faces: r.segments.length,
      footprintSqft: Math.round(r.footprintM2 * 10.7639),
      atticFloorSqft: Math.round(r.takeoff.floorM2 * 10.7639),
      roofSqft: Math.round(r.roofM2 * 10.7639),
      perimeterSource: r.perimeterSource,
      warnings: r.warnings,
    });
  } catch (e) {
    const err = e instanceof RoofLookupError ? e : null;
    console.error('[roof check] failed', e);
    return NextResponse.json({ ok: false, url: baseUrl, code: err?.code ?? 'failed', error: err?.message ?? String(e), seconds: seconds() });
  }
}
