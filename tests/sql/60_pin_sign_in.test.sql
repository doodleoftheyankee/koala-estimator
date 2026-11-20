-- Sign in with a name and a PIN: profiles.pin_sign_in (off unless set, so nobody is listed on the
-- sign-in page until the owner adds a PIN person, and inserts that do not name it keep working),
-- pin_attempts (the server's alone: no privilege and no policy for the public or signed-in
-- users, removed with the person), and the migration run again changing nothing.
-- Runs after the earlier test files, so every id here is new.

\set owner '00000000-0000-0000-0000-0000000006a1'
\set crew  '00000000-0000-0000-0000-0000000006a2'
\set mail  '00000000-0000-0000-0000-0000000006a3'

insert into auth.users (id) values (:'owner'), (:'crew'), (:'mail');
-- As origin/main's code inserts a profile (invite, demo seed): without the new column.
insert into profiles (id, role, full_name, email) values
  (:'owner', 'owner', 'Owner PIN', 'owner.pin@example.com'),
  (:'mail', 'estimator', 'Email Person', 'email.person@example.com');
-- As the team page adds a PIN person: no email, listed on the sign-in page.
insert into profiles (id, role, full_name, email, pin_sign_in) values (:'crew', 'crew', 'Crew PIN', null, true);

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
do $$ begin
  assert (select data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
            from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'pin_sign_in'),
         'profiles.pin_sign_in is a boolean, not null, default false';
  assert (select count(*) from profiles where pin_sign_in) = 1, 'only the person added with a PIN is listed';
  assert not (select pin_sign_in from profiles where full_name = 'Email Person'), 'a profile inserted without the column is not listed';
end $$;

-- ---------------------------------------------------------------------------
-- pin_attempts: the server's only
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
  p text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.pin_attempts'::regclass), 'RLS is on';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pin_attempts') = 0, 'with no policy';
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      assert not has_table_privilege(r, 'public.pin_attempts', p), format('%s has no %s privilege on pin_attempts', r, p);
    end loop;
  end loop;
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    assert has_table_privilege('service_role', 'public.pin_attempts', p), format('the server (service role) can %s', p);
  end loop;
  assert has_table_privilege('anon', 'public.profiles', 'select'), 'tables the migration does not revoke keep the default grants (as in production)';
end $$;

insert into pin_attempts (profile_id, failed, locked_until) values (:'crew', 5, now() + interval '15 minutes');

-- A signed-in owner cannot read or reset anyone's count, through the API or otherwise.
set role authenticated;
select set_config('request.jwt.claim.sub', :'owner', false);
do $$ begin
  begin
    perform count(*) from pin_attempts;
    assert false, 'a signed-in owner read pin_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from pin_attempts;
    assert false, 'a signed-in owner cleared a lockout directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into pin_attempts (profile_id) values ('00000000-0000-0000-0000-0000000006a1');
    assert false, 'a signed-in owner wrote pin_attempts';
  exception when insufficient_privilege then null;
  end;
  -- The owner manages who is listed through the profile (profiles_owner_all).
  update profiles set pin_sign_in = true where full_name = 'Email Person';
  assert (select pin_sign_in from profiles where full_name = 'Email Person'), 'the owner can list a person';
  update profiles set pin_sign_in = false where full_name = 'Email Person';
end $$;
reset role;

set role anon;
do $$ begin
  begin
    perform count(*) from pin_attempts;
    assert false, 'the public read pin_attempts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role service_role;
do $$ begin
  assert (select failed from pin_attempts where profile_id = '00000000-0000-0000-0000-0000000006a2') = 5, 'the server reads the count';
  update pin_attempts set failed = 4 where profile_id = '00000000-0000-0000-0000-0000000006a2';
end $$;
reset role;

do $$ begin
  begin
    insert into pin_attempts (profile_id, failed) values ('00000000-0000-0000-0000-0000000006a1', -1);
    assert false, 'a negative count was stored';
  exception when check_violation then null;
  end;
  begin
    insert into pin_attempts (profile_id) values ('00000000-0000-0000-0000-00000000ffff');
    assert false, 'a count for nobody was stored';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Running the migration again changes nothing
-- ---------------------------------------------------------------------------
create function pg_temp.pin_state() returns text language sql as $$
  select concat_ws(' | ',
    (select string_agg(concat_ws(':', table_name, column_name, data_type, is_nullable, column_default), ',' order by table_name, ordinal_position)
       from information_schema.columns where table_schema = 'public' and table_name in ('profiles', 'pin_attempts')),
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname) from pg_constraint where conrelid = 'public.pin_attempts'::regclass),
    (select coalesce(array_to_string(relacl, ','), 'default') || ':' || relrowsecurity::text from pg_class where oid = 'public.pin_attempts'::regclass),
    (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'pin_attempts'),
    (select col_description('public.profiles'::regclass, (select attnum from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'pin_sign_in'))),
    (select obj_description('public.pin_attempts'::regclass)),
    (select string_agg(concat_ws(':', profile_id, failed, locked_until, updated_at), ',' order by profile_id) from pin_attempts),
    (select string_agg(concat_ws(':', id, pin_sign_in, updated_at, row_version), ',' order by id) from profiles)
  )
$$;
select set_config('pin.before', pg_temp.pin_state(), false);
\ir ../../supabase/migrations/20261121000001_pin_sign_in.sql
do $$ begin
  assert pg_temp.pin_state() = current_setting('pin.before'), 'running the migration again changes nothing (columns, constraints, grants, RLS, policies, comments, rows)';
end $$;

-- ---------------------------------------------------------------------------
-- A person's count goes with them
-- ---------------------------------------------------------------------------
delete from profiles where id = :'crew';
do $$ begin
  assert (select count(*) from pin_attempts where profile_id = '00000000-0000-0000-0000-0000000006a2') = 0, 'removing a person removes their count';
end $$;
