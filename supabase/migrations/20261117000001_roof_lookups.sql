-- Satellite roof lookups. The field app asks /api/roof to look up an address on the Roof Takeoff
-- site (Google aerial photo, roof faces and outline), and every lookup is logged here: who asked,
-- for which address, and the compact result the app was given. Each lookup costs Google calls, so
-- a lookup is reserved ('pending') before the call and the per-person hourly cap counts these rows.
-- A lookup can happen before the estimate or its area has synced, so both ids are plain values.
-- The server writes these rows with the service role after checking the user; people can read
-- their own lookups and the owner reads all of them.

create table if not exists roof_lookups (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid not null references auth.users(id) on delete cascade,
  estimate_id uuid,
  area_id     uuid,
  address     text not null check (char_length(address) <= 200),
  status      text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  result      jsonb,
  error       text
);

-- The hourly cap: lookups by one person since an hour ago.
create index if not exists roof_lookups_created_by_idx on roof_lookups (created_by, created_at desc);
create index if not exists roof_lookups_estimate_idx on roof_lookups (estimate_id);

alter table roof_lookups enable row level security;

-- Read only: no insert, update or delete policies, so nobody writes these rows through the API.
drop policy if exists roof_lookups_own_read on roof_lookups;
create policy roof_lookups_own_read on roof_lookups for select
  using (created_by = auth.uid() or has_role('owner'));
