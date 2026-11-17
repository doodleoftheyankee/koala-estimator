-- Satellite roof lookups: the server (service role) logs a lookup before the area exists on the
-- server; the person who asked can see it, other estimators can't, the owner sees all, and nobody
-- writes lookups directly. Runs after the earlier test files, so every id here is new.

\set owner '00000000-0000-0000-0000-0000000000d1'
\set est1  '00000000-0000-0000-0000-0000000000d2'
\set est2  '00000000-0000-0000-0000-0000000000d3'

insert into auth.users (id) values (:'owner'), (:'est1'), (:'est2');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner RL'), (:'est1', 'estimator', 'Estimator Roof One'), (:'est2', 'estimator', 'Estimator Roof Two');

-- As the server: a finished lookup and one still running, for an area that hasn't synced yet.
insert into roof_lookups (id, created_by, estimate_id, area_id, address, status, result)
values ('f4000000-0000-0000-0000-000000000001', :'est1', 'e4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001',
        '12 Elkton Rd, Newark, DE 19711', 'done', '{"footprintM2": 217}'),
       ('f4000000-0000-0000-0000-000000000002', :'est1', null, null, '12 Elkton Rd, Newark, DE 19711', 'pending', null);

do $$ begin
  assert (select status from roof_lookups where id = 'f4000000-0000-0000-0000-000000000002') = 'pending', 'a lookup is reserved as pending';
  assert (select created_at > now() - interval '1 minute' from roof_lookups where id = 'f4000000-0000-0000-0000-000000000001'), 'created_at defaults to now';
end $$;

-- Only the three statuses, and an address the app could have sent.
do $$
begin
  begin
    insert into roof_lookups (created_by, address, status) values ('00000000-0000-0000-0000-0000000000d2', 'x', 'queued');
    raise exception 'an unknown status should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, address) values ('00000000-0000-0000-0000-0000000000d2', repeat('x', 201));
    raise exception 'an address over 200 characters should be refused';
  exception when check_violation then null;
  end;
end $$;

set role authenticated;

select set_config('request.jwt.claim.sub', :'est1', false);
do $$ begin
  assert (select count(*) from roof_lookups where created_by = '00000000-0000-0000-0000-0000000000d2') = 2, 'the estimator sees their own lookups';
end $$;

select set_config('request.jwt.claim.sub', :'est2', false);
do $$ begin
  assert (select count(*) from roof_lookups where created_by = '00000000-0000-0000-0000-0000000000d2') = 0, 'another estimator does not see them';
end $$;

select set_config('request.jwt.claim.sub', :'owner', false);
do $$ begin
  assert (select count(*) from roof_lookups where created_by = '00000000-0000-0000-0000-0000000000d2') = 2, 'the owner sees every lookup';
end $$;

-- Direct writes are refused or change nothing: lookups come only from the server.
select set_config('request.jwt.claim.sub', :'est1', false);
do $$
begin
  begin
    insert into roof_lookups (created_by, address) values ('00000000-0000-0000-0000-0000000000d2', '12 Elkton Rd, Newark, DE 19711');
    raise exception 'a direct insert into roof_lookups should be refused';
  exception when insufficient_privilege then null;
  end;
end $$;
update roof_lookups set status = 'done', result = '{"footprintM2": 1}' where id = 'f4000000-0000-0000-0000-000000000002';
delete from roof_lookups where id = 'f4000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', :'owner', false);
update roof_lookups set error = 'edited' where id = 'f4000000-0000-0000-0000-000000000001';
delete from roof_lookups where id = 'f4000000-0000-0000-0000-000000000002';

reset role;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  assert (select count(*) from roof_lookups where created_by = '00000000-0000-0000-0000-0000000000d2') = 2, 'nobody deletes lookups through RLS';
  assert (select status from roof_lookups where id = 'f4000000-0000-0000-0000-000000000002') = 'pending', 'the creator cannot update a lookup';
  assert (select error is null from roof_lookups where id = 'f4000000-0000-0000-0000-000000000001'), 'the owner cannot update a lookup';
end $$;
\echo '  ok'
