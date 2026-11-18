import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { serverEnv } from '@/lib/env';
import { addressKey, isRoofResult, LOOKUPS_PER_HOUR, parseLatLng, RESULT_FORMAT, roofRequestSchema } from '@/lib/roof/lookup';
import { finishLookup, savedLookup } from '@/lib/roof/log';
import { recentLookups, RECENT_LIMIT, type RecentRow } from '@/lib/roof/recent';
import { fetchTakeoff, NOT_CONFIGURED, RoofLookupError } from '@/lib/roof/takeoff';

// Satellite roof lookup. POST: look an address (or a spot the estimator tapped on the photo) up on
// the Roof Takeoff service (server to server, with the partner key) and return the attic floor,
// roof faces, outline and roof edges. It is for an area of an estimate, or for the Roof lookup page
// (no estimate or area). A finished lookup of the same house from the last day, by anyone, is sent
// back instead of paying Google again, unless the estimator asked to look it up again (fresh): the
// same address as typed (or written the way an estimate sends it), the address Google matched for it
// (an estimate started from a lookup), or a pin within about 2 m (lib/roof/log). Every paid lookup
// is logged in roof_lookups, written with the service role only, after the checks here.
// GET: whether the lookup is switched on; ?recent=1 the caller's recent finished lookups (the
// owner's: everyone's); ?id= one of them as it was looked up. Both read through the person's own
// client, so row-level security decides what they see.

export const runtime = 'nodejs';
export const maxDuration = 60;

const ROLES = ['owner', 'office', 'estimator'] as const;

function fail(error: string, status: number, code = 'invalid') {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(request: NextRequest) {
  const { profile, error } = await authorize(...ROLES);
  if (error) return error;
  const raw: unknown = await request.json().catch(() => null);
  const body = roofRequestSchema.safeParse(raw);
  if (!body.success) {
    const pinAsked = !!raw && typeof raw === 'object' && 'lat' in raw;
    return fail(pinAsked ? "That spot on the photo couldn't be used. Tap the roof again." : 'Enter the street, city, state and ZIP first.', 400);
  }
  const key = serverEnv.roofTakeoffKey();
  if (!key) {
    console.warn('[roof] ROOF_TAKEOFF_KEY is not set, so the satellite lookup is off');
    return fail(NOT_CONFIGURED, 501, 'not_configured');
  }
  const { estimateId, areaId, fresh } = body.data;
  // An address that is only "lat,lng" (an old Roof Takeoff map-pin link) is looked up as that spot.
  const typedPin = 'address' in body.data ? parseLatLng(body.data.address) : null;
  const address = 'address' in body.data && !typedPin ? body.data.address : null;
  const pin = 'lat' in body.data ? { lat: body.data.lat, lng: body.data.lng } : typedPin;
  const admin = createAdminClient();

  // The same house looked up in the last day: use it again (no Google calls, no new row, not
  // counted toward the cap) unless the estimator pressed "Look up again".
  if (!fresh) {
    const saved = await savedLookup(admin, address, pin);
    if (saved) return NextResponse.json({ lookupId: saved.id, result: saved.result, reused: true, lookedUpAt: saved.created_at });
  }

  // Reserve the lookup before calling Roof Takeoff, then check the hourly cap including it:
  // lookups in flight and failed ones count, and parallel taps can't slip past the cap together.
  const { data: reserved, error: reserveError } = await admin
    .from('roof_lookups')
    .insert({
      status: 'pending',
      created_by: profile.userId,
      estimate_id: estimateId ?? null,
      area_id: areaId ?? null,
      address,
      address_key: address === null ? null : addressKey(address),
      pin_lat: pin?.lat ?? null,
      pin_lng: pin?.lng ?? null,
    })
    .select('id, created_at')
    .single();
  if (reserveError || !reserved) return fail(`Could not start the lookup: ${reserveError?.message ?? 'no row'}`, 500, 'failed');
  const lookupId = reserved.id as string;

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recent, error: countError } = await admin
    .from('roof_lookups')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', profile.userId)
    .gte('created_at', since);
  if (countError || (recent ?? 0) > LOOKUPS_PER_HOUR) {
    await admin.from('roof_lookups').delete().eq('id', lookupId);
    return countError ? fail(`Could not check usage: ${countError.message}`, 500, 'failed') : fail(`That's ${LOOKUPS_PER_HOUR} satellite lookups in the last hour. Try again later.`, 429, 'busy');
  }

  let result;
  try {
    // request.signal: when the phone stops waiting (Stop, or it left), stop waiting on Roof Takeoff.
    result = await fetchTakeoff(address ?? pin!, { baseUrl: serverEnv.roofTakeoffUrl(), key }, request.signal);
  } catch (e) {
    const err = e instanceof RoofLookupError ? e : new RoofLookupError('The lookup failed. Try again.', 500, 'failed');
    if (!(e instanceof RoofLookupError)) console.error('[roof] lookup failed', e);
    // Kept (not released): Roof Takeoff may have paid for Google calls, so it counts toward the cap.
    await admin.from('roof_lookups').update({ status: 'failed', error: `${err.code}: ${err.message}`.slice(0, 500) }).eq('id', lookupId);
    return fail(err.message, err.status, err.code);
  }

  await finishLookup(admin, lookupId, result);
  return NextResponse.json({ lookupId, result, reused: false, lookedUpAt: reserved.created_at as string });
}

/** The parts of a stored result the recent list needs (not the outline, faces or edges). */
const RECENT_COLUMNS = 'id, created_at, created_by, address, pin_lat, pin_lng, matched:result->address, point:result->point, roof:result->roofM2, floor:result->takeoff->floorM2, segments:result->segments';

/**
 * GET → whether the lookup is switched on, so the app can say so before anyone waits.
 * ?recent=1 → { lookups }: recent finished lookups the caller may see, one per house.
 * ?id=<lookup id> → { lookupId, result, lookedUpAt, pin }: one finished lookup, without a new Google call.
 */
export async function GET(request: NextRequest) {
  const { profile, error } = await authorize(...ROLES);
  if (error) return error;
  const sp = request.nextUrl.searchParams;

  if (sp.has('recent')) {
    const supabase = await createClient();
    const { data, error: readError } = await supabase
      .from('roof_lookups')
      .select(RECENT_COLUMNS)
      .eq('status', 'done')
      .eq('result->>format', String(RESULT_FORMAT))
      .order('created_at', { ascending: false })
      .limit(RECENT_LIMIT * 4);
    if (readError) return fail(`Could not read recent lookups: ${readError.message}`, 500, 'failed');
    const rows = (data ?? []) as unknown as RecentRow[];
    // The owner sees everyone's lookups: say whose they are.
    const others = [...new Set(rows.map((r) => r.created_by).filter((id) => id !== profile.userId))];
    const names: Record<string, string> = {};
    if (others.length) {
      const { data: people } = await supabase.from('profiles').select('id, full_name').in('id', others);
      for (const p of (people ?? []) as Array<{ id: string; full_name: string | null }>) if (p.full_name) names[p.id] = p.full_name;
    }
    return NextResponse.json({ lookups: recentLookups(rows, profile.userId, names) }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (sp.has('id')) {
    const id = z.uuid().safeParse(sp.get('id'));
    if (!id.success) return fail('That lookup could not be found.', 400);
    const supabase = await createClient();
    const { data, error: readError } = await supabase.from('roof_lookups').select('id, created_at, result, pin_lat, pin_lng').eq('id', id.data).eq('status', 'done').maybeSingle();
    if (readError) return fail(`Could not read the lookup: ${readError.message}`, 500, 'failed');
    if (!data) return fail('That lookup could not be found.', 404, 'not_found');
    if (!isRoofResult(data.result)) return fail('This lookup was saved by an older version of the app. Look the address up again.', 410, 'old');
    const pin = data.pin_lat !== null && data.pin_lng !== null ? { lat: data.pin_lat as number, lng: data.pin_lng as number } : null;
    return NextResponse.json({ lookupId: data.id, result: data.result, lookedUpAt: data.created_at, pin }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({ configured: serverEnv.roofTakeoffKey() !== null });
}
