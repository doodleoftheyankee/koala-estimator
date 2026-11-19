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
-- Running the migration again adds nothing and changes nothing
-- ---------------------------------------------------------------------------
create temp table before_rerun as
select (select count(*) from materials) as materials, (select count(*) from coefficients) as coefficients,
       (select string_agg(id::text || cost_per_unit::text, ',' order by id) from materials) as costs;
\i supabase/migrations/20261119000001_accuracy.sql
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
-- them back; tests/sql/01_grants.sql granted them again before this file).
update app_settings set value = '"AB"' where key = 'quote_number_prefix';
\i supabase/migrations/20261119000001_accuracy.sql
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

\echo '  ok'
