-- =============================================================================
-- Phase 2: actuals capture + learning loop
--   * jobs are created automatically when a quote is signed, from what the customer signed
--   * crews change job status only through crew_set_job_status(); they read actuals through
--     crew_actuals_view (no costs) and write them only through sync_job_actuals(), which never
--     touches costs, exclusions or verified rows
--   * verified actuals are frozen for everyone but the owner
--   * coefficient promotion, rollback and rejection: owner or the nightly job only
--   * estimator line overrides (qty/hours with a reason) and server-computed deviation
--     flags with estimator acknowledgements, stored on every sync
--   * coefficient candidates can be rejected; stale quotes expire nightly
-- =============================================================================

-- Line overrides and stable line identity across re-syncs.
alter table estimate_lines add column override_reason text;
alter table estimate_lines add column line_key text;
create index estimate_lines_key_idx on estimate_lines (option_id, line_key);

-- Deviation flags keyed so acknowledgements survive re-syncs.
alter table deviation_flags add column flag_key text;
alter table deviation_flags add column tier tier_code;

-- Win/loss bookkeeping.
alter table estimates add column lost_reason text;
alter table estimates add column decided_at timestamptz;

-- The dashboard shows when the ±step limit held a coefficient back.
alter table coefficients add column was_step_limited boolean not null default false;

-- Learning settings used by the win model.
update app_settings
   set value = value || '{"win_half_life_days": 365, "win_l2": 1.0, "price_recommendations": true}'::jsonb
 where key = 'learning';

-- The phase-0 view joined the wrong lines (model hours live on labor lines). Observations are
-- now extracted in TypeScript from the frozen quote snapshot (lib/learning/observations.ts).
drop view if exists learning_observations;

-- -----------------------------------------------------------------------------
-- Jobs from signed quotes
-- -----------------------------------------------------------------------------
-- Crew days come from the signed quote's frozen options: the estimate may have been revised
-- after the quote was sent. (The live option is only a fallback for snapshots without it.)
create or replace function tg_quote_signed_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'signed' and old.status is distinct from 'signed' then
    insert into jobs (quote_id, estimate_id, crew_id, status, revenue, scheduled_days)
    select new.id, new.estimate_id, e.crew_id, 'scheduled', new.signed_price,
           coalesce((select (o->>'crewDays')::numeric from jsonb_array_elements(coalesce(new.snapshot->'options', '[]')) o
                      where o->>'tier' = new.signed_tier::text limit 1),
                    (select o.crew_days from estimate_options o where o.estimate_id = new.estimate_id and o.tier = new.signed_tier))
      from estimates e where e.id = new.estimate_id
    on conflict (quote_id) do nothing;
    update estimates set decided_at = coalesce(decided_at, now()) where id = new.estimate_id;
  end if;
  return new;
end $$;

create trigger quotes_signed_job after update of status on quotes
for each row execute function tg_quote_signed_job();

-- Backfill jobs for quotes signed before this migration.
insert into jobs (quote_id, estimate_id, crew_id, status, revenue)
select q.id, q.estimate_id, e.crew_id, 'scheduled', q.signed_price
  from quotes q join estimates e on e.id = q.estimate_id
 where q.status = 'signed'
on conflict (quote_id) do nothing;

-- -----------------------------------------------------------------------------
-- Crew access: status changes through a function (crews must not edit revenue, dates, crew)
-- -----------------------------------------------------------------------------
drop policy if exists jobs_crew_update on jobs;

create or replace function crew_set_job_status(p_job_id uuid, p_status job_status)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jobs;
begin
  select * into v from jobs where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if not (has_role('owner', 'office')
          or (has_role('crew') and exists (select 1 from crew_members cm
                                            where cm.crew_id = v.crew_id and cm.profile_id = auth.uid()))) then
    raise exception 'not your job' using errcode = '42501';
  end if;
  if not ((v.status = 'scheduled' and p_status = 'in_progress')
       or (v.status = 'in_progress' and p_status in ('completed', 'scheduled'))
       or (v.status = 'completed' and p_status = 'in_progress' and has_role('owner', 'office'))
       or (p_status = 'cancelled' and has_role('owner', 'office'))) then
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
revoke all on function crew_set_job_status(uuid, job_status) from public, anon;
grant execute on function crew_set_job_status(uuid, job_status) to authenticated;

-- Is this job assigned to one of the caller's crews, and is the caller an active crew member?
-- SECURITY DEFINER so crews never need to read the jobs table itself (it carries revenue = the
-- signed price). has_role() also checks profiles.active: a deactivated or re-roled user keeps
-- their crew_members rows but loses access.
create or replace function is_crew_job(p_job_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('crew') and exists (select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
                                       where j.id = p_job_id and cm.profile_id = auth.uid())
$$;
revoke all on function is_crew_job(uuid) from public, anon;
grant execute on function is_crew_job(uuid) to authenticated;

-- Has the office verified any actuals for this job? Then the crew can no longer change them.
create or replace function job_actuals_locked(p_job_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from job_actuals where job_id = p_job_id and verified_at is not null)
$$;
revoke all on function job_actuals_locked(uuid) from public, anon;
grant execute on function job_actuals_locked(uuid) to authenticated;

-- Crews read their jobs only through crew_job_view (no prices). The Phase 1 policy let a crew
-- member select jobs.revenue directly.
drop policy if exists jobs_crew_read on jobs;

-- Crews get no direct access to job_actuals: the rows carry the office's invoice and payroll
-- costs and the learning exclusions. They read through crew_actuals_view and write only through
-- sync_job_actuals() below. Likewise crews no longer read crews (blended labor cost).
drop policy if exists actuals_crew on job_actuals;
drop policy if exists actuals_crew_read on job_actuals;
drop policy if exists crews_crew_read on crews;

-- One actuals row per job x area x product (area/product null = job-level: drive, days, crew size).
create unique index job_actuals_natural_uq on job_actuals (job_id, area_id, product) nulls not distinct;

-- Crew view v2: status timestamps and the signed scope (quantities and hours, no prices), taken
-- from the quote the customer signed: the estimate may have been revised after the quote was sent.
-- Areas come from the quote's frozen input (older quotes without it: the estimate's areas); prep
-- notes and hazards stay live so the office can add them after signing.
drop view if exists crew_job_view;
create view crew_job_view with (security_barrier = true) as
with signed as (
  select j.id, j.status, j.scheduled_start, j.scheduled_days, j.crew_id, j.started_at, j.completed_at, j.estimate_id,
         q.signed_tier, q.snapshot,
         (select o from jsonb_array_elements(coalesce(q.snapshot->'options', '[]')) o
           where o->>'tier' = q.signed_tier::text limit 1) as opt
    from jobs j
    join quotes q on q.id = j.quote_id
   where has_role('owner', 'office')
      or (has_role('crew') and exists (select 1 from crew_members cm where cm.crew_id = j.crew_id and cm.profile_id = auth.uid()))
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
         where l.v->>'areaId' = sa.area_id::text and l.v->>'kind' in ('material', 'labor', 'removal')) as scope
from signed s
join estimates e            on e.id = s.estimate_id
join properties p           on p.id = e.property_id
join customers c            on c.id = e.customer_id
join signed_areas sa        on sa.job_id = s.id
left join estimate_areas a  on a.id = sa.area_id;

-- What the crew app reads of the actuals: quantities, hours and notes of the crew's own jobs
-- (verified rows too, so the phone knows the job is locked), never costs or learning exclusions.
-- row_version is the base a phone sends back with an edit (see sync_job_actuals).
create view crew_actuals_view with (security_barrier = true) as
select a.id, a.job_id, a.area_id, a.product, a.actual_material_qty, a.actual_material_unit, a.actual_hours,
       a.actual_crew_size, a.actual_drive_minutes, a.actual_days, a.notes, a.entered_by, a.entered_at,
       a.verified_at, a.row_version
  from job_actuals a
 where has_role('owner', 'office') or is_crew_job(a.job_id);

-- Verified actuals feed learning. Only the owner may unverify them, delete them, or change their
-- quantities, hours or notes; the office may still add costs and exclude a row from learning.
-- (No signed-in user: migrations, the service role.)
create or replace function tg_job_actuals_frozen() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or has_role('owner') or old.verified_at is null then
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
create trigger job_actuals_frozen before update or delete on job_actuals
for each row execute function tg_job_actuals_frozen();

-- -----------------------------------------------------------------------------
-- Crew actuals sync (offline outbox). Idempotent on p_mutation_id. SECURITY DEFINER with its own
-- checks, because crews have no direct access to job_actuals (see above).
--   p_rows: the rows the phone changed: [{id, area_id, product, actual_material_qty,
--           actual_material_unit, actual_hours, actual_crew_size, actual_drive_minutes, actual_days,
--           notes, base_row_version}]. base_row_version is the row_version the phone last saw for
--           that job x area x product (null: it saw no row).
--   A row that changed on the server since then (the office, another phone) is not written; it
--   comes back under 'conflicts' with the server's values for the phone to merge. Costs, learning
--   exclusions and verification are never taken from the phone.
--   Result: {status: 'applied', rows, saved: [{id, area_id, product, row_version}], conflicts: [...]}
--           {status: 'locked'} once the office has verified any row of the job
--           {status: 'rejected', error} for a mutation id another user already used
-- -----------------------------------------------------------------------------
drop function if exists sync_job_actuals(uuid, uuid, jsonb);
create function sync_job_actuals(p_mutation_id uuid, p_job_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb; v_by uuid; v_result jsonb;
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
  if not (has_role('owner', 'office') or is_crew_job(p_job_id)) then
    raise exception 'job not found' using errcode = '42501';
  end if;
  if job_actuals_locked(p_job_id) then
    return jsonb_build_object('status', 'locked');
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]')) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  -- The job's areas as the customer signed them (crew_job_view).
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
                               actual_crew_size, actual_drive_minutes, actual_days, notes, entered_by)
      values (r.id, p_job_id, r.area_id, r.product, r.actual_material_qty, r.actual_material_unit, r.actual_hours,
              r.actual_crew_size, r.actual_drive_minutes, r.actual_days, r.notes, auth.uid())
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
revoke all on function sync_job_actuals(uuid, uuid, jsonb) from public, anon;
grant execute on function sync_job_actuals(uuid, uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Coefficient sets: only the owner, or the nightly job, may promote, roll back or reject
-- -----------------------------------------------------------------------------
-- The Phase 1 promote let any call without a signed-in user through, and anon could execute it:
-- anyone with the public API key and a candidate id could switch live pricing. The caller's role
-- (current_setting('role'): anon, authenticated or service_role under PostgREST; 'none' for a
-- direct database session) decides instead: signed-in callers must be the owner; anon never.
create or replace function may_manage_coefficients() returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('owner') or coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated')
$$;
revoke all on function may_manage_coefficients() from public, anon;
grant execute on function may_manage_coefficients() to authenticated, service_role;

create or replace function promote_coefficient_set(p_set_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old uuid;
begin
  if not may_manage_coefficients() then
    raise exception 'only owner may promote coefficient sets' using errcode = '42501';
  end if;
  select id into v_old from coefficient_sets where status = 'active' for update;
  if not exists (select 1 from coefficient_sets where id = p_set_id and status = 'candidate') then
    raise exception 'set % is not a candidate', p_set_id;
  end if;

  update coefficient_sets set status = 'superseded' where id = v_old;
  update coefficient_sets set status = 'active', activated_at = now(), activated_by = auth.uid()
   where id = p_set_id;

  insert into coefficient_changes (from_set_id, to_set_id, kind, product, job_type, access_level,
                                   old_value, new_value, pct_change, reason, actor_id)
  select v_old, p_set_id, n.kind, n.product, n.job_type, n.access_level,
         o.value, n.value,
         case when o.value is null or o.value = 0 then null else (n.value - o.value) / o.value end,
         p_reason, auth.uid()
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
revoke all on function promote_coefficient_set(uuid, text) from public, anon;
grant execute on function promote_coefficient_set(uuid, text) to authenticated, service_role;

create or replace function rollback_coefficient_set(p_target_set_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_new uuid;
begin
  if not may_manage_coefficients() then
    raise exception 'only owner may roll back coefficient sets' using errcode = '42501';
  end if;
  insert into coefficient_sets (status, parent_id, source, notes, created_by)
  values ('candidate', p_target_set_id, 'rollback', p_reason, auth.uid())
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
revoke all on function rollback_coefficient_set(uuid, text) from public, anon;
grant execute on function rollback_coefficient_set(uuid, text) to authenticated, service_role;

create or replace function reject_coefficient_set(p_set_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not may_manage_coefficients() then
    raise exception 'only owner may reject coefficient sets' using errcode = '42501';
  end if;
  update coefficient_sets
     set status = 'rejected', notes = concat_ws(E'\n', notes, 'Rejected: ' || p_reason)
   where id = p_set_id and status = 'candidate';
  if not found then raise exception 'set % is not a candidate', p_set_id; end if;
  perform log_event('coefficients.reject', 'coefficient_sets', p_set_id::text, jsonb_build_object('reason', p_reason));
end $$;
revoke all on function reject_coefficient_set(uuid, text) from public, anon;
grant execute on function reject_coefficient_set(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Nightly: expire quotes past their date (service role only)
-- -----------------------------------------------------------------------------
create or replace function expire_stale_quotes() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with x as (
    update quotes set status = 'expired'
     where status in ('sent', 'viewed') and expires_at < now()
    returning id, estimate_id
  ), ev as (
    insert into quote_events (quote_id, event, meta) select id, 'expired', '{}'::jsonb from x
  ), est as (
    update estimates e set status = 'expired', decided_at = coalesce(e.decided_at, now())
     where e.id in (select estimate_id from x) and e.status in ('sent', 'viewed')
  )
  select count(*) into v_n from x;
  return v_n;
end $$;
revoke all on function expire_stale_quotes() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Offline estimate sync v2: line overrides, line keys, deviation flags + acknowledgements
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
  -- Keep who acknowledged which deviation, and when, across re-syncs of the same note.
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

  -- deviation flags: computed by the server from the model on every sync; notes come from the estimator
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
