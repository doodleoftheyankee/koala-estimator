-- =============================================================================
-- Multi-location, part 1 of 5: stores and who works in them.
--
--   * locations: one row per franchise store (name, time zone, state, climate zone, contact
--     details, sender emails, branding). Nothing in the app names a store any more; it reads it here.
--   * location_members: who works in which store, with a role per store. One person can work in
--     several stores with a different role in each. This replaces profiles.role for permissions;
--     profiles.role is kept in step for people in exactly one store (one release), then retired.
--   * profiles.corporate: read-only access across every store, for the corporate roll-up (the
--     roll-up screen comes later). Corporate users never write.
--   * The existing store is created from today's settings, and every existing person joins it
--     with the role they have now. Nothing is copied or renamed.
--
-- Helpers used by every security rule from here on:
--   has_location_role(loc, roles...)  the caller works in that store with one of those roles
--   is_corporate()                    the caller has read-only access to every store
--   can_read_location(loc)            owner/office of that store, or corporate (read-only)
--   user_location_id()                the caller's store when they work in exactly one
--   default_location_id()             user_location_id(), or the only store when there is one
--                                     (lets code that predates stores keep inserting rows; the
--                                     column defaults that use it are removed in a later cleanup)
-- =============================================================================

create table locations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  short_name          text not null check (char_length(btrim(short_name)) between 1 and 60),
  time_zone           text not null,
  state               text not null check (state ~ '^[A-Z]{2}$'),
  default_county      text,
  climate_zone        text not null check (climate_zone ~ '^[1-8][A-C]?$'),
  shop_address        text,
  shop_lat            double precision check (shop_lat between -90 and 90),
  shop_lng            double precision check (shop_lng between -180 and 180),
  phone               text,
  license_number      text,
  quote_from_email    text,
  office_notify_email text,
  owner_report_email  text,
  logo_path           text,
  brand_color         text check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Electric utilities offered as suggestions on the customer screen.
  utilities           text[] not null default '{}',
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  row_version         int not null default 1
);

-- A time zone must be one Postgres knows (the app formats every date in it).
create or replace function tg_locations_check() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'unknown time zone %', new.time_zone using errcode = '22023';
  end if;
  new.name := btrim(new.name);
  new.short_name := btrim(new.short_name);
  return new;
end $$;
create trigger locations_check before insert or update on locations for each row execute function tg_locations_check();
create trigger locations_touch before update on locations for each row execute function tg_touch_row();
create trigger locations_audit after insert or update or delete on locations for each row execute function tg_audit();

create table location_members (
  location_id uuid not null references locations(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  role        user_role not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (location_id, profile_id)
);
create index location_members_profile_idx on location_members (profile_id) where active;
create trigger location_members_audit after insert or update or delete on location_members
  for each row execute function tg_audit();

alter table profiles add column corporate boolean not null default false;

-- -----------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so they never recurse through the rules they serve)
-- -----------------------------------------------------------------------------
create or replace function has_location_role(p_location uuid, variadic p_roles user_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(exists (
    select 1 from location_members m join profiles p on p.id = m.profile_id
     where m.location_id = p_location and m.profile_id = auth.uid()
       and m.active and p.active and m.role = any(p_roles)), false)
$$;

create or replace function is_location_member(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_location_role(p_location, 'owner', 'office', 'estimator', 'crew')
$$;

create or replace function is_corporate() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select corporate from profiles where id = auth.uid() and active), false)
$$;

create or replace function can_read_location(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_location_role(p_location, 'owner', 'office') or is_corporate()
$$;

create or replace function user_location_id() returns uuid
language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then min(m.location_id::text)::uuid end
    from location_members m join profiles p on p.id = m.profile_id
   where m.profile_id = auth.uid() and m.active and p.active
$$;

create or replace function default_location_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(user_location_id(),
                  (select case when count(*) = 1 then min(id::text)::uuid end from locations where active))
$$;

-- The caller's stores, newest role rules first: used by the app's store picker.
create or replace function my_locations()
returns table (location_id uuid, name text, short_name text, role user_role)
language sql stable security definer set search_path = public as $$
  select l.id, l.name, l.short_name, m.role
    from location_members m
    join locations l on l.id = m.location_id and l.active
    join profiles p on p.id = m.profile_id and p.active
   where m.profile_id = auth.uid() and m.active
   order by l.name
$$;

revoke all on function has_location_role(uuid, user_role[]), is_location_member(uuid), is_corporate(),
  can_read_location(uuid), user_location_id(), default_location_id(), my_locations() from public, anon;
grant execute on function has_location_role(uuid, user_role[]), is_location_member(uuid), is_corporate(),
  can_read_location(uuid), user_location_id(), default_location_id(), my_locations() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The existing store, from today's settings
-- -----------------------------------------------------------------------------
insert into locations (name, short_name, time_zone, state, default_county, climate_zone, shop_address,
                       phone, license_number, logo_path, brand_color, utilities)
select b.company,
       coalesce(nullif(btrim(regexp_replace(b.company, '^\s*Koala Insulation of\s+', '', 'i')), ''), b.company),
       coalesce((select value->>'tz' from app_settings where key = 'followup_quiet_hours'), 'America/New_York'),
       'DE', 'New Castle',
       coalesce((select climate_zone from code_requirements where job_type = 'attic' and is_default limit 1), '4A'),
       (select value #>> '{}' from app_settings where key = 'shop_address'),
       b.phone, b.license, b.logo_path,
       case when b.primary_color ~ '^#[0-9A-Fa-f]{6}$' then b.primary_color end,
       array['Delmarva Power', 'City of Newark', 'Delaware Electric Co-op', 'DEMEC municipal']
  from (select coalesce(nullif(value->>'company', ''), 'Koala Insulation') as company,
               value->>'phone' as phone, value->>'license' as license,
               value->>'logo_path' as logo_path, value->>'primary_color' as primary_color
          from app_settings where key = 'branding'
        union all
        -- A database without branding settings still gets its one store.
        select 'Koala Insulation', null, null, null, null
         where not exists (select 1 from app_settings where key = 'branding')) b;

-- Everyone who has an account today works in that store, with the role they have now.
insert into location_members (location_id, profile_id, role, active)
select (select id from locations), p.id, p.role, p.active from profiles p;

-- -----------------------------------------------------------------------------
-- Compatibility for one release: code that predates stores creates people with profiles.role
-- (invites, the bootstrap script). While there is exactly one store, a new person joins it, and
-- a role change for someone in one store follows into that store. Removed in the cleanup.
-- -----------------------------------------------------------------------------
create or replace function tg_profiles_location_compat() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  if tg_op = 'INSERT' then
    select case when count(*) = 1 then min(id::text)::uuid end into v_loc from locations where active;
    if v_loc is not null then
      insert into location_members (location_id, profile_id, role) values (v_loc, new.id, new.role)
      on conflict do nothing;
    end if;
  elsif new.role is distinct from old.role
        and (select count(*) from location_members where profile_id = new.id) = 1 then
    update location_members set role = new.role where profile_id = new.id;
  end if;
  return new;
end $$;
create trigger profiles_location_compat after insert or update of role on profiles
  for each row execute function tg_profiles_location_compat();

-- -----------------------------------------------------------------------------
-- Security rules for the two new tables
-- -----------------------------------------------------------------------------
alter table locations enable row level security;
alter table location_members enable row level security;

-- Anyone in a store can read its name and settings (crews need the time zone); corporate reads all.
create policy locations_read on locations for select using (is_location_member(id) or is_corporate());
-- The owner edits their own store's details. Stores are created by create_location() (service role).
create policy locations_owner_update on locations for update
  using (has_location_role(id, 'owner')) with check (has_location_role(id, 'owner'));

create policy location_members_read on location_members for select
  using (profile_id = auth.uid() or can_read_location(location_id));
create policy location_members_owner on location_members for all
  using (has_location_role(location_id, 'owner')) with check (has_location_role(location_id, 'owner'));

grant select, update on locations to authenticated;
grant select, insert, update, delete on location_members to authenticated;
grant all on locations, location_members to service_role;
