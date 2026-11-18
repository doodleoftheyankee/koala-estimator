-- =============================================================================
-- Multi-location, part 2 of 5: every table that holds a store's data says which store.
--
--   * location_id on each per-store table. Every existing row belongs to the existing store
--     (there is only one), so nothing is copied, renamed or repriced.
--   * A temporary default, default_location_id(), keeps code that predates stores inserting
--     rows correctly until the store-aware code ships. A later cleanup removes it.
--   * Rows that hang off another row take that row's store and may never point at another
--     store's rows (an estimate cannot use another store's customer, crew or pricing set).
--     The store of an estimate is always the store of its customer, never what a phone says.
--
-- Tables that inherit their store from a parent get no column (their rules check the parent):
-- estimate_areas, estimate_options, estimate_lines, deviation_flags, estimate_rebates,
-- quote_events, coefficients, crew_members, crew_availability, followup_steps,
-- followup_variant_stats, photo_corrections.
-- Shared across stores: products, job_types, access_levels, profiles, sync_mutations, opt_outs.
-- =============================================================================

do $$
declare
  t text;
  v_loc uuid := (select id from locations order by created_at limit 1);
begin
  foreach t in array array[
    'app_settings', 'materials', 'labor_roles', 'crews', 'code_requirements', 'tier_templates',
    'lead_sources', 'rebate_programs', 'followup_sequences', 'coefficient_sets', 'coefficient_changes',
    'learning_runs', 'win_models', 'lead_score_models', 'weekly_reports', 'customers', 'properties',
    'leads', 'estimates', 'quotes', 'jobs', 'job_actuals', 'photos', 'photo_analyses', 'messages',
    'followup_enrollments', 'roof_lookups', 'audit_log']
  loop
    -- Triggers stay quiet while existing rows are tagged (no touch, no audit, no immutability check).
    execute format('alter table %I disable trigger user', t);
    execute format('alter table %I add column location_id uuid references locations(id)', t);
    execute format('update %I set location_id = $1', t) using v_loc;
    execute format('alter table %I enable trigger user', t);
    if t <> 'audit_log' then
      execute format('alter table %I alter column location_id set not null', t);
      execute format('alter table %I alter column location_id set default default_location_id()', t);
    end if;
    execute format('create index %I on %I (location_id)', t || '_location_idx', t);
  end loop;
end $$;

-- audit_log: system events may have no store. Domain events and table changes record it.
alter table audit_log alter column location_id set default default_location_id();

-- -----------------------------------------------------------------------------
-- Store inheritance and cross-store guard.
-- Arguments come in (column, table) pairs. The first pair whose value is set gives the row its
-- store when none was given; every pair must point at a row of the same store. A reference that
-- does not exist (yet) is left to the foreign key, or allowed where there is none (photo reads
-- and roof lookups made before the estimate synced).
-- -----------------------------------------------------------------------------
create or replace function tg_location_from_parent() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := to_jsonb(new);
  i int := 0;
  v_ref text;
  v_loc uuid;
begin
  while i < tg_nargs loop
    v_ref := r->>tg_argv[i];
    if v_ref is not null then
      execute format('select location_id from %I where id = $1', tg_argv[i + 1]) into v_loc using v_ref::uuid;
      if v_loc is not null then
        if new.location_id is null then
          new.location_id := v_loc;   -- no store given: take the parent's
        elsif new.location_id <> v_loc then
          raise exception '% % belongs to another location', tg_argv[i + 1], v_ref using errcode = '42501';
        end if;
      end if;
    end if;
    i := i + 2;
  end loop;
  if new.location_id is null then
    raise exception 'location_id is required for %', tg_table_name using errcode = '23502';
  end if;
  return new;
end $$;

create trigger properties_location before insert or update on properties for each row
  execute function tg_location_from_parent('customer_id', 'customers');
create trigger leads_location before insert or update on leads for each row
  execute function tg_location_from_parent('customer_id', 'customers', 'property_id', 'properties',
                                           'source_id', 'lead_sources', 'score_model_id', 'lead_score_models');
create trigger estimates_location before insert or update on estimates for each row
  execute function tg_location_from_parent('customer_id', 'customers', 'property_id', 'properties',
                                           'lead_id', 'leads', 'coefficient_set_id', 'coefficient_sets',
                                           'crew_id', 'crews');
create trigger quotes_location before insert or update on quotes for each row
  execute function tg_location_from_parent('estimate_id', 'estimates');
create trigger jobs_location before insert or update on jobs for each row
  execute function tg_location_from_parent('estimate_id', 'estimates', 'quote_id', 'quotes', 'crew_id', 'crews');
create trigger job_actuals_location before insert or update on job_actuals for each row
  execute function tg_location_from_parent('job_id', 'jobs');
create trigger photos_location before insert or update on photos for each row
  execute function tg_location_from_parent('estimate_id', 'estimates');
create trigger photo_analyses_location before insert or update on photo_analyses for each row
  execute function tg_location_from_parent('estimate_id', 'estimates');
create trigger roof_lookups_location before insert or update on roof_lookups for each row
  execute function tg_location_from_parent('estimate_id', 'estimates');
create trigger coefficient_sets_location before insert or update on coefficient_sets for each row
  execute function tg_location_from_parent('parent_id', 'coefficient_sets', 'learning_run_id', 'learning_runs');
create trigger coefficient_changes_location before insert or update on coefficient_changes for each row
  execute function tg_location_from_parent('to_set_id', 'coefficient_sets', 'from_set_id', 'coefficient_sets');
create trigger learning_runs_location before insert or update on learning_runs for each row
  execute function tg_location_from_parent('candidate_set_id', 'coefficient_sets');
create trigger win_models_location before insert or update on win_models for each row
  execute function tg_location_from_parent('learning_run_id', 'learning_runs');
create trigger messages_location before insert or update on messages for each row
  execute function tg_location_from_parent('customer_id', 'customers', 'quote_id', 'quotes',
                                           'enrollment_id', 'followup_enrollments');
create trigger followup_enrollments_location before insert or update on followup_enrollments for each row
  execute function tg_location_from_parent('sequence_id', 'followup_sequences', 'quote_id', 'quotes', 'lead_id', 'leads');

-- Root rows (no parent) still need a store: the default covers single-store callers; anything
-- else must name one.
do $$
declare t text;
begin
  foreach t in array array['app_settings', 'materials', 'labor_roles', 'crews', 'code_requirements',
                           'tier_templates', 'lead_sources', 'rebate_programs', 'followup_sequences',
                           'lead_score_models', 'weekly_reports', 'customers']
  loop
    execute format('create trigger %I before insert or update on %I for each row execute function tg_location_from_parent()',
                   t || '_location', t);
  end loop;
end $$;

-- Children without their own column must not join rows of two stores.
create or replace function tg_same_location() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := to_jsonb(new);
  i int := 0;
  v_ref text;
  v_loc uuid;
  v_first uuid;
begin
  while i < tg_nargs loop
    v_ref := r->>tg_argv[i];
    if v_ref is not null then
      if tg_argv[i + 1] = 'profiles' then
        -- A person can join a store's crew only if they work in that store.
        if v_first is not null and not exists (select 1 from location_members
                                                where location_id = v_first and profile_id = v_ref::uuid) then
          raise exception 'that person does not work in this location' using errcode = '42501';
        end if;
      else
        execute format('select location_id from %I where id = $1', tg_argv[i + 1]) into v_loc using v_ref::uuid;
        if v_loc is not null then
          if v_first is null then v_first := v_loc;
          elsif v_loc <> v_first then
            raise exception '% % belongs to another location', tg_argv[i + 1], v_ref using errcode = '42501';
          end if;
        end if;
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end $$;

create trigger crew_members_location before insert or update on crew_members for each row
  execute function tg_same_location('crew_id', 'crews', 'profile_id', 'profiles');
create trigger estimate_rebates_location before insert or update on estimate_rebates for each row
  execute function tg_same_location('estimate_id', 'estimates', 'program_id', 'rebate_programs');
create trigger followup_steps_location before insert or update on followup_steps for each row
  execute function tg_same_location('sequence_id', 'followup_sequences');

-- Every table change and domain event records the store it happened in.
create or replace function tg_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; pk text; v_loc uuid;
begin
  r  := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  pk := coalesce(r->>'id', r->>'key', r->>'code');
  v_loc := case when tg_table_name = 'locations' then (r->>'id')::uuid
                else coalesce((r->>'location_id')::uuid, default_location_id()) end;
  insert into audit_log (actor_id, actor_role, action, table_name, row_id, before, after, location_id)
  values (auth.uid(), auth_role(), tg_op, tg_table_name, pk,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
          v_loc);
  return coalesce(new, old);
end $$;
