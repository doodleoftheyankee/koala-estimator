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

insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
values ('f2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 1, 'sent',
        'e2000000-0000-0000-0000-000000000001/v1.pdf', 'sha-p2-1', '{"options": []}', 'p2-token-1',
        now() + interval '30 days', :'est');
update estimates set status = 'sent' where id = 'e2000000-0000-0000-0000-000000000001';

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
  assert j.scheduled_days = 1.5, 'scheduled days come from the signed option';
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
  assert (select count(*) from crew_job_view where job_id = current_setting('p2.job1')::uuid) = 1, 'one row per job area';
  select * into v from crew_job_view where job_id = current_setting('p2.job1')::uuid;
  assert v.signed_tier = 'better' and v.status = 'completed' and v.completed_at is not null, 'status and signed tier visible';
  assert v.area_name = 'Main attic' and v.sqft = 1200 and v.access_level = 'difficult', 'area details visible';
  assert jsonb_array_length(v.scope) = 3, 'scope = the signed option''s material/labor lines for the area: ' || v.scope::text;
  assert v.scope->0->>'product' = 'cellulose' and v.scope->0->>'kind' = 'material' and (v.scope->0->>'qty')::numeric = 70
         and v.scope->0->>'unit' = 'bag', 'material line with quantity';
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
-- sync_job_actuals: crew entry, idempotency, office costs, verification lock
-- ---------------------------------------------------------------------------
reset role;
create table p2_rows (rows jsonb);
insert into p2_rows values (jsonb_build_array(
  jsonb_build_object('id', 'ac200000-0000-0000-0000-000000000001', 'area_id', 'a2000000-0000-0000-0000-000000000001',
    'product', 'cellulose', 'actual_material_qty', 75, 'actual_material_unit', 'bag', 'actual_hours', 15.5,
    'notes', 'two extra bags', 'verified_by', '00000000-0000-0000-0000-0000000000b4', 'verified_at', now()),
  jsonb_build_object('id', 'ac200000-0000-0000-0000-000000000002', 'area_id', null, 'product', null,
    'actual_drive_minutes', 28, 'actual_days', 1, 'actual_crew_size', 2)));
grant select on p2_rows to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; r2 jsonb; a record; ok boolean := false;
begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000010', current_setting('p2.job1')::uuid, (select rows from p2_rows));
  assert r->>'status' = 'applied' and (r->>'rows')::int = 2, 'crew actuals applied: ' || r::text;

  select * into a from job_actuals where id = 'ac200000-0000-0000-0000-000000000001';
  assert a.actual_material_qty = 75 and a.actual_hours = 15.5 and a.notes = 'two extra bags', 'actuals stored';
  assert a.entered_by = '00000000-0000-0000-0000-0000000000b4', 'entered by the crew member';
  assert a.verified_by is null and a.verified_at is null, 'a crew sync can never verify its own rows';

  -- Replaying the mutation returns the first result and writes nothing.
  r2 := sync_job_actuals('d2000000-0000-0000-0000-000000000010', current_setting('p2.job1')::uuid,
          jsonb_set((select rows from p2_rows), '{0,actual_hours}', '99'));
  assert r2 = r, 'replay must be idempotent';
  assert (select actual_hours from job_actuals where id = 'ac200000-0000-0000-0000-000000000001') = 15.5, 'replay writes nothing';
  assert (select count(*) from job_actuals where job_id = current_setting('p2.job1')::uuid) = 2, 'replay adds no rows';

  -- Direct writes cannot smuggle in a verification either.
  begin
    insert into job_actuals (id, job_id, product, actual_hours, entered_by, verified_by, verified_at)
    values ('ac200000-0000-0000-0000-000000000009', current_setting('p2.job1')::uuid, 'air_sealing', 5,
            '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b4', now());
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crew cannot insert a verified row';
end $$;

select set_config('request.jwt.claim.sub', :'crewb', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from job_actuals where job_id = current_setting('p2.job1')::uuid) = 0, 'another crew cannot read the actuals';
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

-- The office adds invoice costs; a later crew re-sync must not wipe them.
select set_config('request.jwt.claim.sub', :'office', false);
update job_actuals set actual_material_cost = 812.50, actual_labor_cost = 640
 where id = 'ac200000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', :'crewa', false);
do $$
declare r jsonb; a record;
begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000013', current_setting('p2.job1')::uuid,
         jsonb_set((select rows from p2_rows), '{0,actual_hours}', '16'));
  assert r->>'status' = 'applied', 'crew correction applied: ' || r::text;
  select * into a from job_actuals where id = 'ac200000-0000-0000-0000-000000000001';
  assert a.actual_hours = 16, 'crew correction stored';
  assert a.actual_material_cost = 812.50 and a.actual_labor_cost = 640, 'office-entered costs preserved on crew re-sync';
end $$;

-- A reinstalled phone re-sends the same area x product under a NEW client id: the natural key
-- (job, area, product) updates the existing row instead of failing forever.
do $$
declare r jsonb; n int;
begin
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000015', current_setting('p2.job1')::uuid,
         jsonb_set(jsonb_set((select rows from p2_rows), '{0,id}', '"ac2000ff-0000-0000-0000-0000000000ff"'),
                   '{0,actual_hours}', '17'));
  assert r->>'status' = 'applied', 're-send under a new id applies: ' || r::text;
  select count(*) into n from job_actuals where job_id = current_setting('p2.job1')::uuid;
  assert n = 2, 'no duplicate row for the same area x product: ' || n;
  assert (select actual_hours from job_actuals where id = 'ac200000-0000-0000-0000-000000000001') = 17,
    'the existing row (original id) was updated';
  r := sync_job_actuals('d2000000-0000-0000-0000-000000000016', current_setting('p2.job1')::uuid,
         jsonb_set((select rows from p2_rows), '{0,actual_hours}', '16'));
  assert r->>'status' = 'applied', 'restore hours for later assertions';
end $$;

-- Crews never read prices: the jobs table (revenue = signed price) is invisible to them.
do $$ begin
  assert (select count(*) from jobs) = 0, 'crew cannot select from jobs (revenue)';
  assert (select count(*) from job_actuals where job_id = current_setting('p2.job1')::uuid) = 2, 'crew still reads its actuals';
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

  update job_actuals set actual_hours = 99 where job_id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 0, 'crew cannot update verified actuals';
  delete from job_actuals where job_id = current_setting('p2.job1')::uuid;
  get diagnostics n = row_count;
  assert n = 0, 'crew cannot delete verified actuals';
  assert (select count(*) from job_actuals where job_id = current_setting('p2.job1')::uuid) = 2,
    'crew can still see its verified actuals';
end $$;

reset role;
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
