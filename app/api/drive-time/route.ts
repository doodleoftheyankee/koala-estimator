import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/server/auth';
import { settingString } from '@/lib/server/snapshot';
import { serverEnv } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';

const query = z.object({ address: z.string().trim().min(5).max(200) });

// One-way drive minutes from the shop to a job, via Google Distance Matrix (if configured).
export async function GET(request: NextRequest) {
  const { error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  const key = serverEnv.googleMapsApiKey();
  if (!key) return NextResponse.json({ error: 'Drive-time lookup is not set up. Enter minutes by hand.' }, { status: 501 });
  const parsed = query.safeParse({ address: request.nextUrl.searchParams.get('address') });
  if (!parsed.success) return NextResponse.json({ error: 'Enter the job address first.' }, { status: 400 });

  const supabase = await createClient();
  const { data } = await supabase.from('app_settings').select('key, value').eq('key', 'shop_address');
  const origin = settingString(data ?? [], 'shop_address');
  if (!origin) return NextResponse.json({ error: 'Set the shop address in Pricing settings.' }, { status: 400 });

  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', origin);
  url.searchParams.set('destinations', parsed.data.address);
  url.searchParams.set('units', 'imperial');
  url.searchParams.set('key', key);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const json = (await res.json()) as { rows?: Array<{ elements?: Array<{ status: string; duration?: { value: number } }> }> };
    const el = json.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK' || !el.duration) return NextResponse.json({ error: 'Address not found by Maps.' }, { status: 404 });
    return NextResponse.json({ minutes: Math.round(el.duration.value / 60) });
  } catch {
    return NextResponse.json({ error: 'Maps lookup failed. Enter minutes by hand.' }, { status: 502 });
  }
}
