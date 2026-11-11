-- AI photo reads: the server (service role) logs a read before the area exists on the server;
-- the person who asked can see it, other estimators can't, the owner sees all, and nobody writes
-- reads or corrections directly. Runs after the earlier test files, so every id here is new.

\set owner '00000000-0000-0000-0000-0000000000c1'
\set est1  '00000000-0000-0000-0000-0000000000c2'
\set est2  '00000000-0000-0000-0000-0000000000c3'

insert into auth.users (id) values (:'owner'), (:'est1'), (:'est2');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner PR'), (:'est1', 'estimator', 'Estimator One'), (:'est2', 'estimator', 'Estimator Two');

-- As the server: a read of an area that hasn't synced yet (no area row, no estimate row).
insert into photo_analyses (id, area_id, estimate_id, created_by, photo_ids, photo_count, model, prompt_version,
                            raw_response, est_sqft, existing_material, existing_depth_in, confidence, cost_usd)
values ('f3000000-0000-0000-0000-000000000001', null, 'e3000000-0000-0000-0000-000000000001', :'est1',
        array['f3100000-0000-0000-0000-000000000001']::uuid[], 1, 'claude-opus-5-5', 'photo-read-test',
        '{"summary": "test"}', 1100, 'Cellulose', 3, 0.6, 0.12);

set role authenticated;

select set_config('request.jwt.claim.sub', :'est1', false);
do $$ begin
  assert (select count(*) from photo_analyses where id = 'f3000000-0000-0000-0000-000000000001') = 1, 'the estimator sees their own read';
end $$;

select set_config('request.jwt.claim.sub', :'est2', false);
do $$ begin
  assert (select count(*) from photo_analyses where id = 'f3000000-0000-0000-0000-000000000001') = 0, 'another estimator does not see it';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
do $$ begin
  assert (select count(*) from photo_analyses where id = 'f3000000-0000-0000-0000-000000000001') = 1, 'the owner sees every read';
end $$;

-- Direct writes are refused: reads and corrections come only from the server.
select set_config('request.jwt.claim.sub', :'est1', false);
do $$
begin
  begin
    insert into photo_analyses (area_id, photo_ids, model, prompt_version, raw_response, created_by)
    values (null, '{}', 'x', 'x', '{}', '00000000-0000-0000-0000-0000000000c2');
    raise exception 'a direct insert into photo_analyses should be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into photo_corrections (analysis_id, field, accepted, corrected_by)
    values ('f3000000-0000-0000-0000-000000000001', 'currentR', true, '00000000-0000-0000-0000-0000000000c2');
    raise exception 'a direct insert into photo_corrections should be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false);
\echo '  ok'
