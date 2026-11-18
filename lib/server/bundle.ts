import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BundleLocation, PricingBundle } from '@/lib/pricing';
import { validateSnapshot } from '@/lib/pricing';
import { LOCATION_COLUMNS, parseLocation, type LocationInfo } from '@/lib/locations/location';
import { makeBundle, type SnapshotRows } from './snapshot';

/** The store details a bundle carries for the phone. */
export function bundleLocation(l: LocationInfo): BundleLocation {
  return { id: l.id, name: l.name, shortName: l.shortName, state: l.state, timeZone: l.timeZone, utilities: l.utilities, rowVersion: l.rowVersion };
}

/**
 * Loads everything the pricing engine needs for one store: its settings, the shared product
 * catalog, its default active material per product, active crews, default code minimums, active
 * tier templates, active coefficient set and win model. Every per-store table is filtered by the
 * store explicitly (RLS alone would mix the stores of someone who works in several, and a
 * service-role client sees every store). Throws if the result is not a valid config.
 */
export async function loadPricingBundle(supabase: SupabaseClient, locationId: string): Promise<PricingBundle> {
  if (!locationId) throw new Error('Loading pricing configuration failed: no location');
  const [settings, products, materials, crews, codes, tiers, set, location] = await Promise.all([
    supabase.from('app_settings').select('key, value').eq('location_id', locationId),
    supabase.from('products').select('id, code, label, unit, r_per_inch, is_r_bearing').eq('active', true),
    supabase
      .from('materials')
      .select('id, product_id, name, unit, cost_per_unit, coverage_sqft_in')
      .eq('location_id', locationId)
      .eq('active', true)
      .eq('is_default', true),
    supabase.from('crews').select('id, name, size, blended_hourly_cost').eq('location_id', locationId).eq('active', true),
    supabase.from('code_requirements').select('job_type, assembly, min_r, code_edition').eq('location_id', locationId).eq('is_default', true),
    supabase
      .from('tier_templates')
      .select('job_type, tier, label, primary_product, target_r, include_air_sealing, include_removal, marketing_bullets')
      .eq('location_id', locationId)
      .eq('active', true),
    supabase.from('coefficient_sets').select('id, version').eq('location_id', locationId).eq('status', 'active').single(),
    supabase.from('locations').select(LOCATION_COLUMNS).eq('id', locationId).single(),
  ]);

  for (const r of [settings, products, materials, crews, codes, tiers, set, location]) {
    if (r.error) throw new Error(`Loading pricing configuration failed: ${r.error.message}`);
  }

  const [coefficients, winModel] = await Promise.all([
    supabase.from('coefficients').select('kind, product, job_type, access_level, value, sample_size, n_eff, confidence').eq('set_id', set.data!.id),
    supabase
      .from('win_models')
      .select('id, trained_at, n_quotes, params, metrics')
      .eq('location_id', locationId)
      .eq('is_active', true)
      .maybeSingle(),
  ]);
  if (coefficients.error) throw new Error(`Loading coefficients failed: ${coefficients.error.message}`);
  // The win model is optional (cold start, or a role that cannot read it); pricing never depends on it.

  const rows: SnapshotRows = {
    settings: settings.data!,
    products: products.data!,
    materials: materials.data!,
    crews: crews.data!,
    codeRequirements: codes.data!,
    tierTemplates: tiers.data!,
    coefficientSet: set.data!,
    coefficients: coefficients.data!,
    winModel: winModel.error ? null : winModel.data,
  };
  const bundle = makeBundle(rows);
  validateSnapshot(bundle.snapshot);
  return { ...bundle, location: bundleLocation(parseLocation(location.data)) };
}
