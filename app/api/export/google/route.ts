// GET /api/export/google?key=<GOOGLE_EXPORT_KEY>: the read-only feed the Google Sheets hub pulls
// (google/apps-script). Estimates, jobs and visualizer data; no costs or margins.
import { NextResponse, type NextRequest } from 'next/server';
import { buildGoogleExport, type EstimateRow, type JobRow } from '@/lib/google/export';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const key = process.env.GOOGLE_EXPORT_KEY;
  if (!key || request.nextUrl.searchParams.get('key') !== key) return NextResponse.json({ error: 'Not available' }, { status: 404 });
  const db = createAdminClient();
  const [estimates, jobs, products, tiers, codes] = await Promise.all([
    db
      .from('estimates')
      .select(
        'id, status, created_at, decided_at, selected_tier, lost_reason, customer:customers(first_name, last_name, phone, email), property:properties(street, city, zip), ' +
          'estimator:profiles!estimator_id(full_name), lead:leads(source:lead_sources(name)), options:estimate_options(tier, price), ' +
          'areas:estimate_areas(id, name, job_type, sqft, current_r, target_r, access_level, removal_needed), quotes(status, signed_price, signed_tier)',
      )
      .order('created_at', { ascending: false })
      .limit(1000),
    db
      .from('jobs')
      .select(
        'id, status, scheduled_start, scheduled_days, started_at, completed_at, revenue, crew:crews(name), quote:quotes(signed_tier, options:snapshot->options), ' +
          'estimate:estimates(customer:customers(first_name, last_name, phone), property:properties(street, city, zip)), ' +
          'actuals:job_actuals(area_id, product, actual_material_qty, actual_hours, verified_at)',
      )
      .order('scheduled_start', { ascending: false, nullsFirst: true })
      .limit(1000),
    db.from('products').select('code, label, r_per_inch'),
    db.from('tier_templates').select('job_type, tier, label, primary_product, target_r, include_removal').eq('active', true),
    db.from('code_requirements').select('job_type, min_r').eq('is_default', true),
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
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
