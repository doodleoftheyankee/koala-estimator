// GET /api/blower-door/settings: the franchise's rebate programs, gauge and defaults
// (app_settings.blower_door) for the blower door tool, which every staff phone caches for offline
// use. Read through the signed-in user's client: crews may read this one setting (RLS). Lenient:
// a program that does not make sense is left out, and the tool still opens with none at all.
import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { parseBlowerDoorSettings, SETTINGS_KEY, type SettingsResponse } from '@/lib/blowerdoor';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await authorize('owner', 'office', 'estimator', 'crew');
  if (error) return error;
  const supabase = await createClient();
  const { data, error: dbError } = await supabase.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  if (dbError) return NextResponse.json({ error: `The rebate programs did not load: ${dbError.message}` }, { status: 500 });
  const { settings, problems } = parseBlowerDoorSettings(data?.value ?? null);
  const hash = createHash('sha256').update(JSON.stringify({ settings, problems })).digest('hex').slice(0, 16);
  const etag = `"${hash}"`;
  if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  const body: SettingsResponse = { settings, problems, hash };
  return NextResponse.json(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } });
}
