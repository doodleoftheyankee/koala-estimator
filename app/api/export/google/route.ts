// GET /api/export/google?key=<key>: the read-only feed the Google Sheets hub pulls
// (google/apps-script). Estimates, jobs and visualizer data; no costs or margins.
// One store per key: GOOGLE_EXPORT_KEY is the first (pilot) store's; other stores get their own
// key in GOOGLE_EXPORT_KEYS, a JSON object of store id -> key. A key never reads another store.
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { buildGoogleExport, type EstimateRow, type JobRow } from '@/lib/google/export';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Store id -> export key, from GOOGLE_EXPORT_KEYS (ignored when it is not a JSON object of strings). */
function storeKeys(): Array<[string, string]> {
  try {
    const parsed: unknown = JSON.parse(process.env.GOOGLE_EXPORT_KEYS || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= 16);
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const given = request.nextUrl.searchParams.get('key') ?? '';
  const notAvailable = () => NextResponse.json({ error: 'Not available' }, { status: 404 });
  if (!given) return notAvailable();
  const db = createAdminClient();

  // Which store this key belongs to.
  let locationId = storeKeys().find(([, k]) => same(k, given))?.[0] ?? null;
  const pilotKey = process.env.GOOGLE_EXPORT_KEY;
  if (!locationId && pilotKey && same(pilotKey, given)) {
    const first = await db.from('locations').select('id').order('created_at').limit(1).maybeSingle();
    if (first.error) return NextResponse.json({ error: first.error.message }, { status: 500 });
    locationId = (first.data as { id: string } | null)?.id ?? null;
  }
  if (!locationId) return notAvailable();
  const store = await db.from('locations').select('name').eq('id', locationId).maybeSingle();
  if (store.error) return NextResponse.json({ error: store.error.message }, { status: 500 });
  if (!store.data) return notAvailable();

  const [estimates, jobs, products, tiers, codes] = await Promise.all([
    db
      .from('estimates')
      .select(
        'id, status, created_at, decided_at, selected_tier, lost_reason, customer:customers(first_name, last_name, phone, email), property:properties(street, city, zip), ' +
          'estimator:profiles!estimator_id(full_name), lead:leads(source:lead_sources(name)), options:estimate_options(tier, price), ' +
          'areas:estimate_areas(id, name, job_type, sqft, current_r, target_r, access_level, removal_needed), quotes(status, signed_price, signed_tier)',
      )
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
      .limit(1000),
    db
      .from('jobs')
      .select(
        'id, status, scheduled_start, scheduled_days, started_at, completed_at, revenue, crew:crews(name), quote:quotes(signed_tier, options:snapshot->options), ' +
          'estimate:estimates(customer:customers(first_name, last_name, phone), property:properties(street, city, zip)), ' +
          'actuals:job_actuals(area_id, product, actual_material_qty, actual_hours, verified_at)',
      )
      .eq('location_id', locationId)
      .order('scheduled_start', { ascending: false, nullsFirst: true })
      .limit(1000),
    db.from('products').select('code, label, r_per_inch'),
    db.from('tier_templates').select('job_type, tier, label, primary_product, target_r, include_removal').eq('location_id', locationId).eq('active', true),
    db.from('code_requirements').select('job_type, min_r').eq('location_id', locationId).eq('is_default', true),
  ]);
  for (const r of [estimates, jobs, products, tiers, codes]) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const body = buildGoogleExport({
    estimates: estimates.data as unknown as EstimateRow[],
    jobs: jobs.data as unknown as JobRow[],
    refs: { products: products.data!, tiers: tiers.data!, codeMins: codes.data! },
    now: new Date(),
  });
  return NextResponse.json({ ...body, store: (store.data as { name: string }).name }, { headers: { 'Cache-Control': 'no-store' } });
}
