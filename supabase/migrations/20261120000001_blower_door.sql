-- =============================================================================
-- Blower door tests (the Blower Door Air Seal Calculator, app/field/blower-door)
--
--   * app_settings.blower_door: the franchise's rebate programs (tiers, cost cap, ventilation
--     rebate, source and effective date, paperwork), the gauge and the default flow exponent and
--     zone N-factor. Owner-edited on the Rebate programs page (app/admin/rebates). This franchise's
--     two programs are seeded below, only when the setting is absent. Crews (who read no other
--     setting) may read this one key: the tool works on their phones too.
--   * blower_door_tests: each test-in and test-out reading taken on an estimate (estimator) or a
--     job (crew lead, office, owner), with the CFM50 worked out on the phone at the time and the
--     program as it was then. Readings are never edited: a retest is a new reading and the newest
--     of each kind counts. The CFM50 must match the reading and its exponent.
--   * Who sees a reading is who sees its job or estimate: owner and office all; an estimator the
--     readings of their own estimates; a crew member only the readings of their crew's jobs (and
--     the test-in taken on the estimate those jobs came from), and only through
--     blower_door_context(), which leaves out the air sealing price: crews never see prices.
--   * sync_blower_door_test(): the phone's offline outbox, and the only way a reading gets in.
--     Idempotent on the mutation id and on the reading's own id, so a reading sent twice is stored
--     once. The program kept with a reading is the franchise's own (app_settings), by its key.
--   * blower_door_context(): what the tool shows for a job or an estimate (who it is for and its
--     saved readings), with the same access rules.
--
-- Additive only: a new setting row, a new read policy on app_settings, a new table and new
-- functions. Nothing existing changes, so the live app works the same with this applied.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
insert into app_settings (key, value, description) values
  ('blower_door', $json${
    "gauge": "Retrotec Model 5000",
    "flow_exponent": 0.65,
    "n_factor": 19,
    "programs": [
      {
        "key": "home_performance",
        "name": "Energize Delaware Home Performance with ENERGY STAR",
        "label": "Home Performance",
        "tiers": [
          {"reduction_pct": 20, "rebate": 900},
          {"reduction_pct": 30, "rebate": 1300},
          {"reduction_pct": 40, "rebate": 1800}
        ],
        "cost_cap_pct": 75,
        "mech_vent_rebate_cap": 400,
        "source": "Energize Delaware rebate schedule",
        "effective_date": "2024-11-01",
        "paperwork": [
          "Photo of the gauge showing CFM, before and after, with the customer's name and address visible in the shot",
          "Combustion appliance zone (CAZ) test if the home has combustion appliances",
          "Health and safety inspection",
          "Test Out Form signed by the customer"
        ],
        "paperwork_source": "Participating Contractors Operations Manual (Oct 2025)"
      },
      {
        "key": "assisted",
        "name": "Energize Delaware Assisted Home Performance",
        "label": "Assisted",
        "tiers": [
          {"reduction_pct": 20, "rebate": 1100},
          {"reduction_pct": 30, "rebate": 1500},
          {"reduction_pct": 40, "rebate": 2000}
        ],
        "cost_cap_pct": 75,
        "mech_vent_rebate_cap": 600,
        "source": "Energize Delaware rebate schedule",
        "effective_date": "2024-11-01",
        "paperwork": [
          "Photo of the gauge showing CFM, before and after, with the customer's name and address visible in the shot",
          "Combustion appliance zone (CAZ) test if the home has combustion appliances",
          "Health and safety inspection",
          "Test Out Form signed by the customer"
        ],
        "paperwork_source": "Participating Contractors Operations Manual (Oct 2025)"
      }
    ]
  }$json$::jsonb, 'Blower door tool: rebate programs, the gauge and its defaults (Rebate programs page)')
on conflict (key) do nothing;

-- Crews read no setting but this one (the others carry margins and costs).
drop policy if exists app_settings_crew_blower_door on app_settings;
create policy app_settings_crew_blower_door on app_settings for select
  using (key = 'blower_door' and has_role('crew'));

-- -----------------------------------------------------------------------------
-- Readings
-- -----------------------------------------------------------------------------
create table if not exists blower_door_tests (
  id               uuid primary key,                                 -- client-generated (offline)
  -- Every reading belongs to an estimate; one taken on a job also names the job (the job's estimate).
  estimate_id      uuid not null references estimates(id) on delete cascade,
  job_id           uuid references jobs(id) on delete cascade,
  kind             text not null check (kind in ('test_in', 'test_out')),
  -- The gauge reading as typed (the sign dropped) and the exponent it was converted with.
  cfm              numeric(10,2) not null check (cfm > 0 and cfm <= 50000),
  pa               numeric(6,2)  not null check (pa >= 1 and pa <= 100),
  exponent         numeric(4,3)  not null check (exponent >= 0.5 and exponent <= 1),
  cfm50            numeric(10,2) not null check (cfm50 > 0),
  -- The program chosen, and the program as it was when the reading was taken (its settings JSON).
  program_key      text check (char_length(program_key) <= 40),
  program          jsonb check (program is null or jsonb_typeof(program) = 'object'),
  -- The inputs given with the reading, where given.
  air_sealing_cost numeric(12,2) check (air_sealing_cost > 0 and air_sealing_cost <= 1000000),
  bas_audit        numeric(10,1) check (bas_audit >= 1 and bas_audit <= 100000),
  volume           numeric(12,1) check (volume >= 500 and volume <= 1000000),
  occupants        int           check (occupants >= 0 and occupants <= 50),
  stories          numeric(2,1)  check (stories in (1, 1.5, 2, 2.5, 3)),
  n_factor         numeric(5,2)  check (n_factor >= 1 and n_factor <= 40),
  -- What the phone showed when it was saved (reduction, tier, rebate, ventilation), for the record.
  result           jsonb check (result is null or jsonb_typeof(result) = 'object'),
  recorded_by      uuid not null references profiles(id),
  recorded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  -- The CFM50 is CFM × (50 ÷ Pa)^n at the stored exponent (within rounding): never another one.
  constraint blower_door_tests_cfm50_matches check (abs(cfm50 - cfm * power(50.0 / pa, exponent)) <= 1)
);
create index if not exists blower_door_tests_job_idx on blower_door_tests (job_id, recorded_at desc) where job_id is not null;
create index if not exists blower_door_tests_estimate_idx on blower_door_tests (estimate_id, recorded_at desc);

-- A reading taken on a job is on the job's estimate.
create or replace function tg_blower_door_tests_job_estimate() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_est uuid;
begin
  if new.job_id is not null then
    select estimate_id into v_est from jobs where id = new.job_id;
    if not found then
      raise exception 'job % not found', new.job_id using errcode = '23503';
    end if;
    if new.estimate_id is not null and new.estimate_id is distinct from v_est then
      raise exception 'the reading names another estimate than its job' using errcode = '23514';
    end if;
    new.estimate_id := v_est;
  end if;
  return new;
end $$;
drop trigger if exists blower_door_tests_job_estimate on blower_door_tests;
create trigger blower_door_tests_job_estimate before insert on blower_door_tests
for each row execute function tg_blower_door_tests_job_estimate();

drop trigger if exists blower_door_tests_audit on blower_door_tests;
create trigger blower_door_tests_audit after insert or update or delete on blower_door_tests
for each row execute function tg_audit();

-- -----------------------------------------------------------------------------
-- Access: who sees and who records a reading
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER so a crew member's check can look at jobs (which crews cannot read: revenue).

-- Can the caller see the readings of this job (or, with no job, of this estimate)? (A crew member
-- reads them through blower_door_context only: see the read policy below.)
create or replace function can_see_blower_door(p_job_id uuid, p_estimate_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('owner', 'office')
      or (has_role('estimator') and exists (select 1 from estimates e where e.id = p_estimate_id and e.estimator_id = auth.uid()))
      or (p_job_id is not null and is_crew_job(p_job_id))
      or (p_job_id is null and has_role('crew') and exists (
            select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
             where j.estimate_id = p_estimate_id and cm.profile_id = auth.uid()))
$$;
revoke all on function can_see_blower_door(uuid, uuid) from public, anon;
grant execute on function can_see_blower_door(uuid, uuid) to authenticated;

-- Can the caller record a reading on this job (owner, office, the job's crew) or, with no job, on
-- this estimate (owner, office, the estimate's estimator)?
create or replace function can_record_blower_door(p_job_id uuid, p_estimate_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_job_id is not null then
      exists (select 1 from jobs j where j.id = p_job_id and (p_estimate_id is null or j.estimate_id = p_estimate_id))
      and (has_role('owner', 'office') or is_crew_job(p_job_id))
    else
      exists (select 1 from estimates e where e.id = p_estimate_id
                 and (has_role('owner', 'office') or (has_role('estimator') and e.estimator_id = auth.uid())))
  end
$$;
revoke all on function can_record_blower_door(uuid, uuid) from public, anon;
grant execute on function can_record_blower_door(uuid, uuid) to authenticated;

alter table blower_door_tests enable row level security;

-- Production grants every new table to the API roles when it is created (default privileges,
-- review B database-B5), so the readings do not rest on RLS alone (review B database-B4): the public
-- has no privilege on them, and a signed-in user only reads them (through the read policy below).
-- A reading gets in only through sync_blower_door_test(). Revoking again changes nothing.
revoke all on table blower_door_tests from anon;
revoke insert, update, delete, truncate on table blower_door_tests from authenticated;

-- Owner, office and estimators read the table; crews do not (a row carries the air sealing price
-- and what the phone showed): they read their jobs' readings through blower_door_context(), which
-- leaves the price out, as crew_job_view leaves out a job's revenue.
drop policy if exists blower_door_tests_read on blower_door_tests;
create policy blower_door_tests_read on blower_door_tests for select
  using (not has_role('crew') and can_see_blower_door(job_id, estimate_id));

-- No insert, update or delete policies: a reading gets in only through sync_blower_door_test()
-- (which dates it no later than now and keeps the franchise's own program), and stays as it was
-- recorded. A direct insert could have dated a reading in the future, so it stayed the newest for
-- good, with any program and rebate.
drop policy if exists blower_door_tests_insert on blower_door_tests;

-- -----------------------------------------------------------------------------
-- The phone's outbox: store one reading. Idempotent on p_mutation_id and on the reading's id.
--   p_test: {id, job_id, estimate_id, kind, cfm, pa, exponent, cfm50, program_key, program,
--            air_sealing_cost, bas_audit, volume, occupants, stories, n_factor, result, recorded_at}
--   (job_id or estimate_id: a job's estimate comes from the job. The program sent is not kept:
--   the program stored is the franchise's, from app_settings.blower_door by program_key, or none
--   when the franchise has no program with that key.)
--   Result: {status: 'applied', id, recorded_at}
--           {status: 'waiting'}   the estimate has not synced from the phone yet: send again later
--           {status: 'refused', error}   not the caller's job or estimate (any more)
--           {status: 'invalid', error}   values no gauge gives (the table's checks)
--           {status: 'rejected', error}  the mutation or reading id belongs to someone else
-- -----------------------------------------------------------------------------
create or replace function sync_blower_door_test(p_mutation_id uuid, p_test jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb; v_by uuid; v_result jsonb; v_program jsonb;
  r blower_door_tests; v_cur blower_door_tests; v_est uuid; v_at timestamptz;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not has_role('owner', 'office', 'estimator', 'crew') then
    raise exception 'this role cannot record blower door tests' using errcode = '42501';
  end if;
  if p_test is null or jsonb_typeof(p_test) <> 'object' then
    raise exception 'the reading must be an object' using errcode = '22023';
  end if;

  select result, profile_id into v_prev, v_by from sync_mutations where mutation_id = p_mutation_id;
  if found then
    if v_by is distinct from auth.uid() then
      return jsonb_build_object('status', 'rejected', 'error', 'This reading was saved by someone else signed in on this phone.');
    end if;
    return v_prev;
  end if;

  r := jsonb_populate_record(null::blower_door_tests, p_test);
  if r.id is null then raise exception 'the reading needs an id' using errcode = '22023'; end if;

  -- Sent before, but the answer was lost: the reading is already stored.
  select * into v_cur from blower_door_tests where id = r.id;
  if found then
    if v_cur.recorded_by is distinct from auth.uid() then
      return jsonb_build_object('status', 'rejected', 'error', 'This reading was saved by someone else signed in on this phone.');
    end if;
    v_result := jsonb_build_object('status', 'applied', 'id', v_cur.id, 'recorded_at', v_cur.recorded_at);
    insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
    values (p_mutation_id, auth.uid(), 'blower_door_test', v_cur.id, v_result);
    return v_result;
  end if;

  if r.job_id is not null then
    select estimate_id into v_est from jobs where id = r.job_id;
    if not found then
      return jsonb_build_object('status', 'refused', 'error', 'This job is no longer in the office system.');
    end if;
  else
    if r.estimate_id is null then raise exception 'the reading needs a job or an estimate' using errcode = '22023'; end if;
    if not exists (select 1 from estimates where id = r.estimate_id) then
      return jsonb_build_object('status', 'waiting');
    end if;
    v_est := r.estimate_id;
  end if;

  if not can_record_blower_door(r.job_id, v_est) then
    return jsonb_build_object('status', 'refused', 'error',
      case when r.job_id is not null then 'This job is not assigned to your crew.' else 'This estimate is not yours.' end);
  end if;

  -- When it was taken, as the phone says (never in the future).
  v_at := least(coalesce(r.recorded_at, now()), now());

  -- The program as the franchise has it now (never the phone's copy, which anyone could make up).
  select p into v_program
    from app_settings s,
         jsonb_array_elements(case when jsonb_typeof(s.value->'programs') = 'array' then s.value->'programs' else '[]'::jsonb end) p
   where s.key = 'blower_door' and r.program_key is not null and p->>'key' = r.program_key
   limit 1;

  begin
    insert into blower_door_tests (id, estimate_id, job_id, kind, cfm, pa, exponent, cfm50, program_key, program,
                                   air_sealing_cost, bas_audit, volume, occupants, stories, n_factor, result,
                                   recorded_by, recorded_at)
    values (r.id, v_est, r.job_id, r.kind, r.cfm, r.pa, r.exponent, r.cfm50, r.program_key, v_program,
            r.air_sealing_cost, r.bas_audit, r.volume, r.occupants, r.stories, r.n_factor, r.result,
            auth.uid(), v_at)
    returning * into v_cur;
  exception when check_violation or not_null_violation or numeric_value_out_of_range then
    return jsonb_build_object('status', 'invalid', 'error', 'The reading is outside what a gauge can show: check the CFM and the pressure.');
  end;

  v_result := jsonb_build_object('status', 'applied', 'id', v_cur.id, 'recorded_at', v_cur.recorded_at);
  insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
  values (p_mutation_id, auth.uid(), 'blower_door_test', v_cur.id, v_result);
  return v_result;
end $$;
revoke all on function sync_blower_door_test(uuid, jsonb) from public, anon;
grant execute on function sync_blower_door_test(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- What the tool shows for a job or an estimate: who it is for and the readings saved to it.
-- Null when the caller may not see it. A job's readings include the test-in taken on its estimate.
-- A crew member gets no air sealing price (null).
-- -----------------------------------------------------------------------------
create or replace function blower_door_context(p_job_id uuid, p_estimate_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_job uuid; v_est uuid; v_label text; v_tests jsonb; v_prices boolean;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if (p_job_id is null) = (p_estimate_id is null) then
    raise exception 'give a job or an estimate' using errcode = '22023';
  end if;

  if p_job_id is not null then
    select j.id, j.estimate_id into v_job, v_est from jobs j where j.id = p_job_id;
    if not found or not can_see_blower_door(v_job, v_est) then return null; end if;
  else
    select e.id into v_est from estimates e where e.id = p_estimate_id;
    if not found or not can_see_blower_door(null, v_est) then return null; end if;
  end if;

  v_prices := not has_role('crew');

  select nullif(trim(concat_ws(', ', nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), nullif(p.street, ''), nullif(p.city, ''))), '')
    into v_label
    from estimates e join customers c on c.id = e.customer_id join properties p on p.id = e.property_id
   where e.id = v_est;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'job_id', t.job_id, 'estimate_id', t.estimate_id, 'kind', t.kind,
           'cfm', t.cfm, 'pa', t.pa, 'exponent', t.exponent, 'cfm50', t.cfm50,
           'program_key', t.program_key, 'program', t.program,
           'air_sealing_cost', case when v_prices then t.air_sealing_cost end,
           'bas_audit', t.bas_audit, 'volume', t.volume, 'occupants', t.occupants, 'stories', t.stories,
           'n_factor', t.n_factor, 'recorded_by', t.recorded_by, 'recorded_by_name', pr.full_name,
           'recorded_at', t.recorded_at) order by t.recorded_at desc, t.created_at desc), '[]')
    into v_tests
    from blower_door_tests t left join profiles pr on pr.id = t.recorded_by
   where t.estimate_id = v_est
     and (v_job is null or t.job_id = v_job or t.job_id is null)
     and can_see_blower_door(t.job_id, t.estimate_id);

  return jsonb_build_object('job_id', v_job, 'estimate_id', v_est, 'label', v_label, 'tests', v_tests);
end $$;
revoke all on function blower_door_context(uuid, uuid) from public, anon;
grant execute on function blower_door_context(uuid, uuid) to authenticated;
