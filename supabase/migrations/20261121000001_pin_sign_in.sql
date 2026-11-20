-- =============================================================================
-- Sign in with your name and a 4-digit PIN (no email)
--
--   * profiles.pin_sign_in: the person is listed on the sign-in page (first name and role only)
--     and signs in with their PIN. Their Supabase login is a made-up address that is never mailed
--     (pin.<id>@example.com) and a password derived from the PIN with the server's PIN_SECRET
--     (lib/auth/pin.ts). The PIN itself is stored nowhere, and without PIN_SECRET nobody can try
--     PINs against Supabase directly, around the lockout below.
--   * pin_attempts: wrong PINs in a row, per person, and until when that name is locked (5 wrong
--     PINs lock it for 15 minutes; the right PIN starts the count again). Only the server (the
--     service role) reads or writes it: RLS on with no policies, and no privilege at all for the
--     public or signed-in users.
--
-- Additive and idempotent: a new column with a default (false: nobody is listed until the owner
-- adds a PIN person) and a new table. Running it again changes nothing, and the live app works the
-- same with it applied.
-- =============================================================================

alter table profiles add column if not exists pin_sign_in boolean not null default false;
comment on column profiles.pin_sign_in is
  'Listed on the sign-in page; signs in with name and 4-digit PIN (login pin.<id>@example.com, password derived from the PIN and PIN_SECRET).';

create table if not exists pin_attempts (
  profile_id   uuid primary key references profiles(id) on delete cascade,
  failed       int not null default 0 check (failed >= 0),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
comment on table pin_attempts is
  'Wrong PINs in a row per person and the lockout (5 wrong: 15 minutes). Service role only.';

alter table pin_attempts enable row level security;

-- Production grants every new table to the API roles when it is created (default privileges,
-- review B database-B5). Nobody but the server may read who is locked out or reset a count, so
-- the public and signed-in users get nothing, not even through a policy (there is none). Revoking
-- again changes nothing.
revoke all on table pin_attempts from public, anon, authenticated;
