// GET /api/cron/nightly: the nightly learning job (vercel.json schedules it for 07:15 UTC,
// 2:15/3:15 AM Eastern). Vercel Cron authenticates with `Authorization: Bearer <CRON_SECRET>`.
// POST does the same, for a manual run with curl:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/nightly
import { NextResponse, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env';
import { runNightly } from '@/lib/learning/nightly';
import { cronAuthorized, summaryHasFailures } from '@/lib/learning/nightlyCore';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

async function handle(request: NextRequest): Promise<NextResponse> {
  const secret = serverEnv.cronSecret();
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not set on the server, so the nightly job is disabled. Add it in the Vercel project settings.' },
      { status: 500, headers: NO_STORE },
    );
  }
  if (!cronAuthorized(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  try {
    const summary = await runNightly(createAdminClient(), new Date(), { trigger: 'cron' });
    // A failed step answers 500 (with the full summary) so it shows up in Vercel's cron log.
    return NextResponse.json(summary, { status: summaryHasFailures(summary) ? 500 : 200, headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[cron] nightly run failed', message);
    return NextResponse.json({ error: `Nightly run failed: ${message}` }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
