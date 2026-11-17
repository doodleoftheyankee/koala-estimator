import { NextResponse, type NextRequest } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { addressKey, LOOKUPS_PER_HOUR, pickSaved, pinBox, REUSE_HOURS, roofRequestSchema, type LatLng, type SavedLookup } from '@/lib/roof/lookup';
import { fetchTakeoff, NOT_CONFIGURED, RoofLookupError } from '@/lib/roof/takeoff';

// Satellite roof lookup. POST: look an address (or a spot the estimator tapped on the photo) up on
// the Roof Takeoff site (server to server, with the partner key) and return the attic floor, roof
// faces and outline. A finished lookup of the same house from the last day, by anyone, is sent back
// instead of paying Google again, unless the estimator asked to look it up again (fresh). Every paid
// lookup is logged in roof_lookups, written with the service role only, after the checks here.
// GET: whether the lookup is switched on, and the Roof Takeoff site's address for its link.

export const runtime = 'nodejs';
export const maxDuration = 60;

const ROLES = ['owner', 'office', 'estimator'] as const;

function fail(error: string, status: number, code = 'invalid') {
  return NextResponse.json({ error, code }, { status });
}

type Admin = ReturnType<typeof createAdminClient>;

/** The newest finished lookup of this address or pin from the last day, or null (also when the check fails). */
async function savedLookup(admin: Admin, address: string | null, pin: LatLng | null) {
  const since = new Date(Date.now() - REUSE_HOURS * 60 * 60 * 1000).toISOString();
  let q = admin.from('roof_lookups').select('id, created_at, result, pin_lat, pin_lng').eq('status', 'done').gte('created_at', since);
  if (address !== null) q = q.eq('address_key', addressKey(address));
  else if (pin) {
    const { dLat, dLng } = pinBox(pin);
    q = q.gte('pin_lat', pin.lat - dLat).lte('pin_lat', pin.lat + dLat).gte('pin_lng', pin.lng - dLng).lte('pin_lng', pin.lng + dLng);
  } else return null;
  const { data, error } = await q.order('created_at', { ascending: false }).limit(5);
  if (error) {
    console.error('[roof] could not check for a saved lookup', error.message);
    return null;
  }
  return pickSaved((data ?? []) as SavedLookup[], pin);
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
  const address = 'address' in body.data ? body.data.address : null;
  const pin = 'lat' in body.data ? { lat: body.data.lat, lng: body.data.lng } : null;
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
      estimate_id: estimateId,
      area_id: areaId,
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

  const { error: logError } = await admin.from('roof_lookups').update({ status: 'done', result }).eq('id', lookupId);
  if (logError) console.error('[roof] could not log the lookup', logError.message);
  return NextResponse.json({ lookupId, result, reused: false, lookedUpAt: reserved.created_at as string });
}

/** GET → whether the lookup is switched on, so the app can say so before anyone waits. */
export async function GET() {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  return NextResponse.json({ configured: serverEnv.roofTakeoffKey() !== null, url: serverEnv.roofTakeoffUrl() });
}
