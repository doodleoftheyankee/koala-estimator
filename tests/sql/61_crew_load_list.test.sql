-- Crew load list (20261121000002_crew_load_list.sql): the estimator's and the office's notes for the
-- crew reach the crew through crew_job_view (its own jobs only, never another crew's, never a $
-- amount, the line breaks kept), the office writes jobs.crew_notes (audited, at most 2,000
-- characters) and nobody else does, the always-bring list in app_settings is seeded once and kept,
-- crews read that key (and blower_door) but no other setting, the public reads nothing, the view
-- keeps every column it had, in order, and running the migration twice changes nothing.
-- Runs after the earlier test files, so every id here is new.

\set owner  '00000000-0000-0000-0000-0000000006a1'
\set office '00000000-0000-0000-0000-0000000006a2'
\set est    '00000000-0000-0000-0000-0000000006a3'
\set crewa  '00000000-0000-0000-0000-0000000006a5'
\set crewb  '00000000-0000-0000-0000-0000000006a6'

insert into auth.users (id) values (:'owner'), (:'office'), (:'est'), (:'crewa'), (:'crewb');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner LL'), (:'office', 'office', 'Office LL'), (:'est', 'estimator', 'Estimator LL'),
  (:'crewa', 'crew', 'Crew Lead A'), (:'crewb', 'crew', 'Crew Lead B');

insert into crews (id, name, size, blended_hourly_cost) values
  ('c6000000-0000-0000-0000-000000000001', 'Crew LL-A', 2, 35),
  ('c6000000-0000-0000-0000-000000000002', 'Crew LL-B', 2, 35);
insert into crew_members (crew_id, profile_id, is_lead) values
  ('c6000000-0000-0000-0000-000000000001', :'crewa', true),
  ('c6000000-0000-0000-0000-000000000002', :'crewb', true);

insert into customers (id, first_name, last_name) values
  ('c6100000-0000-0000-0000-000000000001', 'Dana', 'Load'),
  ('c6100000-0000-0000-0000-000000000002', 'Lee', 'Other');
insert into properties (id, customer_id, street, city, zip) values
  ('c6200000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001', '4 Shop Ln', 'Springfield', '62701'),
  ('c6200000-0000-0000-0000-000000000002', 'c6100000-0000-0000-0000-000000000002', '8 Other Rd', 'Springfield', '62702');

-- E1 (crew A's job) has the estimator's notes, with a price in them and a blank line between two
-- paragraphs; E2 (crew B's job) has none.
insert into estimates (id, customer_id, property_id, estimator_id, status, coefficient_set_id, pricing_snapshot, pricing_snapshot_hash, crew_id, client_doc)
values
  ('e6000000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001', 'c6200000-0000-0000-0000-000000000001', :'est', 'sent',
   (select id from coefficient_sets where status = 'active'), '{}', 'll-1', 'c6000000-0000-0000-0000-000000000001',
   jsonb_build_object('notes', 'For the customer', 'crewNotes', E'Gate code 4411. Dog in the yard.\n\nCustomer paid a $500 deposit (about $1,200 left).')),
  ('e6000000-0000-0000-0000-000000000002', 'c6100000-0000-0000-0000-000000000002', 'c6200000-0000-0000-0000-000000000002', :'est', 'sent',
   (select id from coefficient_sets where status = 'active'), '{}', 'll-2', 'c6000000-0000-0000-0000-000000000002',
   '{"notes": ""}');
insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
select v.id::uuid, v.est::uuid, 1, 'sent', 'x/v1.pdf', 'sha-' || v.n, jsonb_build_object(
         'options', '[]'::jsonb,
         'input', jsonb_build_object('areas', jsonb_build_array(jsonb_build_object(
           'id', v.area, 'name', 'Attic', 'jobType', 'attic', 'sqft', 1000, 'accessLevel', 'easy')))),
       'll-token-' || v.n, now() + interval '10 days', :'est'
  from (values ('f6000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 1),
               ('f6000000-0000-0000-0000-000000000002', 'e6000000-0000-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000002', 2)) v(id, est, area, n);
update quotes set status = 'signed', signed_tier = 'better', signed_price = 5000, signed_at = now()
 where id in ('f6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000002');
select set_config('ll.job1', (select id::text from jobs where quote_id = 'f6000000-0000-0000-0000-000000000001'), false);
select set_config('ll.job2', (select id::text from jobs where quote_id = 'f6000000-0000-0000-0000-000000000002'), false);
update jobs set crew_id = 'c6000000-0000-0000-0000-000000000001', scheduled_start = current_date where id = current_setting('ll.job1')::uuid;
update jobs set crew_id = 'c6000000-0000-0000-0000-000000000002', scheduled_start = current_date where id = current_setting('ll.job2')::uuid;

-- ---------------------------------------------------------------------------
-- The view keeps every column it had, in the same order, and adds the two notes at the end
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
           where table_schema = 'public' and table_name = 'crew_job_view') =
         'job_id,status,scheduled_start,scheduled_days,crew_id,started_at,completed_at,street,city,zip,lat,lng,first_name,last_name,phone,'
         'area_id,area_name,job_type,sqft,current_r,target_r,access_level,removal_needed,prep_notes,hazards,hazard_disposition,area_sort,'
         'signed_tier,scope,estimate_crew_notes,job_crew_notes',
    'crew_job_view: the same columns in the same order, the notes appended';
  assert (select reloptions from pg_class where oid = 'public.crew_job_view'::regclass) @> array['security_barrier=true'],
    'the view is still a security barrier';
  assert has_table_privilege('authenticated', 'crew_job_view', 'select'), 'signed-in users still read the view';
  assert (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'crew_job_view'
            and column_name ~ '(price|cost|margin|revenue|financ)') = 0, 'and it still has no money column';
end $$;

-- ---------------------------------------------------------------------------
-- The always-bring list: seeded once, generic, not a placeholder
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select jsonb_typeof(value->'always_bring') from app_settings where key = 'load_list') = 'array', 'the list is seeded';
  assert (select jsonb_array_length(value->'always_bring') from app_settings where key = 'load_list') = 5, 'five things to bring';
  assert (select value->'always_bring' ? 'Ladders' from app_settings where key = 'load_list'), 'ladders among them';
  assert (select description !~* 'placeholder' from app_settings where key = 'load_list'), 'the pricing page does not flag it as a placeholder';
end $$;

-- ---------------------------------------------------------------------------
-- The office writes the job's notes (audited, at most 2,000 characters); nobody else does
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'office', false);
update jobs set crew_notes = E'Park on the street.\nBring the 28 ft ladder (rental is $45/day).' where id = current_setting('ll.job1')::uuid;
do $$ begin
  assert (select crew_notes from jobs where id = current_setting('ll.job1')::uuid) like 'Park on the street.%', 'the office saves notes for the crew';
  begin
    update jobs set crew_notes = repeat('x', 2001) where id = current_setting('ll.job1')::uuid;
    raise exception 'notes over 2,000 characters should be refused';
  exception when check_violation then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', :'crewa', false);
update jobs set crew_notes = 'Crew wrote this' where id = current_setting('ll.job1')::uuid;
select set_config('request.jwt.claim.sub', :'est', false);
update jobs set crew_notes = 'Estimator wrote this' where id = current_setting('ll.job1')::uuid;
reset role;
do $$ begin
  assert (select crew_notes from jobs where id = current_setting('ll.job1')::uuid) like 'Park on the street.%',
    'a crew member or an estimator cannot change the office''s notes';
  assert (select count(*) from audit_log where action = 'job.crew_notes' and row_id = current_setting('ll.job1')
            and actor_id = '00000000-0000-0000-0000-0000000006a2' and context->>'crew_notes' like 'Park on the street.%') = 1,
    'the change is in the audit log, with who made it';
end $$;

-- ---------------------------------------------------------------------------
-- Crew A reads its job's notes through the view, without prices; never crew B's
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare v record;
begin
  assert (select count(*) from crew_job_view where job_id = current_setting('ll.job1')::uuid) = 1, 'crew A sees its job';
  select * into v from crew_job_view where job_id = current_setting('ll.job1')::uuid;
  assert v.estimate_crew_notes = E'Gate code 4411. Dog in the yard.\n\nCustomer paid a deposit.',
    'the estimator''s notes, the $ amounts and the bracketed price taken out, the paragraphs kept: ' || coalesce(v.estimate_crew_notes, 'null');
  assert v.job_crew_notes = E'Park on the street.\nBring the 28 ft ladder.', 'the office''s notes, without the rental price: ' || coalesce(v.job_crew_notes, 'null');
  assert (select count(*) from crew_job_view where estimate_crew_notes like '%$%' or job_crew_notes like '%$%') = 0, 'no note a crew reads has a $ amount';
  assert (select count(*) from crew_job_view where job_id = current_setting('ll.job2')::uuid) = 0, 'crew A never sees crew B''s job';
  assert not exists (select 1 from crew_job_view where estimate_crew_notes is not null and job_id <> current_setting('ll.job1')::uuid
                       and job_id in (current_setting('ll.job1')::uuid, current_setting('ll.job2')::uuid)), 'or its notes';
  -- Crews still cannot read jobs (revenue) or estimates (prices) directly.
  assert (select count(*) from jobs) = 0, 'a crew reads no job row directly';
  assert (select count(*) from estimates) = 0, 'or any estimate';
end $$;

select set_config('request.jwt.claim.sub', :'crewb', false);
do $$
declare v record;
begin
  select * into v from crew_job_view where job_id = current_setting('ll.job2')::uuid;
  assert v.job_id is not null and v.estimate_crew_notes is null and v.job_crew_notes is null, 'crew B sees its own job, with no notes';
  assert (select count(*) from crew_job_view where job_id = current_setting('ll.job1')::uuid) = 0, 'and never crew A''s job or its notes';
end $$;

-- An estimator reads no crew job; the office reads every one, with the notes.
select set_config('request.jwt.claim.sub', :'est', false);
do $$ begin
  assert (select count(*) from crew_job_view where job_id in (current_setting('ll.job1')::uuid, current_setting('ll.job2')::uuid)) = 0,
    'an estimator reads no crew job';
end $$;
select set_config('request.jwt.claim.sub', :'office', false);
do $$ begin
  assert (select job_crew_notes from crew_job_view where job_id = current_setting('ll.job1')::uuid) = E'Park on the street.\nBring the 28 ft ladder.',
    'the office reads what the crew reads';
end $$;
reset role;

-- An estimate that never had notes, or notes that are not text, gives none.
update estimates set client_doc = client_doc || '{"crewNotes": {"x": 1}}' where id = 'e6000000-0000-0000-0000-000000000002';
do $$ begin
  assert (select estimate_crew_notes from crew_job_view where job_id = current_setting('ll.job2')::uuid) is null, 'notes that are not text are left out';
  assert crew_notes_without_prices(null) is null and crew_notes_without_prices(E'  \n ') is null and crew_notes_without_prices('$500') is null,
    'nothing left is no note';
  assert crew_notes_without_prices(E'Line one\r\nLine two') = E'Line one\nLine two', 'Windows line breaks are kept as line breaks';
end $$;

-- ---------------------------------------------------------------------------
-- Settings: crews read load_list (and blower_door) but no other; only the owner writes it
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ begin
  assert (select array_agg(key order by key) from app_settings) = array['blower_door', 'load_list'],
    'a crew member reads the load list and the blower door settings, and no other setting';
  assert (select value->'always_bring' ? 'Ladders' from app_settings where key = 'load_list'), 'with the list';
end $$;
update app_settings set value = '{"always_bring": []}' where key = 'load_list';
select set_config('request.jwt.claim.sub', :'office', false);
update app_settings set value = '{"always_bring": []}' where key = 'load_list';
select set_config('request.jwt.claim.sub', :'est', false);
do $$ begin
  assert exists (select 1 from app_settings where key = 'load_list') and (select count(*) from app_settings) > 5, 'estimators read every setting, this one too';
end $$;
update app_settings set value = '{"always_bring": []}' where key = 'load_list';
reset role;
do $$ begin
  assert (select jsonb_array_length(value->'always_bring') from app_settings where key = 'load_list') = 5, 'only the owner changes the list';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
update app_settings set value = '{"always_bring": ["Blower", "Ladders"]}' where key = 'load_list';
reset role;
do $$ begin
  assert (select value from app_settings where key = 'load_list') = '{"always_bring": ["Blower", "Ladders"]}', 'the owner changes the list';
  assert (select count(*) from audit_log where table_name = 'app_settings' and row_id = 'load_list'
            and actor_id = '00000000-0000-0000-0000-0000000006a1') >= 1, 'and the change is audited with who made it';
end $$;

-- ---------------------------------------------------------------------------
-- The public reads nothing
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '', false);
set role anon;
do $$ begin
  assert (select count(*) from crew_job_view) = 0, 'the public reads no crew job, no notes';
  assert (select count(*) from app_settings) = 0, 'and no setting, the load list included';
  assert (select count(*) from jobs) = 0, 'and no job';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Running the migration again changes nothing: the owner's list, the notes, the view, the
-- policies, the constraint and the trigger stay as they are
-- ---------------------------------------------------------------------------
create temp table ll_before as
select (select value from app_settings where key = 'load_list') as setting,
       (select count(*) from app_settings) as settings,
       (select crew_notes from jobs where id = current_setting('ll.job1')::uuid) as notes,
       pg_get_viewdef('public.crew_job_view'::regclass) as viewdef,
       (select string_agg(policyname || ':' || qual, ';' order by policyname) from pg_policies where tablename = 'app_settings') as policies,
       (select string_agg(conname || ':' || pg_get_constraintdef(oid), ';' order by conname) from pg_constraint where conrelid = 'public.jobs'::regclass) as constraints,
       (select string_agg(tgname, ';' order by tgname) from pg_trigger where tgrelid = 'public.jobs'::regclass and not tgisinternal) as triggers,
       (select count(*) from audit_log) as audit;
\ir ../../supabase/migrations/20261121000002_crew_load_list.sql
do $$
declare b ll_before;
begin
  select * into b from ll_before;
  assert (select value from app_settings where key = 'load_list') = b.setting, 'running the migration again keeps the owner''s list';
  assert (select count(*) from app_settings) = b.settings, 'and adds no setting';
  assert (select crew_notes from jobs where id = current_setting('ll.job1')::uuid) = b.notes, 'and keeps the office''s notes';
  assert pg_get_viewdef('public.crew_job_view'::regclass) = b.viewdef, 'the view is the same';
  assert (select string_agg(policyname || ':' || qual, ';' order by policyname) from pg_policies where tablename = 'app_settings') = b.policies, 'the same policies';
  assert (select string_agg(conname || ':' || pg_get_constraintdef(oid), ';' order by conname) from pg_constraint where conrelid = 'public.jobs'::regclass) = b.constraints, 'the same constraints';
  assert (select string_agg(tgname, ';' order by tgname) from pg_trigger where tgrelid = 'public.jobs'::regclass and not tgisinternal) = b.triggers, 'the same triggers';
  assert (select count(*) from audit_log) = b.audit, 'and nothing in the audit log';
end $$;
-- Put the seeded list back (a deleted setting comes back on the next run too).
delete from app_settings where key = 'load_list';
\ir ../../supabase/migrations/20261121000002_crew_load_list.sql
do $$ begin
  assert (select jsonb_array_length(value->'always_bring') from app_settings where key = 'load_list') = 5, 'a missing list is seeded again';
end $$;
\echo '  ok'
