-- Satellite roof lookups. The field app asks /api/roof to look up an address (or a spot the
-- estimator tapped on the aerial photo) on the Roof Takeoff site (Google aerial photo, roof faces
-- and outline), and every paid lookup is logged here: who asked, for which address or spot, and the
-- compact result the app was given. Each lookup costs Google calls, so a lookup is reserved
-- ('pending') before the call and the per-person hourly cap counts these rows. A finished lookup of
-- the same house (same address however it was typed, or a pin within about 2 m) is used again for a
-- day by anyone instead of paying again; using one again adds no row.
-- A lookup can happen before the estimate or its area has synced, so both ids are plain values.
-- The server writes these rows with the service role after checking the user; people can read
-- their own lookups and the owner reads all of them.

create table if not exists roof_lookups (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid not null references auth.users(id) on delete cascade,
  estimate_id uuid,
  area_id     uuid,
  -- An address lookup: the address as sent, and the server's match key for it (lib/roof addressKey:
  -- trimmed, lower case, runs of spaces and commas as one space).
  address     text check (char_length(address) <= 200),
  address_key text check (char_length(address_key) <= 200),
  -- A lookup of a spot on the map (the estimator tapped the right roof).
  pin_lat     double precision check (pin_lat between -90 and 90),
  pin_lng     double precision check (pin_lng between -180 and 180),
  status      text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  result      jsonb,
  error       text,
  constraint roof_lookups_address_or_pin check (
    (address is not null and address_key is not null and pin_lat is null and pin_lng is null)
    or (address is null and address_key is null and pin_lat is not null and pin_lng is not null)
  )
);

-- The hourly cap: lookups by one person since an hour ago.
create index if not exists roof_lookups_created_by_idx on roof_lookups (created_by, created_at desc);
create index if not exists roof_lookups_estimate_idx on roof_lookups (estimate_id);
-- Using a finished lookup again: the newest one for the same address, or for a pin nearby.
create index if not exists roof_lookups_reuse_address_idx on roof_lookups (address_key, created_at desc) where status = 'done';
create index if not exists roof_lookups_reuse_pin_idx on roof_lookups (pin_lat, pin_lng, created_at desc) where status = 'done' and pin_lat is not null;

alter table roof_lookups enable row level security;

-- Read only: no insert, update or delete policies, so nobody writes these rows through the API.
drop policy if exists roof_lookups_own_read on roof_lookups;
create policy roof_lookups_own_read on roof_lookups for select
  using (created_by = auth.uid() or has_role('owner'));
