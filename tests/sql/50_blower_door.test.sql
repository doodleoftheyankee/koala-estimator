-- Blower door tests: the seeded settings (only when absent, readable by crews alone among the
-- settings), readings saved through the phone's outbox (idempotent, never duplicated, CFM50
-- checked against the reading), who sees and records them (owner and office all; an estimator
-- their own estimates; a crew lead only their crew's jobs and the test-in of the estimate those
-- came from), and readings that nobody edits or deletes. Runs after the earlier test files, so
-- every id here is new.

\set owner  '00000000-0000-0000-0000-0000000005a1'
\set office '00000000-0000-0000-0000-0000000005a2'
\set esta   '00000000-0000-0000-0000-0000000005a3'
\set estb   '00000000-0000-0000-0000-0000000005a4'
\set crewa  '00000000-0000-0000-0000-0000000005a5'
\set crewb  '00000000-0000-0000-0000-0000000005a6'

insert into auth.users (id) values (:'owner'), (:'office'), (:'esta'), (:'estb'), (:'crewa'), (:'crewb');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner BD'), (:'office', 'office', 'Office BD'), (:'esta', 'estimator', 'Erin Estimator'),
  (:'estb', 'estimator', 'Other Estimator'), (:'crewa', 'crew', 'Carl Crew'), (:'crewb', 'crew', 'Other Crew');

insert into crews (id, name, size, blended_hourly_cost) values
  ('c5000000-0000-0000-0000-000000000001', 'Crew BD-A', 2, 35),
  ('c5000000-0000-0000-0000-000000000002', 'Crew BD-B', 2, 35);
insert into crew_members (crew_id, profile_id, is_lead) values
  ('c5000000-0000-0000-0000-000000000001', :'crewa', true),
  ('c5000000-0000-0000-0000-000000000002', :'crewb', true);

insert into customers (id, first_name, last_name) values ('c5100000-0000-0000-0000-000000000001', 'Pat', 'Lee');
insert into properties (id, customer_id, street, city, zip) values ('c5200000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001', '12 Elkton Rd', 'Newark', '19711');

-- E1 (Erin's) and E2 (the other estimator's) become jobs for crew A and crew B; E3 (Erin's) is not a job.
insert into estimates (id, customer_id, property_id, estimator_id, status, coefficient_set_id, pricing_snapshot, pricing_snapshot_hash, crew_id)
select v.id::uuid, 'c5100000-0000-0000-0000-000000000001', 'c5200000-0000-0000-0000-000000000001', v.est::uuid, 'sent',
       (select id from coefficient_sets where status = 'active'), '{}', 'bd-' || v.n, v.crew::uuid
  from (values ('e5000000-0000-0000-0000-000000000001', :'esta', 'c5000000-0000-0000-0000-000000000001', 1),
               ('e5000000-0000-0000-0000-000000000002', :'estb', 'c5000000-0000-0000-0000-000000000002', 2),
               ('e5000000-0000-0000-0000-000000000003', :'esta', null, 3)) as v(id, est, crew, n);
insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
values ('f5000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 1, 'sent', 'x/v1.pdf', 'sha-bd-1', '{"options": []}', 'bd-token-1', now() + interval '10 days', :'esta'),
       ('f5000000-0000-0000-0000-000000000002', 'e5000000-0000-0000-0000-000000000002', 1, 'sent', 'x/v1.pdf', 'sha-bd-2', '{"options": []}', 'bd-token-2', now() + interval '10 days', :'estb');
update quotes set status = 'signed', signed_tier = 'better', signed_price = 5000, signed_at = now()
 where id in ('f5000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000002');
select set_config('bd.job1', (select id::text from jobs where quote_id = 'f5000000-0000-0000-0000-000000000001'), false);
select set_config('bd.job2', (select id::text from jobs where quote_id = 'f5000000-0000-0000-0000-000000000002'), false);

-- A reading as the phone sends it: test-in 6,952 CFM at 50 Pa, or test-out 3,325 CFM at 50.8 Pa (n 0.65).
create function pg_temp.reading(p_id text, p_kind text, p_job text, p_est text, p_extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('id', p_id, 'kind', p_kind, 'job_id', p_job, 'estimate_id', p_est, 'exponent', 0.65,
                            'program_key', 'home_performance',
                            'program', jsonb_build_object('key', 'home_performance', 'label', 'Home Performance'),
                            'recorded_at', now())
      || case when p_kind = 'test_in' then '{"cfm": 6952, "pa": 50, "cfm50": 6952}'::jsonb
              else '{"cfm": 3325, "pa": 50.8, "cfm50": 3290.87}'::jsonb end
      || p_extra
$$;
grant execute on function pg_temp.reading(text, text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Settings: seeded once, kept when the owner has changed them, readable by crews (that key only)
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select jsonb_array_length(value->'programs') from app_settings where key = 'blower_door') = 2, 'two programs seeded';
  assert (select value->'programs'->0->'tiers'->2->>'rebate' from app_settings where key = 'blower_door') = '1800', 'top tier seeded';
  assert (select value->>'gauge' from app_settings where key = 'blower_door') = 'Retrotec Model 5000', 'gauge seeded';
  assert (select description !~* 'placeholder' from app_settings where key = 'blower_door'), 'the pricing page does not flag it as a placeholder';
end $$;

update app_settings set value = '{"gauge": "Edited gauge", "flow_exponent": 0.6, "n_factor": 18, "programs": []}' where key = 'blower_door';
\ir ../../supabase/migrations/20261120000001_blower_door.sql
do $$ begin
  assert (select value->>'gauge' from app_settings where key = 'blower_door') = 'Edited gauge', 'running the migration again keeps the owner''s settings';
  assert (select count(*) from app_settings where key = 'blower_door') = 1, 'one settings row';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ begin
  assert (select array_agg(key) from app_settings) = array['blower_door'], 'a crew member reads the blower door setting and no other';
end $$;
select set_config('request.jwt.claim.sub', :'esta', false);
do $$ begin
  assert (select count(*) from app_settings) > 5 and exists (select 1 from app_settings where key = 'blower_door'), 'estimators read every setting, this one too';
end $$;
select set_config('request.jwt.claim.sub', :'crewa', false);
update app_settings set value = '{}' where key = 'blower_door';
select set_config('request.jwt.claim.sub', :'esta', false);
update app_settings set value = '{}' where key = 'blower_door';
reset role;
do $$ begin
  assert (select value->>'gauge' from app_settings where key = 'blower_door') = 'Edited gauge', 'only the owner changes the settings';
end $$;
-- Put the seed back for the rest of the file.
delete from app_settings where key = 'blower_door';
\ir ../../supabase/migrations/20261120000001_blower_door.sql

-- ---------------------------------------------------------------------------
-- The estimator's test-in on their estimate, through the outbox
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'esta', false);
do $$
declare r jsonb; r2 jsonb; t blower_door_tests;
begin
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000001',
         pg_temp.reading('b5000000-0000-0000-0000-000000000001', 'test_in', null, 'e5000000-0000-0000-0000-000000000001',
                         '{"volume": 20000, "occupants": 3, "stories": 2, "n_factor": 19}'));
  assert r->>'status' = 'applied' and r->>'id' = 'b5000000-0000-0000-0000-000000000001', 'test-in saved: ' || r::text;
  select * into t from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000001';
  assert t.recorded_by = '00000000-0000-0000-0000-0000000005a3' and t.job_id is null and t.kind = 'test_in', 'saved as Erin, on the estimate';
  assert t.cfm50 = 6952 and t.exponent = 0.65 and t.volume = 20000 and t.occupants = 3 and t.stories = 2, 'reading and house kept as sent';
  assert t.program->>'key' = 'home_performance', 'the program as it was is kept';

  -- The phone sends it again (the answer was lost): the same answer, still one reading.
  r2 := sync_blower_door_test('d5000000-0000-0000-0000-000000000001',
          pg_temp.reading('b5000000-0000-0000-0000-000000000001', 'test_in', null, 'e5000000-0000-0000-0000-000000000001'));
  assert r2 = r, 'the same mutation gives the same answer';
  -- Sent again under a new mutation id (the phone lost its outbox entry): still one reading.
  r2 := sync_blower_door_test('d5000000-0000-0000-0000-000000000002',
          pg_temp.reading('b5000000-0000-0000-0000-000000000001', 'test_in', null, 'e5000000-0000-0000-0000-000000000001'));
  assert r2->>'status' = 'applied' and r2->>'id' = 'b5000000-0000-0000-0000-000000000001', 'the same reading id is applied once';
  assert (select count(*) from blower_door_tests where estimate_id = 'e5000000-0000-0000-0000-000000000001') = 1, 'no duplicate readings';
  assert (select count(*) from sync_mutations where entity = 'blower_door_test' and entity_id = 'b5000000-0000-0000-0000-000000000001') = 2, 'both mutations in the ledger';

  -- An estimate this phone has not synced yet: wait and send again later.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000003',
         pg_temp.reading('b5000000-0000-0000-0000-000000000003', 'test_in', null, 'e5000000-0000-0000-0000-0000000000ff'));
  assert r->>'status' = 'waiting', 'an estimate not on the server yet waits: ' || r::text;
  assert not exists (select 1 from sync_mutations where mutation_id = 'd5000000-0000-0000-0000-000000000003'), 'a waiting reading is not in the ledger';

  -- A CFM50 that is not this reading at this exponent, and a pressure no gauge shows.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000004',
         pg_temp.reading('b5000000-0000-0000-0000-000000000004', 'test_in', null, 'e5000000-0000-0000-0000-000000000001', '{"cfm50": 7500}'));
  assert r->>'status' = 'invalid', 'a CFM50 worked out with another exponent is refused: ' || r::text;
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000005',
         pg_temp.reading('b5000000-0000-0000-0000-000000000005', 'test_in', null, 'e5000000-0000-0000-0000-000000000001', '{"pa": 150, "cfm50": 4350}'));
  assert r->>'status' = 'invalid', 'a pressure over 100 Pa is refused';
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000006',
         pg_temp.reading('b5000000-0000-0000-0000-000000000006', 'test_in', null, 'e5000000-0000-0000-0000-000000000001', '{"kind": "test_middle"}'));
  assert r->>'status' = 'invalid', 'only test-in and test-out';
  assert (select count(*) from blower_door_tests where estimate_id = 'e5000000-0000-0000-0000-000000000001') = 1, 'nothing invalid was stored';

  -- Taken "tomorrow" by a phone with a wrong clock: stored as now.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000007',
         pg_temp.reading('b5000000-0000-0000-0000-000000000007', 'test_in', null, 'e5000000-0000-0000-0000-000000000003',
                         jsonb_build_object('recorded_at', now() + interval '1 day')));
  assert r->>'status' = 'applied', 'test-in on Erin''s other estimate';
  assert (select recorded_at <= now() from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000007'), 'never recorded in the future';

  -- Erin cannot save to a job (estimators do not see jobs).
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000008',
         pg_temp.reading('b5000000-0000-0000-0000-000000000008', 'test_out', current_setting('bd.job1'), null));
  assert r->>'status' = 'refused', 'an estimator cannot save to a job: ' || r::text;
end $$;

-- The other estimator: cannot save to Erin's estimate, cannot see its readings or its context.
select set_config('request.jwt.claim.sub', :'estb', false);
do $$
declare r jsonb;
begin
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000011',
         pg_temp.reading('b5000000-0000-0000-0000-000000000011', 'test_in', null, 'e5000000-0000-0000-0000-000000000001'));
  assert r->>'status' = 'refused' and r->>'error' = 'This estimate is not yours.', 'another estimator is refused: ' || r::text;
  assert (select count(*) from blower_door_tests) = 0, 'and sees none of Erin''s readings';
  assert blower_door_context(null, 'e5000000-0000-0000-0000-000000000001') is null, 'nor the estimate''s context';
  -- Reusing Erin's mutation id on this phone is refused, not a crash.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000001',
         pg_temp.reading('b5000000-0000-0000-0000-000000000012', 'test_in', null, 'e5000000-0000-0000-0000-000000000002'));
  assert r->>'status' = 'rejected', 'someone else''s mutation id is rejected';
  -- Reusing Erin's reading id too.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000013',
         pg_temp.reading('b5000000-0000-0000-0000-000000000001', 'test_in', null, 'e5000000-0000-0000-0000-000000000002'));
  assert r->>'status' = 'rejected', 'someone else''s reading id is rejected';
end $$;

-- ---------------------------------------------------------------------------
-- The crew lead's test-out on the job
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; t blower_door_tests; c jsonb;
begin
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000021',
         pg_temp.reading('b5000000-0000-0000-0000-000000000021', 'test_out', current_setting('bd.job1'), null,
                         '{"result": {"reduction_pct": 52.66, "tier_pct": 40}}'));
  assert r->>'status' = 'applied', 'crew A saves the test-out on their job: ' || r::text;
  select * into t from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000021';
  assert t.job_id = current_setting('bd.job1')::uuid and t.estimate_id = 'e5000000-0000-0000-0000-000000000001', 'on the job and its estimate';
  assert t.cfm50 = 3290.87 and t.pa = 50.8, 'as recorded';
  assert t.result->>'tier_pct' = '40', 'what the phone showed is kept';

  -- The crew sees the test-in taken on the estimate and their own test-out, nothing else.
  assert (select count(*) from blower_door_tests) = 2, 'crew A sees the estimate''s test-in and the job''s test-out';
  assert not exists (select 1 from blower_door_tests where estimate_id = 'e5000000-0000-0000-0000-000000000003'), 'not Erin''s other estimate';
  c := blower_door_context(current_setting('bd.job1')::uuid, null);
  assert c->>'label' = 'Pat Lee, 12 Elkton Rd, Newark', 'the context names the house: ' || coalesce(c->>'label', 'null');
  assert jsonb_array_length(c->'tests') = 2, 'and has both readings';
  assert c->'tests'->0->>'kind' = 'test_out' and c->'tests'->0->>'recorded_by_name' = 'Carl Crew', 'newest first, with who took it';
  assert c->'tests'->1->>'recorded_by_name' = 'Erin Estimator', 'the estimator''s test-in';
  assert blower_door_context(null, 'e5000000-0000-0000-0000-000000000001') is not null, 'the estimate of their job too';
  assert blower_door_context(current_setting('bd.job2')::uuid, null) is null, 'not another crew''s job';

  -- Another crew's job: refused.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000022',
         pg_temp.reading('b5000000-0000-0000-0000-000000000022', 'test_out', current_setting('bd.job2'), null));
  assert r->>'status' = 'refused' and r->>'error' = 'This job is not assigned to your crew.', 'crew A cannot save to crew B''s job';
  -- An estimate with no job: refused.
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000023',
         pg_temp.reading('b5000000-0000-0000-0000-000000000023', 'test_in', null, 'e5000000-0000-0000-0000-000000000003'));
  assert r->>'status' = 'refused', 'crews save to jobs, not estimates';
end $$;

select set_config('request.jwt.claim.sub', :'crewb', false);
do $$ begin
  assert (select count(*) from blower_door_tests) = 0, 'crew B sees none of crew A''s readings';
  assert blower_door_context(current_setting('bd.job1')::uuid, null) is null, 'nor crew A''s job';
end $$;

-- ---------------------------------------------------------------------------
-- Office and owner see every reading; the estimator sees the test-out on their estimate's job
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :'office', false);
do $$ begin
  assert (select count(*) from blower_door_tests) = 3, 'the office sees every reading';
  assert jsonb_array_length(blower_door_context(current_setting('bd.job1')::uuid, null)->'tests') = 2, 'the job''s two readings';
end $$;
select set_config('request.jwt.claim.sub', :'owner', false);
do $$ declare r jsonb; begin
  assert (select count(*) from blower_door_tests) = 3, 'the owner sees every reading';
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000031',
         pg_temp.reading('b5000000-0000-0000-0000-000000000031', 'test_out', current_setting('bd.job2'), null));
  assert r->>'status' = 'applied', 'the owner can record on any job';
end $$;
select set_config('request.jwt.claim.sub', :'esta', false);
do $$ begin
  assert (select count(*) from blower_door_tests where estimate_id = 'e5000000-0000-0000-0000-000000000001') = 2, 'Erin sees the crew''s test-out on her estimate''s job';
  assert (select count(*) from blower_door_tests where estimate_id = 'e5000000-0000-0000-0000-000000000002') = 0, 'but not the other estimator''s';
end $$;

-- ---------------------------------------------------------------------------
-- Direct writes: inserts follow the same rules; nobody updates or deletes a reading
-- ---------------------------------------------------------------------------
do $$
begin
  insert into blower_door_tests (id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
  values ('b5000000-0000-0000-0000-000000000041', 'e5000000-0000-0000-0000-000000000003', 'test_in', 4000, 50, 0.65, 4000, '00000000-0000-0000-0000-0000000005a3');
  begin
    insert into blower_door_tests (id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
    values ('b5000000-0000-0000-0000-000000000042', 'e5000000-0000-0000-0000-000000000003', 'test_in', 4000, 50, 0.65, 4000, '00000000-0000-0000-0000-0000000005a1');
    raise exception 'recording as someone else should be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into blower_door_tests (id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
    values ('b5000000-0000-0000-0000-000000000043', 'e5000000-0000-0000-0000-000000000002', 'test_in', 4000, 50, 0.65, 4000, '00000000-0000-0000-0000-0000000005a3');
    raise exception 'recording on another estimator''s estimate should be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
begin
  begin
    insert into blower_door_tests (id, job_id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
    values ('b5000000-0000-0000-0000-000000000044', current_setting('bd.job2')::uuid, null, 'test_out', 3000, 50, 0.65, 3000, '00000000-0000-0000-0000-0000000005a5');
    raise exception 'a direct insert on another crew''s job should be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into blower_door_tests (id, job_id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
    values ('b5000000-0000-0000-0000-000000000045', current_setting('bd.job1')::uuid, 'e5000000-0000-0000-0000-000000000002', 'test_out', 3000, 50, 0.65, 3000, '00000000-0000-0000-0000-0000000005a5');
    raise exception 'a reading naming another estimate than its job should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into blower_door_tests (id, job_id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
    values ('b5000000-0000-0000-0000-000000000046', current_setting('bd.job1')::uuid, null, 'test_out', 3000, 40, 0.65, 3000, '00000000-0000-0000-0000-0000000005a5');
    raise exception 'a CFM50 that is not the reading at its exponent should be refused';
  exception when check_violation then null;
  end;
  -- Its own job, with the estimate filled in from the job.
  insert into blower_door_tests (id, job_id, estimate_id, kind, cfm, pa, exponent, cfm50, recorded_by)
  values ('b5000000-0000-0000-0000-000000000047', current_setting('bd.job1')::uuid, null, 'test_out', 3000, 50, 0.65, 3000, '00000000-0000-0000-0000-0000000005a5');
end $$;
update blower_door_tests set cfm50 = 1, cfm = 1 where id = 'b5000000-0000-0000-0000-000000000021';
delete from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000021';
select set_config('request.jwt.claim.sub', :'owner', false);
update blower_door_tests set exponent = 0.7 where id = 'b5000000-0000-0000-0000-000000000001';
delete from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000001';

reset role;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  assert (select estimate_id from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000047') = 'e5000000-0000-0000-0000-000000000001', 'a job reading gets its job''s estimate';
  assert (select cfm50 from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000021') = 3290.87, 'the crew cannot change a reading';
  assert (select exponent from blower_door_tests where id = 'b5000000-0000-0000-0000-000000000001') = 0.65, 'nor can the owner: readings stay as recorded';
  assert (select count(*) from blower_door_tests) = 6, 'nobody deletes a reading';
  assert (select count(*) from audit_log where table_name = 'blower_door_tests' and action = 'INSERT') = 6, 'every reading is audited';
  assert (select actor_id from audit_log where table_name = 'blower_door_tests' and row_id = 'b5000000-0000-0000-0000-000000000021') = '00000000-0000-0000-0000-0000000005a5', 'with who took it';
end $$;

-- ---------------------------------------------------------------------------
-- A crew member moved off the job, or deactivated, is refused; nobody signed out gets in
-- ---------------------------------------------------------------------------
update jobs set crew_id = 'c5000000-0000-0000-0000-000000000002' where id = current_setting('bd.job1')::uuid;
set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ declare r jsonb; begin
  r := sync_blower_door_test('d5000000-0000-0000-0000-000000000051',
         pg_temp.reading('b5000000-0000-0000-0000-000000000051', 'test_out', current_setting('bd.job1'), null));
  assert r->>'status' = 'refused', 'a crew moved off the job is refused';
  assert (select count(*) from blower_door_tests) = 0, 'and no longer sees its readings';
end $$;
reset role;
update jobs set crew_id = 'c5000000-0000-0000-0000-000000000001' where id = current_setting('bd.job1')::uuid;
update profiles set active = false where id = :'crewa';
set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ begin
  begin
    perform sync_blower_door_test('d5000000-0000-0000-0000-000000000052',
              pg_temp.reading('b5000000-0000-0000-0000-000000000052', 'test_out', current_setting('bd.job1'), null));
    raise exception 'a deactivated crew member should be refused';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from blower_door_tests) = 0, 'and sees nothing';
  assert (select count(*) from app_settings) = 0, 'not even the settings';
end $$;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  begin
    perform sync_blower_door_test('d5000000-0000-0000-0000-000000000053', '{}'::jsonb);
    raise exception 'signed out should be refused';
  exception when invalid_authorization_specification then null;
  end;
end $$;
reset role;
update profiles set active = true where id = :'crewa';
set role anon;
do $$ begin
  begin
    perform blower_door_context(null, 'e5000000-0000-0000-0000-000000000001');
    raise exception 'anon should not run blower_door_context';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
\echo '  ok'
