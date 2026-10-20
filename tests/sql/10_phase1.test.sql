-- Phase 1 database tests: roles, RLS, offline sync, audit, coefficient promotion/rollback.
-- Each assertion raises on failure; ON_ERROR_STOP makes psql exit non-zero.

\set owner     '00000000-0000-0000-0000-0000000000a1'
\set office    '00000000-0000-0000-0000-0000000000a2'
\set est1      '00000000-0000-0000-0000-0000000000a3'
\set est2      '00000000-0000-0000-0000-0000000000a4'
\set crew      '00000000-0000-0000-0000-0000000000a5'

insert into auth.users (id) values (:'owner'), (:'office'), (:'est1'), (:'est2'), (:'crew');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner'), (:'office', 'office', 'Office'),
  (:'est1', 'estimator', 'Estimator One'), (:'est2', 'estimator', 'Estimator Two'), (:'crew', 'crew', 'Crew');

-- A sync payload for one estimate (snake_case, as lib/sync/payload.ts produces).
create table test_payload as
select jsonb_build_object(
  'estimate', jsonb_build_object(
    'id', '10000000-0000-0000-0000-000000000001', 'status', 'draft',
    'coefficient_set_id', (select id from coefficient_sets where status = 'active'),
    'pricing_snapshot', '{"test": true}'::jsonb, 'pricing_snapshot_hash', 'h1',
    'drive_minutes_est', 20, 'crew_id', null, 'selected_tier', null, 'model_total_price', 5420,
    'notes', null, 'priced_offline', false, 'client_created_at', now(),
    'client_doc', '{"id": "10000000-0000-0000-0000-000000000001", "overrides": {}}'::jsonb),
  'customer', jsonb_build_object('id', '20000000-0000-0000-0000-000000000001', 'first_name', 'Pat', 'last_name', 'Lee',
                                 'email', 'pat@example.com', 'phone', '+13025550100', 'sms_consent', true, 'email_consent', true),
  'property', jsonb_build_object('id', '30000000-0000-0000-0000-000000000001', 'street', '1 Main St', 'city', 'Newark',
                                 'state', 'DE', 'zip', '19711'),
  'areas', jsonb_build_array(jsonb_build_object(
    'id', '40000000-0000-0000-0000-000000000001', 'name', 'Main attic', 'job_type', 'attic', 'sqft', 1000,
    'current_r', 0, 'target_r', null, 'access_level', 'easy', 'removal_needed', false, 'sort_order', 0)),
  'options', jsonb_build_array(jsonb_build_object(
    'id', '50000000-0000-0000-0000-000000000001', 'tier', 'good', 'label', 'Good', 'direct_cost', 2707.67,
    'loaded_cost', 3249.20, 'price', 5420, 'model_price', 5420, 'is_overridden', false, 'margin_pct', 0.4005,
    'crew_days', 1, 'financing', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'id', '60000000-0000-0000-0000-000000000001', 'area_id', '40000000-0000-0000-0000-000000000001',
      'kind', 'material', 'product', 'fiberglass_blown', 'description', 'Blown fiberglass', 'qty', 58,
      'unit', 'bag', 'cost', 2204, 'model_cost', 2204, 'sort_order', 0))))
) as p;
grant select on test_payload to authenticated;

-- ---------------------------------------------------------------------------
-- Estimator 1 creates an estimate via sync
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'est1', false);

do $$
declare r jsonb; r2 jsonb;
begin
  r := sync_upsert_estimate('70000000-0000-0000-0000-000000000001', null, (select p from test_payload));
  assert r->>'status' = 'applied', 'first sync should apply: ' || r::text;
  assert (r->>'row_version')::int = 1, 'new estimate has row_version 1';

  -- replaying the same mutation is a no-op that returns the same result
  r2 := sync_upsert_estimate('70000000-0000-0000-0000-000000000001', null, (select p from test_payload));
  assert r2 = r, 'replay must be idempotent';
  assert (select count(*) from estimate_options) = 1, 'replay must not duplicate options';

  -- an edit on the current version applies and bumps the version
  r := sync_upsert_estimate('70000000-0000-0000-0000-000000000002', 1,
         jsonb_set((select p from test_payload), '{options,0,price}', '5600'));
  assert r->>'status' = 'applied' and (r->>'row_version')::int = 2, 'edit should apply: ' || r::text;
  assert (select price from estimate_options) = 5600, 'option price updated';

  -- a stale base version is a conflict, and nothing changes
  r := sync_upsert_estimate('70000000-0000-0000-0000-000000000003', 1, (select p from test_payload));
  assert r->>'status' = 'conflict' and (r->>'row_version')::int = 2, 'stale edit should conflict: ' || r::text;
  assert (select price from estimate_options) = 5600, 'conflict must not write';

  assert (select count(*) from estimates) = 1, 'estimator sees own estimate';
  assert (select count(*) from customers) = 1, 'estimator sees own customer';
end $$;

-- price change was audited (owner reads audit log)
reset role;
do $$
begin
  assert (select count(*) from audit_log where action = 'estimate.price_change') = 2,
    'two price changes expected (create + edit)';
  assert (select (context->'after'->>'good')::numeric from audit_log where action = 'estimate.price_change' order by id desc limit 1) = 5600,
    'audit captures new price';
end $$;

-- ---------------------------------------------------------------------------
-- Estimator 2 cannot see or overwrite estimator 1's work
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'est2', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from estimates) = 0, 'est2 must not see est1 estimates';
  assert (select count(*) from customers) = 0, 'est2 must not see est1 customers';
  begin
    perform sync_upsert_estimate('70000000-0000-0000-0000-000000000009', null, (select p from test_payload));
  exception when others then ok := true;
  end;
  assert ok, 'est2 must not be able to overwrite est1 estimate';
end $$;

-- ---------------------------------------------------------------------------
-- Office sees everything; crew sees nothing priced
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :'office', false);
do $$ begin
  assert (select count(*) from estimates) = 1, 'office sees all estimates';
  assert (select count(*) from audit_log) = 0, 'office cannot read the audit log';
end $$;

select set_config('request.jwt.claim.sub', :'crew', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from estimates) = 0, 'crew cannot read estimates';
  assert (select count(*) from materials) = 0, 'crew cannot read material costs';
  assert (select count(*) from estimate_options) = 0, 'crew cannot read prices';
  begin
    perform sync_upsert_estimate('70000000-0000-0000-0000-000000000010', null, (select p from test_payload));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crew cannot sync estimates';
end $$;

-- ---------------------------------------------------------------------------
-- Pricing config: estimators read, only the owner writes (and it is audited)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :'est1', false);
do $$ begin
  assert (select count(*) from materials) > 0, 'estimator can read materials (offline pricing)';
  update materials set cost_per_unit = 0;
  assert (select count(*) from materials where cost_per_unit = 0) = 0, 'estimator update must be silently filtered by RLS';
  assert (select count(*) from tier_templates) = 18, 'tier templates seeded';
  assert (select count(*) from coefficient_sets) = 1, 'estimator sees only the active coefficient set';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
update app_settings set value = '0.42' where key = 'target_margin_pct';
do $$ begin
  assert (select count(*) from audit_log where table_name = 'app_settings' and action = 'UPDATE'
          and row_id = 'target_margin_pct' and actor_id = auth.uid()) = 1, 'settings change audited with actor';
end $$;

-- ---------------------------------------------------------------------------
-- Coefficient promotion and rollback
-- ---------------------------------------------------------------------------
reset role;
with s as (
  insert into coefficient_sets (status, source, parent_id)
  select 'candidate', 'nightly', id from coefficient_sets where status = 'active' returning id
)
insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound)
select s.id, kind, product, job_type, access_level,
       case when kind = 'waste_factor' and product = 'cellulose' then 1.12 else value end,
       prior_value, lower_bound, upper_bound
from s, coefficients c where c.set_id = (select id from coefficient_sets where status = 'active');

set role authenticated;
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare ok boolean := false;
begin
  begin
    perform promote_coefficient_set((select id from coefficient_sets where status = 'candidate'), 'x');
  exception when others then ok := true;
  end;
  assert ok, 'office cannot promote coefficients';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
do $$
declare v_seed uuid := (select id from coefficient_sets where source = 'seed');
begin
  perform promote_coefficient_set((select id from coefficient_sets where status = 'candidate'), 'test');
  assert (select count(*) from coefficient_sets where status = 'active') = 1, 'exactly one active set';
  assert (select new_value from coefficient_changes where product = 'cellulose' and kind = 'waste_factor') = 1.12,
    'changelog records the change';
  perform rollback_coefficient_set(v_seed, 'bad night');
  assert (select c.value from coefficients c join coefficient_sets s on s.id = c.set_id
           where s.status = 'active' and c.kind = 'waste_factor' and c.product = 'cellulose') = 1.08,
    'rollback restores the seed value';
  assert (select source from coefficient_sets where status = 'active') = 'rollback', 'rollback creates a new set';
end $$;

reset role;
\echo '  ok'
