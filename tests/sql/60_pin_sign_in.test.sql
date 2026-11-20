-- Sign in with a name and a PIN: profiles.pin_sign_in (off unless set, so nobody is listed on the
-- sign-in page until the owner adds a PIN person, and inserts that do not name it keep working),
-- pin_attempts and pin_device_attempts (the server's alone: no privilege and no policy for the
-- public or signed-in users, removed with the person; a known phone's count is per person and
-- phone), and the migration run again changing nothing.
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
  t text;
  r text;
  p text;
begin
  foreach t in array array['pin_attempts', 'pin_device_attempts'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), format('RLS is on for %s', t);
    assert (select count(*) from pg_policies where schemaname = 'public' and tablename = t) = 0, format('with no policy on %s', t);
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        assert not has_table_privilege(r, 'public.' || t, p), format('%s has no %s privilege on %s', r, p, t);
      end loop;
    end loop;
    foreach p in array array['select', 'insert', 'update', 'delete'] loop
      assert has_table_privilege('service_role', 'public.' || t, p), format('the server (service role) can %s on %s', p, t);
    end loop;
  end loop;
  assert has_table_privilege('anon', 'public.profiles', 'select'), 'tables the migration does not revoke keep the default grants (as in production)';
  assert (select array_agg(a.attname::text order by a.attname) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
           where c.conrelid = 'public.pin_device_attempts'::regclass and c.contype = 'p') = array['device', 'profile_id'],
         'a known phone''s count is one row per person and phone';
end $$;

insert into pin_attempts (profile_id, failed, locked_until) values (:'crew', 5, now() + interval '15 minutes');
-- The stranger's lock above is the name's; the person's own phone counts on its own, and two
-- phones of one person (or one shared phone of two people) are separate counts.
insert into pin_device_attempts (profile_id, device, failed) values
  (:'crew', 'phone-key-1', 1), (:'crew', 'phone-key-2', 0), (:'owner', 'phone-key-1', 2);

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
    perform count(*) from pin_device_attempts;
    assert false, 'a signed-in owner read pin_device_attempts';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into pin_device_attempts (profile_id, device) values ('00000000-0000-0000-0000-0000000006a1', 'mine');
    assert false, 'a signed-in owner wrote pin_device_attempts';
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
  begin
    update pin_device_attempts set failed = 0;
    assert false, 'the public reset a phone''s count';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role service_role;
do $$ begin
  assert (select failed from pin_attempts where profile_id = '00000000-0000-0000-0000-0000000006a2') = 5, 'the server reads the count';
  update pin_attempts set failed = 4 where profile_id = '00000000-0000-0000-0000-0000000006a2';
  assert (select failed from pin_device_attempts where profile_id = '00000000-0000-0000-0000-0000000006a2' and device = 'phone-key-1') = 1,
         'the server reads a phone''s count';
  update pin_device_attempts set failed = 2, locked_until = null where profile_id = '00000000-0000-0000-0000-0000000006a2' and device = 'phone-key-1';
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
  begin
    insert into pin_device_attempts (profile_id, device) values ('00000000-0000-0000-0000-00000000ffff', 'k');
    assert false, 'a phone''s count for nobody was stored';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into pin_device_attempts (profile_id, device) values ('00000000-0000-0000-0000-0000000006a2', 'phone-key-1');
    assert false, 'two counts for one person on one phone';
  exception when unique_violation then null;
  end;
  begin
    insert into pin_device_attempts (profile_id, device, failed) values ('00000000-0000-0000-0000-0000000006a1', 'k-neg', -1);
    assert false, 'a negative phone count was stored';
  exception when check_violation then null;
  end;
  begin
    insert into pin_device_attempts (profile_id, device) values ('00000000-0000-0000-0000-0000000006a1', '');
    assert false, 'a phone with no key was stored';
  exception when check_violation then null;
  end;
  begin
    insert into pin_device_attempts (profile_id, device) values ('00000000-0000-0000-0000-0000000006a1', repeat('k', 65));
    assert false, 'a phone key longer than 64 characters was stored';
  exception when check_violation then null;
  end;
  begin
    insert into pin_device_attempts (profile_id) values ('00000000-0000-0000-0000-0000000006a1');
    assert false, 'a phone count with no phone was stored';
  exception when not_null_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Running the migration again changes nothing
-- ---------------------------------------------------------------------------
create function pg_temp.pin_state() returns text language sql as $$
  select concat_ws(' | ',
    (select string_agg(concat_ws(':', table_name, column_name, data_type, is_nullable, column_default), ',' order by table_name, ordinal_position)
       from information_schema.columns where table_schema = 'public' and table_name in ('profiles', 'pin_attempts', 'pin_device_attempts')),
    (select string_agg(conrelid::regclass || '.' || conname || ':' || pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname)
       from pg_constraint where conrelid in ('public.pin_attempts'::regclass, 'public.pin_device_attempts'::regclass)),
    (select string_agg(relname || ':' || coalesce(array_to_string(relacl, ','), 'default') || ':' || relrowsecurity::text, ',' order by relname)
       from pg_class where oid in ('public.pin_attempts'::regclass, 'public.pin_device_attempts'::regclass)),
    (select count(*)::text from pg_policies where schemaname = 'public' and tablename in ('pin_attempts', 'pin_device_attempts')),
    (select string_agg(indexrelid::regclass::text, ',' order by indexrelid::regclass::text) from pg_index
       where indrelid in ('public.pin_attempts'::regclass, 'public.pin_device_attempts'::regclass)),
    (select col_description('public.profiles'::regclass, (select attnum from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'pin_sign_in'))),
    (select obj_description('public.pin_attempts'::regclass)),
    (select obj_description('public.pin_device_attempts'::regclass)),
    (select string_agg(concat_ws(':', profile_id, failed, locked_until, updated_at), ',' order by profile_id) from pin_attempts),
    (select string_agg(concat_ws(':', profile_id, device, failed, locked_until, updated_at), ',' order by profile_id, device) from pin_device_attempts),
    (select string_agg(concat_ws(':', id, pin_sign_in, updated_at, row_version), ',' order by id) from profiles)
  )
$$;
select set_config('pin.before', pg_temp.pin_state(), false);
\ir ../../supabase/migrations/20261121000001_pin_sign_in.sql
do $$ begin
  assert pg_temp.pin_state() = current_setting('pin.before'), 'running the migration again changes nothing (columns, constraints, indexes, grants, RLS, policies, comments, rows)';
end $$;

-- ---------------------------------------------------------------------------
-- A person's counts go with them
-- ---------------------------------------------------------------------------
delete from profiles where id = :'crew';
do $$ begin
  assert (select count(*) from pin_attempts where profile_id = '00000000-0000-0000-0000-0000000006a2') = 0, 'removing a person removes their count';
  assert (select count(*) from pin_device_attempts where profile_id = '00000000-0000-0000-0000-0000000006a2') = 0, 'and their phones'' counts';
  assert (select count(*) from pin_device_attempts where profile_id = '00000000-0000-0000-0000-0000000006a1') = 1, 'not anyone else''s';
end $$;
