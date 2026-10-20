-- =============================================================================
-- Phase 2: actuals capture + learning loop
--   * jobs are created automatically when a quote is signed
--   * crews change job status only through crew_set_job_status(); they enter actuals
--     through sync_job_actuals() and can never touch verified rows
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
create or replace function tg_quote_signed_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'signed' and old.status is distinct from 'signed' then
    insert into jobs (quote_id, estimate_id, crew_id, status, revenue, scheduled_days)
    select new.id, new.estimate_id, e.crew_id, 'scheduled', new.signed_price,
           (select o.crew_days from estimate_options o where o.estimate_id = new.estimate_id and o.tier = new.signed_tier)
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

-- Crews may only touch their own, unverified actuals.
drop policy if exists actuals_crew on job_actuals;
create policy actuals_crew on job_actuals for all
  using (has_role('crew') and verified_at is null
         and exists (select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
                      where j.id = job_id and cm.profile_id = auth.uid()))
  with check (has_role('crew') and entered_by = auth.uid() and verified_by is null and verified_at is null
              and exists (select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
                           where j.id = job_id and cm.profile_id = auth.uid()));

-- One actuals row per job x area x product (area/product null = job-level: drive, days, crew size).
create unique index job_actuals_natural_uq on job_actuals (job_id, area_id, product) nulls not distinct;

-- Crew view v2: adds status timestamps and the signed scope (quantities and hours, no prices).
drop view if exists crew_job_view;
create view crew_job_view with (security_barrier = true) as
select j.id as job_id, j.status, j.scheduled_start, j.scheduled_days, j.crew_id, j.started_at, j.completed_at,
       p.street, p.city, p.zip, p.lat, p.lng,
       c.first_name, c.last_name, c.phone,
       a.id as area_id, a.name as area_name, a.job_type, a.sqft, a.current_r, a.target_r,
       a.access_level, a.removal_needed, a.prep_notes, a.hazards, a.hazard_disposition, a.sort_order as area_sort,
       q.signed_tier,
       (select jsonb_agg(jsonb_build_object('product', l.product, 'kind', l.kind, 'description', l.description,
                                            'qty', l.qty, 'unit', l.unit, 'hours', l.hours) order by l.sort_order)
          from estimate_options o join estimate_lines l on l.option_id = o.id
         where o.estimate_id = j.estimate_id and o.tier = q.signed_tier
           and l.area_id = a.id and l.kind in ('material', 'labor', 'removal')) as scope
from jobs j
join quotes q          on q.id = j.quote_id
join estimates e       on e.id = j.estimate_id
join properties p      on p.id = e.property_id
join customers c       on c.id = e.customer_id
join estimate_areas a  on a.estimate_id = e.id
where has_role('owner', 'office')
   or exists (select 1 from crew_members cm where cm.crew_id = j.crew_id and cm.profile_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Crew actuals sync (offline outbox). Idempotent on p_mutation_id; RLS applies.
-- -----------------------------------------------------------------------------
create or replace function sync_job_actuals(p_mutation_id uuid, p_job_id uuid, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_prev jsonb; v_result jsonb; v_n int;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not has_role('owner', 'office', 'crew') then raise exception 'this role cannot enter actuals' using errcode = '42501'; end if;
  select result into v_prev from sync_mutations where mutation_id = p_mutation_id;
  if found then return v_prev; end if;
  if not exists (select 1 from jobs where id = p_job_id) then
    raise exception 'job not found' using errcode = '42501';
  end if;
  if exists (select 1 from job_actuals where job_id = p_job_id and verified_at is not null) then
    return jsonb_build_object('status', 'locked');
  end if;

  insert into job_actuals as ja (id, job_id, area_id, product, actual_material_qty, actual_material_unit, actual_hours,
                                 actual_crew_size, actual_drive_minutes, actual_days, actual_material_cost,
                                 actual_labor_cost, actual_other_cost, notes, entered_by)
  select r.id, p_job_id, r.area_id, r.product, r.actual_material_qty, r.actual_material_unit, r.actual_hours,
         r.actual_crew_size, r.actual_drive_minutes, r.actual_days, r.actual_material_cost,
         r.actual_labor_cost, r.actual_other_cost, r.notes, auth.uid()
    from jsonb_populate_recordset(null::job_actuals, coalesce(p_rows, '[]')) r
  on conflict (id) do update set
    actual_material_qty  = excluded.actual_material_qty,
    actual_material_unit = excluded.actual_material_unit,
    actual_hours         = excluded.actual_hours,
    actual_crew_size     = excluded.actual_crew_size,
    actual_drive_minutes = excluded.actual_drive_minutes,
    actual_days          = excluded.actual_days,
    -- costs come from the office; a crew sync never clears them
    actual_material_cost = coalesce(excluded.actual_material_cost, ja.actual_material_cost),
    actual_labor_cost    = coalesce(excluded.actual_labor_cost, ja.actual_labor_cost),
    actual_other_cost    = coalesce(excluded.actual_other_cost, ja.actual_other_cost),
    notes                = excluded.notes,
    entered_by           = auth.uid(),
    entered_at           = now()
  where ja.job_id = p_job_id and ja.verified_at is null;
  get diagnostics v_n = row_count;

  v_result := jsonb_build_object('status', 'applied', 'rows', v_n);
  insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
  values (p_mutation_id, auth.uid(), 'job_actuals', p_job_id, v_result);
  return v_result;
end $$;
revoke all on function sync_job_actuals(uuid, uuid, jsonb) from public, anon;
grant execute on function sync_job_actuals(uuid, uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Coefficient candidates: owner may reject (promote/rollback exist since init)
-- -----------------------------------------------------------------------------
create or replace function reject_coefficient_set(p_set_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_role('owner') then
    raise exception 'only owner may reject coefficient sets' using errcode = '42501';
  end if;
  update coefficient_sets
     set status = 'rejected', notes = concat_ws(E'\n', notes, 'Rejected: ' || p_reason)
   where id = p_set_id and status = 'candidate';
  if not found then raise exception 'set % is not a candidate', p_set_id; end if;
  perform log_event('coefficients.reject', 'coefficient_sets', p_set_id::text, jsonb_build_object('reason', p_reason));
end $$;
revoke all on function reject_coefficient_set(uuid, text) from public, anon;
grant execute on function reject_coefficient_set(uuid, text) to authenticated;

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
  )
  update estimates e set status = 'expired', decided_at = coalesce(e.decided_at, now())
   where e.id in (select estimate_id from x) and e.status in ('sent', 'viewed');
  get diagnostics v_n = row_count;
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
