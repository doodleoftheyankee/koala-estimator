-- =============================================================================
-- Koala Insulation of Newark, DE — Estimator Platform
-- schema.sql  (Supabase / Postgres 15+)
--
-- Conventions
--   * UUID PKs; estimate-side IDs are generated on the client (offline-first).
--   * Money: numeric(12,2). Rates / coefficients: numeric(14,6).
--   * row_version + updated_at maintained by trigger for sync conflict checks.
--   * Every pricing/config table is audited by trigger into audit_log.
--   * RLS is ON for every table. Role comes from public.profiles.role.
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type user_role        as enum ('owner', 'office', 'estimator', 'crew');
create type job_type_code    as enum ('attic', 'walls', 'crawlspace', 'rim_joist', 'garage', 'commercial');
create type product_code     as enum ('ocsf', 'ccsf', 'cellulose', 'fiberglass_blown', 'batts', 'air_sealing', 'removal');
create type product_unit     as enum ('board_ft', 'bag', 'sqft', 'linear_ft', 'hour', 'each');
create type access_code      as enum ('easy', 'moderate', 'difficult', 'extreme');
create type tier_code        as enum ('good', 'better', 'best');
create type lead_status      as enum ('new', 'contacted', 'appointment_set', 'estimated', 'won', 'lost', 'disqualified');
create type estimate_status  as enum ('draft', 'ready', 'sent', 'viewed', 'signed', 'lost', 'expired', 'void');
create type quote_status     as enum ('sent', 'viewed', 'signed', 'declined', 'expired', 'superseded');
create type job_status       as enum ('scheduled', 'in_progress', 'completed', 'cancelled');
create type coeff_kind       as enum ('waste_factor', 'labor_hrs_per_unit', 'access_mult', 'setup_hours',
                                      'removal_hrs_per_sqft', 'drive_time_factor', 'photo_area_bias');
create type coeff_set_status as enum ('candidate', 'active', 'superseded', 'rejected');
create type run_status       as enum ('running', 'succeeded', 'failed');
create type channel_code     as enum ('email', 'sms');
create type message_status   as enum ('queued', 'sent', 'delivered', 'failed', 'bounced', 'received');
create type line_kind        as enum ('material', 'labor', 'removal', 'disposal', 'drive', 'misc', 'discount');

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------
create or replace function tg_touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at  := now();
  new.row_version := coalesce(old.row_version, 0) + 1;
  return new;
end $$;

-- =============================================================================
-- IDENTITY & ROLES
-- =============================================================================
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        user_role not null default 'estimator',
  full_name   text not null,
  email       citext,
  phone       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1
);

-- Role helpers (SECURITY DEFINER so RLS on profiles doesn't recurse).
create or replace function auth_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function has_role(variadic roles user_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth_role() = any(roles), false)
$$;

-- =============================================================================
-- AUDIT LOG (append-only)
-- =============================================================================
create table audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,                         -- auth.uid(), null for system/cron
  actor_role  user_role,
  action      text not null,                -- INSERT/UPDATE/DELETE or domain verb ('quote.sent', 'price.override', ...)
  table_name  text,
  row_id      text,
  before      jsonb,
  after       jsonb,
  context     jsonb                         -- e.g. {"reason": "...", "estimate_id": "..."}
);
create index audit_log_table_row_idx on audit_log (table_name, row_id);
create index audit_log_at_idx        on audit_log (at desc);

create or replace function tg_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; pk text;
begin
  r  := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  pk := coalesce(r->>'id', r->>'key', r->>'code');
  insert into audit_log (actor_id, actor_role, action, table_name, row_id, before, after)
  values (auth.uid(), auth_role(), tg_op, tg_table_name, pk,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- Domain events (quote sent, override, etc.) go through this.
create or replace function log_event(p_action text, p_table text, p_row_id text, p_context jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into audit_log (actor_id, actor_role, action, table_name, row_id, context)
  values (auth.uid(), auth_role(), p_action, p_table, p_row_id, p_context)
$$;

-- =============================================================================
-- PRICING CONFIGURATION (owner-editable, audited, never hardcoded in app)
-- =============================================================================
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references profiles(id)
);

create table job_types (
  code        job_type_code primary key,
  label       text not null,
  sort_order  int not null default 0,
  active      boolean not null default true
);

create table access_levels (
  code          access_code primary key,
  label         text not null,
  description   text,
  prior_mult    numeric(14,6) not null check (prior_mult > 0),  -- seed prior for access_mult
  sort_order    int not null default 0
);

create table products (
  id            uuid primary key default gen_random_uuid(),
  code          product_code not null unique,
  label         text not null,
  unit          product_unit not null,
  r_per_inch    numeric(8,3),               -- null for air sealing / removal
  is_r_bearing  boolean not null default true,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  row_version   int not null default 1
);

-- A product can have several SKUs/materials (e.g. two cellulose suppliers). One is default.
create table materials (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references products(id),
  name               text not null,
  sku                text,
  unit               product_unit not null,
  cost_per_unit      numeric(12,4) not null check (cost_per_unit >= 0),
  -- coverage: how many sqft·inch one unit covers (bags), or board_ft per unit, etc.
  coverage_sqft_in   numeric(14,4),
  is_default         boolean not null default false,
  active             boolean not null default true,
  needs_owner_input  boolean not null default false,   -- placeholder seed flag
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  row_version        int not null default 1
);
create unique index materials_one_default_per_product on materials (product_id) where is_default and active;

create table labor_roles (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,      -- 'Lead installer', 'Helper'
  hourly_cost     numeric(10,2) not null check (hourly_cost >= 0),  -- fully burdened
  needs_owner_input boolean not null default false,
  updated_at      timestamptz not null default now(),
  row_version     int not null default 1
);

create table crews (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  size            int not null check (size between 1 and 10),
  blended_hourly_cost numeric(10,2) not null check (blended_hourly_cost >= 0), -- per person-hour
  home_lat        double precision,
  home_lng        double precision,
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  row_version     int not null default 1
);

create table crew_members (
  crew_id     uuid references crews(id) on delete cascade,
  profile_id  uuid references profiles(id) on delete cascade,
  role_id     uuid references labor_roles(id),
  is_lead     boolean not null default false,
  primary key (crew_id, profile_id)
);

-- Code minimums (DE / IECC climate zone 4A). Editable; edition recorded.
create table code_requirements (
  id            uuid primary key default gen_random_uuid(),
  job_type      job_type_code not null,
  assembly      text not null,               -- 'ceiling', 'wood_frame_wall', 'floor', 'crawl_wall', 'basement_wall', 'rim_joist'
  min_r         numeric(6,1) not null,
  alt_spec      text,                        -- e.g. '13+5ci'
  code_edition  text not null,               -- '2021 IECC'
  climate_zone  text not null default '4A',
  is_default    boolean not null default true,
  source_note   text,
  updated_at    timestamptz not null default now(),
  unique (job_type, assembly, code_edition)
);

-- Good/better/best recipes per job type: which products, to what R, with which add-ons.
create table tier_templates (
  id            uuid primary key default gen_random_uuid(),
  job_type      job_type_code not null,
  tier          tier_code not null,
  label         text not null,               -- 'Good — Blown Fiberglass R-49'
  primary_product product_code not null,
  target_r      numeric(6,1),                -- null = use code minimum
  include_air_sealing boolean not null default false,
  include_removal     boolean not null default false,
  marketing_bullets   text[] not null default '{}',
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  row_version   int not null default 1,
  unique (job_type, tier)
);

-- =============================================================================
-- LEARNED COEFFICIENTS (versioned, immutable sets; exactly one active)
-- =============================================================================
create table coefficient_sets (
  id              uuid primary key default gen_random_uuid(),
  version         int generated always as identity unique,
  status          coeff_set_status not null default 'candidate',
  parent_id       uuid references coefficient_sets(id),   -- set it was derived from
  source          text not null check (source in ('seed', 'nightly', 'manual', 'rollback')),
  learning_run_id uuid,                                   -- fk added below
  metrics         jsonb not null default '{}',            -- {"holdout_mape_active":..,"holdout_mape_candidate":..,"n_jobs":..}
  gate_results    jsonb not null default '{}',            -- per-guardrail pass/fail + messages
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      uuid references profiles(id),
  activated_at    timestamptz,
  activated_by    uuid references profiles(id)
);
create unique index coefficient_sets_one_active on coefficient_sets ((true)) where status = 'active';

create table coefficients (
  id            uuid primary key default gen_random_uuid(),
  set_id        uuid not null references coefficient_sets(id) on delete cascade,
  kind          coeff_kind not null,
  product       product_code,               -- null = not scoped by product
  job_type      job_type_code,
  access_level  access_code,
  value         numeric(14,6) not null check (value > 0),
  prior_value   numeric(14,6) not null check (prior_value > 0),
  lower_bound   numeric(14,6) not null,
  upper_bound   numeric(14,6) not null,
  std_error     numeric(14,6),
  sample_size   int not null default 0,
  n_eff         numeric(10,2) not null default 0,
  confidence    numeric(5,2) not null default 0 check (confidence between 0 and 100),
  was_clamped   boolean not null default false,
  check (lower_bound <= value and value <= upper_bound)
);
create unique index coefficients_scope_uq on coefficients
  (set_id, kind, product, job_type, access_level) nulls not distinct;

-- Human-readable changelog row per coefficient change on activation/rollback.
create table coefficient_changes (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  from_set_id   uuid references coefficient_sets(id),
  to_set_id     uuid not null references coefficient_sets(id),
  kind          coeff_kind not null,
  product       product_code,
  job_type      job_type_code,
  access_level  access_code,
  old_value     numeric(14,6),
  new_value     numeric(14,6) not null,
  pct_change    numeric(8,4),
  reason        text not null,              -- 'nightly calibration n_eff=14.2', 'rollback to v12 by owner: ...'
  actor_id      uuid references profiles(id)
);
create index coefficient_changes_to_idx on coefficient_changes (to_set_id);

create table learning_runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'calibration' check (kind in ('calibration','win_model','lead_model','followup_stats','report')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        run_status not null default 'running',
  jobs_considered int,
  jobs_used     int,
  candidate_set_id uuid references coefficient_sets(id),
  promoted      boolean not null default false,
  summary       jsonb not null default '{}',
  error         text
);
alter table coefficient_sets
  add constraint coefficient_sets_run_fk foreign key (learning_run_id) references learning_runs(id);

-- Atomic promotion: candidate -> active, prior active -> superseded, changelog written.
create or replace function promote_coefficient_set(p_set_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old uuid;
begin
  if auth.uid() is not null and not has_role('owner') then
    raise exception 'only owner may promote coefficient sets';
  end if;
  select id into v_old from coefficient_sets where status = 'active' for update;
  if not exists (select 1 from coefficient_sets where id = p_set_id and status = 'candidate') then
    raise exception 'set % is not a candidate', p_set_id;
  end if;

  update coefficient_sets set status = 'superseded' where id = v_old;
  update coefficient_sets set status = 'active', activated_at = now(), activated_by = auth.uid()
   where id = p_set_id;

  insert into coefficient_changes (from_set_id, to_set_id, kind, product, job_type, access_level,
                                   old_value, new_value, pct_change, reason, actor_id)
  select v_old, p_set_id, n.kind, n.product, n.job_type, n.access_level,
         o.value, n.value,
         case when o.value is null or o.value = 0 then null else (n.value - o.value) / o.value end,
         p_reason, auth.uid()
    from coefficients n
    left join coefficients o
      on o.set_id = v_old and o.kind = n.kind
     and o.product      is not distinct from n.product
     and o.job_type     is not distinct from n.job_type
     and o.access_level is not distinct from n.access_level
   where n.set_id = p_set_id
     and (o.value is null or o.value <> n.value);

  perform log_event('coefficients.promote', 'coefficient_sets', p_set_id::text,
                    jsonb_build_object('from', v_old, 'reason', p_reason));
end $$;

-- Rollback = clone a historical set into a new candidate and promote it. History is never rewritten.
create or replace function rollback_coefficient_set(p_target_set_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_new uuid;
begin
  if not has_role('owner') then
    raise exception 'only owner may roll back coefficient sets';
  end if;
  insert into coefficient_sets (status, parent_id, source, notes, created_by)
  values ('candidate', p_target_set_id, 'rollback', p_reason, auth.uid())
  returning id into v_new;

  insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value,
                            lower_bound, upper_bound, std_error, sample_size, n_eff, confidence, was_clamped)
  select v_new, kind, product, job_type, access_level, value, prior_value,
         lower_bound, upper_bound, std_error, sample_size, n_eff, confidence, was_clamped
    from coefficients where set_id = p_target_set_id;

  perform promote_coefficient_set(v_new, 'rollback: ' || p_reason);
  return v_new;
end $$;

-- =============================================================================
-- CUSTOMERS, PROPERTIES, LEADS
-- =============================================================================
create table customers (
  id            uuid primary key default gen_random_uuid(),
  first_name    text not null,
  last_name     text not null,
  email         citext,
  phone         text,                          -- E.164
  sms_consent   boolean not null default false,
  sms_consent_at timestamptz,
  email_consent boolean not null default true,
  notes         text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  row_version   int not null default 1
);

create table properties (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete cascade,
  street        text not null,
  city          text not null,
  state         text not null default 'DE',
  zip           text not null,
  county        text default 'New Castle',
  lat           double precision,
  lng           double precision,
  parcel_id     text,
  year_built    int,
  living_sqft   int,
  home_type     text,                          -- single_family, townhome, etc.
  utility       text,                          -- 'Delmarva Power', 'City of Newark', 'DEMEC'...
  assessor_data jsonb,
  assessor_fetched_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  row_version   int not null default 1
);
create index properties_customer_idx on properties (customer_id);

create table lead_sources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,          -- 'Google LSA', 'Website', 'Referral', 'Angi', 'Energize DE'...
  cost_per_lead numeric(10,2),
  active        boolean not null default true
);

create table leads (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references customers(id),
  property_id       uuid references properties(id),
  source_id         uuid references lead_sources(id),
  status            lead_status not null default 'new',
  assigned_to       uuid references profiles(id),
  received_at       timestamptz not null default now(),
  first_response_at timestamptz,
  appointment_at    timestamptz,
  requested_work    text,
  est_job_size_sqft int,
  score             numeric(5,2),              -- 0..100
  score_breakdown   jsonb,
  score_model_id    uuid,                      -- fk added in Phase 4 section
  lost_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  row_version       int not null default 1
);
create index leads_status_idx   on leads (status);
create index leads_assigned_idx on leads (assigned_to);

-- =============================================================================
-- ESTIMATES
-- =============================================================================
create table estimates (
  id                 uuid primary key,          -- client-generated (offline)
  lead_id            uuid references leads(id),
  customer_id        uuid not null references customers(id),
  property_id        uuid not null references properties(id),
  estimator_id       uuid not null references profiles(id),
  status             estimate_status not null default 'draft',
  coefficient_set_id uuid not null references coefficient_sets(id),
  pricing_snapshot   jsonb not null,            -- frozen rates/settings used to price
  pricing_snapshot_hash text not null,          -- detect drift on sync
  drive_minutes_est  numeric(6,1),              -- one-way, from Maps
  crew_id            uuid references crews(id), -- crew assumed for pricing
  selected_tier      tier_code,
  -- learning-loop fields
  model_total_price  numeric(12,2),             -- what the model alone would charge (best? -> per selected tier)
  recommended_price  numeric(12,2),             -- expected-profit optimum (Phase 2)
  recommended_win_p  numeric(5,4),
  notes              text,
  priced_offline     boolean not null default false,
  client_created_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  row_version        int not null default 1
);
create index estimates_estimator_idx on estimates (estimator_id, status);
create index estimates_status_idx    on estimates (status, created_at desc);

create table estimate_areas (
  id                uuid primary key,          -- client-generated
  estimate_id       uuid not null references estimates(id) on delete cascade,
  name              text not null,             -- 'Main attic', 'Garage ceiling'
  job_type          job_type_code not null,
  sqft              numeric(10,1) not null check (sqft > 0),
  current_r         numeric(6,1) not null default 0 check (current_r >= 0),
  target_r          numeric(6,1),              -- null => code minimum
  existing_material text,
  existing_depth_in numeric(5,2),
  depth_in          numeric(5,2),              -- cavity depth / spray depth where relevant
  access_level      access_code not null default 'moderate',
  removal_needed    boolean not null default false,
  prep_notes        text,
  hazards           text[] not null default '{}',     -- confirmed hazards
  hazard_disposition text,                             -- required when hazards present
  sort_order        int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  row_version       int not null default 1
);
create index estimate_areas_estimate_idx on estimate_areas (estimate_id);

create table estimate_options (
  id              uuid primary key,
  estimate_id     uuid not null references estimates(id) on delete cascade,
  tier            tier_code not null,
  label           text not null,
  direct_cost     numeric(12,2) not null,
  loaded_cost     numeric(12,2) not null,
  price           numeric(12,2) not null,      -- price shown to customer
  model_price     numeric(12,2) not null,      -- price the engine computed before overrides
  is_overridden   boolean not null default false,
  override_reason text,
  margin_pct      numeric(6,4) not null,
  crew_days       numeric(6,2),
  financing       jsonb,                        -- {"apr":..,"term":..,"monthly":..}
  updated_at      timestamptz not null default now(),
  row_version     int not null default 1,
  unique (estimate_id, tier)
);

create table estimate_lines (
  id               uuid primary key,
  option_id        uuid not null references estimate_options(id) on delete cascade,
  area_id          uuid references estimate_areas(id) on delete cascade,
  kind             line_kind not null,
  product          product_code,
  material_id      uuid references materials(id),
  description      text not null,
  -- estimator values (possibly overridden)
  qty              numeric(14,4) not null,
  unit             product_unit,
  hours            numeric(10,3),
  unit_cost        numeric(12,4),
  cost             numeric(12,2) not null,
  -- model values for the same inputs (for deviation + learning)
  design_qty       numeric(14,4),               -- before waste factor
  model_qty        numeric(14,4),
  model_hours      numeric(10,3),
  model_cost       numeric(12,2),
  is_overridden    boolean not null default false,
  sort_order       int not null default 0
);
create index estimate_lines_option_idx on estimate_lines (option_id);

create table deviation_flags (
  id              uuid primary key default gen_random_uuid(),
  estimate_id     uuid not null references estimates(id) on delete cascade,
  option_id       uuid references estimate_options(id) on delete cascade,
  line_id         uuid references estimate_lines(id) on delete cascade,
  metric          text not null check (metric in ('qty','hours','cost','total_price')),
  estimator_value numeric(14,4) not null,
  model_value     numeric(14,4) not null,
  pct_diff        numeric(8,4) not null,
  reasons         jsonb not null,               -- [{"code":"labor_rate","text":"..."}]
  acknowledged_by uuid references profiles(id),
  acknowledged_at timestamptz,
  ack_note        text,
  -- after job completes: who was closer to actual?
  outcome         text check (outcome in ('estimator_closer','model_closer','tie')),
  created_at      timestamptz not null default now()
);
create index deviation_flags_estimate_idx on deviation_flags (estimate_id);

-- =============================================================================
-- QUOTES & E-SIGN
-- =============================================================================
create table quotes (
  id               uuid primary key default gen_random_uuid(),
  estimate_id      uuid not null references estimates(id),
  version          int not null,
  status           quote_status not null default 'sent',
  pdf_path         text not null,                -- storage: quotes/<estimate>/<version>.pdf
  pdf_sha256       text not null,
  snapshot         jsonb not null,               -- full rendered content (options, lines, rebates, financing, terms)
  public_token_hash text not null unique,        -- sha256 of URL token; raw token never stored
  expires_at       timestamptz not null,
  sent_at          timestamptz not null default now(),
  sent_by          uuid not null references profiles(id),
  sent_to_email    citext,
  sent_to_phone    text,
  first_viewed_at  timestamptz,
  signed_at        timestamptz,
  signed_tier      tier_code,
  signed_price     numeric(12,2),
  signer_name      text,
  signature_path   text,                          -- storage: signature image
  signed_pdf_path  text,
  esign_audit      jsonb,                         -- ip, ua, consent text, doc hash, timestamps
  unique (estimate_id, version)
);
create index quotes_status_idx on quotes (status, sent_at desc);

create table quote_events (
  id          bigint generated always as identity primary key,
  quote_id    uuid not null references quotes(id) on delete cascade,
  at          timestamptz not null default now(),
  event       text not null check (event in ('sent','email_delivered','email_opened','viewed','option_selected',
                                              'signed','declined','expired','bounced','reminder_sent')),
  meta        jsonb not null default '{}'
);
create index quote_events_quote_idx on quote_events (quote_id, at);

-- Sent quotes are immutable except for lifecycle fields.
create or replace function tg_quote_immutable() returns trigger
language plpgsql as $$
begin
  if new.snapshot is distinct from old.snapshot
     or new.pdf_sha256 is distinct from old.pdf_sha256
     or new.estimate_id is distinct from old.estimate_id
     or new.version is distinct from old.version then
    raise exception 'quote content is immutable; create a new version';
  end if;
  return new;
end $$;

-- =============================================================================
-- JOBS & ACTUALS
-- =============================================================================
create table jobs (
  id              uuid primary key default gen_random_uuid(),
  quote_id        uuid not null unique references quotes(id),
  estimate_id     uuid not null references estimates(id),
  crew_id         uuid references crews(id),
  status          job_status not null default 'scheduled',
  scheduled_start date,
  scheduled_days  numeric(4,1),
  started_at      timestamptz,
  completed_at    timestamptz,
  revenue         numeric(12,2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     int not null default 1
);
create index jobs_crew_date_idx on jobs (crew_id, scheduled_start);

create table job_actuals (
  id                    uuid primary key,              -- client-generated (crew may be offline)
  job_id                uuid not null references jobs(id) on delete cascade,
  area_id               uuid references estimate_areas(id),
  product               product_code,
  actual_material_qty   numeric(14,4),
  actual_material_unit  product_unit,
  actual_hours          numeric(10,3),                 -- total person-hours
  actual_removal_hours  numeric(10,3),
  actual_crew_size      int,
  actual_drive_minutes  numeric(6,1),                  -- one-way, avg per day
  actual_days           numeric(4,1),
  actual_material_cost  numeric(12,2),
  actual_labor_cost     numeric(12,2),
  actual_other_cost     numeric(12,2),
  notes                 text,
  entered_by            uuid not null references profiles(id),
  entered_at            timestamptz not null default now(),
  verified_by           uuid references profiles(id),
  verified_at           timestamptz,
  exclude_from_learning boolean not null default false,
  exclude_reason        text,
  updated_at            timestamptz not null default now(),
  row_version           int not null default 1,
  check (not exclude_from_learning or exclude_reason is not null)
);
create index job_actuals_job_idx on job_actuals (job_id);
create index job_actuals_learning_idx on job_actuals (verified_at) where verified_at is not null and not exclude_from_learning;

-- Flattened training rows for lib/learning (estimate prediction vs actual).
create or replace view learning_observations as
select
  ja.id                     as actual_id,
  j.id                      as job_id,
  e.id                      as estimate_id,
  e.coefficient_set_id,
  j.completed_at,
  a.job_type,
  a.access_level,
  a.sqft,
  a.removal_needed,
  ja.product,
  l.design_qty,
  l.model_qty,
  l.model_hours,
  e.drive_minutes_est,
  ja.actual_material_qty,
  ja.actual_hours,
  ja.actual_removal_hours,
  ja.actual_drive_minutes,
  ja.actual_crew_size
from job_actuals ja
join jobs j             on j.id = ja.job_id and j.status = 'completed'
join estimates e        on e.id = j.estimate_id
join quotes q           on q.id = j.quote_id
left join estimate_areas a on a.id = ja.area_id
left join estimate_options o on o.estimate_id = e.id and o.tier = q.signed_tier
left join estimate_lines l on l.option_id = o.id and l.area_id = ja.area_id
                          and l.product = ja.product and l.kind = 'material'
where ja.verified_at is not null
  and not ja.exclude_from_learning;

-- =============================================================================
-- PHOTOS & AI TAKEOFF (Phase 3)
-- =============================================================================
create table photos (
  id            uuid primary key,                -- client-generated
  estimate_id   uuid not null references estimates(id) on delete cascade,
  area_id       uuid references estimate_areas(id) on delete cascade,
  storage_path  text not null,
  taken_at      timestamptz,
  width         int,
  height        int,
  uploaded_at   timestamptz,
  created_by    uuid references profiles(id)
);
create index photos_area_idx on photos (area_id);

create table photo_analyses (
  id              uuid primary key default gen_random_uuid(),
  area_id         uuid not null references estimate_areas(id) on delete cascade,
  photo_ids       uuid[] not null,
  model           text not null,
  prompt_version  text not null,
  request_tokens  int,
  response_tokens int,
  cost_usd        numeric(8,4),
  raw_response    jsonb not null,
  est_sqft        numeric(10,1),
  existing_material text,
  existing_depth_in numeric(5,2),
  obstructions    jsonb,
  hazards         jsonb,                          -- [{"type":"vermiculite_suspected","confidence":0.7}]
  confidence      numeric(4,3),
  created_at      timestamptz not null default now()
);

create table photo_corrections (
  id              uuid primary key default gen_random_uuid(),
  analysis_id     uuid not null references photo_analyses(id) on delete cascade,
  field           text not null,                  -- 'sqft', 'existing_depth_in', 'existing_material', 'hazard:<type>'
  ai_value        text,
  confirmed_value text,
  accepted        boolean not null,               -- true = estimator accepted AI value as-is
  corrected_by    uuid not null references profiles(id),
  corrected_at    timestamptz not null default now()
);

-- =============================================================================
-- REBATES (Phase 4)
-- =============================================================================
create table rebate_programs (
  id              uuid primary key default gen_random_uuid(),
  sponsor         text not null,                  -- 'Delmarva Power', 'Energize Delaware'
  name            text not null,
  description     text,
  rules           jsonb not null,                 -- eligibility DSL, evaluated in lib/rebates
  amount_formula  jsonb not null,                 -- {"type":"per_sqft","rate":..,"cap":..} | {"type":"pct","pct":..,"cap":..} | {"type":"flat","amount":..}
  valid_from      date,
  valid_to        date,
  source_url      text,
  last_verified_at date,
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  row_version     int not null default 1
);

create table estimate_rebates (
  estimate_id     uuid references estimates(id) on delete cascade,
  option_id       uuid references estimate_options(id) on delete cascade,
  program_id      uuid references rebate_programs(id),
  amount          numeric(12,2) not null,
  evaluation      jsonb,                          -- which rules matched
  primary key (option_id, program_id)
);

-- =============================================================================
-- MODELS: WIN RATE, LEAD SCORE (Phase 2 / 4)
-- =============================================================================
create table win_models (
  id            uuid primary key default gen_random_uuid(),
  learning_run_id uuid references learning_runs(id),
  trained_at    timestamptz not null default now(),
  n_quotes      int not null,
  params        jsonb not null,                   -- coefficients, feature encodings
  metrics       jsonb not null,                   -- AUC, log-loss, calibration
  is_active     boolean not null default false
);
create unique index win_models_one_active on win_models ((true)) where is_active;

create table lead_score_models (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('rules','logistic')),
  trained_at    timestamptz not null default now(),
  n_leads       int,
  params        jsonb not null,
  metrics       jsonb,
  is_active     boolean not null default false
);
create unique index lead_score_models_one_active on lead_score_models ((true)) where is_active;
alter table leads add constraint leads_score_model_fk foreign key (score_model_id) references lead_score_models(id);

-- =============================================================================
-- FOLLOW-UP AUTOMATION (Phase 4)
-- =============================================================================
create table followup_sequences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  trigger     text not null check (trigger in ('quote_unsigned','lead_no_appointment','post_install_review')),
  active      boolean not null default true
);

create table followup_steps (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references followup_sequences(id) on delete cascade,
  step_no       int not null,
  channel       channel_code not null,
  template_subject text,
  template_body text not null,                    -- handlebars-style {{first_name}}
  -- timing variants for the bandit: delay in hours after previous step
  delay_variants_hours int[] not null check (array_length(delay_variants_hours,1) >= 1),
  unique (sequence_id, step_no)
);

create table followup_enrollments (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references followup_sequences(id),
  quote_id      uuid references quotes(id) on delete cascade,
  lead_id       uuid references leads(id) on delete cascade,
  current_step  int not null default 0,
  next_send_at  timestamptz,
  chosen_variants jsonb not null default '{}',     -- {"1": 48, "2": 120}
  stopped_at    timestamptz,
  stop_reason   text,                              -- signed, replied, opted_out, manual, completed
  converted     boolean
);
create index followup_due_idx on followup_enrollments (next_send_at) where stopped_at is null;

create table followup_variant_stats (
  step_id       uuid references followup_steps(id) on delete cascade,
  delay_hours   int,
  sends         int not null default 0,
  conversions   int not null default 0,           -- signed within attribution window
  primary key (step_id, delay_hours)
);

create table messages (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references customers(id),
  enrollment_id uuid references followup_enrollments(id),
  quote_id      uuid references quotes(id),
  channel       channel_code not null,
  direction     text not null check (direction in ('out','in')),
  status        message_status not null default 'queued',
  to_addr       text not null,
  subject       text,
  body          text not null,
  provider_id   text,
  error         text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index messages_customer_idx on messages (customer_id, created_at desc);

create table opt_outs (
  channel   channel_code not null,
  address   text not null,                         -- normalized email / E.164
  at        timestamptz not null default now(),
  source    text,                                  -- 'STOP reply', 'unsubscribe link', 'manual'
  primary key (channel, address)
);

-- =============================================================================
-- SCHEDULING (Phase 4)
-- =============================================================================
create table crew_availability (
  crew_id       uuid references crews(id) on delete cascade,
  day           date,
  hours_available numeric(4,1) not null default 8,
  note          text,
  primary key (crew_id, day)
);

-- =============================================================================
-- REPORTING & SYNC
-- =============================================================================
create table weekly_reports (
  id          uuid primary key default gen_random_uuid(),
  week_start  date not null unique,
  data        jsonb not null,
  html        text,
  emailed_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- Idempotency ledger for the offline outbox.
create table sync_mutations (
  mutation_id   uuid primary key,
  profile_id    uuid not null references profiles(id),
  entity        text not null,
  entity_id     uuid not null,
  applied_at    timestamptz not null default now(),
  result        jsonb
);

-- =============================================================================
-- CREW VIEW (no prices, margins, or costs)
-- =============================================================================
create or replace view crew_job_view with (security_barrier = true) as
select j.id as job_id, j.status, j.scheduled_start, j.scheduled_days, j.crew_id,
       p.street, p.city, p.zip, p.lat, p.lng,
       c.first_name, c.last_name, c.phone,
       a.id as area_id, a.name as area_name, a.job_type, a.sqft, a.current_r, a.target_r,
       a.access_level, a.removal_needed, a.prep_notes, a.hazards, a.hazard_disposition,
       q.signed_tier,
       (select jsonb_agg(jsonb_build_object('product', l.product, 'description', l.description,
                                            'qty', l.qty, 'unit', l.unit) order by l.sort_order)
          from estimate_options o join estimate_lines l on l.option_id = o.id
         where o.estimate_id = j.estimate_id and o.tier = q.signed_tier
           and l.area_id = a.id and l.kind = 'material') as materials
from jobs j
join quotes q          on q.id = j.quote_id
join estimates e       on e.id = j.estimate_id
join properties p      on p.id = e.property_id
join customers c       on c.id = e.customer_id
join estimate_areas a  on a.estimate_id = e.id
where has_role('owner','office')
   or exists (select 1 from crew_members cm where cm.crew_id = j.crew_id and cm.profile_id = auth.uid());

-- =============================================================================
-- TRIGGERS: touch + audit + immutability
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array['profiles','products','materials','labor_roles','crews','tier_templates',
                           'customers','properties','leads','estimates','estimate_areas','estimate_options',
                           'jobs','job_actuals','rebate_programs']
  loop
    execute format('create trigger %I before update on %I for each row execute function tg_touch_row()',
                   t || '_touch', t);
  end loop;

  foreach t in array array['app_settings','products','materials','labor_roles','crews','job_types',
                           'access_levels','code_requirements','tier_templates','coefficient_sets',
                           'rebate_programs','profiles','estimate_options','job_actuals']
  loop
    execute format('create trigger %I after insert or update or delete on %I for each row execute function tg_audit()',
                   t || '_audit', t);
  end loop;
end $$;

create trigger quotes_immutable before update on quotes for each row execute function tg_quote_immutable();

-- Audit quote send / sign.
create or replace function tg_quote_events_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.event in ('sent','signed','declined') then
    perform log_event('quote.' || new.event, 'quotes', new.quote_id::text, new.meta);
  end if;
  return new;
end $$;
create trigger quote_events_audit after insert on quote_events for each row execute function tg_quote_events_audit();

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','audit_log','app_settings','job_types','access_levels','products','materials','labor_roles',
    'crews','crew_members','code_requirements','tier_templates','coefficient_sets','coefficients',
    'coefficient_changes','learning_runs','customers','properties','lead_sources','leads','estimates',
    'estimate_areas','estimate_options','estimate_lines','deviation_flags','quotes','quote_events','jobs',
    'job_actuals','photos','photo_analyses','photo_corrections','rebate_programs','estimate_rebates',
    'win_models','lead_score_models','followup_sequences','followup_steps','followup_enrollments',
    'followup_variant_stats','messages','opt_outs','crew_availability','weekly_reports','sync_mutations']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Audit log: owner reads; nobody writes directly (triggers are SECURITY DEFINER).
create policy audit_read on audit_log for select using (has_role('owner'));
revoke insert, update, delete on audit_log from anon, authenticated;

-- Profiles
create policy profiles_self_read  on profiles for select using (id = auth.uid() or has_role('owner','office'));
create policy profiles_owner_all  on profiles for all    using (has_role('owner')) with check (has_role('owner'));

-- Pricing config: staff (non-crew) read, owner writes.
do $$
declare t text;
begin
  foreach t in array array['app_settings','job_types','access_levels','products','materials','labor_roles',
                           'crews','code_requirements','tier_templates','rebate_programs','lead_sources']
  loop
    execute format('create policy %I on %I for select using (has_role(''owner'',''office'',''estimator''))', t||'_read', t);
    execute format('create policy %I on %I for all using (has_role(''owner'')) with check (has_role(''owner''))', t||'_owner_write', t);
  end loop;
end $$;
create policy crews_crew_read on crews for select using (has_role('crew'));
create policy crew_members_read on crew_members for select using (has_role('owner','office') or profile_id = auth.uid());
create policy crew_members_owner on crew_members for all using (has_role('owner')) with check (has_role('owner'));

-- Coefficients: estimators need the active set to price offline; writes only via cron (service role) or owner RPCs.
create policy coeff_sets_read on coefficient_sets for select
  using (has_role('owner','office') or (has_role('estimator') and status = 'active'));
create policy coeff_read on coefficients for select
  using (has_role('owner','office') or
         (has_role('estimator') and exists (select 1 from coefficient_sets s where s.id = set_id and s.status = 'active')));
create policy coeff_changes_read on coefficient_changes for select using (has_role('owner','office'));
create policy learning_runs_read on learning_runs for select using (has_role('owner','office'));
create policy win_models_read     on win_models for select using (has_role('owner','office','estimator'));
create policy lead_models_read    on lead_score_models for select using (has_role('owner','office'));

-- Customers / properties / leads: owner+office all; estimator sees those tied to their leads/estimates.
create or replace function estimator_can_see_customer(p_customer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from leads where customer_id = p_customer and assigned_to = auth.uid())
      or exists (select 1 from estimates where customer_id = p_customer and estimator_id = auth.uid())
      or exists (select 1 from customers where id = p_customer and created_by = auth.uid())
$$;

create policy customers_staff on customers for all using (has_role('owner','office')) with check (has_role('owner','office'));
create policy customers_est   on customers for select using (has_role('estimator') and estimator_can_see_customer(id));
create policy customers_est_ins on customers for insert with check (has_role('estimator') and created_by = auth.uid());
create policy customers_est_upd on customers for update using (has_role('estimator') and estimator_can_see_customer(id));

create policy properties_staff on properties for all using (has_role('owner','office')) with check (has_role('owner','office'));
create policy properties_est   on properties for all
  using (has_role('estimator') and estimator_can_see_customer(customer_id))
  with check (has_role('estimator') and estimator_can_see_customer(customer_id));

create policy leads_staff on leads for all using (has_role('owner','office')) with check (has_role('owner','office'));
create policy leads_est   on leads for select using (has_role('estimator') and assigned_to = auth.uid());
create policy leads_est_upd on leads for update using (has_role('estimator') and assigned_to = auth.uid());

-- Estimates and children
create or replace function can_edit_estimate(p_estimate uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('owner','office')
      or exists (select 1 from estimates where id = p_estimate and estimator_id = auth.uid() and has_role('estimator'))
$$;

create policy estimates_staff on estimates for all using (has_role('owner','office')) with check (has_role('owner','office'));
create policy estimates_est   on estimates for all
  using (has_role('estimator') and estimator_id = auth.uid())
  with check (has_role('estimator') and estimator_id = auth.uid());

create policy areas_rw   on estimate_areas   for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy options_rw on estimate_options for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy lines_rw   on estimate_lines   for all
  using (exists (select 1 from estimate_options o where o.id = option_id and can_edit_estimate(o.estimate_id)))
  with check (exists (select 1 from estimate_options o where o.id = option_id and can_edit_estimate(o.estimate_id)));
create policy flags_rw   on deviation_flags  for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy rebates_rw on estimate_rebates for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy photos_rw  on photos           for all using (can_edit_estimate(estimate_id)) with check (can_edit_estimate(estimate_id));
create policy analyses_rw on photo_analyses  for all
  using (exists (select 1 from estimate_areas a where a.id = area_id and can_edit_estimate(a.estimate_id)))
  with check (exists (select 1 from estimate_areas a where a.id = area_id and can_edit_estimate(a.estimate_id)));
create policy corrections_rw on photo_corrections for all
  using (exists (select 1 from photo_analyses pa join estimate_areas a on a.id = pa.area_id
                  where pa.id = analysis_id and can_edit_estimate(a.estimate_id)))
  with check (corrected_by = auth.uid());

-- Quotes: creation happens server-side (service role) so the PDF/token are trusted.
create policy quotes_read on quotes for select using (can_edit_estimate(estimate_id));
create policy quote_events_read on quote_events for select
  using (exists (select 1 from quotes q where q.id = quote_id and can_edit_estimate(q.estimate_id)));

-- Jobs: office/owner manage; crew reads assigned jobs via crew_job_view only.
create policy jobs_staff on jobs for all using (has_role('owner','office')) with check (has_role('owner','office'));
create policy jobs_crew_read on jobs for select
  using (has_role('crew') and exists (select 1 from crew_members cm where cm.crew_id = jobs.crew_id and cm.profile_id = auth.uid()));
create policy jobs_crew_update on jobs for update
  using (has_role('crew') and exists (select 1 from crew_members cm where cm.crew_id = jobs.crew_id and cm.profile_id = auth.uid()));

-- Actuals: crew enters for assigned jobs; office/owner verify. Crew cannot set verified_*.
create policy actuals_staff on job_actuals for all using (has_role('owner','office')) with check (has_role('owner','office'));
create policy actuals_crew  on job_actuals for all
  using (has_role('crew') and exists (select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
                                       where j.id = job_id and cm.profile_id = auth.uid()))
  with check (has_role('crew') and entered_by = auth.uid() and verified_by is null and verified_at is null
              and exists (select 1 from jobs j join crew_members cm on cm.crew_id = j.crew_id
                           where j.id = job_id and cm.profile_id = auth.uid()));

-- Ops tables: owner/office.
do $$
declare t text;
begin
  foreach t in array array['followup_sequences','followup_steps','followup_enrollments','followup_variant_stats',
                           'messages','opt_outs','crew_availability']
  loop
    execute format('create policy %I on %I for all using (has_role(''owner'',''office'')) with check (has_role(''owner'',''office''))', t||'_staff', t);
  end loop;
end $$;
create policy crew_avail_read on crew_availability for select using (has_role('estimator','crew'));
create policy weekly_reports_owner on weekly_reports for select using (has_role('owner'));
create policy sync_mutations_self on sync_mutations for select using (profile_id = auth.uid());

-- =============================================================================
-- SEED DATA (placeholders flagged; owner must confirm)
-- =============================================================================
insert into job_types (code, label, sort_order) values
  ('attic','Attic',1), ('walls','Walls',2), ('crawlspace','Crawlspace',3),
  ('rim_joist','Basement Rim Joist',4), ('garage','Garage',5), ('commercial','Commercial',6);

insert into access_levels (code, label, description, prior_mult, sort_order) values
  ('easy',      'Easy',      'Walk-up / pull-down stair, ≥4 ft clearance',             1.00, 1),
  ('moderate',  'Moderate',  'Scuttle hatch, 3–4 ft clearance, some obstructions',     1.15, 2),
  ('difficult', 'Difficult', '<3 ft clearance, heavy obstructions, long hose runs',     1.35, 3),
  ('extreme',   'Extreme',   'Crawl-only, confined space, multiple small bays',         1.60, 4);

insert into products (code, label, unit, r_per_inch, is_r_bearing) values
  ('ocsf',             'Open-Cell Spray Foam',     'board_ft', 3.7, true),
  ('ccsf',             'Closed-Cell Spray Foam',   'board_ft', 6.5, true),
  ('cellulose',        'Blown Cellulose',          'bag',      3.6, true),
  ('fiberglass_blown', 'Blown Fiberglass',         'bag',      2.5, true),
  ('batts',            'Fiberglass Batts',         'sqft',     3.2, true),
  ('air_sealing',      'Air Sealing',              'hour',     null, false),
  ('removal',          'Old Insulation Removal',   'sqft',     null, false);

-- Default code minimums: 2021 IECC Table R402.1.3, Climate Zone 4A (except Marine).
-- VERIFY which edition Newark / New Castle County currently enforce (2018 IECC ceiling = R-49).
insert into code_requirements (job_type, assembly, min_r, alt_spec, code_edition, source_note) values
  ('attic',      'ceiling',         60, null,         '2021 IECC', 'R402.1.3 CZ4 ceiling R-60 — verify local adoption'),
  ('walls',      'wood_frame_wall', 20, '13+5ci',     '2021 IECC', 'R402.1.3 CZ4 wood frame wall'),
  ('crawlspace', 'floor',           19, null,         '2021 IECC', 'R402.1.3 CZ4 floor'),
  ('crawlspace', 'crawl_wall',      10, '10ci or 13', '2021 IECC', 'R402.1.3 CZ4 crawlspace wall'),
  ('rim_joist',  'basement_wall',   10, '10ci or 13', '2021 IECC', 'R402.1.3 CZ4 basement wall'),
  ('garage',     'ceiling',         30, null,         'company default', 'Garage ceiling under conditioned space: treat as floor; owner-editable'),
  ('commercial', 'ceiling',         30, null,         'company default', 'Commercial per IECC C402 — set per project');

insert into app_settings (key, value, description) values
  ('overhead_pct',               '0.18',  'Overhead as % of direct cost — PLACEHOLDER'),
  ('target_margin_pct',          '0.40',  'Target gross margin on price — PLACEHOLDER'),
  ('floor_margin_pct',           '0.25',  'Never recommend/allow below this without owner override'),
  ('ceiling_margin_pct',         '0.60',  'Upper bound for price optimizer scan'),
  ('minimum_job_price',          '995',   'Minimum job price ($) — PLACEHOLDER'),
  ('price_rounding',             '5',     'Round customer price to nearest $'),
  ('productive_hours_per_day',   '7',     'Productive hours per crew member per day'),
  ('vehicle_cost_per_trip',      '45',    'Rig/fuel cost per crew-day trip ($) — PLACEHOLDER'),
  ('disposal_cost_per_sqft',     '0.35',  'Removal disposal ($/sqft) — PLACEHOLDER'),
  ('estimator_override_limit_pct','0.10', 'Max price change an estimator may make without office/owner'),
  ('estimators_see_costs',       'false', 'Show cost/margin breakdown to estimators'),
  ('deviation_threshold',        '0.15',  'Flag estimates deviating more than this from model'),
  ('quote_valid_days',           '30',    'Quote expiry'),
  ('financing',                  '{"provider":null,"apr":0.0999,"term_months":120,"show":true}', 'PLACEHOLDER — confirm partner/terms'),
  ('learning',                   '{"half_life_days":180,"shrinkage_k":5,"min_n_eff":3,"max_step_pct":0.10,"holdout_frac":0.2,"winsor_pct":0.05,"auto_promote":false,"min_quotes_for_win_model":40}', 'Learning loop guardrails'),
  ('followup_quiet_hours',       '{"start":"20:00","end":"09:00","tz":"America/New_York"}', 'No SMS/email during these hours'),
  ('branding',                   '{"company":"Koala Insulation of Newark","license":null,"phone":null,"primary_color":null,"logo_path":null}', 'PLACEHOLDER — PDF branding');

-- Seed coefficient set v1 (priors). Values are industry rules of thumb and MUST be reviewed.
with s as (
  insert into coefficient_sets (status, source, notes, activated_at)
  values ('active', 'seed', 'Initial priors — review with owner', now())
  returning id
)
insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound)
select s.id, v.kind::coeff_kind, v.product::product_code, v.job_type::job_type_code, v.access::access_code,
       v.val, v.val, v.lo, v.hi
from s, (values
  -- waste factors (by product)
  ('waste_factor','ocsf',null,null,             1.10, 1.00, 1.60),
  ('waste_factor','ccsf',null,null,             1.10, 1.00, 1.60),
  ('waste_factor','cellulose',null,null,        1.08, 1.00, 1.60),
  ('waste_factor','fiberglass_blown',null,null, 1.08, 1.00, 1.60),
  ('waste_factor','batts',null,null,            1.05, 1.00, 1.40),
  -- labor person-hours per unit (board_ft / bag / sqft / hour-of-air-sealing)
  ('labor_hrs_per_unit','ocsf',null,null,             0.0040, 0.0005, 0.05),
  ('labor_hrs_per_unit','ccsf',null,null,             0.0060, 0.0005, 0.05),
  ('labor_hrs_per_unit','cellulose',null,null,        0.1500, 0.02,   1.00),
  ('labor_hrs_per_unit','fiberglass_blown',null,null, 0.1500, 0.02,   1.00),
  ('labor_hrs_per_unit','batts',null,null,            0.0150, 0.002,  0.10),
  ('labor_hrs_per_unit','air_sealing',null,null,      1.0000, 1.00,   1.00),
  -- setup / cleanup person-hours per product per job
  ('setup_hours','ocsf',null,null,             3.0, 0.5, 12),
  ('setup_hours','ccsf',null,null,             3.0, 0.5, 12),
  ('setup_hours','cellulose',null,null,        2.0, 0.5, 8),
  ('setup_hours','fiberglass_blown',null,null, 2.0, 0.5, 8),
  ('setup_hours','batts',null,null,            1.0, 0.25, 6),
  -- access multipliers
  ('access_mult',null,null,'easy',      1.00, 0.80, 1.30),
  ('access_mult',null,null,'moderate',  1.15, 0.90, 1.60),
  ('access_mult',null,null,'difficult', 1.35, 1.00, 2.00),
  ('access_mult',null,null,'extreme',   1.60, 1.10, 2.50),
  -- removal person-hours per sqft
  ('removal_hrs_per_sqft',null,'attic',null,      0.020, 0.005, 0.10),
  ('removal_hrs_per_sqft',null,'crawlspace',null, 0.030, 0.005, 0.12),
  -- drive time actual/estimated
  ('drive_time_factor',null,null,null, 1.10, 0.80, 1.80)
) as v(kind, product, job_type, access, val, lo, hi);

insert into materials (product_id, name, unit, cost_per_unit, coverage_sqft_in, is_default, needs_owner_input)
select p.id, m.name, m.unit::product_unit, m.cost, m.cov, true, true
from products p join (values
  ('ocsf',             'Open-cell set (per board ft)',   'board_ft', 0.45, 1.0),
  ('ccsf',             'Closed-cell set (per board ft)', 'board_ft', 1.00, 1.0),
  ('cellulose',        'Cellulose bag (25 lb)',          'bag',      14.00, 200.0),
  ('fiberglass_blown', 'Blown fiberglass bag (~28 lb)',  'bag',      38.00, 450.0),
  ('batts',            'Batt (per sqft @ rated R)',      'sqft',     0.75, null)
) as m(code, name, unit, cost, cov) on p.code = m.code::product_code;

-- Storage buckets (private): quotes, signatures, photos.
-- insert into storage.buckets (id, name, public) values ('quotes','quotes',false), ('signatures','signatures',false), ('photos','photos',false);
