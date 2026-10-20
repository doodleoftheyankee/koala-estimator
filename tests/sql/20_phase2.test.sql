-- Phase 2 database tests: jobs from signed quotes, crew job status, crew_job_view scope, crew
-- actuals sync and verification lock, coefficient rejection, quote expiry, and sync v2 (line
-- overrides, deviation flags and acknowledgements). Runs after 10_phase1 in the same database,
-- so every id here is new. Each assertion raises on failure; ON_ERROR_STOP makes psql exit non-zero.

\set owner   '00000000-0000-0000-0000-0000000000b1'
\set office  '00000000-0000-0000-0000-0000000000b2'
\set est     '00000000-0000-0000-0000-0000000000b3'
\set crewa   '00000000-0000-0000-0000-0000000000b4'
\set crewb   '00000000-0000-0000-0000-0000000000b5'

insert into auth.users (id) values (:'owner'), (:'office'), (:'est'), (:'crewa'), (:'crewb');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner P2'), (:'office', 'office', 'Office P2'), (:'est', 'estimator', 'Estimator P2'),
  (:'crewa', 'crew', 'Crew Lead A'), (:'crewb', 'crew', 'Crew Lead B');

-- Two crews; each crew member belongs to one.
insert into crews (id, name, size, blended_hourly_cost) values
  ('c2000000-0000-0000-0000-000000000001', 'Crew P2-A', 2, 35),
  ('c2000000-0000-0000-0000-000000000002', 'Crew P2-B', 2, 35);
insert into crew_members (crew_id, profile_id, is_lead) values
  ('c2000000-0000-0000-0000-000000000001', :'crewa', true),
  ('c2000000-0000-0000-0000-000000000002', :'crewb', true);

-- Sync v2 payload: an attic with an estimator hours override on the cellulose labor line and two
-- flags (an acknowledged line flag and an unacknowledged total-price flag).
create table p2_payload as
select jsonb_build_object(
  'estimate', jsonb_build_object(
    'id', 'e2000000-0000-0000-0000-000000000001', 'status', 'ready',
    'coefficient_set_id', (select id from coefficient_sets where status = 'active'),
    'pricing_snapshot', '{"test": "phase2"}'::jsonb, 'pricing_snapshot_hash', 'p2-h1',
    'drive_minutes_est', 25, 'crew_id', 'c2000000-0000-0000-0000-000000000001', 'selected_tier', 'better',
    'model_total_price', 6100, 'notes', null, 'priced_offline', false, 'client_created_at', now(),
    'client_doc', jsonb_build_object(
      'id', 'e2000000-0000-0000-0000-000000000001',
      'lineOverrides', jsonb_build_object('a2000000-0000-0000-0000-000000000001|cellulose|labor',
                                          jsonb_build_object('hours', 14, 'reason', 'Tight attic')))),
  'customer', jsonb_build_object('id', 'c2100000-0000-0000-0000-000000000001', 'first_name', 'Jo', 'last_name', 'Ruiz',
                                 'email', 'jo@example.com', 'phone', '+13025550111', 'sms_consent', false, 'email_consent', true),
  'property', jsonb_build_object('id', 'c2200000-0000-0000-0000-000000000001', 'street', '9 Elkton Rd', 'city', 'Newark',
                                 'state', 'DE', 'zip', '19711'),
  'areas', jsonb_build_array(jsonb_build_object(
    'id', 'a2000000-0000-0000-0000-000000000001', 'name', 'Main attic', 'job_type', 'attic', 'sqft', 1200,
    'current_r', 11, 'target_r', null, 'access_level', 'difficult', 'removal_needed', false, 'sort_order', 0)),
  'options', jsonb_build_array(
    jsonb_build_object(
      'id', 'b2000000-0000-0000-0000-000000000001', 'tier', 'good', 'label', 'Good', 'direct_cost', 2500,
      'loaded_cost', 4075, 'price', 4795, 'model_price', 4795, 'is_overridden', false, 'margin_pct', 0.15,
      'crew_days', 1, 'financing', null,
      'lines', jsonb_build_array(
        jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000001', 'area_id', 'a2000000-0000-0000-0000-000000000001',
          'kind', 'material', 'product', 'cellulose', 'description', 'Blown cellulose', 'qty', 70, 'unit', 'bag',
          'cost', 980, 'design_qty', 64.8, 'model_qty', 70, 'model_cost', 980, 'is_overridden', false,
          'line_key', 'a2000000-0000-0000-0000-000000000001|cellulose|material', 'sort_order', 0),
        jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000002', 'area_id', 'a2000000-0000-0000-0000-000000000001',
          'kind', 'labor', 'product', 'cellulose', 'description', 'Install cellulose', 'qty', 14, 'unit', 'hour',
          'hours', 14, 'cost', 490, 'model_hours', 10.5, 'model_cost', 367.5, 'is_overridden', true,
          'override_reason', 'Tight attic', 'line_key', 'a2000000-0000-0000-0000-000000000001|cellulose|labor',
          'sort_order', 1))),
    jsonb_build_object(
      'id', 'b2000000-0000-0000-0000-000000000002', 'tier', 'better', 'label', 'Better', 'direct_cost', 3100,
      'loaded_cost', 5053, 'price', 6400, 'model_price', 6100, 'is_overridden', true, 'override_reason', 'Match competitor',
      'margin_pct', 0.21, 'crew_days', 1.5, 'financing', null,
      'lines', jsonb_build_array(
        jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000003', 'area_id', 'a2000000-0000-0000-0000-000000000001',
          'kind', 'material', 'product', 'cellulose', 'description', 'Blown cellulose', 'qty', 70, 'unit', 'bag',
          'cost', 980, 'design_qty', 64.8, 'model_qty', 70, 'model_cost', 980, 'is_overridden', false,
          'line_key', 'a2000000-0000-0000-0000-000000000001|cellulose|material', 'sort_order', 0),
        jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000004', 'area_id', 'a2000000-0000-0000-0000-000000000001',
          'kind', 'labor', 'product', 'cellulose', 'description', 'Install cellulose', 'qty', 14, 'unit', 'hour',
          'hours', 14, 'cost', 490, 'model_hours', 10.5, 'model_cost', 367.5, 'is_overridden', true,
          'override_reason', 'Tight attic', 'line_key', 'a2000000-0000-0000-0000-000000000001|cellulose|labor',
          'sort_order', 1),
        jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000005', 'area_id', 'a2000000-0000-0000-0000-000000000001',
          'kind', 'labor', 'product', 'air_sealing', 'description', 'Air sealing', 'qty', 6, 'unit', 'hour',
          'hours', 6, 'cost', 210, 'model_hours', 6, 'model_cost', 210, 'is_overridden', false,
          'line_key', 'a2000000-0000-0000-0000-000000000001|air_sealing|labor', 'sort_order', 2),
        jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000006', 'area_id', null,
          'kind', 'drive', 'product', null, 'description', 'Travel', 'qty', 1, 'cost', 120, 'model_cost', 120,
          'is_overridden', false, 'line_key', null, 'sort_order', 3)))),
  'flags', jsonb_build_array(
    jsonb_build_object('flag_key', 'a2000000-0000-0000-0000-000000000001|cellulose|labor|hours', 'tier', 'good',
      'line_key', 'a2000000-0000-0000-0000-000000000001|cellulose|labor', 'metric', 'hours',
      'estimator_value', 14, 'model_value', 10.5, 'pct_diff', 0.3333,
      'reasons', jsonb_build_array(jsonb_build_object('code', 'labor_rate', 'text', 'Labor hours 33% above model.')),
      'ack_note', 'Low clearance, long hose run'),
    jsonb_build_object('flag_key', 'better|total_price', 'tier', 'better', 'line_key', null, 'metric', 'total_price',
      'estimator_value', 6400, 'model_value', 6100, 'pct_diff', 0.0492, 'reasons', '[]'::jsonb, 'ack_note', null))
) as p;
grant select on p2_payload to authenticated;

-- ---------------------------------------------------------------------------
-- sync_upsert_estimate v2: line keys, override reasons, flags and acknowledgements
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'est', false);

do $$
declare r jsonb; f record; t record;
begin
  r := sync_upsert_estimate('d2000000-0000-0000-0000-000000000001', null, (select p from p2_payload));
  assert r->>'status' = 'applied' and (r->>'row_version')::int = 1, 'first sync should apply: ' || r::text;

  select line_key, override_reason, is_overridden, hours, model_hours into f
    from estimate_lines where id = 'b2100000-0000-0000-0000-000000000002';
  assert f.line_key = 'a2000000-0000-0000-0000-000000000001|cellulose|labor', 'line_key stored: ' || coalesce(f.line_key, 'null');
  assert f.override_reason = 'Tight attic' and f.is_overridden, 'override reason stored';
  assert f.hours = 14 and f.model_hours = 10.5, 'estimator and model hours stored';
  assert (select line_key from estimate_lines where id = 'b2100000-0000-0000-0000-000000000006') is null,
    'job-level lines have no line key';

  assert (select count(*) from deviation_flags where estimate_id = 'e2000000-0000-0000-0000-000000000001') = 2, 'two flags stored';
  select * into f from deviation_flags where flag_key = 'a2000000-0000-0000-0000-000000000001|cellulose|labor|hours';
  assert f.tier = 'good' and f.metric = 'hours' and f.estimator_value = 14 and f.model_value = 10.5 and f.pct_diff = 0.3333,
    'line flag values stored';
  assert f.option_id = 'b2000000-0000-0000-0000-000000000001', 'line flag linked to its tier''s option';
  assert f.line_id = 'b2100000-0000-0000-0000-000000000002', 'line flag linked to the line with its line key';
  assert f.reasons->0->>'code' = 'labor_rate', 'reasons stored';
  assert f.ack_note = 'Low clearance, long hose run', 'ack note stored';
  assert f.acknowledged_by = '00000000-0000-0000-0000-0000000000b3' and f.acknowledged_at is not null,
    'acknowledged by the estimator who wrote the note';
  assert f.outcome is null, 'no outcome before the job is done';

  select * into t from deviation_flags where flag_key = 'better|total_price';
  assert t.option_id = 'b2000000-0000-0000-0000-000000000002' and t.line_id is null, 'total flag linked to its option only';
  assert t.ack_note is null and t.acknowledged_by is null and t.acknowledged_at is null, 'unacknowledged flag stays open';
end $$;

reset role;
select set_config('p2.ack_at',
  (select acknowledged_at::text from deviation_flags where flag_key = 'a2000000-0000-0000-0000-000000000001|cellulose|labor|hours'),
  false);
select pg_sleep(0.02);

-- The office re-syncs with the same note: who acknowledged, and when, must not change.
set role authenticated;
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare r jsonb; f record;
begin
  r := sync_upsert_estimate('d2000000-0000-0000-0000-000000000002', 1, (select p from p2_payload));
  assert r->>'status' = 'applied' and (r->>'row_version')::int = 2, 're-sync should apply: ' || r::text;
  assert (select count(*) from deviation_flags where estimate_id = 'e2000000-0000-0000-0000-000000000001') = 2,
    're-sync replaces flags, never duplicates them';
  select * into f from deviation_flags where flag_key = 'a2000000-0000-0000-0000-000000000001|cellulose|labor|hours';
  assert f.acknowledged_by = '00000000-0000-0000-0000-0000000000b3', 'acknowledged_by kept across a re-sync with the same note';
  assert f.acknowledged_at = current_setting('p2.ack_at')::timestamptz, 'acknowledged_at kept across a re-sync with the same note';
  assert (select estimator_id from estimates where id = 'e2000000-0000-0000-0000-000000000001') = '00000000-0000-0000-0000-0000000000b3',
    'an office re-sync does not take over the estimate';
end $$;

reset role;
select pg_sleep(0.02);

-- A changed note is a new acknowledgement by whoever wrote it.
set role authenticated;
do $$
declare r jsonb; f record;
begin
  r := sync_upsert_estimate('d2000000-0000-0000-0000-000000000003', 2,
         jsonb_set((select p from p2_payload), '{flags,0,ack_note}', '"Low clearance; customer stored boxes in the attic"'));
  assert r->>'status' = 'applied', 'note change should apply: ' || r::text;
  select * into f from deviation_flags where flag_key = 'a2000000-0000-0000-0000-000000000001|cellulose|labor|hours';
  assert f.ack_note = 'Low clearance; customer stored boxes in the attic', 'new note stored';
  assert f.acknowledged_by = '00000000-0000-0000-0000-0000000000b2', 'new note acknowledged by the office user';
  assert f.acknowledged_at > current_setting('p2.ack_at')::timestamptz, 'new note gets a new acknowledgement time';
end $$;

-- Crews never see estimate lines or flags.
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ begin
  assert (select count(*) from estimate_lines) = 0, 'crew cannot read estimate lines';
  assert (select count(*) from deviation_flags) = 0, 'crew cannot read deviation flags';
  assert (select count(*) from estimate_options) = 0, 'crew cannot read options';
end $$;

-- ---------------------------------------------------------------------------
-- Signing a quote creates exactly one job
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- The snapshot is what the quote route freezes: every option with its lines, and the areas quoted.
insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
select 'f2000000-0000-0000-0000-000000000001', e.id, 1, 'sent', e.id || '/v1.pdf', 'sha-p2-1',
       jsonb_build_object(
         'options', (select jsonb_agg(jsonb_build_object(
                       'tier', o.tier, 'crewDays', o.crew_days, 'price', o.price,
                       'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'key', l.line_key, 'areaId', l.area_id, 'kind', l.kind, 'product', l.product,
                                   'description', l.description, 'qty', l.qty, 'unit', l.unit, 'hours', l.hours, 'cost', l.cost)
                                   order by l.sort_order), '[]')
                                   from estimate_lines l where l.option_id = o.id)) order by o.tier)
                       from estimate_options o where o.estimate_id = e.id),
         'input', jsonb_build_object('areas', (select jsonb_agg(jsonb_build_object(
                       'id', a.id, 'name', a.name, 'jobType', a.job_type, 'accessLevel', a.access_level, 'sqft', a.sqft)
                       order by a.sort_order) from estimate_areas a where a.estimate_id = e.id))),
       'p2-token-1', now() + interval '30 days', :'est'
  from estimates e where e.id = 'e2000000-0000-0000-0000-000000000001';
update estimates set status = 'sent' where id = 'e2000000-0000-0000-0000-000000000001';


-- The estimator then starts a revision that is never sent: more bags, more days, another area.
-- The customer signs v1, so the job and the crew's scope must follow v1, not the revision.
update estimate_options set crew_days = 3
 where estimate_id = 'e2000000-0000-0000-0000-000000000001' and tier = 'better';
update estimate_lines l set qty = 120 from estimate_options o
 where l.option_id = o.id and o.estimate_id = 'e2000000-0000-0000-0000-000000000001' and o.tier = 'better'
   and l.kind = 'material' and l.product = 'cellulose';
insert into estimate_areas (id, estimate_id, name, job_type, sqft)
values ('a2000000-0000-0000-0000-00000000000f', 'e2000000-0000-0000-0000-000000000001', 'Garage (revision only)', 'garage', 300);

do $$
declare j record;
begin
  assert (select count(*) from jobs where quote_id = 'f2000000-0000-0000-0000-000000000001') = 0, 'no job before signing';
  update quotes set status = 'signed', signed_tier = 'better', signed_price = 6400, signed_at = now(), signer_name = 'Jo Ruiz'
   where id = 'f2000000-0000-0000-0000-000000000001';
  update estimates set status = 'signed' where id = 'e2000000-0000-0000-0000-000000000001';

  assert (select count(*) from jobs where quote_id = 'f2000000-0000-0000-0000-000000000001') = 1, 'signing creates one job';
  select * into j from jobs where quote_id = 'f2000000-0000-0000-0000-000000000001';
  assert j.estimate_id = 'e2000000-0000-0000-0000-000000000001', 'job belongs to the estimate';
  assert j.crew_id = 'c2000000-0000-0000-0000-000000000001', 'job goes to the estimate''s crew';
  assert j.status = 'scheduled' and j.revenue = 6400, 'job starts scheduled with the signed price as revenue';
  assert j.scheduled_days = 1.5, 'scheduled days come from the signed quote, not the later revision (3): ' || j.scheduled_days;
  assert (select decided_at from estimates where id = 'e2000000-0000-0000-0000-000000000001') is not null,
    'signing decides the estimate';
end $$;

-- Re-signing (status bounced and signed again) and later edits never duplicate the job.
update quotes set status = 'viewed' where id = 'f2000000-0000-0000-0000-000000000001';
update quotes set status = 'signed' where id = 'f2000000-0000-0000-0000-000000000001';
update quotes set signer_name = 'Jo A. Ruiz' where id = 'f2000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*) from jobs where estimate_id = 'e2000000-0000-0000-0000-000000000001') = 1, 're-signing must not duplicate the job';
end $$;
select set_config('p2.job1', (select id::text from jobs where quote_id = 'f2000000-0000-0000-0000-000000000001'), false);

-- A second signed job for crew B, used for the cancel test and the expiry test.
insert into estimates (id, customer_id, property_id, estimator_id, status, coefficient_set_id, pricing_snapshot,
                       pricing_snapshot_hash, crew_id)
values ('e2000000-0000-0000-0000-000000000002', 'c2100000-0000-0000-0000-000000000001', 'c2200000-0000-0000-0000-000000000001',
        :'est', 'sent', (select id from coefficient_sets where status = 'active'), '{}', 'p2-h2',
        'c2000000-0000-0000-0000-000000000002');
insert into estimate_areas (id, estimate_id, name, job_type, sqft, access_level)
values ('a2000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'Crawlspace', 'crawlspace', 600, 'extreme');
insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
values ('f2000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 1, 'sent', 'x/v1.pdf', 'sha-p2-2',
        '{"options": []}', 'p2-token-2', now() - interval '1 day', :'est');
update quotes set status = 'signed', signed_tier = 'good', signed_price = 2100, signed_at = now()
 where id = 'f2000000-0000-0000-0000-000000000002';
select set_config('p2.job2', (select id::text from jobs where quote_id = 'f2000000-0000-0000-0000-000000000002'), false);

-- ---------------------------------------------------------------------------
-- Crew job status: only the job's own crew, only valid transitions
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'crewb', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from jobs where id = current_setting('p2.job1')::uuid) = 0, 'crew B cannot see crew A''s job';
  begin
    perform crew_set_job_status(current_setting('p2.job1')::uuid, 'in_progress');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'another crew cannot change the job status';
end $$;

select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; n int; ok boolean;
begin
  r := crew_set_job_status(current_setting('p2.job1')::uuid, 'in_progress');
  assert r->>'status' = 'in_progress' and r->>'started_at' is not null and r->>'completed_at' is null,
    'scheduled -> in_progress: ' || r::text;

  ok := false;
  begin
    perform crew_set_job_status(current_setting('p2.job1')::uuid, 'cancelled');
  exception when invalid_parameter_value then ok := true;
  end;
  assert ok, 'crew cannot cancel a job';

  r := crew_set_job_status(current_setting('p2.job1')::uuid, 'completed');
  assert r->>'status' = 'completed' and r->>'completed_at' is not null, 'in_progress -> completed: ' || r::text;

  ok := false;
  begin
    perform crew_set_job_status(current_setting('p2.job1')::uuid, 'in_progress');
  exception when invalid_parameter_value then ok := true;
  end;
  assert ok, 'only the office may reopen a completed job';

  ok := false;
  begin
    perform crew_set_job_status(current_setting('p2.job1')::uuid, 'scheduled');
  exception when invalid_parameter_value then ok := true;
  end;
  assert ok, 'completed -> scheduled is not a valid transition';

  ok := false;
  begin
    perform crew_set_job_status(current_setting('p2.job2')::uuid, 'in_progress');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crew A cannot touch crew B''s job';

  ok := false;
  begin
    perform crew_set_job_status('00000000-0000-0000-0000-00000000dead', 'in_progress');
  exception when no_data_found then ok := true;
  end;
  assert ok, 'unknown job raises not found';

  -- Crews change jobs only through crew_set_job_status: direct updates match no rows.
  update jobs set revenue = 1, crew_id = null where id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 0, 'crew cannot update jobs directly';
  update jobs set status = 'scheduled' where id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 0, 'crew cannot change status directly';
end $$;

select set_config('request.jwt.claim.sub', :'est', false);
do $$
declare ok boolean := false;
begin
  begin
    perform crew_set_job_status(current_setting('p2.job2')::uuid, 'in_progress');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'estimators cannot change job status';
end $$;

select set_config('request.jwt.claim.sub', :'crewb', false);
do $$
declare ok boolean := false;
begin
  begin
    perform crew_set_job_status(current_setting('p2.job2')::uuid, 'cancelled');
  exception when invalid_parameter_value then ok := true;
  end;
  assert ok, 'crew B cannot cancel its own job either';
end $$;

select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare r jsonb;
begin
  r := crew_set_job_status(current_setting('p2.job2')::uuid, 'cancelled');
  assert r->>'status' = 'cancelled' and r->>'completed_at' is null, 'office can cancel: ' || r::text;
end $$;

reset role;
do $$ begin
  assert (select revenue from jobs where id = current_setting('p2.job1')::uuid) = 6400, 'revenue untouched by the crew';
  assert (select status from jobs where id = current_setting('p2.job1')::uuid) = 'completed', 'job 1 completed';
  assert (select count(*) from audit_log where action = 'job.status' and row_id = current_setting('p2.job1')) = 2,
    'each status change is audited';
end $$;

-- ---------------------------------------------------------------------------
-- crew_job_view: the signed scope (quantities and hours, never money) for the crew's own jobs
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'crew_job_view'
             and column_name ~ '(price|cost|margin|revenue|financ)') = 0,
    'crew_job_view exposes no money columns';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare v record;
begin
  assert (select count(*) from crew_job_view where job_id = current_setting('p2.job1')::uuid) = 1,
    'one row per signed area (not the revision-only garage)';
  select * into v from crew_job_view where job_id = current_setting('p2.job1')::uuid;
  assert v.signed_tier = 'better' and v.status = 'completed' and v.completed_at is not null, 'status and signed tier visible';
  assert v.area_name = 'Main attic' and v.sqft = 1200 and v.access_level = 'difficult', 'area details visible';
  assert jsonb_array_length(v.scope) = 3, 'scope = the signed option''s material/labor lines for the area: ' || v.scope::text;
  assert v.scope->0->>'product' = 'cellulose' and v.scope->0->>'kind' = 'material' and (v.scope->0->>'qty')::numeric = 70
         and v.scope->0->>'unit' = 'bag', 'material line with the signed quantity (70, not the revision''s 120)';
  assert v.scope->1->>'kind' = 'labor' and (v.scope->1->>'hours')::numeric = 14, 'labor line with the hours the crew should plan';
  assert v.scope->2->>'product' = 'air_sealing', 'air sealing in scope';
  assert not exists (select 1 from jsonb_array_elements(v.scope) e
                      where e ?| array['cost', 'unit_cost', 'model_cost', 'price']), 'scope carries no money';
  assert (select count(*) from crew_job_view where job_id = current_setting('p2.job2')::uuid) = 0, 'crew A cannot see crew B''s job';
end $$;

select set_config('request.jwt.claim.sub', :'crewb', false);
do $$ begin
  assert (select count(*) from crew_job_view where job_id = current_setting('p2.job1')::uuid) = 0, 'another crew sees nothing';
  assert (select count(*) from crew_job_view where job_id = current_setting('p2.job2')::uuid) = 1, 'crew B sees its own job';
  assert (select scope from crew_job_view where job_id = current_setting('p2.job2')::uuid) is null, 'no lines, no scope';
end $$;

-- ---------------------------------------------------------------------------
-- sync_job_actuals: crew entry, idempotency, versions, office costs, verification lock
-- ---------------------------------------------------------------------------
reset role;
create table p2_rows (rows jsonb);
insert into p2_rows values (jsonb_build_array(
  jsonb_build_object('id', 'ac200000-0000-0000-0000-000000000001', 'area_id', 'a2000000-0000-0000-0000-000000000001',
    'product', 'cellulose', 'actual_material_qty', 75, 'actual_material_unit', 'bag', 'actual_hours', 15.5,
    'notes', 'two extra bags', 'base_row_version', null,
    -- never taken from a phone:
    'verified_by', '00000000-0000-0000-0000-0000000000b4', 'verified_at', now(),
    'actual_material_cost', 99999, 'exclude_from_learning', true, 'exclude_reason', 'x'),
  jsonb_build_object('id', 'ac200000-0000-0000-0000-000000000002', 'area_id', null, 'product', null,
    'actual_drive_minutes', 28, 'actual_days', 1, 'actual_crew_size', 2, 'base_row_version', null)));
grant select on p2_rows to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; r2 jsonb; a record; ok boolean := false;
begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000010', current_setting('p2.job1')::uuid, (select rows from p2_rows));
  assert r->>'status' = 'applied' and (r->>'rows')::int = 2 and jsonb_array_length(r->'conflicts') = 0,
    'crew actuals applied: ' || r::text;
  assert (r->'saved'->0->>'row_version')::int = 1 and r->'saved'->0->>'id' = 'ac200000-0000-0000-0000-000000000001',
    'saved rows come back with their row_version: ' || r::text;

  select * into a from crew_actuals_view where id = 'ac200000-0000-0000-0000-000000000001';
  assert a.actual_material_qty = 75 and a.actual_hours = 15.5 and a.notes = 'two extra bags', 'actuals stored';
  assert a.entered_by = '00000000-0000-0000-0000-0000000000b4', 'entered by the crew member';
  assert a.verified_at is null, 'a crew sync can never verify its own rows';

  -- Replaying the mutation returns the first result and writes nothing.
  r2 := sync_job_actuals('d2000000-0000-0000-0000-000000000010', current_setting('p2.job1')::uuid,
          jsonb_set((select rows from p2_rows), '{0,actual_hours}', '99'));
  assert r2 = r, 'replay must be idempotent';
  assert (select actual_hours from crew_actuals_view where id = 'ac200000-0000-0000-0000-000000000001') = 15.5, 'replay writes nothing';
  assert (select count(*) from crew_actuals_view where job_id = current_setting('p2.job1')::uuid) = 2, 'replay adds no rows';

  -- Crews have no direct access to the table (it holds the office's costs).
  assert (select count(*) from job_actuals) = 0, 'crew cannot read job_actuals directly';
  begin
    insert into job_actuals (id, job_id, product, actual_hours, entered_by)
    values ('ac200000-0000-0000-0000-000000000009', current_setting('p2.job1')::uuid, 'air_sealing', 5,
            '00000000-0000-0000-0000-0000000000b4');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crew cannot insert into job_actuals directly';

  -- An area that is not part of the job is refused.
  ok := false;
  begin
    perform sync_job_actuals('d2000000-0000-0000-0000-000000000017', current_setting('p2.job1')::uuid,
      jsonb_build_array(jsonb_build_object('id', 'ac200000-0000-0000-0000-0000000000a1',
        'area_id', 'a2000000-0000-0000-0000-000000000002', 'product', 'batts', 'actual_hours', 1)));
  exception when invalid_parameter_value then ok := true;
  end;
  assert ok, 'an area of another job is refused';
  ok := false;
  begin
    perform sync_job_actuals('d2000000-0000-0000-0000-000000000018', current_setting('p2.job1')::uuid,
      jsonb_build_array(jsonb_build_object('id', 'ac200000-0000-0000-0000-0000000000a2',
        'area_id', 'a2000000-0000-0000-0000-00000000000f', 'product', 'batts', 'actual_hours', 1)));
  exception when invalid_parameter_value then ok := true;
  end;
  assert ok, 'an area added only in an unsigned revision is refused';
end $$;

reset role;
do $$ declare a record; begin
  select * into a from job_actuals where id = 'ac200000-0000-0000-0000-000000000001';
  assert a.actual_material_cost is null and not a.exclude_from_learning and a.verified_by is null,
    'costs, exclusions and verification are never taken from a phone';
end $$;
set role authenticated;

select set_config('request.jwt.claim.sub', :'crewb', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from crew_actuals_view where job_id = current_setting('p2.job1')::uuid) = 0, 'another crew cannot read the actuals';
  begin
    perform sync_job_actuals('d2000000-0000-0000-0000-000000000011', current_setting('p2.job1')::uuid, (select rows from p2_rows));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'another crew cannot enter actuals for the job';
end $$;

select set_config('request.jwt.claim.sub', :'est', false);
do $$
declare ok boolean := false;
begin
  begin
    perform sync_job_actuals('d2000000-0000-0000-0000-000000000012', current_setting('p2.job1')::uuid, (select rows from p2_rows));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'estimators cannot enter actuals';
end $$;

-- A mutation id is its author's: replaying another user's id returns 'rejected', not their result.
select set_config('request.jwt.claim.sub', :'office', false);
do $$ declare r jsonb; begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000010', current_setting('p2.job1')::uuid, (select rows from p2_rows));
  assert r->>'status' = 'rejected', 'another user''s mutation id is rejected: ' || r::text;
end $$;

-- The office adds invoice costs. That bumps the row's version, so a crew edit made against the
-- old version comes back as a conflict (with the server's values) instead of being written.
update job_actuals set actual_material_cost = 812.50, actual_labor_cost = 640
 where id = 'ac200000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; a record; v int;
begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000013', current_setting('p2.job1')::uuid,
         jsonb_build_array(jsonb_set(jsonb_set((select rows->0 from p2_rows), '{actual_hours}', '16'), '{base_row_version}', '1')));
  assert r->>'status' = 'applied' and (r->>'rows')::int = 0 and jsonb_array_length(r->'conflicts') = 1,
    'a stale base is a conflict: ' || r::text;
  v := (r->'conflicts'->0->>'row_version')::int;
  assert v = 2 and (r->'conflicts'->0->>'actual_hours')::numeric = 15.5, 'the conflict carries the server row';
  assert not (r->'conflicts'->0 ?| array['actual_material_cost', 'actual_labor_cost', 'actual_other_cost']), 'and no costs';
  assert (select actual_hours from crew_actuals_view where id = 'ac200000-0000-0000-0000-000000000001') = 15.5, 'nothing written';

  -- The phone merges and re-sends against the version it now knows.
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000019', current_setting('p2.job1')::uuid,
         jsonb_build_array(jsonb_set(jsonb_set((select rows->0 from p2_rows), '{actual_hours}', '16'), '{base_row_version}', to_jsonb(v))));
  assert r->>'status' = 'applied' and (r->>'rows')::int = 1 and (r->'saved'->0->>'row_version')::int = 3, 'merged edit applied: ' || r::text;
  assert (select actual_hours from crew_actuals_view where id = 'ac200000-0000-0000-0000-000000000001') = 16, 'crew correction stored';

  -- A reinstalled phone re-sends the same area x product under a NEW client id without having seen
  -- the row: a conflict naming the existing row, never a duplicate.
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000015', current_setting('p2.job1')::uuid,
         jsonb_build_array(jsonb_set(jsonb_set((select rows->0 from p2_rows), '{id}', '"ac2000ff-0000-0000-0000-0000000000ff"'),
                                     '{actual_hours}', '17')));
  assert jsonb_array_length(r->'conflicts') = 1 and r->'conflicts'->0->>'id' = 'ac200000-0000-0000-0000-000000000001',
    'a new id for an existing area x product is a conflict on the existing row: ' || r::text;
  assert (select count(*) from crew_actuals_view where job_id = current_setting('p2.job1')::uuid) = 2, 'no duplicate row';
end $$;

reset role;
do $$ begin
  assert (select actual_material_cost from job_actuals where id = 'ac200000-0000-0000-0000-000000000001') = 812.50
     and (select actual_labor_cost from job_actuals where id = 'ac200000-0000-0000-0000-000000000001') = 640,
    'office-entered costs preserved on crew re-sync';
end $$;
set role authenticated;

-- Crews never read money: not the jobs table (revenue), not costs, not crew labor rates.
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ declare n int; begin
  assert (select count(*) from jobs) = 0, 'crew cannot select from jobs (revenue)';
  assert (select count(*) from crews) = 0, 'crew cannot read crews (blended labor cost)';
  assert (select count(*) from crew_actuals_view where job_id = current_setting('p2.job1')::uuid) = 2, 'crew reads its actuals through the view';
  assert (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'crew_actuals_view'
             and column_name ~ '(cost|price|revenue|exclude)') = 0, 'crew_actuals_view has no cost or exclusion columns';
  update job_actuals set actual_labor_cost = 2, exclude_from_learning = true, exclude_reason = 'x'
   where job_id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 0, 'crew cannot update costs or exclusions directly';
  delete from job_actuals where job_id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 0, 'crew cannot delete actuals directly';
end $$;

-- The office verifies: the job's actuals are locked for the crew.
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare n int;
begin
  update job_actuals set verified_by = auth.uid(), verified_at = now() where job_id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 2, 'office verifies every row of the job';
end $$;

select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; n int;
begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000014', current_setting('p2.job1')::uuid,
         jsonb_set((select rows from p2_rows), '{0,actual_hours}', '40'));
  assert r->>'status' = 'locked', 'sync after verification is locked: ' || r::text;
  assert (select count(*) from crew_actuals_view where job_id = current_setting('p2.job1')::uuid and verified_at is not null) = 2,
    'crew still sees its verified actuals (without costs)';
end $$;

-- Verified rows are frozen for everyone but the owner; the office may still add costs and exclude.
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare ok boolean := false; n int;
begin
  begin
    update job_actuals set actual_hours = 3 where id = 'ac200000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'office cannot change verified hours';
  ok := false;
  begin
    update job_actuals set verified_at = null, verified_by = null where id = 'ac200000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'office cannot unverify';
  ok := false;
  begin
    delete from job_actuals where id = 'ac200000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'office cannot delete verified actuals';
  update job_actuals set actual_other_cost = 25, exclude_from_learning = true, exclude_reason = 'callback'
   where id = 'ac200000-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  assert n = 1, 'office may add costs and exclude a verified row';
  update job_actuals set exclude_from_learning = false, exclude_reason = null where id = 'ac200000-0000-0000-0000-000000000002';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
do $$ declare n int; begin
  update job_actuals set verified_at = null, verified_by = null where job_id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 2, 'the owner can unverify';
  update job_actuals set verified_by = auth.uid(), verified_at = now() where job_id = current_setting('p2.job1')::uuid;
end $$;

-- A deactivated crew member (or one moved to another role) keeps crew_members rows but loses access.
reset role;
update profiles set active = false where id = :'crewa';
set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ begin
  assert (select count(*) from crew_job_view) = 0, 'a deactivated crew member sees no jobs (customer names, addresses)';
  assert (select count(*) from crew_actuals_view) = 0, 'nor actuals';
end $$;
reset role;
update profiles set active = true, role = 'estimator' where id = :'crewa';
set role authenticated;
do $$ begin
  assert (select count(*) from crew_job_view) = 0, 'a crew member moved to estimator no longer sees the crew''s jobs';
end $$;
reset role;
update profiles set role = 'crew' where id = :'crewa';

do $$ begin
  assert (select actual_hours from job_actuals where id = 'ac200000-0000-0000-0000-000000000001') = 16, 'verified actuals unchanged';
  assert (select count(*) from job_actuals where job_id = current_setting('p2.job1')::uuid and verified_at is not null) = 2,
    'both rows still verified';
end $$;

-- ---------------------------------------------------------------------------
-- reject_coefficient_set: owner only (or the nightly job's service role), candidates only
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '', false);
with s as (
  insert into coefficient_sets (status, source, parent_id, notes)
  select 'candidate', 'nightly', id, 'Nightly calibration: 3 changed' from coefficient_sets where status = 'active'
  returning id)
select set_config('p2.cand1', (select id::text from s), false);
with s as (insert into coefficient_sets (status, source) values ('candidate', 'nightly') returning id)
select set_config('p2.cand2', (select id::text from s), false);
select set_config('p2.active', (select id::text from coefficient_sets where status = 'active'), false);

set role authenticated;
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare ok boolean := false;
begin
  begin
    perform reject_coefficient_set(current_setting('p2.cand1')::uuid, 'office says no');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'office cannot reject coefficient sets';
end $$;

select set_config('request.jwt.claim.sub', :'est', false);
do $$
declare ok boolean := false;
begin
  begin
    perform reject_coefficient_set(current_setting('p2.cand1')::uuid, 'estimator says no');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'estimators cannot reject coefficient sets';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
do $$
declare ok boolean := false;
begin
  perform reject_coefficient_set(current_setting('p2.cand1')::uuid, 'holdout looked worse');
  assert (select status from coefficient_sets where id = current_setting('p2.cand1')::uuid) = 'rejected', 'owner rejects a candidate';
  assert (select notes from coefficient_sets where id = current_setting('p2.cand1')::uuid)
         = E'Nightly calibration: 3 changed\nRejected: holdout looked worse', 'reason appended to the notes';

  begin
    perform reject_coefficient_set(current_setting('p2.cand1')::uuid, 'again');
  exception when others then ok := true;
  end;
  assert ok, 'a rejected set cannot be rejected again';

  ok := false;
  begin
    perform reject_coefficient_set(current_setting('p2.active')::uuid, 'not a candidate');
  exception when others then ok := true;
  end;
  assert ok, 'the active set cannot be rejected';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  assert (select status from coefficient_sets where id = current_setting('p2.active')::uuid) = 'active', 'active set untouched';
  assert (select count(*) from audit_log where action = 'coefficients.reject' and row_id = current_setting('p2.cand1')
            and actor_id = '00000000-0000-0000-0000-0000000000b1') = 1, 'rejection audited with the owner as actor';
  -- The nightly job runs without a user (service role) and may reject a failed candidate.
  perform reject_coefficient_set(current_setting('p2.cand2')::uuid, 'Failed gate(s): backtest');
  assert (select status from coefficient_sets where id = current_setting('p2.cand2')::uuid) = 'rejected', 'service role rejects';
end $$;

-- Promote and roll back: never anon (the public API key), never a signed-in non-owner; the
-- nightly job's service role may promote.
with s as (
  insert into coefficient_sets (status, source, parent_id) select 'candidate', 'nightly', id from coefficient_sets where status = 'active'
  returning id)
select set_config('p2.cand3', (select id::text from s), false);
insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound)
select current_setting('p2.cand3')::uuid, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound
  from coefficients where set_id = current_setting('p2.active')::uuid;
do $$ begin
  assert not has_function_privilege('anon', 'promote_coefficient_set(uuid,text)', 'execute'), 'anon cannot execute promote';
  assert not has_function_privilege('anon', 'rollback_coefficient_set(uuid,text)', 'execute'), 'anon cannot execute rollback';
  assert not has_function_privilege('anon', 'reject_coefficient_set(uuid,text)', 'execute'), 'anon cannot execute reject';
end $$;

set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $$ declare ok boolean := false; begin
  begin
    perform promote_coefficient_set(current_setting('p2.cand3')::uuid, 'anon promoted');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'anon cannot promote a candidate';
end $$;

set role authenticated;
do $$ declare ok boolean := false; begin
  begin
    perform promote_coefficient_set(current_setting('p2.cand3')::uuid, 'no user');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'an authenticated call without a user cannot promote';
end $$;
select set_config('request.jwt.claim.sub', :'office', false);
do $$ declare ok boolean := false; begin
  begin
    perform promote_coefficient_set(current_setting('p2.cand3')::uuid, 'office promoted');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'office cannot promote';
  ok := false;
  begin
    perform rollback_coefficient_set(current_setting('p2.active')::uuid, 'office rollback');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'office cannot roll back';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  assert (select status from coefficient_sets where id = current_setting('p2.cand3')::uuid) = 'candidate', 'candidate untouched';
end $$;
set role service_role;
do $$ begin
  perform promote_coefficient_set(current_setting('p2.cand3')::uuid, 'Nightly: auto-promoted');
end $$;
reset role;
do $$ begin
  assert (select status from coefficient_sets where id = current_setting('p2.cand3')::uuid) = 'active', 'the service role promotes';
  assert (select status from coefficient_sets where id = current_setting('p2.active')::uuid) = 'superseded', 'previous set superseded';
end $$;

-- ---------------------------------------------------------------------------
-- expire_stale_quotes: past-due sent/viewed quotes and their estimates expire, once
-- ---------------------------------------------------------------------------
insert into estimates (id, customer_id, property_id, estimator_id, status, coefficient_set_id, pricing_snapshot, pricing_snapshot_hash)
values
  ('e2000000-0000-0000-0000-000000000003', 'c2100000-0000-0000-0000-000000000001', 'c2200000-0000-0000-0000-000000000001',
   :'est', 'sent', (select id from coefficient_sets where status = 'active'), '{}', 'p2-h3'),
  ('e2000000-0000-0000-0000-000000000004', 'c2100000-0000-0000-0000-000000000001', 'c2200000-0000-0000-0000-000000000001',
   :'est', 'viewed', (select id from coefficient_sets where status = 'active'), '{}', 'p2-h4');
insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
values
  ('f2000000-0000-0000-0000-000000000003', 'e2000000-0000-0000-0000-000000000003', 1, 'sent', 'x/v1.pdf', 'sha-p2-3',
   '{"options": []}', 'p2-token-3', now() - interval '2 days', :'est'),
  ('f2000000-0000-0000-0000-000000000004', 'e2000000-0000-0000-0000-000000000004', 1, 'viewed', 'x/v1.pdf', 'sha-p2-4',
   '{"options": []}', 'p2-token-4', now() + interval '10 days', :'est');

do $$
declare n int;
begin
  n := expire_stale_quotes();
  assert n = 1, 'exactly the past-due quote expired: ' || n;
  assert (select status from quotes where id = 'f2000000-0000-0000-0000-000000000003') = 'expired', 'past-due quote expired';
  assert (select count(*) from quote_events where quote_id = 'f2000000-0000-0000-0000-000000000003' and event = 'expired') = 1,
    'expiry recorded as a quote event';
  assert (select status from estimates where id = 'e2000000-0000-0000-0000-000000000003') = 'expired', 'its estimate expired';
  assert (select decided_at from estimates where id = 'e2000000-0000-0000-0000-000000000003') is not null, 'expiry decides the estimate';

  assert (select status from quotes where id = 'f2000000-0000-0000-0000-000000000004') = 'viewed', 'a quote still valid stays open';
  assert (select status from estimates where id = 'e2000000-0000-0000-0000-000000000004') = 'viewed', 'its estimate stays open';
  assert (select status from quotes where id = 'f2000000-0000-0000-0000-000000000002') = 'signed', 'signed quotes never expire';

  n := expire_stale_quotes();
  assert n = 0, 'a second run expires nothing: ' || n;
  assert (select count(*) from quote_events where quote_id = 'f2000000-0000-0000-0000-000000000003' and event = 'expired') = 1,
    'no duplicate expiry events';
end $$;

\echo '  ok'
