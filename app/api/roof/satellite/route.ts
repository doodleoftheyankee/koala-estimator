import { NextResponse, type NextRequest } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { serverEnv } from '@/lib/env';
import { satelliteQuerySchema } from '@/lib/roof/lookup';
import { fetchSatellite, NOT_CONFIGURED, RoofLookupError } from '@/lib/roof/takeoff';

// The aerial photo behind a satellite lookup, fetched from Roof Takeoff (which holds the Google
// key) with the partner key, so neither key reaches the phone.

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  const sp = request.nextUrl.searchParams;
  const q = satelliteQuerySchema.safeParse({ lat: sp.get('lat'), lng: sp.get('lng'), zoom: sp.get('zoom') });
  if (!q.success) return NextResponse.json({ error: 'Bad map request.', code: 'invalid' }, { status: 400 });
  const key = serverEnv.roofTakeoffKey();
  if (!key) return NextResponse.json({ error: NOT_CONFIGURED, code: 'not_configured' }, { status: 501 });
  try {
    const img = await fetchSatellite(q.data, { baseUrl: serverEnv.roofTakeoffUrl(), key }, request.signal);
    return new Response(img.body, { status: 200, headers: { 'Content-Type': img.contentType, 'Cache-Control': 'private, max-age=3600' } });
  } catch (e) {
    const err = e instanceof RoofLookupError ? e : new RoofLookupError("The aerial photo didn't load. Try again.", 502, 'failed');
    if (!(e instanceof RoofLookupError)) console.error('[roof] satellite failed', e);
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
}
