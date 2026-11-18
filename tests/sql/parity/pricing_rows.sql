-- The rows loadPricingBundle (lib/server/bundle.ts) reads for one store, as one JSON document in
-- the SnapshotRows shape. scripts/test-db.sh runs it before the multi-location migrations (no
-- store filter: one store) and after them (filtered to the pilot store), and the parity test
-- requires the two to build the identical bundle and identical prices.
-- :loc_filter is "true" before the migrations, or "location_id = '<id>'" after.
select jsonb_build_object(
  'settings', (select jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key)
                 from app_settings where :loc_filter),
  'products', (select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'label', label, 'unit', unit,
                                                   'r_per_inch', r_per_inch, 'is_r_bearing', is_r_bearing) order by code)
                 from products where active),
  'materials', (select jsonb_agg(jsonb_build_object('id', id, 'product_id', product_id, 'name', name, 'unit', unit,
                                                    'cost_per_unit', cost_per_unit, 'coverage_sqft_in', coverage_sqft_in) order by id)
                  from materials where active and is_default and :loc_filter),
  'crews', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'size', size,
                                                'blended_hourly_cost', blended_hourly_cost) order by id)
              from crews where active and :loc_filter),
  'codeRequirements', (select jsonb_agg(jsonb_build_object('job_type', job_type, 'assembly', assembly,
                                                           'min_r', min_r, 'code_edition', code_edition) order by id)
                         from code_requirements where is_default and :loc_filter),
  'tierTemplates', (select jsonb_agg(jsonb_build_object('job_type', job_type, 'tier', tier, 'label', label,
                                                        'primary_product', primary_product, 'target_r', target_r,
                                                        'include_air_sealing', include_air_sealing,
                                                        'include_removal', include_removal,
                                                        'marketing_bullets', marketing_bullets) order by id)
                      from tier_templates where active and :loc_filter),
  'coefficientSet', (select jsonb_build_object('id', id, 'version', version)
                       from coefficient_sets where status = 'active' and :loc_filter),
  'coefficients', (select jsonb_agg(jsonb_build_object('kind', c.kind, 'product', c.product, 'job_type', c.job_type,
                                                       'access_level', c.access_level, 'value', c.value,
                                                       'sample_size', c.sample_size, 'n_eff', c.n_eff,
                                                       'confidence', c.confidence) order by c.id)
                     from coefficients c join coefficient_sets s on s.id = c.set_id
                    where s.status = 'active' and :loc_filter),
  'winModel', null
);
