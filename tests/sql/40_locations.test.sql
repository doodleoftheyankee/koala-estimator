-- Multi-location database tests: a second store is opened, and every role in each store is
-- kept out of the other store's data; pricing sets are per store; crews still see no prices;
-- corporate reads everything and writes nothing; opt-outs are shared; and nothing done in the
-- second store moves the pilot store's prices. Runs last, after the earlier tests left data in
-- the pilot store. Each assertion raises on failure; ON_ERROR_STOP makes psql exit non-zero.

\set ownb    '00000000-0000-0000-0000-0000000000e1'
\set offb    '00000000-0000-0000-0000-0000000000e2'
\set estb    '00000000-0000-0000-0000-0000000000e3'
\set crewb   '00000000-0000-0000-0000-0000000000e4'
\set both    '00000000-0000-0000-0000-0000000000e5'
\set corp    '00000000-0000-0000-0000-0000000000e6'
\set newb    '00000000-0000-0000-0000-0000000000e7'
\set owna    '00000000-0000-0000-0000-0000000000a1'
\set offa    '00000000-0000-0000-0000-0000000000a2'
\set esta    '00000000-0000-0000-0000-0000000000a3'
\set crewa   '00000000-0000-0000-0000-0000000000b4'

-- The pilot store's pricing rows, fingerprinted (same rows the bundle loader reads).
create function pilot_pricing_md5() returns text language sql security definer set search_path = public as $$
  with l as (select id from locations order by created_at limit 1)
  select md5(concat_ws('|',
    (select string_agg(a.key || '=' || a.value::text, ',' order by a.key) from app_settings a, l where a.location_id = l.id),
    (select string_agg(m.id || ':' || m.cost_per_unit || ':' || coalesce(m.coverage_sqft_in::text, '-'), ',' order by m.id)
       from materials m, l where m.location_id = l.id and m.active and m.is_default),
    (select string_agg(c.id || ':' || c.size || ':' || c.blended_hourly_cost, ',' order by c.id) from crews c, l where c.location_id = l.id and c.active),
    (select string_agg(cr.job_type::text || cr.assembly || cr.min_r, ',' order by cr.id) from code_requirements cr, l where cr.location_id = l.id and cr.is_default),
    (select string_agg(t.job_type::text || t.tier::text || t.primary_product::text || coalesce(t.target_r::text, '-'), ',' order by t.id)
       from tier_templates t, l where t.location_id = l.id and t.active),
    (select string_agg(c.kind::text || coalesce(c.product::text, '') || coalesce(c.job_type::text, '') || coalesce(c.access_level::text, '')
                       || '=' || c.value, ',' order by c.id)
       from coefficients c join coefficient_sets s on s.id = c.set_id, l where s.location_id = l.id and s.status = 'active'),
    (select string_agg(code::text || r_per_inch, ',' order by code) from products where active)))
$$;
grant execute on function pilot_pricing_md5() to authenticated;
create table t_ids (k text primary key, v text);
grant select on t_ids to authenticated, service_role;
insert into t_ids values ('pilot', (select id::text from locations order by created_at limit 1)),
                         ('pilot_md5', pilot_pricing_md5()),
                         ('pilot_set', (select s.id::text from coefficient_sets s join locations l on l.id = s.location_id
                                         where s.status = 'active' order by l.created_at limit 1));

-- ---------------------------------------------------------------------------
-- The conversion carried the pilot store over whole
-- ---------------------------------------------------------------------------
do $$
declare v_pilot uuid := (select v::uuid from t_ids where k = 'pilot');
begin
  assert (select count(*) from locations) = 1, 'one store after the migrations';
  assert (select count(*) from profiles p where not exists
           (select 1 from location_members m where m.profile_id = p.id and m.location_id = v_pilot and m.role = p.role)) = 0,
    'every person works in the pilot store with the role they had';
  assert (select count(*) from estimates where location_id is distinct from v_pilot) = 0, 'every estimate is the pilot store''s';
  assert (select count(*) from jobs where location_id is distinct from v_pilot) = 0, 'every job is the pilot store''s';
  assert (select count(*) from coefficient_sets where location_id is distinct from v_pilot) = 0, 'every pricing set is the pilot store''s';
  assert (select time_zone from locations) = 'America/New_York', 'time zone from the settings';
  assert (select state from locations) = 'DE', 'state';
  assert (select column_default from information_schema.columns
           where table_name = 'properties' and column_name = 'state') is null, 'no Delaware default on new addresses';
end $$;

-- A second store needs the cleanup migration (the old settings key index) first.
do $$
declare ok boolean := false;
begin
  begin
    perform create_location('Koala Insulation of Testville', 'Testville', 'America/Chicago', 'TX', '2A');
  exception when others then ok := sqlerrm like '%cleanup migration%';
  end;
  assert ok, 'create_location refuses before the cleanup';
end $$;
drop index app_settings_key_compat;   -- what the cleanup migration does

-- Only the server opens stores.
set role authenticated;
select set_config('request.jwt.claim.sub', :'owna', false);
do $$
declare ok boolean := false;
begin
  begin
    perform create_location('Koala Insulation of Elsewhere', 'Elsewhere', 'America/Chicago', 'TX', '2A');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'a signed-in owner cannot open a store';
end $$;
reset role;

insert into t_ids values ('b', create_location('Koala Insulation of Testville', 'Testville', 'America/Chicago', 'tx', '2a',
                                               'Travis', '1 Test Rd, Testville, TX'));

do $$
declare
  v_pilot uuid := (select v::uuid from t_ids where k = 'pilot');
  v_b uuid := (select v::uuid from t_ids where k = 'b');
begin
  assert (select state || climate_zone from locations where id = v_b) = 'TX2A', 'state and zone upper-cased';
  assert (select count(*) from app_settings where location_id = v_b) =
         (select count(*) from app_settings where location_id = v_pilot and key not in ('branding', 'shop_address')),
    'settings copied';
  assert (select value #>> '{}' from app_settings where location_id = v_b and key = 'quote_terms') like '%Koala Insulation of Testville%',
    'quote terms name the new store';
  assert (select value #>> '{}' from app_settings where location_id = v_b and key = 'quote_terms') not like
         '%' || (select name from locations where id = v_pilot) || '%', 'quote terms do not name the pilot store';
  assert (select value->>'tz' from app_settings where location_id = v_b and key = 'followup_quiet_hours') = 'America/Chicago',
    'quiet hours in the new store''s time zone';
  assert (select (value #>> '{}')::uuid from app_settings where location_id = v_b and key = 'default_crew_id')
         in (select id from crews where location_id = v_b), 'default crew is the new store''s copy';
  assert (select bool_and(needs_owner_input) from crews where location_id = v_b), 'copied crews flagged to confirm';
  assert (select bool_and(needs_owner_input) from materials where location_id = v_b), 'copied costs flagged to confirm';
  assert (select count(*) from crews where name = 'Crew A') = 2, 'two stores can each have a Crew A';
  assert (select count(*) from tier_templates where location_id = v_b) = 18, 'tier menu copied';
  assert (select bool_and(source_note like 'Copied from%CONFIRM for TX, climate zone 2A.') from code_requirements where location_id = v_b),
    'copied code minimums flagged to confirm';
  -- A: fresh pricing set from the industry starting values, not the pilot's learned numbers.
  assert (select count(*) from coefficient_sets where location_id = v_b and status = 'active') = 1, 'one active set in the new store';
  assert (select count(*) from coefficient_sets where location_id = v_pilot and status = 'active') = 1, 'still one active set in the pilot';
  assert not exists (
    select 1 from coefficients c join coefficient_sets s on s.id = c.set_id
     where s.location_id = v_b and s.status = 'active' and (c.value <> c.prior_value or c.sample_size <> 0)),
    'new store starts from the starting values with no learned evidence';
  assert (select count(*) from coefficients c join coefficient_sets s on s.id = c.set_id
           where s.location_id = v_b and s.status = 'active') = 26, 'every coefficient present';
end $$;

-- People: an owner, office, estimator and crew in the new store; one estimator in both; corporate.
insert into auth.users (id) values (:'ownb'), (:'offb'), (:'estb'), (:'crewb'), (:'both'), (:'corp'), (:'newb');
insert into profiles (id, role, full_name) values
  (:'ownb', 'owner', 'Owner B'), (:'offb', 'office', 'Office B'), (:'estb', 'estimator', 'Estimator B'),
  (:'crewb', 'crew', 'Crew B'), (:'both', 'estimator', 'Estimator Both'), (:'corp', 'office', 'Corporate');
update profiles set corporate = true where id = :'corp';

do $$ begin
  assert (select count(*) from location_members m where m.profile_id in
           ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e6')) = 0,
    'with two stores, new people do not join a store by themselves';
end $$;

insert into location_members (location_id, profile_id, role)
select (select v::uuid from t_ids where k = 'b'), x.id::uuid, x.role::user_role from (values
  (:'ownb', 'owner'), (:'offb', 'office'), (:'estb', 'estimator'), (:'crewb', 'crew'), (:'both', 'estimator')) x(id, role);
insert into location_members (location_id, profile_id, role)
values ((select v::uuid from t_ids where k = 'pilot'), :'both', 'estimator');

insert into crew_members (crew_id, profile_id, is_lead)
select id, :'crewb', true from crews where location_id = (select v::uuid from t_ids where k = 'b');

do $$
declare ok boolean := false;
begin
  begin
    -- A pilot crew member cannot be put on the new store's crew.
    insert into crew_members (crew_id, profile_id)
    select id, '00000000-0000-0000-0000-0000000000b4' from crews where location_id = (select v::uuid from t_ids where k = 'b');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crews only take people from their own store';
end $$;

-- ---------------------------------------------------------------------------
-- An estimator in the new store syncs an estimate: it belongs to that store
-- ---------------------------------------------------------------------------
create table b_payload as
select jsonb_build_object(
  'estimate', jsonb_build_object(
    'id', 'e4000000-0000-0000-0000-000000000001', 'status', 'ready',
    'coefficient_set_id', (select id from coefficient_sets where status = 'active'
                              and location_id = (select v::uuid from t_ids where k = 'b')),
    'pricing_snapshot', '{"test": "b"}'::jsonb, 'pricing_snapshot_hash', 'b-h1',
    'drive_minutes_est', 15, 'crew_id', null, 'selected_tier', 'good', 'model_total_price', 3000,
    'notes', null, 'priced_offline', false, 'client_created_at', now(),
    'client_doc', '{"id": "e4000000-0000-0000-0000-000000000001"}'::jsonb),
  'customer', jsonb_build_object('id', 'c4000000-0000-0000-0000-000000000001', 'first_name', 'Tex', 'last_name', 'Ville',
                                 'email', 'tex@example.com', 'phone', '+15125550100', 'sms_consent', false, 'email_consent', true),
  'property', jsonb_build_object('id', 'c4100000-0000-0000-0000-000000000001', 'street', '5 Oak St', 'city', 'Testville',
                                 'state', '', 'zip', '78701'),
  'areas', jsonb_build_array(jsonb_build_object(
    'id', 'a4000000-0000-0000-0000-000000000001', 'name', 'Attic', 'job_type', 'attic', 'sqft', 900,
    'current_r', 0, 'target_r', null, 'access_level', 'easy', 'removal_needed', false, 'sort_order', 0)),
  'options', jsonb_build_array(jsonb_build_object(
    'id', 'b4000000-0000-0000-0000-000000000001', 'tier', 'good', 'label', 'Good', 'direct_cost', 1500,
    'loaded_cost', 2445, 'price', 3000, 'model_price', 3000, 'is_overridden', false, 'margin_pct', 0.15,
    'crew_days', 1, 'financing', null, 'lines', '[]'::jsonb))
) as p;
grant select on b_payload to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', :'estb', false);
do $$
declare r jsonb; ok boolean := false;
begin
  r := sync_upsert_estimate('74000000-0000-0000-0000-000000000001', null, (select p from b_payload));
  assert r->>'status' = 'applied', 'store B estimator syncs: ' || r::text;
  assert (select location_id from estimates where id = 'e4000000-0000-0000-0000-000000000001')
         = (select v::uuid from t_ids where k = 'b'), 'the estimate is store B''s';
  assert (select state from properties where id = 'c4100000-0000-0000-0000-000000000001') = 'TX',
    'a blank state is the store''s state';

  -- The phone cannot put a new estimate in a store the person does not estimate for.
  begin
    perform sync_upsert_estimate('74000000-0000-0000-0000-000000000002', null,
      jsonb_set(jsonb_set(jsonb_set((select p from b_payload), '{estimate,id}', '"e4000000-0000-0000-0000-000000000002"'),
                          '{customer,id}', '"c4000000-0000-0000-0000-000000000002"'),
                '{estimate,location_id}', to_jsonb((select v from t_ids where k = 'pilot'))));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'cannot sync into another store';

  -- ...nor price it with another store's pricing set.
  ok := false;
  begin
    perform sync_upsert_estimate('74000000-0000-0000-0000-000000000003', null,
      jsonb_set(jsonb_set(jsonb_set((select p from b_payload), '{estimate,id}', '"e4000000-0000-0000-0000-000000000003"'),
                          '{customer,id}', '"c4000000-0000-0000-0000-000000000003"'),
                '{estimate,coefficient_set_id}', to_jsonb((select v from t_ids where k = 'pilot_set'))));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'cannot use another store''s pricing set';
end $$;

-- An estimator in both stores must say which store a new estimate is for, and can sync to either.
select set_config('request.jwt.claim.sub', :'both', false);
do $$
declare ok boolean := false; r jsonb;
  v_payload jsonb := jsonb_set(jsonb_set(jsonb_set((select p from b_payload), '{estimate,id}', '"e4000000-0000-0000-0000-000000000004"'),
                               '{customer,id}', '"c4000000-0000-0000-0000-000000000004"'),
                               '{property,id}', '"c4100000-0000-0000-0000-000000000004"');
begin
  begin
    perform sync_upsert_estimate('74000000-0000-0000-0000-000000000004', null,
      jsonb_set(jsonb_set(v_payload, '{areas,0,id}', '"a4000000-0000-0000-0000-000000000004"'),
                '{options,0,id}', '"b4000000-0000-0000-0000-000000000004"'));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'two-store estimator without a store is refused';
  r := sync_upsert_estimate('74000000-0000-0000-0000-000000000005', null,
         jsonb_set(jsonb_set(jsonb_set(v_payload, '{areas,0,id}', '"a4000000-0000-0000-0000-000000000004"'),
                             '{options,0,id}', '"b4000000-0000-0000-0000-000000000004"'),
                   '{estimate,location_id}', to_jsonb((select v from t_ids where k = 'b'))));
  assert r->>'status' = 'applied', 'two-store estimator syncs with the store named: ' || r::text;
  assert (select count(*) from estimates) = 1, 'sees only their own estimate';
end $$;

-- ---------------------------------------------------------------------------
-- Every role is kept out of the other store
-- ---------------------------------------------------------------------------
reset role;
-- A signed quote and job in store B, for the crew and office checks.
insert into quotes (id, estimate_id, version, status, pdf_path, pdf_sha256, snapshot, public_token_hash, expires_at, sent_by)
values ('f4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 1, 'sent', 'b/v1.pdf', 'sha-b-1',
        jsonb_build_object('options', jsonb_build_array(jsonb_build_object('tier', 'good', 'crewDays', 1, 'price', 3000, 'lines', '[]'::jsonb))),
        'b-token-1', now() + interval '30 days', :'estb');
update quotes set status = 'signed', signed_tier = 'good', signed_price = 3000, signed_at = now()
 where id = 'f4000000-0000-0000-0000-000000000001';
update jobs set crew_id = (select id from crews where name = 'Crew A' and location_id = (select v::uuid from t_ids where k = 'b'))
 where quote_id = 'f4000000-0000-0000-0000-000000000001';

do $$ begin
  assert (select location_id from quotes where id = 'f4000000-0000-0000-0000-000000000001') = (select v::uuid from t_ids where k = 'b'),
    'quote takes its estimate''s store';
  assert (select location_id from jobs where quote_id = 'f4000000-0000-0000-0000-000000000001') = (select v::uuid from t_ids where k = 'b'),
    'job from a signed quote takes its store';
end $$;

set role authenticated;

-- Store B's owner sees only store B.
select set_config('request.jwt.claim.sub', :'ownb', false);
do $$
declare v_b uuid := (select v::uuid from t_ids where k = 'b'); ok boolean := false;
begin
  assert (select count(*) from locations) = 1, 'owner B sees one store';
  assert (select count(*) from estimates where location_id <> v_b) = 0 and (select count(*) from estimates) = 2, 'owner B: store B estimates only';
  assert (select count(*) from customers where location_id <> v_b) = 0, 'owner B: no pilot customers';
  assert (select count(*) from properties where location_id <> v_b) = 0, 'owner B: no pilot addresses';
  assert (select count(*) from jobs where location_id <> v_b) = 0, 'owner B: no pilot jobs';
  assert (select count(*) from job_actuals where location_id <> v_b) = 0, 'owner B: no pilot actuals';
  assert (select count(*) from quotes where location_id <> v_b) = 0, 'owner B: no pilot quotes';
  assert (select count(*) from estimate_options o join estimates e on e.id = o.estimate_id where e.location_id <> v_b) = 0, 'owner B: no pilot prices';
  assert (select count(*) from app_settings where location_id <> v_b) = 0, 'owner B: no pilot settings';
  assert (select count(*) from materials where location_id <> v_b) = 0, 'owner B: no pilot costs';
  assert (select count(*) from crews where location_id <> v_b) = 0, 'owner B: no pilot crews';
  assert (select count(*) from coefficient_sets where location_id <> v_b) = 0, 'owner B: no pilot pricing sets';
  assert (select count(*) from coefficients c join coefficient_sets s on s.id = c.set_id where s.location_id <> v_b) = 0, 'owner B: no pilot coefficients';
  assert (select count(*) from audit_log where location_id is distinct from v_b) = 0, 'owner B: no pilot audit rows';
  assert (select count(*) from crew_job_view where job_id not in (select id from jobs)) = 0, 'owner B: crew view only store B';
  assert (select count(*) from profiles where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3')) = 0,
    'owner B cannot see pilot staff';
  assert (select count(*) from location_members where location_id <> v_b) = 0, 'owner B: no pilot memberships';

  -- Writes to the pilot store go nowhere or fail.
  update app_settings set value = '0.99' where key = 'target_margin_pct' and location_id <> v_b;
  update materials set cost_per_unit = 0 where location_id <> v_b;
  update locations set name = 'Hijacked' where id <> v_b;
  begin
    insert into crews (name, size, blended_hourly_cost, location_id)
    values ('Rogue', 2, 1, (select v::uuid from t_ids where k = 'pilot'));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'owner B cannot add a crew to the pilot store';
  ok := false;
  begin
    insert into location_members (location_id, profile_id, role)
    values ((select v::uuid from t_ids where k = 'pilot'), '00000000-0000-0000-0000-0000000000e1', 'owner');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'owner B cannot make themselves an owner of the pilot store';
  ok := false;
  begin
    perform promote_coefficient_set((select v::uuid from t_ids where k = 'pilot_set'), 'test');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'owner B cannot touch the pilot''s pricing sets';
  ok := false;
  begin
    perform rollback_coefficient_set((select v::uuid from t_ids where k = 'pilot_set'), 'test');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'owner B cannot roll back the pilot''s pricing';
  ok := false;
  begin
    update products set r_per_inch = 1;   -- shared catalog: owner of one store of two cannot change it
    ok := not exists (select 1 from products where r_per_inch = 1);
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'an owner of one store cannot change the shared catalog';
  ok := false;
  begin
    update profiles set corporate = true where id = auth.uid();
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'nobody grants themselves corporate access';
end $$;

-- Owner B invites someone: the profile, then their role in store B (the Team page's invite).
do $$
declare v_b uuid := (select v::uuid from t_ids where k = 'b'); ok boolean := false;
begin
  insert into profiles (id, full_name, email, role) values ('00000000-0000-0000-0000-0000000000e7', 'New Hire', 'new@b.test', 'estimator');
  insert into location_members (location_id, profile_id, role) values (v_b, '00000000-0000-0000-0000-0000000000e7', 'estimator');
  assert exists (select 1 from profiles where id = '00000000-0000-0000-0000-0000000000e7'), 'owner B sees the new hire';
  assert (select count(*) from location_members where profile_id = '00000000-0000-0000-0000-0000000000e7') = 1,
    'the new hire works in store B only (no automatic pilot membership with two stores)';
  begin
    insert into profiles (id, full_name, email, role, corporate)
    values ('00000000-0000-0000-0000-0000000000e8', 'Sneaky', 'x@b.test', 'owner', true);
  exception when insufficient_privilege or foreign_key_violation then ok := true;
  end;
  assert ok, 'an invite cannot grant corporate access';
end $$;
select set_config('request.jwt.claim.sub', :'estb', false);
do $$
declare ok boolean := false;
begin
  begin
    insert into profiles (id, full_name, email, role) values ('00000000-0000-0000-0000-0000000000e8', 'Nope', 'n@b.test', 'owner');
  exception when insufficient_privilege or foreign_key_violation then ok := true;
  end;
  assert ok, 'an estimator cannot add people';
end $$;

-- The pilot owner sees none of store B, and can no longer edit the shared catalog either.
select set_config('request.jwt.claim.sub', :'owna', false);
do $$
declare v_b uuid := (select v::uuid from t_ids where k = 'b');
begin
  assert (select count(*) from locations) = 1, 'pilot owner sees one store';
  assert (select count(*) from estimates where location_id = v_b) = 0, 'pilot owner: no store B estimates';
  assert (select count(*) from customers where location_id = v_b) = 0, 'pilot owner: no store B customers';
  assert (select count(*) from jobs where location_id = v_b) = 0, 'pilot owner: no store B jobs';
  assert (select count(*) from coefficient_sets where location_id = v_b) = 0, 'pilot owner: no store B pricing sets';
  assert (select count(*) from audit_log where location_id = v_b) = 0, 'pilot owner: no store B audit rows';
  assert not exists (select 1 from crew_job_view where job_id in
                      (select id from jobs where quote_id = 'f4000000-0000-0000-0000-000000000001')), 'pilot owner: no store B crew view';
  assert not can_edit_shared_catalog(), 'owner of one of two stores cannot edit the shared catalog';
  assert (select count(*) from products) > 0, 'catalog still readable';
end $$;

-- Office and estimators.
select set_config('request.jwt.claim.sub', :'offa', false);
do $$ begin
  assert (select count(*) from estimates where location_id = (select v::uuid from t_ids where k = 'b')) = 0, 'pilot office: no store B estimates';
  assert (select count(*) from crew_actuals_view a join jobs j on j.id = a.job_id) = (select count(*) from crew_actuals_view), 'pilot office: own actuals';
end $$;
select set_config('request.jwt.claim.sub', :'esta', false);
do $$ begin
  assert (select count(*) from materials where location_id = (select v::uuid from t_ids where k = 'b')) = 0, 'pilot estimator: no store B costs';
  assert (select count(*) from coefficient_sets where location_id = (select v::uuid from t_ids where k = 'b')) = 0, 'pilot estimator: no store B pricing';
end $$;
select set_config('request.jwt.claim.sub', :'offb', false);
do $$
declare v_b uuid := (select v::uuid from t_ids where k = 'b');
begin
  assert (select count(*) from estimates) = 2 and (select count(*) from estimates where location_id <> v_b) = 0, 'office B: store B only';
  assert (select count(*) from audit_log) = 0, 'office B cannot read the audit log';
end $$;

-- Crews: own store's assigned jobs only, and still no prices or costs anywhere.
select set_config('request.jwt.claim.sub', :'crewb', false);
do $$
declare ok boolean := false; v_pilot_job uuid;
begin
  assert (select count(distinct job_id) from crew_job_view) = 1, 'crew B sees its one job';
  assert (select count(*) from estimate_options) = 0, 'crew B: no prices';
  assert (select count(*) from materials) = 0, 'crew B: no costs';
  assert (select count(*) from crews) = 0, 'crew B: no labor rates';
  assert (select count(*) from jobs) = 0, 'crew B: no job revenue';
  assert (select count(*) from job_actuals) = 0, 'crew B: no actual costs';
  assert (select count(*) from coefficients) = 0, 'crew B: no pricing set';
  select id into v_pilot_job from jobs limit 1;   -- RLS: none visible
  assert v_pilot_job is null, 'crew B cannot list jobs';
end $$;
reset role;
select set_config('t.pilot_job', (select id::text from jobs where location_id = (select v::uuid from t_ids where k = 'pilot') limit 1), false);
set role authenticated;
do $$
declare ok boolean := false;
begin
  begin
    perform crew_set_job_status(current_setting('t.pilot_job')::uuid, 'in_progress');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crew B cannot move a pilot job';
  ok := false;
  begin
    perform sync_job_actuals('74000000-0000-0000-0000-0000000000c1', current_setting('t.pilot_job')::uuid, '[]'::jsonb);
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'crew B cannot enter actuals on a pilot job';
end $$;

select set_config('request.jwt.claim.sub', :'crewa', false);
do $$ begin
  assert not exists (select 1 from crew_job_view where job_id in
                      (select j.id from jobs j where j.quote_id = 'f4000000-0000-0000-0000-000000000001')),
    'pilot crew sees no store B job';
end $$;

-- ---------------------------------------------------------------------------
-- Corporate: reads every store, writes nothing
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :'corp', false);
do $$
declare ok boolean := false;
begin
  assert (select count(*) from locations) = 2, 'corporate sees both stores';
  assert (select count(distinct location_id) from estimates) = 2, 'corporate reads estimates of both stores';
  assert (select count(distinct location_id) from jobs) = 2, 'corporate reads jobs of both stores';
  assert (select count(distinct location_id) from coefficient_sets) = 2, 'corporate reads both stores'' pricing sets';
  assert (select count(*) from estimate_options) > 0, 'corporate reads prices';
  update app_settings set value = '0.99' where key = 'target_margin_pct';
  update estimates set notes = 'corporate was here';
  update locations set name = 'Corporate';
  begin
    insert into customers (first_name, last_name, location_id) values ('C', 'Orp', (select v::uuid from t_ids where k = 'b'));
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'corporate cannot add customers';
  ok := false;
  begin
    perform promote_coefficient_set((select v::uuid from t_ids where k = 'pilot_set'), 'corp');
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'corporate cannot change pricing';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from app_settings where key = 'target_margin_pct' and value = '0.99'::jsonb), 'no settings written by B owner or corporate';
  assert not exists (select 1 from estimates where notes = 'corporate was here'), 'corporate wrote no estimate';
  assert not exists (select 1 from locations where name in ('Corporate', 'Hijacked')), 'no store renamed across stores';
  assert not exists (select 1 from materials where cost_per_unit = 0), 'no costs zeroed across stores';
end $$;

-- ---------------------------------------------------------------------------
-- B: opt-outs are shared by every store
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'offb', false);
insert into opt_outs (channel, address, source) values ('sms', '+15125550199', 'STOP reply');
select set_config('request.jwt.claim.sub', :'offa', false);
do $$ begin
  assert exists (select 1 from opt_outs where address = '+15125550199'), 'a STOP to store B is honored by the pilot store';
end $$;

-- ---------------------------------------------------------------------------
-- Learning in store B (the nightly job, service role) moves only store B's prices
-- ---------------------------------------------------------------------------
reset role;
set role service_role;
do $$
declare
  v_b uuid := (select v::uuid from t_ids where k = 'b');
  v_run uuid; v_cand uuid; v_old uuid;
begin
  select id into v_old from coefficient_sets where location_id = v_b and status = 'active';
  insert into learning_runs (kind, status, location_id) values ('calibration', 'running', v_b) returning id into v_run;
  insert into coefficient_sets (status, parent_id, source, learning_run_id, location_id)
  values ('candidate', v_old, 'nightly', v_run, v_b) returning id into v_cand;
  insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound)
  select v_cand, kind, product, job_type, access_level, least(value * 1.05, upper_bound), prior_value, lower_bound, upper_bound
    from coefficients where set_id = v_old;
  perform promote_coefficient_set(v_cand, 'nightly test');
  assert (select status from coefficient_sets where id = v_cand) = 'active', 'store B candidate promoted';
  assert (select status from coefficient_sets where id = v_old) = 'superseded', 'store B old set superseded';
  assert (select status from coefficient_sets where id = (select v::uuid from t_ids where k = 'pilot_set')) = 'active',
    'pilot active set untouched by store B promotion';
  assert (select count(*) from coefficient_changes where to_set_id = v_cand and location_id = v_b) > 0, 'changelog in store B';
end $$;
reset role;

-- Store B prices change; the pilot store's do not.
update app_settings set value = '0.25' where key = 'target_margin_pct' and location_id = (select v::uuid from t_ids where k = 'b');
update materials set cost_per_unit = cost_per_unit * 2 where location_id = (select v::uuid from t_ids where k = 'b');
do $$ begin
  assert pilot_pricing_md5() = (select v from t_ids where k = 'pilot_md5'), 'the pilot store''s pricing did not move';
  assert (select count(*) from audit_log where table_name = 'materials' and location_id = (select v::uuid from t_ids where k = 'b')) > 0,
    'store B changes are audited under store B';
end $$;
\echo '  ok'
