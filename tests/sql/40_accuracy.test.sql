-- Accuracy round, cavity stage (supabase/migrations/20261119000001_accuracy.sql): dense-pack wall
-- cellulose (L20, OD7), batt sizes by R and thickness (L22, OD8) and the walls cellulose waste cell
-- (L21). Quotes stage: quote numbers from a counter (L12, OD10) and the quote number prefix. The new rows are never a default, so the live site's default-material lookup is unchanged.
-- Runs after the earlier test files (10_phase1 changes the active set), so it reads the seed set
-- where it needs the values the migration wrote.

\set owner '00000000-0000-0000-0000-0000000000e1'
\set est1  '00000000-0000-0000-0000-0000000000e2'

insert into auth.users (id) values (:'owner'), (:'est1');
insert into profiles (id, role, full_name) values (:'owner', 'owner', 'Owner AC'), (:'est1', 'estimator', 'Estimator AC');

-- ---------------------------------------------------------------------------
-- The rows the migration adds
-- ---------------------------------------------------------------------------
do $$
declare
  cel  uuid := (select id from products where code = 'cellulose');
  batt uuid := (select id from products where code = 'batts');
begin
  -- Dense-pack walls: one row, walls only, 122.5 sq ft x in per bag, the cellulose bag cost, flagged.
  assert (select count(*) from materials where product_id = cel and job_type = 'walls') = 1, 'one dense-pack wall cellulose row';
  assert (select name = 'Cellulose bag, dense-pack walls (25 lb)' and unit = 'bag' and coverage_sqft_in = 122.5
                 and not is_default and active and needs_owner_input and r_value is null and thickness_in is null
            from materials where product_id = cel and job_type = 'walls'), 'dense-pack row: 122.5 sq ft x in per 25 lb bag, needs owner input';
  assert (select d.cost_per_unit = m.cost_per_unit
            from materials d join materials m on m.product_id = d.product_id and m.is_default
           where d.product_id = cel and d.job_type = 'walls'), 'dense-pack starts at the current cellulose bag cost';

  -- Seven batt sizes, R-11 to R-38, each with its thickness, at the batt cost, flagged.
  assert (select count(*) from materials where product_id = batt and r_value is not null) = 7, 'seven batt sizes';
  assert (select array_agg(r_value::text || '@' || thickness_in::text order by r_value)
            from materials where product_id = batt and r_value is not null)
         = array['11.0@3.50', '13.0@3.50', '15.0@3.50', '19.0@6.25', '21.0@5.50', '30.0@10.00', '38.0@12.00'],
    'batt sizes R-11 3.5 in to R-38 12 in';
  assert (select bool_and(not s.is_default and s.active and s.needs_owner_input and s.unit = 'sqft' and s.job_type is null
                          and s.cost_per_unit = m.cost_per_unit)
            from materials s join materials m on m.product_id = s.product_id and m.is_default
           where s.product_id = batt and s.r_value is not null), 'batt sizes: not default, any job type, the current batt cost, needs owner input';

  -- What the live site (origin/main) loads: active and default. Still one per product, none new.
  assert (select count(*) from materials where active and is_default) = 6, 'six default materials, as before';
  assert (select count(*) from materials where active and is_default and (job_type is not null or r_value is not null)) = 0,
    'no new row is a default';
  assert (select count(*) from (select product_id from materials where active and is_default group by product_id having count(*) > 1) d) = 0,
    'one default per product';
end $$;

-- The walls cellulose waste cell (L21): in the seed set at the shared value, with its bounds.
do $$
declare v_seed uuid := (select id from coefficient_sets where source = 'seed');
begin
  assert (select value = 1.08 and prior_value = 1.08 and lower_bound = 1.00 and upper_bound = 1.60
            from coefficients where set_id = v_seed and kind = 'waste_factor' and product = 'cellulose' and job_type = 'walls'),
    'walls cellulose waste 1.08, bounds 1.00 to 1.60';
  assert (select value from coefficients where set_id = v_seed and kind = 'waste_factor' and product = 'cellulose' and job_type is null) = 1.08,
    'the shared cellulose cell is unchanged';
  assert (select count(*) from coefficients where set_id = v_seed) = 27, '26 seeded cells plus the walls cell';
end $$;

-- ---------------------------------------------------------------------------
-- The grants as the migrations leave them, before any re-run below (review B database-B5): the test
-- database gets Supabase's default privileges when each object is created (tests/sql/00_supabase_stub.sql,
-- read from production's pg_default_acl), and tests/sql/01_grants.sql no longer grants everything
-- again, so a revoke a migration forgets fails here instead of passing on the re-run's own revoke.
-- ---------------------------------------------------------------------------
do $$ begin
  assert not has_function_privilege('authenticated', 'next_quote_number(int)', 'execute'), 'first run: a signed-in user may not take a quote number';
  assert not has_function_privilege('anon', 'next_quote_number(int)', 'execute'), 'first run: nor may the public';
  assert has_function_privilege('service_role', 'next_quote_number(int)', 'execute'), 'first run: the service role may';
  assert not has_table_privilege('authenticated', 'quote_number_counters', 'select'), 'first run: signed-in users cannot read the counters';
  assert not has_table_privilege('authenticated', 'quote_number_counters', 'update'), 'first run: or move them';
  assert not has_table_privilege('authenticated', 'price_approvals', 'insert'), 'first run: signed-in users cannot write price requests (database-B4)';
  assert has_table_privilege('authenticated', 'price_approvals', 'select') and has_table_privilege('authenticated', 'price_approvals', 'update'),
    'first run: they still read and decide them (RLS says whose)';
  assert not has_table_privilege('anon', 'price_approvals', 'select'), 'first run: the public cannot read approvals';
  assert has_table_privilege('authenticated', 'estimates', 'select'), 'tables a migration does not revoke keep the default grants (as in production)';
end $$;

-- ---------------------------------------------------------------------------
-- Running the migration again adds nothing and changes nothing
-- ---------------------------------------------------------------------------
create temp table before_rerun as
select (select count(*) from materials) as materials, (select count(*) from coefficients) as coefficients,
       (select string_agg(id::text || cost_per_unit::text, ',' order by id) from materials) as costs;
\i tests/sql/rerun_accuracy.psql
do $$ begin
  assert (select materials from before_rerun) = (select count(*) from materials), 'no material added on a second run';
  assert (select coefficients from before_rerun) = (select count(*) from coefficients), 'no coefficient added on a second run';
  assert (select costs from before_rerun) = (select string_agg(id::text || cost_per_unit::text, ',' order by id) from materials),
    'no cost changed on a second run';
end $$;

-- ---------------------------------------------------------------------------
-- The rules the engine relies on
-- ---------------------------------------------------------------------------
do $$
declare ok boolean;
begin
  -- A sized or job-type material can never become a product's default.
  ok := false;
  begin
    update materials set is_default = true where r_value = 21;
  exception when check_violation or unique_violation then ok := true;
  end;
  assert ok, 'a batt size cannot be the default';
  ok := false;
  begin
    update materials set job_type = 'walls' where is_default and product_id = (select id from products where code = 'batts');
  exception when check_violation then ok := true;
  end;
  assert ok, 'the default material has no job type';
  -- A sized material has both its R-value and its thickness.
  ok := false;
  begin
    update materials set thickness_in = null where r_value = 19;
  exception when check_violation then ok := true;
  end;
  assert ok, 'a batt size keeps its thickness';
  ok := false;
  begin
    update materials set r_value = 0, thickness_in = 1 where r_value = 11;
  exception when check_violation then ok := true;
  end;
  assert ok, 'an R-value is positive';
end $$;

-- An estimate line can name the dense-pack row (estimate_lines.material_id), so a priced wall keeps it.
do $$ begin
  assert exists (select 1 from information_schema.columns where table_name = 'estimate_lines' and column_name = 'material_id'),
    'estimate lines keep the material priced';
end $$;

-- ---------------------------------------------------------------------------
-- RLS: estimators read the new rows (offline pricing); only the owner edits them
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'est1', false);
do $$ begin
  assert (select count(*) from materials where job_type is not null or r_value is not null) = 8, 'an estimator reads the dense-pack row and the batt sizes';
  update materials set cost_per_unit = 0 where r_value is not null;
  assert (select count(*) from materials where cost_per_unit = 0) = 0, 'an estimator cannot change them';
  assert (select count(*) from coefficients c join coefficient_sets s on s.id = c.set_id
           where s.status = 'active' and c.kind = 'waste_factor' and c.product = 'cellulose') = 2,
    'an estimator reads both cellulose waste cells of the active set';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
update materials set cost_per_unit = 0.95, needs_owner_input = false where r_value = 21;
do $$ begin
  assert (select cost_per_unit from materials where r_value = 21) = 0.95, 'the owner prices a batt size';
  assert (select count(*) from audit_log where table_name = 'materials' and action = 'UPDATE' and actor_id = auth.uid()) >= 1,
    'the change is audited';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Quote numbers from a counter (L12, OD10)
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select value from app_settings where key = 'quote_number_prefix') = '"KN"'::jsonb, 'the prefix quotes already carry is seeded';
  assert next_quote_number(2026) = 1, 'the first number of a year is 1';
  assert next_quote_number(2026) = 2, 'then 2';
  assert next_quote_number(2027) = 1, 'a new year starts again at 1';
  assert next_quote_number(2026) = 3, 'and the year before goes on from where it was';
  assert (select last_value from quote_number_counters where year = 2026) = 3, 'the counter keeps the last number given';
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform next_quote_number(1999);
  exception when raise_exception then ok := true;
  end;
  assert ok, 'a year out of range is refused';
end $$;

-- Running the migration again keeps the counters and a prefix the owner changed (and the
-- function's grants: Supabase grants every new function to the API roles, the migration takes
-- them back; the same grants were checked on the first run above).
update app_settings set value = '"AB"' where key = 'quote_number_prefix';
\i tests/sql/rerun_accuracy.psql
do $$ begin
  assert (select value from app_settings where key = 'quote_number_prefix') = '"AB"'::jsonb, 'a saved prefix is kept on a second run';
  assert (select last_value from quote_number_counters where year = 2026) = 3, 'the counters are kept on a second run';
  assert (select prosecdef from pg_proc where proname = 'next_quote_number'), 'next_quote_number runs as its owner';
  assert (select proconfig::text from pg_proc where proname = 'next_quote_number') like '%search_path=public, pg_temp%', 'with a pinned search_path';
  assert has_function_privilege('service_role', 'next_quote_number(int)', 'execute'), 'the service role (the send route) may call it';
  assert not has_function_privilege('authenticated', 'next_quote_number(int)', 'execute'), 'a signed-in user may not';
  assert not has_function_privilege('anon', 'next_quote_number(int)', 'execute'), 'nor may the public';
end $$;
update app_settings set value = '"KN"' where key = 'quote_number_prefix';

-- Nobody but the server reads or moves the counter.
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
do $$
declare ok boolean := false;
begin
  begin
    perform next_quote_number(2026);
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'even the owner cannot take a number directly';
  ok := false;
  begin
    perform count(*) from quote_number_counters;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'or read the counters';
  ok := false;
  begin
    update quote_number_counters set last_value = 1;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'or move them';
end $$;
reset role;

-- ===========================================================================
-- Flow stage (L11, L34, L35)
-- ===========================================================================
\set office '00000000-0000-0000-0000-0000000000e3'
\set est2   '00000000-0000-0000-0000-0000000000e4'
\set crew   '00000000-0000-0000-0000-0000000000e5'
insert into auth.users (id) values (:'office'), (:'est2'), (:'crew');
insert into profiles (id, role, full_name) values (:'office', 'office', 'Office AC'), (:'est2', 'estimator', 'Estimator AC 2'), (:'crew', 'crew', 'Crew AC');

-- ---------------------------------------------------------------------------
-- L11: every material has its usual cost range, half to twice its cost when the migration ran
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select count(*) from materials where cost_per_unit > 0 and (typical_min is null or typical_max is null)) = 0,
    'every priced material has a usual range';
  -- (Earlier test files change some costs after the migration ran; a batt size no test touches shows the rule.)
  assert (select typical_min = round(cost_per_unit / 2, 4) and typical_max = round(cost_per_unit * 2, 4)
            from materials where r_value = 11), 'the starting range is half to twice the cost';
  assert (select bool_and(typical_max = typical_min * 4) from materials where typical_source like 'Starting range%'),
    'every starting range runs from half to twice one cost';
  assert (select bool_and(typical_source like 'Starting range: half to twice%') from materials where typical_min is not null),
    'the range says where it comes from';
end $$;
do $$
declare ok boolean := false;
begin
  begin
    update materials set typical_min = 2, typical_max = 1 where r_value = 11;
  exception when check_violation then ok := true;
  end;
  assert ok, 'a range runs from low to high';
end $$;
-- An owner's own range (and cost) is kept when the migration runs again.
update materials set typical_min = 0.5, typical_max = 1.5, typical_source = 'Supplier price list' where r_value = 13;
\i tests/sql/rerun_accuracy.psql
do $$ begin
  assert (select typical_min = 0.5 and typical_max = 1.5 and typical_source = 'Supplier price list' from materials where r_value = 13),
    'a range the owner entered is kept on a second run';
end $$;

-- ---------------------------------------------------------------------------
-- L35: a signed estimate answers 'locked' before the row-version check
-- ---------------------------------------------------------------------------
create table flow_payload as
select jsonb_build_object(
  'estimate', jsonb_build_object(
    'id', 'f1000000-0000-0000-0000-000000000001', 'status', 'draft',
    'coefficient_set_id', (select id from coefficient_sets where status = 'active'),
    'pricing_snapshot', '{"test": true}'::jsonb, 'pricing_snapshot_hash', 'h1',
    'drive_minutes_est', 20, 'crew_id', null, 'selected_tier', null, 'model_total_price', 5420,
    'notes', null, 'priced_offline', false, 'client_created_at', now(),
    'client_doc', '{"id": "f1000000-0000-0000-0000-000000000001", "overrides": {}}'::jsonb),
  'customer', jsonb_build_object('id', 'f2000000-0000-0000-0000-000000000001', 'first_name', 'Sam', 'last_name', 'Flow',
                                 'email', 'sam@example.com', 'phone', null, 'sms_consent', false, 'email_consent', true),
  'property', jsonb_build_object('id', 'f3000000-0000-0000-0000-000000000001', 'street', '9 Test Rd', 'city', 'Springfield',
                                 'state', 'IL', 'zip', '62701'),
  'areas', '[]'::jsonb,
  'options', jsonb_build_array(jsonb_build_object(
    'id', 'f5000000-0000-0000-0000-000000000001', 'tier', 'better', 'label', 'Better', 'direct_cost', 2707.67,
    'loaded_cost', 3249.20, 'price', 5420, 'model_price', 5420, 'is_overridden', false, 'margin_pct', 0.4005,
    'crew_days', 1, 'financing', null, 'lines', '[]'::jsonb))
) as p;
grant select on flow_payload to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', :'est1', false);
do $$
declare r jsonb;
begin
  r := sync_upsert_estimate('f7000000-0000-0000-0000-000000000001', null, (select p from flow_payload));
  assert r->>'status' = 'applied' and (r->>'row_version')::int = 1, 'the estimate is created: ' || r::text;
  -- An empty state keeps the stored property's state (no state is written in by the database).
  r := sync_upsert_estimate('f7000000-0000-0000-0000-000000000002', 1,
         jsonb_set((select p from flow_payload), '{property,state}', '""'));
  assert r->>'status' = 'applied', 'an edit applies: ' || r::text;
  assert (select state from properties where id = 'f3000000-0000-0000-0000-000000000001') = 'IL', 'an empty state keeps the stored one';
end $$;
reset role;
-- The customer signs (the server writes it): the row version moves on.
update estimates set status = 'signed' where id = 'f1000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub', :'est1', false);
do $$
declare r jsonb; v int;
begin
  v := (select row_version from estimates where id = 'f1000000-0000-0000-0000-000000000001');
  -- The phone had an unsent edit made before it heard about the signature: its base is the old version.
  r := sync_upsert_estimate('f7000000-0000-0000-0000-000000000003', 2,
         jsonb_set((select p from flow_payload), '{options,0,price}', '5000'));
  assert r->>'status' = 'locked', 'a signed estimate answers locked, not conflict: ' || r::text;
  assert (r->>'row_version')::int = v and r->'server_doc' is not null, 'with the signed version and its document';
  -- On the current version it is locked too.
  r := sync_upsert_estimate('f7000000-0000-0000-0000-000000000004', v,
         jsonb_set((select p from flow_payload), '{options,0,price}', '5000'));
  assert r->>'status' = 'locked', 'locked on the current version as well: ' || r::text;
  assert (select price from estimate_options where estimate_id = 'f1000000-0000-0000-0000-000000000001') = 5420, 'nothing was written';
  assert (select status from estimates where id = 'f1000000-0000-0000-0000-000000000001') = 'signed', 'still signed';
  -- A stale edit of an estimate that is not signed is still a conflict.
end $$;
reset role;
do $$ begin
  assert (select prosecdef from pg_proc where proname = 'sync_upsert_estimate') = false, 'the sync function still runs as the caller (RLS applies)';
  assert has_function_privilege('authenticated', 'sync_upsert_estimate(uuid, int, jsonb)', 'execute'), 'signed-in staff may call it';
  assert not has_function_privilege('anon', 'sync_upsert_estimate(uuid, int, jsonb)', 'execute'), 'the public may not';
  assert (select count(*) from pg_proc where proname = 'sync_upsert_estimate') = 1, 'one function, same signature';
end $$;

-- ---------------------------------------------------------------------------
-- L34: price approvals. Staff read; an estimator (or the office) asks; the owner or the office
-- decides; nobody decides their own request; below the floor margin only the owner.
-- Review B database-B4: a request is written by the server only (app/api/approvals prices it first and
-- writes it with the service role), so what the owner sees is never typed in by the asker.
-- ---------------------------------------------------------------------------
reset role;
update estimates set status = 'draft' where id = 'f1000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub', :'est1', false);
do $$
declare ok boolean := false;
begin
  -- The estimator posting straight to the database with numbers of their own (database-B4).
  begin
    insert into price_approvals (estimate_id, tier, price, model_price, below_floor, requested_by)
    values ('f1000000-0000-0000-0000-000000000001', 'good', 3500, 5420, false, auth.uid());
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'an estimator cannot write a price request into the database directly';
  assert (select count(*) from price_approvals) = 0, 'nothing was written';
end $$;
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare ok boolean := false;
begin
  begin
    insert into price_approvals (estimate_id, tier, price, model_price, requested_by)
    values ('f1000000-0000-0000-0000-000000000001', 'good', 2000, 2400, auth.uid());
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'nor can the office';
end $$;
reset role;

-- The server writes the requests: the service role, with no user in its token.
select set_config('request.jwt.claim.sub', '', false);
set role service_role;
do $$
declare v_id uuid; ok boolean;
begin
  insert into price_approvals (estimate_id, tier, price, model_price, below_floor, loaded_cost, note, requested_by)
  values ('f1000000-0000-0000-0000-000000000001', 'better', 4500, 5420, false, 3249.20, 'Neighbour discount', '00000000-0000-0000-0000-0000000000e2')
  returning id into v_id;
  assert (select requested_by from price_approvals where id = v_id) = '00000000-0000-0000-0000-0000000000e2', 'the server writes it as the asker';
  assert (select status from price_approvals where id = v_id) = 'pending', 'and it starts pending';
  -- One pending request per estimate, option, price and cost.
  ok := false;
  begin
    insert into price_approvals (estimate_id, tier, price, model_price, loaded_cost, requested_by)
    values ('f1000000-0000-0000-0000-000000000001', 'better', 4500, 5420, 3249.20, '00000000-0000-0000-0000-0000000000e2');
  exception when unique_violation then ok := true;
  end;
  assert ok, 'the same request is not queued twice';
  -- Whole dollars only.
  ok := false;
  begin
    insert into price_approvals (estimate_id, tier, price, model_price, requested_by)
    values ('f1000000-0000-0000-0000-000000000001', 'better', 4500.50, 5420, '00000000-0000-0000-0000-0000000000e2');
  exception when check_violation then ok := true;
  end;
  assert ok, 'an approval is for a whole-dollar price';
  insert into price_approvals (estimate_id, tier, price, model_price, below_floor, loaded_cost, requested_by)
  values ('f1000000-0000-0000-0000-000000000001', 'best', 3000, 7000, true, 2800.00, '00000000-0000-0000-0000-0000000000e2');
  -- A request the office made: the office does not decide it (below).
  insert into price_approvals (estimate_id, tier, price, model_price, loaded_cost, requested_by)
  values ('f1000000-0000-0000-0000-000000000001', 'good', 2000, 2400, 1500.00, '00000000-0000-0000-0000-0000000000e3');
end $$;
reset role;

-- A row written with a user's token is always that user's own and starts pending (the guard trigger).
select set_config('request.jwt.claim.sub', :'est1', false);
do $$
declare v_id uuid;
begin
  insert into price_approvals (estimate_id, tier, price, model_price, requested_by, status)
  values ('f1000000-0000-0000-0000-000000000001', 'good', 2100, 2400, '00000000-0000-0000-0000-0000000000e3', 'approved')
  returning id into v_id;
  assert (select requested_by = auth.uid() and status = 'pending' from price_approvals where id = v_id), 'the request is always the asker''s own, and pending';
  delete from price_approvals where id = v_id;
end $$;

-- The estimator cannot approve it.
set role authenticated;
select set_config('request.jwt.claim.sub', :'est1', false);
do $$ begin
  assert (select count(*) from price_approvals where estimate_id = 'f1000000-0000-0000-0000-000000000001') = 3, 'the estimator reads the requests on their estimate';
  update price_approvals set status = 'approved' where tier = 'better';
  assert (select status from price_approvals where tier = 'better') = 'pending', 'an estimator cannot approve (not even their own)';
end $$;

-- Another estimator sees none of it and cannot ask for an estimate that is not theirs.
select set_config('request.jwt.claim.sub', :'est2', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from price_approvals) = 0, 'another estimator reads none';
  begin
    insert into price_approvals (estimate_id, tier, price, model_price, requested_by)
    values ('f1000000-0000-0000-0000-000000000001', 'good', 1000, 1500, auth.uid());
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'and cannot ask for someone else''s estimate';
end $$;

-- Crews read none.
select set_config('request.jwt.claim.sub', :'crew', false);
do $$ begin
  assert (select count(*) from price_approvals) = 0, 'crews read no approvals';
end $$;

-- The office approves the price inside its own powers, not the one below the floor.
select set_config('request.jwt.claim.sub', :'office', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from price_approvals where estimate_id = 'f1000000-0000-0000-0000-000000000001') = 3, 'the office reads the requests';
  update price_approvals set status = 'approved', decision_note = 'OK' where tier = 'better' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  assert (select status = 'approved' and decided_by = auth.uid() and decided_role = 'office' and decided_at is not null
            from price_approvals where tier = 'better' and estimate_id = 'f1000000-0000-0000-0000-000000000001'),
    'the office approves it; who and when are recorded by the database';
  begin
    update price_approvals set status = 'approved' where tier = 'best' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'only the owner approves a price below the floor margin';
  -- A request the office made itself (the server wrote it above) is not the office's to decide.
  update price_approvals set status = 'approved' where tier = 'good' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  assert (select status from price_approvals where tier = 'good' and estimate_id = 'f1000000-0000-0000-0000-000000000001') = 'pending',
    'nobody approves their own request';
end $$;

-- The owner approves below the floor; a decision cannot be changed, nor what was approved.
select set_config('request.jwt.claim.sub', :'owner', false);
do $$
declare ok boolean := false;
begin
  update price_approvals set status = 'approved' where tier = 'best' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  assert (select status = 'approved' and decided_role = 'owner' from price_approvals where tier = 'best' and estimate_id = 'f1000000-0000-0000-0000-000000000001'),
    'the owner approves below the floor';
  update price_approvals set status = 'declined' where tier = 'better' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  assert (select status from price_approvals where tier = 'better' and estimate_id = 'f1000000-0000-0000-0000-000000000001') = 'approved',
    'a decision stands';
  begin
    update price_approvals set status = 'approved', price = 1 where tier = 'good' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  exception when raise_exception then ok := true;
  end;
  assert ok, 'approving cannot change the price asked';
  update price_approvals set status = 'declined', decision_note = 'Too low' where tier = 'good' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  assert (select status from price_approvals where tier = 'good' and estimate_id = 'f1000000-0000-0000-0000-000000000001') = 'declined', 'the owner declines';
  assert (select count(*) from audit_log where table_name = 'price_approvals') >= 5, 'requests and decisions are audited';
end $$;
reset role;
do $$
declare ok boolean := false;
begin
  begin
    update price_approvals set status = 'pending' where tier = 'good' and estimate_id = 'f1000000-0000-0000-0000-000000000001';
  exception when raise_exception then ok := true;
  end;
  assert ok, 'not even the server reopens a decision';
  assert not has_table_privilege('anon', 'price_approvals', 'select'), 'the public cannot read approvals';
end $$;

-- Running the migration again keeps every approval.
create temp table approvals_before as select count(*) as n, string_agg(id::text || status, ',' order by id) as s from price_approvals;
\i tests/sql/rerun_accuracy.psql
do $$ begin
  assert (select n from approvals_before) = (select count(*) from price_approvals)
     and (select s from approvals_before) = (select string_agg(id::text || status, ',' order by id) from price_approvals),
    'approvals are kept on a second run';
end $$;

\echo '  ok'
