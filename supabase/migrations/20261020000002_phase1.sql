-- =============================================================================
-- Phase 1: estimator + quotes
--   * offline sync RPC (idempotent, row-version checked, RLS enforced)
--   * client_doc for round-tripping the offline draft
--   * seed tier templates, a placeholder crew, lead sources, storage buckets
-- =============================================================================

-- The offline client's draft, stored verbatim so another device can resume it.
alter table estimates add column client_doc jsonb;

-- -----------------------------------------------------------------------------
-- Settings added in Phase 1
-- -----------------------------------------------------------------------------
insert into app_settings (key, value, description) values
  ('shop_address',     '"Newark, DE 19711"', 'Origin for drive-time lookups — PLACEHOLDER, set the shop address'),
  ('quote_terms',      '"Quote valid for the period shown. A signed quote authorizes Koala Insulation of Newark to schedule the work. Final price may change only if hidden conditions are found; any change requires your written approval."', 'Terms printed on every quote — PLACEHOLDER, owner to replace'),
  ('warranty_text',    '"Workmanship warranty — PLACEHOLDER, owner to replace."', 'Warranty text on the quote PDF')
on conflict (key) do nothing;

-- Placeholder crew so pricing works on day one.
insert into crews (name, size, blended_hourly_cost, needs_owner_input)
values ('Crew A', 2, 38.00, true);

insert into app_settings (key, value, description)
select 'default_crew_id', to_jsonb(id::text), 'Crew assumed when an estimate does not pick one'
from crews where name = 'Crew A';

insert into lead_sources (name) values
  ('Website'), ('Google Local Services'), ('Google Search'), ('Referral'), ('Repeat customer'),
  ('Angi / HomeAdvisor'), ('Energize Delaware'), ('Yard sign / truck'), ('Facebook'), ('Other');

-- -----------------------------------------------------------------------------
-- Good / better / best recipes (owner-editable)
-- -----------------------------------------------------------------------------
insert into tier_templates (job_type, tier, label, primary_product, target_r, include_air_sealing, include_removal, marketing_bullets) values
  ('attic','good',   'Blown Fiberglass to Code',            'fiberglass_blown', null, false, false, array['Brings your attic to current code R-value','Non-combustible, won''t settle much']),
  ('attic','better', 'Air Seal + Blown Cellulose',          'cellulose',        null, true,  false, array['Seals the leaks that drive drafts and high bills','Dense cellulose blocks air movement','Eligible for most utility rebates']),
  ('attic','best',   'Remove, Air Seal + Cellulose',        'cellulose',        null, true,  true,  array['Old, dirty or damaged insulation removed','Full air sealing before new insulation','Best comfort and efficiency']),
  ('walls','good',   'Dense-Pack Cellulose',                'cellulose',        null, false, false, array['Installed from outside or inside with minimal disruption','Fills the full cavity']),
  ('walls','better', 'Open-Cell Spray Foam',                'ocsf',             null, false, false, array['Seals and insulates in one step','Excellent sound dampening']),
  ('walls','best',   'Closed-Cell Spray Foam',              'ccsf',             null, false, false, array['Highest R per inch','Adds wall rigidity and a moisture barrier']),
  ('crawlspace','good',  'Fiberglass Batts',                'batts',            null, false, false, array['Insulates the floor above the crawlspace']),
  ('crawlspace','better','Closed-Cell Spray Foam',          'ccsf',             null, false, false, array['Moisture-resistant','Seals out drafts and pests']),
  ('crawlspace','best',  'Closed-Cell Foam + Air Sealing',  'ccsf',             null, true,  false, array['Moisture-resistant','Every penetration sealed','Warmest floors']),
  ('rim_joist','good',   'Fiberglass Batts',                'batts',            null, false, false, array['Fills the rim joist bays']),
  ('rim_joist','better', 'Open-Cell Spray Foam',            'ocsf',             null, false, false, array['Seals the biggest air leak in most basements']),
  ('rim_joist','best',   'Closed-Cell Spray Foam',          'ccsf',             null, false, false, array['Air, moisture and thermal barrier in one']),
  ('garage','good',      'Fiberglass Batts',                'batts',            null, false, false, array['Insulates the garage ceiling or walls']),
  ('garage','better',    'Blown Fiberglass',                'fiberglass_blown', null, false, false, array['Seamless coverage over living space']),
  ('garage','best',      'Open-Cell Spray Foam',            'ocsf',             null, false, false, array['Seals and insulates; quieter, more comfortable rooms above']),
  ('commercial','good',  'Blown Fiberglass',                'fiberglass_blown', null, false, false, array['Cost-effective code compliance']),
  ('commercial','better','Open-Cell Spray Foam',            'ocsf',             null, false, false, array['Air seal and insulate in one step']),
  ('commercial','best',  'Closed-Cell Spray Foam',          'ccsf',             null, false, false, array['Highest R per inch; moisture and air barrier']);

-- -----------------------------------------------------------------------------
-- Storage buckets (private; accessed through the server with signed URLs)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('quotes', 'quotes', false), ('signatures', 'signatures', false), ('photos', 'photos', false)
    on conflict (id) do nothing;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Offline sync: apply one estimate document atomically.
--
-- SECURITY INVOKER, so every write goes through RLS as the calling user.
-- Idempotent on p_mutation_id. Optimistic concurrency on estimates.row_version:
-- a stale base version returns {"status":"conflict"} with the server's copy.
-- Payload keys are snake_case column names (see lib/sync/payload.ts).
-- -----------------------------------------------------------------------------
create or replace function sync_upsert_estimate(p_mutation_id uuid, p_base_row_version int, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_est    jsonb := p_payload->'estimate';
  v_cust   jsonb := p_payload->'customer';
  v_prop   jsonb := p_payload->'property';
  v_id     uuid  := (v_est->>'id')::uuid;
  v_prev   jsonb;
  v_cur    record;
  v_exists boolean;
  v_before jsonb;
  v_after  jsonb;
  v_rv     int;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not has_role('owner', 'office', 'estimator') then
    raise exception 'this role cannot edit estimates' using errcode = '42501';
  end if;

  select result into v_prev from sync_mutations where mutation_id = p_mutation_id;
  if found then
    return v_prev;
  end if;

  select id, row_version, status, client_doc into v_cur from estimates where id = v_id for update;
  v_exists := found;

  if v_exists and v_cur.row_version is distinct from p_base_row_version then
    return jsonb_build_object('status', 'conflict', 'row_version', v_cur.row_version, 'server_doc', v_cur.client_doc);
  end if;
  if v_exists and v_cur.status = 'signed' then
    return jsonb_build_object('status', 'locked', 'row_version', v_cur.row_version, 'server_doc', v_cur.client_doc);
  end if;

  -- customer -----------------------------------------------------------------
  -- Update-then-insert rather than ON CONFLICT: the estimator SELECT policy looks the
  -- customer up by id, which cannot see a row that is still being inserted.
  update customers c set
    first_name     = v_cust->>'first_name',
    last_name      = v_cust->>'last_name',
    email          = nullif(v_cust->>'email', '')::citext,
    phone          = nullif(v_cust->>'phone', ''),
    sms_consent    = coalesce((v_cust->>'sms_consent')::boolean, false),
    sms_consent_at = case when coalesce((v_cust->>'sms_consent')::boolean, false) and not c.sms_consent then now()
                          when not coalesce((v_cust->>'sms_consent')::boolean, false) then null
                          else c.sms_consent_at end,
    email_consent  = coalesce((v_cust->>'email_consent')::boolean, true)
  where c.id = (v_cust->>'id')::uuid;
  if not found then
    insert into customers (id, first_name, last_name, email, phone, sms_consent, sms_consent_at, email_consent, created_by)
    values ((v_cust->>'id')::uuid, v_cust->>'first_name', v_cust->>'last_name',
            nullif(v_cust->>'email', '')::citext, nullif(v_cust->>'phone', ''),
            coalesce((v_cust->>'sms_consent')::boolean, false),
            case when coalesce((v_cust->>'sms_consent')::boolean, false) then now() end,
            coalesce((v_cust->>'email_consent')::boolean, true), auth.uid());
  end if;

  -- property -----------------------------------------------------------------
  insert into properties as p (id, customer_id, street, city, state, zip, year_built, utility, home_type)
  values ((v_prop->>'id')::uuid, (v_cust->>'id')::uuid, v_prop->>'street', v_prop->>'city',
          coalesce(nullif(v_prop->>'state', ''), 'DE'), v_prop->>'zip',
          (v_prop->>'year_built')::int, nullif(v_prop->>'utility', ''), nullif(v_prop->>'home_type', ''))
  on conflict (id) do update set
    street = excluded.street, city = excluded.city, state = excluded.state, zip = excluded.zip,
    year_built = excluded.year_built, utility = excluded.utility, home_type = excluded.home_type
  where p.customer_id = excluded.customer_id;

  -- estimate -----------------------------------------------------------------
  select coalesce(jsonb_object_agg(tier, price), '{}') into v_before from estimate_options where estimate_id = v_id;

  insert into estimates as e (id, customer_id, property_id, estimator_id, status, coefficient_set_id,
                              pricing_snapshot, pricing_snapshot_hash, drive_minutes_est, crew_id, selected_tier,
                              model_total_price, notes, priced_offline, client_created_at, client_doc)
  values (v_id, (v_cust->>'id')::uuid, (v_prop->>'id')::uuid, auth.uid(),
          (v_est->>'status')::estimate_status, (v_est->>'coefficient_set_id')::uuid,
          v_est->'pricing_snapshot', v_est->>'pricing_snapshot_hash', (v_est->>'drive_minutes_est')::numeric,
          (v_est->>'crew_id')::uuid, (v_est->>'selected_tier')::tier_code, (v_est->>'model_total_price')::numeric,
          v_est->>'notes', coalesce((v_est->>'priced_offline')::boolean, false),
          (v_est->>'client_created_at')::timestamptz, v_est->'client_doc')
  on conflict (id) do update set
    customer_id           = excluded.customer_id,
    property_id           = excluded.property_id,
    status                = excluded.status,
    coefficient_set_id    = excluded.coefficient_set_id,
    pricing_snapshot      = excluded.pricing_snapshot,
    pricing_snapshot_hash = excluded.pricing_snapshot_hash,
    drive_minutes_est     = excluded.drive_minutes_est,
    crew_id               = excluded.crew_id,
    selected_tier         = excluded.selected_tier,
    model_total_price     = excluded.model_total_price,
    notes                 = excluded.notes,
    priced_offline        = excluded.priced_offline,
    client_doc            = excluded.client_doc
  returning row_version into v_rv;

  -- areas ----------------------------------------------------------------------
  delete from estimate_options where estimate_id = v_id;   -- lines cascade
  delete from estimate_areas
   where estimate_id = v_id
     and id not in (select (a->>'id')::uuid from jsonb_array_elements(coalesce(p_payload->'areas', '[]')) a);

  insert into estimate_areas as ea (id, estimate_id, name, job_type, sqft, current_r, target_r, existing_material,
                                    existing_depth_in, depth_in, access_level, removal_needed, prep_notes, sort_order)
  select r.id, v_id, r.name, r.job_type, r.sqft, coalesce(r.current_r, 0), r.target_r, r.existing_material,
         r.existing_depth_in, r.depth_in, coalesce(r.access_level, 'moderate'), coalesce(r.removal_needed, false),
         r.prep_notes, coalesce(r.sort_order, 0)
    from jsonb_populate_recordset(null::estimate_areas, coalesce(p_payload->'areas', '[]')) r
  on conflict (id) do update set
    name = excluded.name, job_type = excluded.job_type, sqft = excluded.sqft, current_r = excluded.current_r,
    target_r = excluded.target_r, existing_material = excluded.existing_material,
    existing_depth_in = excluded.existing_depth_in, depth_in = excluded.depth_in,
    access_level = excluded.access_level, removal_needed = excluded.removal_needed,
    prep_notes = excluded.prep_notes, sort_order = excluded.sort_order
  where ea.estimate_id = v_id;

  -- options + lines ------------------------------------------------------------
  insert into estimate_options (id, estimate_id, tier, label, direct_cost, loaded_cost, price, model_price,
                                is_overridden, override_reason, margin_pct, crew_days, financing)
  select r.id, v_id, r.tier, r.label, r.direct_cost, r.loaded_cost, r.price, r.model_price,
         coalesce(r.is_overridden, false), r.override_reason, r.margin_pct, r.crew_days, r.financing
    from jsonb_populate_recordset(null::estimate_options, coalesce(p_payload->'options', '[]')) r;

  insert into estimate_lines (id, option_id, area_id, kind, product, material_id, description, qty, unit, hours,
                              unit_cost, cost, design_qty, model_qty, model_hours, model_cost, is_overridden, sort_order)
  select l.id, (o->>'id')::uuid, l.area_id, l.kind, l.product, l.material_id, l.description, l.qty, l.unit, l.hours,
         l.unit_cost, l.cost, l.design_qty, l.model_qty, l.model_hours, l.model_cost, coalesce(l.is_overridden, false),
         coalesce(l.sort_order, 0)
    from jsonb_array_elements(coalesce(p_payload->'options', '[]')) o,
         jsonb_populate_recordset(null::estimate_lines, coalesce(o->'lines', '[]')) l;

  select coalesce(jsonb_object_agg(tier, price), '{}') into v_after from estimate_options where estimate_id = v_id;
  if v_before is distinct from v_after then
    perform log_event('estimate.price_change', 'estimates', v_id::text,
                      jsonb_build_object('before', v_before, 'after', v_after,
                                         'overrides', v_est->'client_doc'->'overrides',
                                         'pricing_snapshot_hash', v_est->>'pricing_snapshot_hash'));
  end if;

  v_result := jsonb_build_object('status', 'applied', 'row_version', v_rv);
  insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
  values (p_mutation_id, auth.uid(), 'estimate', v_id, v_result);
  return v_result;
end $$;

revoke all on function sync_upsert_estimate(uuid, int, jsonb) from public, anon;
grant execute on function sync_upsert_estimate(uuid, int, jsonb) to authenticated;
