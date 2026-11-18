-- =============================================================================
-- Multi-location, part 5 of 5: store identity lives on the store, and new stores can be opened.
--
--   * New addresses no longer default to Delaware / New Castle County. The store's state fills a
--     blank state on sync instead.
--   * create_location(): opens a new store (service role only: corporate set-up scripts). It copies
--     a template store's setup (settings, materials, labor roles, crews, tier menu, code minimums,
--     lead sources) and gives the new store a fresh pricing set built from the industry starting
--     values, not the template store's learned numbers. Everything copied that depends on the market
--     (costs, crew rates, code minimums) is flagged for the new owner to confirm.
--
-- The app reads the store's name, time zone, state, contact details and branding from locations.
-- The old app_settings rows 'branding' and 'shop_address' stay until the cleanup migration so code
-- that predates stores keeps working during the deploy.
-- =============================================================================

alter table properties alter column state drop default;
alter table properties alter column county drop default;

create or replace function create_location(
  p_name          text,
  p_short_name    text,
  p_time_zone     text,
  p_state         text,
  p_climate_zone  text,
  p_county        text default null,
  p_shop_address  text default null,
  p_template      uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tpl       uuid;
  v_tpl_name  text;
  v_loc       uuid;
  v_seed      uuid;
  v_set       uuid;
  v_crew_map  jsonb := '{}';
  r           record;
  v_new_id    uuid;
begin
  if coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated') then
    raise exception 'new locations are created by the server only' using errcode = '42501';
  end if;
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'app_settings_key_compat') then
    raise exception 'apply the multi-location cleanup migration before opening a second location';
  end if;

  v_tpl := coalesce(p_template, (select id from locations order by created_at limit 1));
  select name into v_tpl_name from locations where id = v_tpl;
  if v_tpl_name is null then raise exception 'template location % not found', v_tpl; end if;

  insert into locations (name, short_name, time_zone, state, default_county, climate_zone, shop_address)
  values (p_name, p_short_name, p_time_zone, upper(p_state), p_county, upper(p_climate_zone), p_shop_address)
  returning id into v_loc;

  -- Crews first: the default crew setting points at the new store's copy.
  for r in select * from crews where location_id = v_tpl and active order by name loop
    insert into crews (name, size, blended_hourly_cost, needs_owner_input, active, location_id)
    values (r.name, r.size, r.blended_hourly_cost, true, true, v_loc)
    returning id into v_new_id;
    v_crew_map := v_crew_map || jsonb_build_object(r.id::text, v_new_id::text);
  end loop;

  insert into app_settings (location_id, key, value, description)
  select v_loc, s.key,
         case s.key
           when 'default_crew_id' then coalesce(v_crew_map->(s.value #>> '{}'), 'null'::jsonb)
           when 'quote_terms' then to_jsonb(replace(s.value #>> '{}', v_tpl_name, p_name))
           when 'followup_quiet_hours' then s.value || jsonb_build_object('tz', p_time_zone)
           else s.value
         end,
         s.description
    from app_settings s
   where s.location_id = v_tpl and s.key not in ('branding', 'shop_address');

  insert into materials (product_id, name, sku, unit, cost_per_unit, coverage_sqft_in, is_default, active,
                         needs_owner_input, location_id)
  select product_id, name, sku, unit, cost_per_unit, coverage_sqft_in, is_default, active, true, v_loc
    from materials where location_id = v_tpl and active;

  insert into labor_roles (name, hourly_cost, needs_owner_input, location_id)
  select name, hourly_cost, true, v_loc from labor_roles where location_id = v_tpl;

  insert into code_requirements (job_type, assembly, min_r, alt_spec, code_edition, climate_zone, is_default,
                                 source_note, location_id)
  select job_type, assembly, min_r, alt_spec, code_edition, upper(p_climate_zone), is_default,
         format('Copied from %s. CONFIRM for %s, climate zone %s.', v_tpl_name, upper(p_state), upper(p_climate_zone)),
         v_loc
    from code_requirements where location_id = v_tpl and is_default;

  insert into tier_templates (job_type, tier, label, primary_product, target_r, include_air_sealing, include_removal,
                              marketing_bullets, active, location_id)
  select job_type, tier, label, primary_product, target_r, include_air_sealing, include_removal,
         marketing_bullets, active, v_loc
    from tier_templates where location_id = v_tpl;

  insert into lead_sources (name, cost_per_lead, active, location_id)
  select name, null, active, v_loc from lead_sources where location_id = v_tpl and active;

  -- Fresh pricing set from the industry starting values (the template's first seed set's priors).
  select id into v_seed from coefficient_sets
   where location_id = v_tpl and source = 'seed' order by created_at, version limit 1;
  if v_seed is null then
    select id into v_seed from coefficient_sets where location_id = v_tpl and status = 'active';
  end if;
  insert into coefficient_sets (status, source, notes, activated_at, location_id)
  values ('active', 'seed', 'Industry starting values for a new location; the nightly learning run tunes them from this location''s jobs',
          now(), v_loc)
  returning id into v_set;
  insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound)
  select v_set, kind, product, job_type, access_level,
         least(greatest(prior_value, lower_bound), upper_bound), prior_value, lower_bound, upper_bound
    from coefficients where set_id = v_seed;

  perform log_event('location.create', 'locations', v_loc::text,
                    jsonb_build_object('template', v_tpl, 'name', p_name));
  return v_loc;
end $$;
revoke all on function create_location(text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function create_location(text, text, text, text, text, text, text, uuid) to service_role;
