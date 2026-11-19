-- Minimal stand-ins for the Supabase-provided schemas so migrations run on plain Postgres (CI, local).
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
-- Same lookup order as Supabase: legacy per-claim GUC, then the JSON claims PostgREST sets.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase's default privileges on the public schema, as production has them (pg_default_acl, read
-- with a SELECT on 2026-11-19): every table, sequence and function a migration creates is granted to
-- the API roles at creation, and a migration's own revoke then holds. tests/sql/01_grants.sql used to
-- grant everything again after the migrations, which undid those revokes (review B database-B5).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant usage, select, update on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
