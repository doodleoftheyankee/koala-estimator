-- The pricing rows, read-only: the one SELECT behind lib/pricing/__fixtures__/seeded-rows.json
-- (scripts/accuracy/seeded-rows.sh runs it on a freshly migrated database) and behind the live
-- golden set (run it on production with SELECT rights only).
--
-- Same filters as loadPricingBundle (lib/server/bundle.ts); keep the two in step:
--   products active, materials active and default, crews active, code requirements default,
--   tier templates active, the one active coefficient set and its coefficients, the active win model.
-- Settings: only the keys the pricing snapshot reads (PRICING_SETTING_KEYS in lib/accuracy/rows.ts;
-- lib/accuracy/invariants.test.ts checks this list against that one). No branding, terms or
-- franchise text.
--
-- Returns one row with one column, `rows`: a JSON object shaped like SnapshotRows
-- (lib/server/snapshot.ts).
with active_set as (
  select id, version from coefficient_sets where status = 'active'
)
select jsonb_build_object(
  'settings', coalesce((
    select jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key)
      from app_settings
     where key in ('overhead_pct', 'target_margin_pct', 'floor_margin_pct', 'ceiling_margin_pct',
                   'minimum_job_price', 'price_rounding', 'productive_hours_per_day',
                   'vehicle_cost_per_trip', 'disposal_cost_per_sqft', 'estimator_override_limit_pct',
                   'estimators_see_costs', 'deviation_threshold', 'quote_valid_days', 'financing',
                   'default_crew_id')), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'label', label, 'unit', unit,
             'r_per_inch', r_per_inch, 'is_r_bearing', is_r_bearing) order by code)
      from products where active), '[]'::jsonb),
  'materials', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'product_id', m.product_id, 'name', m.name, 'unit', m.unit,
             'cost_per_unit', m.cost_per_unit, 'coverage_sqft_in', m.coverage_sqft_in) order by p.code, m.name)
      from materials m left join products p on p.id = m.product_id
     where m.active and m.is_default), '[]'::jsonb),
  'crews', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'size', size,
             'blended_hourly_cost', blended_hourly_cost) order by name)
      from crews where active), '[]'::jsonb),
  'codeRequirements', coalesce((
    select jsonb_agg(jsonb_build_object('job_type', job_type, 'assembly', assembly, 'min_r', min_r,
             'code_edition', code_edition) order by job_type, assembly)
      from code_requirements where is_default), '[]'::jsonb),
  'tierTemplates', coalesce((
    select jsonb_agg(jsonb_build_object('job_type', job_type, 'tier', tier, 'label', label,
             'primary_product', primary_product, 'target_r', target_r, 'include_air_sealing', include_air_sealing,
             'include_removal', include_removal, 'marketing_bullets', marketing_bullets) order by job_type, tier)
      from tier_templates where active), '[]'::jsonb),
  'coefficientSet', (select jsonb_build_object('id', id, 'version', version) from active_set),
  'coefficients', coalesce((
    select jsonb_agg(jsonb_build_object('kind', c.kind, 'product', c.product, 'job_type', c.job_type,
             'access_level', c.access_level, 'value', c.value, 'sample_size', c.sample_size,
             'n_eff', c.n_eff, 'confidence', c.confidence)
             order by c.kind, c.product nulls first, c.job_type nulls first, c.access_level nulls first)
      from coefficients c join active_set s on s.id = c.set_id), '[]'::jsonb),
  'winModel', (
    select jsonb_build_object('id', id, 'trained_at', trained_at, 'n_quotes', n_quotes, 'params', params,
             'metrics', metrics)
      from win_models where is_active limit 1)
) as rows;
