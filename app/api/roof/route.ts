import { NextResponse, type NextRequest } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { LOOKUPS_PER_HOUR, roofRequestSchema } from '@/lib/roof/lookup';
import { fetchTakeoff, NOT_CONFIGURED, RoofLookupError } from '@/lib/roof/takeoff';

// Satellite roof lookup. POST: look an address up on the Roof Takeoff site (server to server, with
// the partner key) and return the attic floor, roof faces and outline; every lookup is logged in
// roof_lookups, written with the service role only, after the checks here. GET: whether the
// lookup is switched on, and the Roof Takeoff site's address for the "full takeoff" link.

export const runtime = 'nodejs';
export const maxDuration = 60;

const ROLES = ['owner', 'office', 'estimator'] as const;

function fail(error: string, status: number, code = 'invalid') {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(request: NextRequest) {
  const { profile, error } = await authorize(...ROLES);
  if (error) return error;
  const body = roofRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail('Enter the street, city, state and ZIP first.', 400);
  const key = serverEnv.roofTakeoffKey();
  if (!key) return fail(NOT_CONFIGURED, 501, 'not_configured');
  const { estimateId, areaId, address } = body.data;

  // Reserve the lookup before calling Roof Takeoff, then check the hourly cap including it:
  // lookups in flight and failed ones count, and parallel taps can't slip past the cap together.
  const admin = createAdminClient();
  const { data: reserved, error: reserveError } = await admin
    .from('roof_lookups')
    .insert({ status: 'pending', created_by: profile.userId, estimate_id: estimateId, area_id: areaId, address })
    .select('id')
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
    result = await fetchTakeoff(address, { baseUrl: serverEnv.roofTakeoffUrl(), key }, request.signal);
  } catch (e) {
    const err = e instanceof RoofLookupError ? e : new RoofLookupError('The lookup failed. Try again.', 500, 'failed');
    if (!(e instanceof RoofLookupError)) console.error('[roof] lookup failed', e);
    // Kept (not released): Roof Takeoff may have paid for Google calls, so it counts toward the cap.
    await admin.from('roof_lookups').update({ status: 'failed', error: `${err.code}: ${err.message}`.slice(0, 500) }).eq('id', lookupId);
    return fail(err.message, err.status, err.code);
  }

  const { error: logError } = await admin.from('roof_lookups').update({ status: 'done', result }).eq('id', lookupId);
  if (logError) console.error('[roof] could not log the lookup', logError.message);
  return NextResponse.json({ lookupId, result });
}

/** GET → whether the lookup is switched on, so the app can say so before anyone waits. */
export async function GET() {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  return NextResponse.json({ configured: serverEnv.roofTakeoffKey() !== null, url: serverEnv.roofTakeoffUrl() });
}
