// GET /api/demo/seed?key=<CRON_SECRET>: loads the demo history (lib/demo/seed.ts) into an empty
// demo database, then runs the learning job once so the dashboard has results. Demo mode only,
// runs once (refuses when the demo estimator already has estimates). It executes the generated
// SQL through demo_exec(), a temporary service-role-only database function created for the
// seeding and dropped afterwards; without it this route does nothing.
import { NextResponse, type NextRequest } from 'next/server';
import { demoEnabled, DEMO_USER_IDS } from '@/lib/demo/accounts';
import { buildDemoSeed } from '@/lib/demo/seed';
import { serverEnv } from '@/lib/env';
import { runNightly } from '@/lib/learning/nightly';
import { loadPricingBundle } from '@/lib/server/bundle';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = serverEnv.cronSecret();
  if (!demoEnabled() || !secret || request.nextUrl.searchParams.get('key') !== secret) {
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }
  const admin = createAdminClient();
  const existing = await admin.from('estimates').select('id', { count: 'exact', head: true }).eq('estimator_id', DEMO_USER_IDS.estimator);
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
  if ((existing.count ?? 0) > 0) return NextResponse.json({ status: 'already seeded', estimates: existing.count });

  const settings = await admin.from('app_settings').select('key, value');
  if (settings.error) return NextResponse.json({ error: settings.error.message }, { status: 500 });
  const { batches, summary } = buildDemoSeed({ bundle: await loadPricingBundle(admin), settings: settings.data, now: new Date() });
  for (const [i, sql] of batches.entries()) {
    const r = await admin.rpc('demo_exec', { p_sql: sql });
    if (r.error) return NextResponse.json({ error: `Batch ${i + 1} failed: ${r.error.message}` }, { status: 500 });
  }
  const learning = await runNightly(admin, new Date(), { trigger: 'manual' });
  return NextResponse.json({ status: 'seeded', summary, learning });
}
