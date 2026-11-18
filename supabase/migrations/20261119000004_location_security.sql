-- =============================================================================
-- Multi-location, part 4 of 5: every security rule checks the store.
--
-- The role rules are the same as before; "owner" now means "owner of this store", and so on.
--   * A person sees and changes only the stores they work in, with the role they have there.
--   * Corporate users (profiles.corporate) read every store and write nothing.
--   * Crews still never see a price or a cost, and see only their own store's assigned jobs.
--   * The shared catalog (products, job types, access levels) changes every store's prices, so
--     only someone who owns every active store may edit it (today: the pilot store's owner).
--   * "STOP" opt-outs are shared: one opt-out is honored by every store.
--   * Pricing sets are promoted, rolled back and rejected within their own store only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role helpers, now from store membership
-- -----------------------------------------------------------------------------
-- The caller's role in their store (people in several stores: their role in none in particular,
-- so audit rows record null and the rules below never rely on it).
create or replace function auth_role() returns user_role
language sql stable security definer set search_path = public as $$
  select m.role from location_members m join profiles p on p.id = m.profile_id and p.active
   where m.profile_id = auth.uid() and m.active and m.location_id = user_location_id()
$$;

-- "Has this role in at least one store." Only used as a first, coarse check; every rule that
-- touches a row checks the row's store with has_location_role().
create or replace function has_role(variadic roles user_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(exists (
    select 1 from location_members m join profiles p on p.id = m.profile_id
     where m.profile_id = auth.uid() and m.active and p.active and m.role = any(roles)), false)
$$;

-- Owner of every active store: may edit the shared product catalog.
create or replace function can_edit_shared_catalog() returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('owner') and not exists (
    select 1 from locations l where l.active and not has_location_role(l.id, 'owner'))
$$;
revoke all on function can_edit_shared_catalog() from public, anon;
grant execute on function can_edit_shared_catalog() to authenticated, service_role;

-- Can the caller see this person (themselves, or someone in a store they run or the office of)?
create or replace function can_see_profile(p_profile uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_profile = auth.uid() or is_corporate()
      or exists (select 1 from location_members m where m.profile_id = p_profile and can_read_location(m.location_id))
$$;
create or replace function is_owner_of_profile(p_profile uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from location_members m
                  where m.profile_id = p_profile and has_location_role(m.location_id, 'owner'))
$$;
revoke all on function can_see_profile(uuid), is_owner_of_profile(uuid) from public, anon;
grant execute on function can_see_profile(uuid), is_owner_of_profile(uuid) to authenticated, service_role;

-- Domain events record the store of the row they are about.
create or replace function log_event(p_action text, p_table text, p_row_id text, p_context jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  if p_table = 'locations' then
    v_loc := p_row_id::uuid;
  else
    begin
      execute format('select location_id from %I where id::text = $1', p_table) into v_loc using p_row_id;
    exception when others then
      v_loc := null;
    end;
  end if;
  insert into audit_log (actor_id, actor_role, action, table_name, row_id, context, location_id)
  values (auth.uid(), auth_role(), p_action, p_table, p_row_id, p_context, coalesce(v_loc, default_location_id()));
end $$;

-- Only the service role (server set-up) grants corporate access.
create or replace function tg_profiles_corporate_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated')
     and new.corporate is distinct from (case when tg_op = 'INSERT' then false else old.corporate end) then
    raise exception 'corporate access is granted by the server only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_corporate_guard before insert or update on profiles
  for each row execute function tg_profiles_corporate_guard();

-- -----------------------------------------------------------------------------
-- Drop every rule; recreate each with the store check
-- -----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and tablename not in ('locations', 'location_members')
  loop
    execute format('drop policy %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

-- Audit log: the store's owner reads it; corporate reads all. Nobody writes it directly.
create policy audit_read on audit_log for select
  using (has_location_role(location_id, 'owner') or is_corporate());

-- People
create policy profiles_read on profiles for select using (can_see_profile(id));
create policy profiles_owner_update on profiles for update
  using (is_owner_of_profile(id)) with check (is_owner_of_profile(id));
-- An owner invites new people (the invite then adds them to the owner's store).
create policy profiles_owner_insert on profiles for insert with check (has_role('owner'));

-- Store pricing and setup: the store's staff (not crews) read, the store's owner writes.
do $$
declare t text;
begin
  foreach t in array array['app_settings', 'materials', 'labor_roles', 'crews', 'code_requirements',
                           'tier_templates', 'rebate_programs', 'lead_sources']
  loop
    execute format($f$create policy %I on %I for select
                      using (has_location_role(location_id, 'owner', 'office', 'estimator') or is_corporate())$f$,
                   t || '_read', t);
    execute format($f$create policy %I on %I for all
                      using (has_location_role(location_id, 'owner'))
                      with check (has_location_role(location_id, 'owner'))$f$,
                   t || '_owner_write', t);
  end loop;
end $$;

-- The shared catalog: every signed-in staff member reads; the owner of every store writes.
do $$
declare t text;
begin
  foreach t in array array['job_types', 'access_levels', 'products']
  loop
    execute format($f$create policy %I on %I for select
                      using (has_role('owner', 'office', 'estimator') or is_corporate())$f$, t || '_read', t);
    execute format($f$create policy %I on %I for all
                      using (can_edit_shared_catalog()) with check (can_edit_shared_catalog())$f$, t || '_owner_write', t);
  end loop;
end $$;

-- Crews and their members
create policy crew_members_read on crew_members for select
  using (profile_id = auth.uid()
         or exists (select 1 from crews c where c.id = crew_id and can_read_location(c.location_id)));
create policy crew_members_owner on crew_members for all
  using (exists (select 1 from crews c where c.id = crew_id and has_location_role(c.location_id, 'owner')))
  with check (exists (select 1 from crews c where c.id = crew_id and has_location_role(c.location_id, 'owner')));

create policy crew_availability_staff on crew_availability for all
  using (exists (select 1 from crews c where c.id = crew_id and has_location_role(c.location_id, 'owner', 'office')))
  with check (exists (select 1 from crews c where c.id = crew_id and has_location_role(c.location_id, 'owner', 'office')));
create policy crew_avail_read on crew_availability for select
  using (exists (select 1 from crews c where c.id = crew_id
                  and (has_location_role(c.location_id, 'estimator', 'crew') or is_corporate())));

-- Pricing sets: the store's owner and office read every set; its estimators read the active
-- set (offline pricing). Writes go through the functions below or the nightly job only.
create policy coeff_sets_read on coefficient_sets for select
  using (can_read_location(location_id) or (has_location_role(location_id, 'estimator') and status = 'active'));
create policy coeff_read on coefficients for select
  using (exists (select 1 from coefficient_sets s where s.id = set_id
                  and (can_read_location(s.location_id)
                       or (has_location_role(s.location_id, 'estimator') and s.status = 'active'))));
create policy coeff_changes_read on coefficient_changes for select using (can_read_location(location_id));
create policy learning_runs_read on learning_runs for select using (can_read_location(location_id));
create policy win_models_read on win_models for select
  using (has_location_role(location_id, 'owner', 'office', 'estimator') or is_corporate());
create policy lead_models_read on lead_score_models for select using (can_read_location(location_id));
create policy weekly_reports_owner on weekly_reports for select
  using (has_location_role(location_id, 'owner') or is_corporate());

-- Customers, properties, leads: the store's owner and office; its estimators for their own.
create policy customers_staff on customers for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy customers_corporate on customers for select using (is_corporate());
create policy customers_est on customers for select
  using (has_location_role(location_id, 'estimator') and estimator_can_see_customer(id));
create policy customers_est_ins on customers for insert
  with check (has_location_role(location_id, 'estimator') and created_by = auth.uid());
create policy customers_est_upd on customers for update
  using (has_location_role(location_id, 'estimator') and estimator_can_see_customer(id))
  with check (has_location_role(location_id, 'estimator'));

create policy properties_staff on properties for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy properties_corporate on properties for select using (is_corporate());
create policy properties_est on properties for all
  using (has_location_role(location_id, 'estimator') and estimator_can_see_customer(customer_id))
  with check (has_location_role(location_id, 'estimator') and estimator_can_see_customer(customer_id));

create policy leads_staff on leads for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy leads_corporate on leads for select using (is_corporate());
create policy leads_est on leads for select using (has_location_role(location_id, 'estimator') and assigned_to = auth.uid());
create policy leads_est_upd on leads for update
  using (has_location_role(location_id, 'estimator') and assigned_to = auth.uid())
  with check (has_location_role(location_id, 'estimator') and assigned_to = auth.uid());

-- Estimates and everything under them
create or replace function can_edit_estimate(p_estimate uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from estimates e
                  where e.id = p_estimate
                    and (has_location_role(e.location_id, 'owner', 'office')
                         or (e.estimator_id = auth.uid() and has_location_role(e.location_id, 'estimator'))))
$$;
create or replace function can_read_estimate(p_estimate uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select can_edit_estimate(p_estimate) or is_corporate()
$$;
revoke all on function can_read_estimate(uuid) from public, anon;
grant execute on function can_read_estimate(uuid) to authenticated, service_role;

create policy estimates_staff on estimates for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy estimates_corporate on estimates for select using (is_corporate());
create policy estimates_est on estimates for all
  using (has_location_role(location_id, 'estimator') and estimator_id = auth.uid())
  with check (has_location_role(location_id, 'estimator') and estimator_id = auth.uid());

create policy areas_rw   on estimate_areas   for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy options_rw on estimate_options for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy lines_rw   on estimate_lines   for all
  using (exists (select 1 from estimate_options o where o.id = option_id and can_edit_estimate(o.estimate_id)))
  with check (exists (select 1 from estimate_options o where o.id = option_id and can_edit_estimate(o.estimate_id)));
create policy flags_rw   on deviation_flags  for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy rebates_rw on estimate_rebates for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy photos_rw  on photos           for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));

create policy areas_corporate   on estimate_areas   for select using (is_corporate());
create policy options_corporate on estimate_options for select using (is_corporate());
create policy lines_corporate   on estimate_lines   for select using (is_corporate());
create policy flags_corporate   on deviation_flags  for select using (is_corporate());
create policy rebates_corporate on estimate_rebates for select using (is_corporate());
create policy photos_corporate  on photos           for select using (is_corporate());

-- Photo reads and roof lookups: your own, plus the store's owner (cost tracking).
create policy analyses_own_read on photo_analyses for select
  using (created_by = auth.uid() or has_location_role(location_id, 'owner') or is_corporate());
create policy corrections_own_read on photo_corrections for select
  using (corrected_by = auth.uid() or is_corporate()
         or exists (select 1 from photo_analyses pa where pa.id = analysis_id and has_location_role(pa.location_id, 'owner')));
create policy roof_lookups_own_read on roof_lookups for select
  using (created_by = auth.uid() or has_location_role(location_id, 'owner') or is_corporate());

-- Quotes (written by the server only)
create policy quotes_read on quotes for select using (can_read_estimate(estimate_id));
create policy quote_events_read on quote_events for select
  using (exists (select 1 from quotes q where q.id = quote_id and can_read_estimate(q.estimate_id)));

-- Jobs and actuals: the store's owner and office. Crews go through crew_job_view,
-- crew_actuals_view and the functions below, never these tables.
create policy jobs_staff on jobs for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy jobs_corporate on jobs for select using (is_corporate());
create policy actuals_staff on job_actuals for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy actuals_corporate on job_actuals for select using (is_corporate());

-- Follow-up and messages: the store's owner and office.
create policy followup_sequences_staff on followup_sequences for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy followup_steps_staff on followup_steps for all
  using (exists (select 1 from followup_sequences s where s.id = sequence_id and has_location_role(s.location_id, 'owner', 'office')))
  with check (exists (select 1 from followup_sequences s where s.id = sequence_id and has_location_role(s.location_id, 'owner', 'office')));
create policy followup_enrollments_staff on followup_enrollments for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));
create policy followup_variant_stats_staff on followup_variant_stats for all
  using (exists (select 1 from followup_steps st join followup_sequences s on s.id = st.sequence_id
                  where st.id = step_id and has_location_role(s.location_id, 'owner', 'office')))
  with check (exists (select 1 from followup_steps st join followup_sequences s on s.id = st.sequence_id
                       where st.id = step_id and has_location_role(s.location_id, 'owner', 'office')));
create policy messages_staff on messages for all
  using (has_location_role(location_id, 'owner', 'office')) with check (has_location_role(location_id, 'owner', 'office'));

-- Opt-outs are shared on purpose: a "STOP" to any store is honored by every store.
create policy opt_outs_staff on opt_outs for all
  using (has_role('owner', 'office')) with check (has_role('owner', 'office'));

-- Offline outbox ledger: per person, as before.
create policy sync_mutations_self on sync_mutations for select using (profile_id = auth.uid());
create policy sync_mutations_insert on sync_mutations for insert with check (profile_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Crew access (no prices, no costs; own store's assigned jobs only)
-- -----------------------------------------------------------------------------
create or replace function is_crew_job(p_job_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
                  where j.id = p_job_id and cm.profile_id = auth.uid()
                    and has_location_role(j.location_id, 'crew'))
$$;

create or replace view crew_job_view with (security_barrier = true) as
with signed as (
  select j.id, j.status, j.scheduled_start, j.scheduled_days, j.crew_id, j.started_at, j.completed_at, j.estimate_id,
         j.location_id, q.signed_tier, q.snapshot,
         (select o from jsonb_array_elements(coalesce(q.snapshot->'options', '[]')) o
           where o->>'tier' = q.signed_tier::text limit 1) as opt
    from jobs j
    join quotes q on q.id = j.quote_id
   where has_location_role(j.location_id, 'owner', 'office')
      or (has_location_role(j.location_id, 'crew')
          and exists (select 1 from crew_members cm where cm.crew_id = j.crew_id and cm.profile_id = auth.uid()))
), signed_areas as (
  select s.id as job_id, (sa.v->>'id')::uuid as area_id, sa.v->>'name' as area_name,
         (sa.v->>'jobType')::job_type_code as job_type, (sa.v->>'sqft')::numeric as sqft,
         (sa.v->>'accessLevel')::access_code as access_level, sa.i::int as ord
    from signed s, jsonb_array_elements(s.snapshot->'input'->'areas') with ordinality sa(v, i)
   where jsonb_typeof(s.snapshot->'input'->'areas') = 'array'
  union all
  select s.id, a.id, a.name, a.job_type, a.sqft, a.access_level, a.sort_order
    from signed s join estimate_areas a on a.estimate_id = s.estimate_id
   where jsonb_typeof(s.snapshot->'input'->'areas') is distinct from 'array'
)
select s.id as job_id, s.status, s.scheduled_start, s.scheduled_days, s.crew_id, s.started_at, s.completed_at,
       p.street, p.city, p.zip, p.lat, p.lng,
       c.first_name, c.last_name, c.phone,
       sa.area_id, sa.area_name, sa.job_type, sa.sqft, a.current_r, a.target_r,
       sa.access_level, a.removal_needed, a.prep_notes, a.hazards, a.hazard_disposition, sa.ord as area_sort,
       s.signed_tier,
       (select jsonb_agg(jsonb_build_object('product', l.v->>'product', 'kind', l.v->>'kind', 'description', l.v->>'description',
                                            'qty', (l.v->>'qty')::numeric, 'unit', l.v->>'unit',
                                            'hours', (l.v->>'hours')::numeric) order by l.i)
          from jsonb_array_elements(coalesce(s.opt->'lines', '[]')) with ordinality l(v, i)
         where l.v->>'areaId' = sa.area_id::text and l.v->>'kind' in ('material', 'labor', 'removal')) as scope,
       s.location_id
from signed s
join estimates e            on e.id = s.estimate_id
join properties p           on p.id = e.property_id
join customers c            on c.id = e.customer_id
join signed_areas sa        on sa.job_id = s.id
left join estimate_areas a  on a.id = sa.area_id;

create or replace view crew_actuals_view with (security_barrier = true) as
select a.id, a.job_id, a.area_id, a.product, a.actual_material_qty, a.actual_material_unit, a.actual_hours,
       a.actual_crew_size, a.actual_drive_minutes, a.actual_days, a.notes, a.entered_by, a.entered_at,
       a.verified_at, a.row_version, a.location_id
  from job_actuals a
 where has_location_role(a.location_id, 'owner', 'office') or is_crew_job(a.job_id);

create or replace function crew_set_job_status(p_job_id uuid, p_status job_status)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jobs; v_staff boolean;
begin
  select * into v from jobs where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  v_staff := has_location_role(v.location_id, 'owner', 'office');
  if not (v_staff or is_crew_job(p_job_id)) then
    raise exception 'not your job' using errcode = '42501';
  end if;
  if not ((v.status = 'scheduled' and p_status = 'in_progress')
       or (v.status = 'in_progress' and p_status in ('completed', 'scheduled'))
       or (v.status = 'completed' and p_status = 'in_progress' and v_staff)
       or (p_status = 'cancelled' and v_staff)) then
    raise exception 'cannot move a job from % to %', v.status, p_status using errcode = '22023';
  end if;
  update jobs set
    status       = p_status,
    started_at   = case when p_status = 'in_progress' then coalesce(started_at, now()) else started_at end,
    completed_at = case when p_status = 'completed' then now() else null end
  where id = p_job_id
  returning * into v;
  perform log_event('job.status', 'jobs', p_job_id::text, jsonb_build_object('status', p_status));
  return jsonb_build_object('id', v.id, 'status', v.status, 'started_at', v.started_at, 'completed_at', v.completed_at);
end $$;

create or replace function tg_job_actuals_frozen() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or has_location_role(old.location_id, 'owner') or old.verified_at is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'only the owner can delete verified actuals' using errcode = '42501';
  end if;
  if new.verified_at is distinct from old.verified_at or new.verified_by is distinct from old.verified_by
     or (new.job_id, new.area_id, new.product, new.actual_material_qty, new.actual_material_unit, new.actual_hours,
         new.actual_removal_hours, new.actual_crew_size, new.actual_drive_minutes, new.actual_days, new.notes)
        is distinct from
        (old.job_id, old.area_id, old.product, old.actual_material_qty, old.actual_material_unit, old.actual_hours,
         old.actual_removal_hours, old.actual_crew_size, old.actual_drive_minutes, old.actual_days, old.notes) then
    raise exception 'these actuals are verified; only the owner can unverify or change them' using errcode = '42501';
  end if;
  return new;
end $$;

-- sync_job_actuals: same body as Phase 2, with the store check on the job.
create or replace function sync_job_actuals(p_mutation_id uuid, p_job_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb; v_by uuid; v_result jsonb; v_loc uuid;
  v_areas uuid[]; v_item jsonb; r job_actuals; v_base int; v_cur job_actuals; v_new job_actuals;
  v_saved jsonb := '[]'; v_conflicts jsonb := '[]';
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not has_role('owner', 'office', 'crew') then raise exception 'this role cannot enter actuals' using errcode = '42501'; end if;
  select result, profile_id into v_prev, v_by from sync_mutations where mutation_id = p_mutation_id;
  if found then
    if v_by is distinct from auth.uid() then
      return jsonb_build_object('status', 'rejected', 'error', 'This change was saved by someone else signed in on this phone.');
    end if;
    return v_prev;
  end if;
  select location_id into v_loc from jobs where id = p_job_id;
  if v_loc is null or not (has_location_role(v_loc, 'owner', 'office') or is_crew_job(p_job_id)) then
    raise exception 'job not found' using errcode = '42501';
  end if;
  if job_actuals_locked(p_job_id) then
    return jsonb_build_object('status', 'locked');
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]')) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct area_id), '{}') into v_areas from crew_job_view where job_id = p_job_id;

  for v_item in select value from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    r := jsonb_populate_record(null::job_actuals, v_item);
    if r.area_id is not null and not (r.area_id = any(v_areas)) then
      raise exception 'area % is not part of this job', r.area_id using errcode = '22023';
    end if;
    v_base := (v_item->>'base_row_version')::int;

    select * into v_cur from job_actuals
     where job_id = p_job_id and area_id is not distinct from r.area_id and product is not distinct from r.product
     for update;
    if found then
      if v_base is distinct from v_cur.row_version then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'id', v_cur.id, 'area_id', v_cur.area_id, 'product', v_cur.product, 'row_version', v_cur.row_version,
          'actual_material_qty', v_cur.actual_material_qty, 'actual_material_unit', v_cur.actual_material_unit,
          'actual_hours', v_cur.actual_hours, 'actual_crew_size', v_cur.actual_crew_size,
          'actual_drive_minutes', v_cur.actual_drive_minutes, 'actual_days', v_cur.actual_days,
          'notes', v_cur.notes, 'entered_by', v_cur.entered_by, 'entered_at', v_cur.entered_at));
        continue;
      end if;
      update job_actuals set
        actual_material_qty  = r.actual_material_qty,
        actual_material_unit = r.actual_material_unit,
        actual_hours         = r.actual_hours,
        actual_crew_size     = r.actual_crew_size,
        actual_drive_minutes = r.actual_drive_minutes,
        actual_days          = r.actual_days,
        notes                = r.notes,
        entered_by           = auth.uid(),
        entered_at           = now()
      where id = v_cur.id
      returning * into v_new;
    else
      insert into job_actuals (id, job_id, area_id, product, actual_material_qty, actual_material_unit, actual_hours,
                               actual_crew_size, actual_drive_minutes, actual_days, notes, entered_by, location_id)
      values (r.id, p_job_id, r.area_id, r.product, r.actual_material_qty, r.actual_material_unit, r.actual_hours,
              r.actual_crew_size, r.actual_drive_minutes, r.actual_days, r.notes, auth.uid(), v_loc)
      returning * into v_new;
    end if;
    v_saved := v_saved || jsonb_build_array(jsonb_build_object(
      'id', v_new.id, 'area_id', v_new.area_id, 'product', v_new.product, 'row_version', v_new.row_version));
  end loop;

  v_result := jsonb_build_object('status', 'applied', 'rows', jsonb_array_length(v_saved),
                                 'saved', v_saved, 'conflicts', v_conflicts);
  insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
  values (p_mutation_id, auth.uid(), 'job_actuals', p_job_id, v_result);
  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Pricing sets: promote, roll back and reject within one store
-- -----------------------------------------------------------------------------
drop function if exists may_manage_coefficients();
create or replace function may_manage_coefficients(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_location_role(p_location, 'owner')
      or coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated')
$$;
revoke all on function may_manage_coefficients(uuid) from public, anon;
grant execute on function may_manage_coefficients(uuid) to authenticated, service_role;

create or replace function promote_coefficient_set(p_set_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old uuid; v_loc uuid;
begin
  select location_id into v_loc from coefficient_sets where id = p_set_id;
  if not may_manage_coefficients(v_loc) then
    raise exception 'only owner may promote coefficient sets' using errcode = '42501';
  end if;
  if not exists (select 1 from coefficient_sets where id = p_set_id and status = 'candidate') then
    raise exception 'set % is not a candidate', p_set_id;
  end if;
  select id into v_old from coefficient_sets where status = 'active' and location_id = v_loc for update;

  update coefficient_sets set status = 'superseded' where id = v_old;
  update coefficient_sets set status = 'active', activated_at = now(), activated_by = auth.uid()
   where id = p_set_id;

  insert into coefficient_changes (from_set_id, to_set_id, kind, product, job_type, access_level,
                                   old_value, new_value, pct_change, reason, actor_id, location_id)
  select v_old, p_set_id, n.kind, n.product, n.job_type, n.access_level,
         o.value, n.value,
         case when o.value is null or o.value = 0 then null else (n.value - o.value) / o.value end,
         p_reason, auth.uid(), v_loc
    from coefficients n
    left join coefficients o
      on o.set_id = v_old and o.kind = n.kind
     and o.product      is not distinct from n.product
     and o.job_type     is not distinct from n.job_type
     and o.access_level is not distinct from n.access_level
   where n.set_id = p_set_id
     and (o.value is null or o.value <> n.value);

  perform log_event('coefficients.promote', 'coefficient_sets', p_set_id::text,
                    jsonb_build_object('from', v_old, 'reason', p_reason));
end $$;

create or replace function rollback_coefficient_set(p_target_set_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_new uuid; v_loc uuid;
begin
  select location_id into v_loc from coefficient_sets where id = p_target_set_id;
  if v_loc is null or not may_manage_coefficients(v_loc) then
    raise exception 'only owner may roll back coefficient sets' using errcode = '42501';
  end if;
  insert into coefficient_sets (status, parent_id, source, notes, created_by, location_id)
  values ('candidate', p_target_set_id, 'rollback', p_reason, auth.uid(), v_loc)
  returning id into v_new;

  insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value,
                            lower_bound, upper_bound, std_error, sample_size, n_eff, confidence, was_clamped,
                            was_step_limited)
  select v_new, kind, product, job_type, access_level, value, prior_value,
         lower_bound, upper_bound, std_error, sample_size, n_eff, confidence, was_clamped, was_step_limited
    from coefficients where set_id = p_target_set_id;

  perform promote_coefficient_set(v_new, 'rollback: ' || p_reason);
  return v_new;
end $$;

create or replace function reject_coefficient_set(p_set_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  select location_id into v_loc from coefficient_sets where id = p_set_id;
  if not may_manage_coefficients(v_loc) then
    raise exception 'only owner may reject coefficient sets' using errcode = '42501';
  end if;
  update coefficient_sets
     set status = 'rejected', notes = concat_ws(E'\n', notes, 'Rejected: ' || p_reason)
   where id = p_set_id and status = 'candidate';
  if not found then raise exception 'set % is not a candidate', p_set_id; end if;
  perform log_event('coefficients.reject', 'coefficient_sets', p_set_id::text, jsonb_build_object('reason', p_reason));
end $$;

-- -----------------------------------------------------------------------------
-- Offline estimate sync: the store comes from the estimate (or, for a new estimate, the store
-- the phone was pricing for, which must be one the caller estimates in), never from a default.
-- Same body as Phase 2 otherwise.
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
  v_loc    uuid;
  v_state  text;
  v_prev   jsonb;
  v_cur    record;
  v_exists boolean;
  v_before jsonb;
  v_after  jsonb;
  v_rv     int;
  v_result jsonb;
  v_acks   jsonb;
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

  select id, row_version, status, client_doc, location_id into v_cur from estimates where id = v_id for update;
  v_exists := found;

  if v_exists then
    v_loc := v_cur.location_id;
  else
    v_loc := coalesce(nullif(v_est->>'location_id', '')::uuid, default_location_id());
  end if;
  if v_loc is null or not has_location_role(v_loc, 'owner', 'office', 'estimator') then
    raise exception 'you do not estimate for that location' using errcode = '42501';
  end if;

  if v_exists and v_cur.row_version is distinct from p_base_row_version then
    return jsonb_build_object('status', 'conflict', 'row_version', v_cur.row_version, 'server_doc', v_cur.client_doc);
  end if;
  if v_exists and v_cur.status = 'signed' then
    return jsonb_build_object('status', 'locked', 'row_version', v_cur.row_version, 'server_doc', v_cur.client_doc);
  end if;

  -- customer -----------------------------------------------------------------
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
  where c.id = (v_cust->>'id')::uuid and c.location_id = v_loc;
  if not found then
    insert into customers (id, first_name, last_name, email, phone, sms_consent, sms_consent_at, email_consent,
                           created_by, location_id)
    values ((v_cust->>'id')::uuid, v_cust->>'first_name', v_cust->>'last_name',
            nullif(v_cust->>'email', '')::citext, nullif(v_cust->>'phone', ''),
            coalesce((v_cust->>'sms_consent')::boolean, false),
            case when coalesce((v_cust->>'sms_consent')::boolean, false) then now() end,
            coalesce((v_cust->>'email_consent')::boolean, true), auth.uid(), v_loc);
  end if;

  -- property (a blank state is the store's state) ----------------------------
  select state into v_state from locations where id = v_loc;
  insert into properties as p (id, customer_id, street, city, state, zip, year_built, utility, home_type, location_id)
  values ((v_prop->>'id')::uuid, (v_cust->>'id')::uuid, v_prop->>'street', v_prop->>'city',
          coalesce(nullif(v_prop->>'state', ''), v_state), v_prop->>'zip',
          (v_prop->>'year_built')::int, nullif(v_prop->>'utility', ''), nullif(v_prop->>'home_type', ''), v_loc)
  on conflict (id) do update set
    street = excluded.street, city = excluded.city, state = excluded.state, zip = excluded.zip,
    year_built = excluded.year_built, utility = excluded.utility, home_type = excluded.home_type
  where p.customer_id = excluded.customer_id;

  -- estimate -----------------------------------------------------------------
  select coalesce(jsonb_object_agg(tier, price), '{}') into v_before from estimate_options where estimate_id = v_id;

  insert into estimates as e (id, customer_id, property_id, estimator_id, status, coefficient_set_id,
                              pricing_snapshot, pricing_snapshot_hash, drive_minutes_est, crew_id, selected_tier,
                              model_total_price, notes, priced_offline, client_created_at, client_doc, location_id)
  values (v_id, (v_cust->>'id')::uuid, (v_prop->>'id')::uuid, auth.uid(),
          (v_est->>'status')::estimate_status, (v_est->>'coefficient_set_id')::uuid,
          v_est->'pricing_snapshot', v_est->>'pricing_snapshot_hash', (v_est->>'drive_minutes_est')::numeric,
          (v_est->>'crew_id')::uuid, (v_est->>'selected_tier')::tier_code, (v_est->>'model_total_price')::numeric,
          v_est->>'notes', coalesce((v_est->>'priced_offline')::boolean, false),
          (v_est->>'client_created_at')::timestamptz, v_est->'client_doc', v_loc)
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
  select coalesce(jsonb_object_agg(flag_key, jsonb_build_object('note', ack_note, 'by', acknowledged_by, 'at', acknowledged_at)), '{}')
    into v_acks from deviation_flags where estimate_id = v_id and flag_key is not null and ack_note is not null;
  delete from deviation_flags where estimate_id = v_id;
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
                              unit_cost, cost, design_qty, model_qty, model_hours, model_cost, is_overridden,
                              override_reason, line_key, sort_order)
  select l.id, (o->>'id')::uuid, l.area_id, l.kind, l.product, l.material_id, l.description, l.qty, l.unit, l.hours,
         l.unit_cost, l.cost, l.design_qty, l.model_qty, l.model_hours, l.model_cost, coalesce(l.is_overridden, false),
         l.override_reason, l.line_key, coalesce(l.sort_order, 0)
    from jsonb_array_elements(coalesce(p_payload->'options', '[]')) o,
         jsonb_populate_recordset(null::estimate_lines, coalesce(o->'lines', '[]')) l;

  insert into deviation_flags (estimate_id, option_id, line_id, metric, estimator_value, model_value, pct_diff, reasons,
                               flag_key, tier, ack_note, acknowledged_by, acknowledged_at)
  select v_id, o.id, l.id, f->>'metric', (f->>'estimator_value')::numeric, (f->>'model_value')::numeric,
         (f->>'pct_diff')::numeric, coalesce(f->'reasons', '[]'), f->>'flag_key', (f->>'tier')::tier_code,
         nullif(f->>'ack_note', ''),
         case when nullif(f->>'ack_note', '') is null then null
              when v_acks->(f->>'flag_key')->>'note' = f->>'ack_note' then (v_acks->(f->>'flag_key')->>'by')::uuid
              else auth.uid() end,
         case when nullif(f->>'ack_note', '') is null then null
              when v_acks->(f->>'flag_key')->>'note' = f->>'ack_note' then (v_acks->(f->>'flag_key')->>'at')::timestamptz
              else now() end
    from jsonb_array_elements(coalesce(p_payload->'flags', '[]')) f
    left join estimate_options o on o.estimate_id = v_id and o.tier = (f->>'tier')::tier_code
    left join lateral (select el.id from estimate_lines el
                        where el.option_id = o.id and el.line_key = f->>'line_key' limit 1) l on true;

  select coalesce(jsonb_object_agg(tier, price), '{}') into v_after from estimate_options where estimate_id = v_id;
  if v_before is distinct from v_after then
    perform log_event('estimate.price_change', 'estimates', v_id::text,
                      jsonb_build_object('before', v_before, 'after', v_after,
                                         'overrides', v_est->'client_doc'->'overrides',
                                         'line_overrides', v_est->'client_doc'->'lineOverrides',
                                         'pricing_snapshot_hash', v_est->>'pricing_snapshot_hash'));
  end if;

  v_result := jsonb_build_object('status', 'applied', 'row_version', v_rv);
  insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
  values (p_mutation_id, auth.uid(), 'estimate', v_id, v_result);
  return v_result;
end $$;

revoke all on function sync_upsert_estimate(uuid, int, jsonb) from public, anon;
grant execute on function sync_upsert_estimate(uuid, int, jsonb) to authenticated;
