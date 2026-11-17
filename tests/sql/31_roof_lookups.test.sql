-- Satellite roof lookups: the server (service role) logs a lookup before the area exists on the
-- server; the person who asked can see it, other estimators can't, the owner sees all, and nobody
-- writes lookups directly. A lookup is of an address (with its match key) or of a map pin, and the
-- server finds a finished one of the same house from the last day to use again (by any estimator).
-- Runs after the earlier test files, so every id here is new.

\set owner '00000000-0000-0000-0000-0000000000d1'
\set est1  '00000000-0000-0000-0000-0000000000d2'
\set est2  '00000000-0000-0000-0000-0000000000d3'

insert into auth.users (id) values (:'owner'), (:'est1'), (:'est2');
insert into profiles (id, role, full_name) values
  (:'owner', 'owner', 'Owner RL'), (:'est1', 'estimator', 'Estimator Roof One'), (:'est2', 'estimator', 'Estimator Roof Two');

-- As the server: a finished lookup and one still running, for an area that hasn't synced yet.
insert into roof_lookups (id, created_by, estimate_id, area_id, address, address_key, status, result)
values ('f4000000-0000-0000-0000-000000000001', :'est1', 'e4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001',
        '12 Elkton Rd, Newark, DE 19711', '12 elkton rd newark de 19711', 'done', '{"footprintM2": 217}'),
       ('f4000000-0000-0000-0000-000000000002', :'est1', null, null, '12 Elkton Rd, Newark, DE 19711', '12 elkton rd newark de 19711', 'pending', null);

do $$ begin
  assert (select status from roof_lookups where id = 'f4000000-0000-0000-0000-000000000002') = 'pending', 'a lookup is reserved as pending';
  assert (select created_at > now() - interval '1 minute' from roof_lookups where id = 'f4000000-0000-0000-0000-000000000001'), 'created_at defaults to now';
end $$;

-- Only the three statuses, and an address the app could have sent.
do $$
begin
  begin
    insert into roof_lookups (created_by, address, address_key, status) values ('00000000-0000-0000-0000-0000000000d2', 'x', 'x', 'queued');
    raise exception 'an unknown status should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, address, address_key) values ('00000000-0000-0000-0000-0000000000d2', repeat('x', 201), 'x');
    raise exception 'an address over 200 characters should be refused';
  exception when check_violation then null;
  end;
end $$;

-- An address (with its key) or a pin, never both or neither, and the pin is a real spot.
do $$
declare
  est constant uuid := '00000000-0000-0000-0000-0000000000d2';
begin
  begin
    insert into roof_lookups (created_by) values (est);
    raise exception 'a lookup of nothing should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, address) values (est, '12 Elkton Rd, Newark, DE 19711');
    raise exception 'an address without its match key should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, address, address_key, pin_lat, pin_lng) values (est, '12 Elkton Rd', '12 elkton rd', 39.68, -75.75);
    raise exception 'an address and a pin together should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, pin_lat) values (est, 39.68);
    raise exception 'half a pin should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, pin_lat, pin_lng) values (est, 91, -75.75);
    raise exception 'a latitude past 90 should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into roof_lookups (created_by, pin_lat, pin_lng) values (est, 39.68, -180.5);
    raise exception 'a longitude past 180 should be refused';
  exception when check_violation then null;
  end;
end $$;

-- A pin lookup by the other estimator, an older finished lookup of the same address, one from
-- two days ago and a failed one: the reuse queries the server runs find the newest finished one
-- from the last day, for the address or for a pin within about 2 m.
insert into roof_lookups (id, created_at, created_by, address, address_key, status, result) values
  ('f4000000-0000-0000-0000-000000000003', now() - interval '3 hours', :'est2', '12 elkton rd newark de 19711', '12 elkton rd newark de 19711', 'done', '{"footprintM2": 200}'),
  ('f4000000-0000-0000-0000-000000000004', now() - interval '2 days', :'est2', '12 Elkton Rd, Newark, DE 19711', '12 elkton rd newark de 19711', 'done', '{"footprintM2": 1}'),
  ('f4000000-0000-0000-0000-000000000005', now(), :'est2', '12 Elkton Rd, Newark, DE 19711', '12 elkton rd newark de 19711', 'failed', null);
insert into roof_lookups (id, created_by, estimate_id, area_id, pin_lat, pin_lng, status, result) values
  ('f4000000-0000-0000-0000-000000000006', :'est2', 'e4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 39.6834700, -75.7503900, 'done', '{"footprintM2": 180}');

do $$ begin
  assert (select id from roof_lookups
          where status = 'done' and address_key = '12 elkton rd newark de 19711' and created_at >= now() - interval '24 hours'
          order by created_at desc limit 1) = 'f4000000-0000-0000-0000-000000000001', 'the newest finished lookup of the address from the last day';
  assert (select count(*) from roof_lookups
          where status = 'done' and address_key = '12 elkton rd newark de 19711' and created_at >= now() - interval '24 hours') = 2, 'not the old, pending or failed ones';
  assert (select id from roof_lookups
          where status = 'done' and pin_lat is not null
            and pin_lat between 39.6834700 - 0.00002 and 39.6834700 + 0.00002
            and pin_lng between -75.7503910 - 0.00003 and -75.7503910 + 0.00003
            and created_at >= now() - interval '24 hours') = 'f4000000-0000-0000-0000-000000000006', 'a pin lookup within about 2 m';
  assert (select count(*) from roof_lookups
          where status = 'done' and pin_lat between 39.6835 - 0.00002 and 39.6835 + 0.00002 and pin_lng between -75.75039 - 0.00003 and -75.75039 + 0.00003) = 0,
         'not a pin 3 m away';
  assert (select count(*) from pg_indexes where tablename = 'roof_lookups'
          and indexname in ('roof_lookups_reuse_address_idx', 'roof_lookups_reuse_pin_idx', 'roof_lookups_created_by_idx')) = 3, 'the cap and reuse indexes exist';
  assert (select indexdef from pg_indexes where indexname = 'roof_lookups_reuse_address_idx') like '%(address_key, created_at DESC) WHERE (status = ''done''::text)%',
         'the address reuse index covers finished lookups by key, newest first';
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
