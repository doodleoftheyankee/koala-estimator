-- =============================================================================
-- Accuracy round, Phase 1: insulation that fits (docs/accuracy/ledger.txt, stage "cavity").
--
-- Additive only. origin/main (the live site) keeps working on a database with this migration:
--   - the new materials columns are nullable and nothing on origin/main reads or writes them;
--   - the new material rows are never a product's default (is_default false), so origin/main's
--     default-material lookup (lib/server/bundle.ts: active and is_default) never sees them;
--   - the new coefficient is a job-type cell next to the shared cellulose cell, at the same value,
--     so no price moves on either side.
-- Every insert runs only when its row is not there yet, so running it twice changes nothing, and
-- no value the owner has saved is overwritten.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Materials for one job type (dense-pack walls) and sized materials (batts by R and thickness)
-- -----------------------------------------------------------------------------
alter table materials add column if not exists job_type job_type_code;
alter table materials add column if not exists r_value numeric(6,1);
alter table materials add column if not exists thickness_in numeric(6,2);

comment on column materials.job_type is
  'Used only for this job type (dense-pack walls); null = any job type. A product''s default material has none.';
comment on column materials.r_value is
  'Rated R-value of one piece (batt sizes); null = R comes from the product''s R per inch.';
comment on column materials.thickness_in is
  'Thickness of one piece in inches (batt sizes), so the engine only picks a batt that fits the cavity.';

alter table materials drop constraint if exists materials_r_value_positive;
alter table materials add constraint materials_r_value_positive check (r_value is null or r_value > 0);
alter table materials drop constraint if exists materials_thickness_positive;
alter table materials add constraint materials_thickness_positive check (thickness_in is null or thickness_in > 0);
-- A sized material has both its R-value and its thickness.
alter table materials drop constraint if exists materials_sized_both;
alter table materials add constraint materials_sized_both check ((r_value is null) = (thickness_in is null));
-- A product's default material is its general one: no job type, no size.
alter table materials drop constraint if exists materials_default_is_general;
alter table materials add constraint materials_default_is_general
  check (not is_default or (job_type is null and r_value is null));

-- Dense-pack wall cellulose (OD7, S1-F9). A wall is blown dense, so a bag covers far less than on
-- an attic floor: Greenfiber SANCTUARY card (Rev E, 01/23), dry dense-pack sidewalls at 3.5 pcf,
-- 2x4 (3.5 in): 35.0 sq ft per bag at 16 in o.c. (33.8 at 24 in o.c.) = 122.5 sq ft x in per bag;
-- 2x6: 22.3 (21.6). Not the INS765 card, another product. Starts at the current cellulose bag cost.
-- Needs owner input: confirm the coverage, stud spacing, bag weight and cost with your supplier.
insert into materials (product_id, name, unit, cost_per_unit, coverage_sqft_in, is_default, active, needs_owner_input, job_type)
select p.id, 'Cellulose bag, dense-pack walls (25 lb)', 'bag', m.cost_per_unit, 122.5, false, true, true, 'walls'
  from products p
  join materials m on m.product_id = p.id and m.is_default and m.active
 where p.code = 'cellulose'
   and not exists (select 1 from materials x where x.product_id = p.id and x.job_type = 'walls' and x.r_value is null);

-- Batt sizes (OD8, S1-F6): the engine picks the size by R-value and thickness, so a batt always
-- fits the cavity. Thickness: typical kraft-faced fiberglass batt data (for example Owens Corning
-- EcoTouch: R-11, R-13 and R-15 at 3.5 in, R-19 6.25 in, R-21 5.5 in, R-30 10 in, R-38 12 in).
-- All start at the current batt cost per sq ft. Needs owner input: enter each size's real cost.
insert into materials (product_id, name, unit, cost_per_unit, coverage_sqft_in, is_default, active, needs_owner_input, r_value, thickness_in)
select p.id, v.name, 'sqft', m.cost_per_unit, null, false, true, true, v.r, v.thick
  from products p
  join materials m on m.product_id = p.id and m.is_default and m.active
  cross join (values
    ('Fiberglass batt R-11 (3.5 in)',  11.0, 3.50),
    ('Fiberglass batt R-13 (3.5 in)',  13.0, 3.50),
    ('Fiberglass batt R-15 (3.5 in)',  15.0, 3.50),
    ('Fiberglass batt R-19 (6.25 in)', 19.0, 6.25),
    ('Fiberglass batt R-21 (5.5 in)',  21.0, 5.50),
    ('Fiberglass batt R-30 (10 in)',   30.0, 10.00),
    ('Fiberglass batt R-38 (12 in)',   38.0, 12.00)
  ) as v(name, r, thick)
 where p.code = 'batts'
   and not exists (select 1 from materials x where x.product_id = p.id and x.r_value = v.r);

-- -----------------------------------------------------------------------------
-- Walls get their own cellulose waste cell (L21, review R4). It starts at the shared cellulose
-- value (1.08 seeded), so no price moves today; the learning loop then fits wall actuals in their
-- own cell, and attic prices read the shared cell. Bounds as the shared cell: 1.00 to 1.60.
-- Added to the active set only; earlier sets stay as they were.
-- -----------------------------------------------------------------------------
insert into coefficients (set_id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound)
select c.set_id, 'waste_factor', 'cellulose', 'walls', null, c.value, c.prior_value, 1.00, 1.60
  from coefficients c
  join coefficient_sets s on s.id = c.set_id and s.status = 'active'
 where c.kind = 'waste_factor' and c.product = 'cellulose' and c.job_type is null and c.access_level is null
   and c.value between 1.00 and 1.60
   and not exists (
     select 1 from coefficients x
      where x.set_id = c.set_id and x.kind = 'waste_factor' and x.product = 'cellulose' and x.job_type = 'walls' and x.access_level is null);

-- =============================================================================
-- Accuracy round, quotes stage (docs/accuracy/ledger.txt, stage "quotes"). Additive like the rest:
-- origin/main never calls the function, reads the table or the new setting, and keeps numbering
-- its quotes as before.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Quote numbers from a counter (L12, OD10): PREFIX-YEAR-0001-v1, the year in the business time
-- zone. One row per year holds the last number given; next_quote_number(year) gives the next one,
-- so two quotes sent at the same moment never share a number. Only the server's service role may
-- call it (the send route); nobody reads or writes the table directly.
-- -----------------------------------------------------------------------------
create table if not exists quote_number_counters (
  year       int primary key check (year between 2000 and 9999),
  last_value int not null check (last_value >= 1),
  updated_at timestamptz not null default now()
);
alter table quote_number_counters enable row level security;
revoke all on table quote_number_counters from public, anon, authenticated;

create or replace function next_quote_number(year int) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if next_quote_number.year is null or next_quote_number.year not between 2000 and 9999 then
    raise exception 'next_quote_number: % is not a year', next_quote_number.year;
  end if;
  insert into quote_number_counters as c (year, last_value) values (next_quote_number.year, 1)
  on conflict on constraint quote_number_counters_pkey
    do update set last_value = c.last_value + 1, updated_at = now()
  returning c.last_value into n;
  return n;
end $$;
revoke all on function next_quote_number(int) from public, anon, authenticated;
grant execute on function next_quote_number(int) to service_role;

-- The prefix in front of every quote number: the one quotes already carry. The owner changes it
-- on the Business profile page; a value already saved is kept.
insert into app_settings (key, value, description)
values ('quote_number_prefix', '"KN"', 'Quote number prefix: quote numbers read PREFIX-YEAR-0001-v1')
on conflict (key) do nothing;

-- =============================================================================
-- Accuracy round, flow stage (docs/accuracy/ledger.txt, stage "flow"). Additive like the rest:
-- origin/main never reads the new columns or the new table, and the sync function keeps its
-- signature and its answers (origin/main's phone already handles 'locked').
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The usual cost of each material (L11, RF-13): the Pricing page refuses a cost far outside it
-- until the owner ticks "This cost is right". Until the owner enters a supplier's range, it starts
-- at half to twice the cost on file when this runs. A range already set is kept.
-- -----------------------------------------------------------------------------
alter table materials add column if not exists typical_min numeric(12,4);
alter table materials add column if not exists typical_max numeric(12,4);
alter table materials add column if not exists typical_source text;
alter table materials drop constraint if exists materials_typical_range;
alter table materials add constraint materials_typical_range
  check (typical_min is null or typical_max is null or (typical_min >= 0 and typical_min <= typical_max));
update materials
   set typical_min = round(cost_per_unit / 2, 4),
       typical_max = round(cost_per_unit * 2, 4),
       typical_source = 'Starting range: half to twice the cost on file when ranges were added. Enter your supplier''s range.'
 where typical_min is null and typical_max is null and cost_per_unit > 0;

-- -----------------------------------------------------------------------------
-- Offline estimate sync, same signature and answers as before (phase 2), with two changes:
--   - a signed estimate answers 'locked' before the row-version check (L35, RF-05);
--   - an empty state keeps the stored property's state, else the business profile's state; the
--     database no longer writes in a state of its own (hard rule 3).
-- origin/main's phone already treats 'locked' as "the customer signed: read-only".
-- -----------------------------------------------------------------------------
create or replace function sync_upsert_estimate(p_mutation_id uuid, p_base_row_version int, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_est    jsonb := p_payload->'estimate';
  v_cust   jsonb := p_payload->'customer';
  v_prop   jsonb := p_payload->'property';
  v_id     uuid  := (v_est->>'id')::uuid;
  v_prev   jsonb;
  v_cur    record;
  v_exists boolean;
  v_before jsonb;
  v_after  jsonb;
  v_rv     int;
  v_result jsonb;
  v_acks   jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not has_role('owner', 'office', 'estimator') then
    raise exception 'this role cannot edit estimates' using errcode = '42501';
  end if;

  select result into v_prev from sync_mutations where mutation_id = p_mutation_id;
  if found then
    return v_prev;
  end if;

  select id, row_version, status, client_doc into v_cur from estimates where id = v_id for update;
  v_exists := found;

  -- A signed estimate is never edited again, whatever version the phone started from: it answers
  -- 'locked' first, so a phone with an edit made before it heard of the signature shows the signed
  -- quote, not a false "changed on another device" (L35, RF-05).
  if v_exists and v_cur.status = 'signed' then
    return jsonb_build_object('status', 'locked', 'row_version', v_cur.row_version, 'server_doc', v_cur.client_doc);
  end if;
  if v_exists and v_cur.row_version is distinct from p_base_row_version then
    return jsonb_build_object('status', 'conflict', 'row_version', v_cur.row_version, 'server_doc', v_cur.client_doc);
  end if;

  -- customer -----------------------------------------------------------------
  -- Update-then-insert rather than ON CONFLICT: the estimator SELECT policy looks the
  -- customer up by id, which cannot see a row that is still being inserted.
  update customers c set
    first_name     = v_cust->>'first_name',
    last_name      = v_cust->>'last_name',
    email          = nullif(v_cust->>'email', '')::citext,
    phone          = nullif(v_cust->>'phone', ''),
    sms_consent    = coalesce((v_cust->>'sms_consent')::boolean, false),
    sms_consent_at = case when coalesce((v_cust->>'sms_consent')::boolean, false) and not c.sms_consent then now()
                          when not coalesce((v_cust->>'sms_consent')::boolean, false) then null
                          else c.sms_consent_at end,
    email_consent  = coalesce((v_cust->>'email_consent')::boolean, true)
  where c.id = (v_cust->>'id')::uuid;
  if not found then
    insert into customers (id, first_name, last_name, email, phone, sms_consent, sms_consent_at, email_consent, created_by)
    values ((v_cust->>'id')::uuid, v_cust->>'first_name', v_cust->>'last_name',
            nullif(v_cust->>'email', '')::citext, nullif(v_cust->>'phone', ''),
            coalesce((v_cust->>'sms_consent')::boolean, false),
            case when coalesce((v_cust->>'sms_consent')::boolean, false) then now() end,
            coalesce((v_cust->>'email_consent')::boolean, true), auth.uid());
  end if;

  -- property -----------------------------------------------------------------
  insert into properties as p (id, customer_id, street, city, state, zip, year_built, utility, home_type)
  values ((v_prop->>'id')::uuid, (v_cust->>'id')::uuid, v_prop->>'street', v_prop->>'city',
          coalesce(nullif(v_prop->>'state', ''),
                   (select p0.state from properties p0 where p0.id = (v_prop->>'id')::uuid),
                   nullif(trim((select s.value #>> '{}' from app_settings s where s.key = 'default_state')), '')), v_prop->>'zip',
          (v_prop->>'year_built')::int, nullif(v_prop->>'utility', ''), nullif(v_prop->>'home_type', ''))
  on conflict (id) do update set
    street = excluded.street, city = excluded.city, state = excluded.state, zip = excluded.zip,
    year_built = excluded.year_built, utility = excluded.utility, home_type = excluded.home_type
  where p.customer_id = excluded.customer_id;

  -- estimate -----------------------------------------------------------------
  select coalesce(jsonb_object_agg(tier, price), '{}') into v_before from estimate_options where estimate_id = v_id;

  insert into estimates as e (id, customer_id, property_id, estimator_id, status, coefficient_set_id,
                              pricing_snapshot, pricing_snapshot_hash, drive_minutes_est, crew_id, selected_tier,
                              model_total_price, notes, priced_offline, client_created_at, client_doc)
  values (v_id, (v_cust->>'id')::uuid, (v_prop->>'id')::uuid, auth.uid(),
          (v_est->>'status')::estimate_status, (v_est->>'coefficient_set_id')::uuid,
          v_est->'pricing_snapshot', v_est->>'pricing_snapshot_hash', (v_est->>'drive_minutes_est')::numeric,
          (v_est->>'crew_id')::uuid, (v_est->>'selected_tier')::tier_code, (v_est->>'model_total_price')::numeric,
          v_est->>'notes', coalesce((v_est->>'priced_offline')::boolean, false),
          (v_est->>'client_created_at')::timestamptz, v_est->'client_doc')
  on conflict (id) do update set
    customer_id           = excluded.customer_id,
    property_id           = excluded.property_id,
    status                = excluded.status,
    coefficient_set_id    = excluded.coefficient_set_id,
    pricing_snapshot      = excluded.pricing_snapshot,
    pricing_snapshot_hash = excluded.pricing_snapshot_hash,
    drive_minutes_est     = excluded.drive_minutes_est,
    crew_id               = excluded.crew_id,
    selected_tier         = excluded.selected_tier,
    model_total_price     = excluded.model_total_price,
    notes                 = excluded.notes,
    priced_offline        = excluded.priced_offline,
    client_doc            = excluded.client_doc
  returning row_version into v_rv;

  -- areas ----------------------------------------------------------------------
  -- Keep who acknowledged which deviation, and when, across re-syncs of the same note.
  select coalesce(jsonb_object_agg(flag_key, jsonb_build_object('note', ack_note, 'by', acknowledged_by, 'at', acknowledged_at)), '{}')
    into v_acks from deviation_flags where estimate_id = v_id and flag_key is not null and ack_note is not null;
  delete from deviation_flags where estimate_id = v_id;
  delete from estimate_options where estimate_id = v_id;   -- lines cascade
  delete from estimate_areas
   where estimate_id = v_id
     and id not in (select (a->>'id')::uuid from jsonb_array_elements(coalesce(p_payload->'areas', '[]')) a);

  insert into estimate_areas as ea (id, estimate_id, name, job_type, sqft, current_r, target_r, existing_material,
                                    existing_depth_in, depth_in, access_level, removal_needed, prep_notes, sort_order)
  select r.id, v_id, r.name, r.job_type, r.sqft, coalesce(r.current_r, 0), r.target_r, r.existing_material,
         r.existing_depth_in, r.depth_in, coalesce(r.access_level, 'moderate'), coalesce(r.removal_needed, false),
         r.prep_notes, coalesce(r.sort_order, 0)
    from jsonb_populate_recordset(null::estimate_areas, coalesce(p_payload->'areas', '[]')) r
  on conflict (id) do update set
    name = excluded.name, job_type = excluded.job_type, sqft = excluded.sqft, current_r = excluded.current_r,
    target_r = excluded.target_r, existing_material = excluded.existing_material,
    existing_depth_in = excluded.existing_depth_in, depth_in = excluded.depth_in,
    access_level = excluded.access_level, removal_needed = excluded.removal_needed,
    prep_notes = excluded.prep_notes, sort_order = excluded.sort_order
  where ea.estimate_id = v_id;

  -- options + lines ------------------------------------------------------------
  insert into estimate_options (id, estimate_id, tier, label, direct_cost, loaded_cost, price, model_price,
                                is_overridden, override_reason, margin_pct, crew_days, financing)
  select r.id, v_id, r.tier, r.label, r.direct_cost, r.loaded_cost, r.price, r.model_price,
         coalesce(r.is_overridden, false), r.override_reason, r.margin_pct, r.crew_days, r.financing
    from jsonb_populate_recordset(null::estimate_options, coalesce(p_payload->'options', '[]')) r;

  insert into estimate_lines (id, option_id, area_id, kind, product, material_id, description, qty, unit, hours,
                              unit_cost, cost, design_qty, model_qty, model_hours, model_cost, is_overridden,
                              override_reason, line_key, sort_order)
  select l.id, (o->>'id')::uuid, l.area_id, l.kind, l.product, l.material_id, l.description, l.qty, l.unit, l.hours,
         l.unit_cost, l.cost, l.design_qty, l.model_qty, l.model_hours, l.model_cost, coalesce(l.is_overridden, false),
         l.override_reason, l.line_key, coalesce(l.sort_order, 0)
    from jsonb_array_elements(coalesce(p_payload->'options', '[]')) o,
         jsonb_populate_recordset(null::estimate_lines, coalesce(o->'lines', '[]')) l;

  -- deviation flags: computed by the server from the model on every sync; notes come from the estimator
  insert into deviation_flags (estimate_id, option_id, line_id, metric, estimator_value, model_value, pct_diff, reasons,
                               flag_key, tier, ack_note, acknowledged_by, acknowledged_at)
  select v_id, o.id, l.id, f->>'metric', (f->>'estimator_value')::numeric, (f->>'model_value')::numeric,
         (f->>'pct_diff')::numeric, coalesce(f->'reasons', '[]'), f->>'flag_key', (f->>'tier')::tier_code,
         nullif(f->>'ack_note', ''),
         case when nullif(f->>'ack_note', '') is null then null
              when v_acks->(f->>'flag_key')->>'note' = f->>'ack_note' then (v_acks->(f->>'flag_key')->>'by')::uuid
              else auth.uid() end,
         case when nullif(f->>'ack_note', '') is null then null
              when v_acks->(f->>'flag_key')->>'note' = f->>'ack_note' then (v_acks->(f->>'flag_key')->>'at')::timestamptz
              else now() end
    from jsonb_array_elements(coalesce(p_payload->'flags', '[]')) f
    left join estimate_options o on o.estimate_id = v_id and o.tier = (f->>'tier')::tier_code
    left join lateral (select el.id from estimate_lines el
                        where el.option_id = o.id and el.line_key = f->>'line_key' limit 1) l on true;

  select coalesce(jsonb_object_agg(tier, price), '{}') into v_after from estimate_options where estimate_id = v_id;
  if v_before is distinct from v_after then
    perform log_event('estimate.price_change', 'estimates', v_id::text,
                      jsonb_build_object('before', v_before, 'after', v_after,
                                         'overrides', v_est->'client_doc'->'overrides',
                                         'line_overrides', v_est->'client_doc'->'lineOverrides',
                                         'pricing_snapshot_hash', v_est->>'pricing_snapshot_hash'));
  end if;

  v_result := jsonb_build_object('status', 'applied', 'row_version', v_rv);
  insert into sync_mutations (mutation_id, profile_id, entity, entity_id, result)
  values (p_mutation_id, auth.uid(), 'estimate', v_id, v_result);
  return v_result;
end $$;


revoke all on function sync_upsert_estimate(uuid, int, jsonb) from public, anon;
grant execute on function sync_upsert_estimate(uuid, int, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Price approvals (L34, RF-02). An estimator who needs a price beyond what they may quote alone
-- asks for it here; the owner or the office decides. An approval is bound to one estimate, one
-- option, the exact whole-dollar price and the model price it was asked against, so it never
-- covers a different price or a re-priced estimate. Rules:
--   staff read      owner and office read every request, an estimator those on their estimates;
--   ask             an estimator (or the office) asks, for an estimate they can edit, as themselves;
--   decide          the owner or the office approves or declines a pending request, never their own;
--                   a price below the floor margin is for the owner only.
-- The database records who decided, in which role and when, and a decision never changes again.
-- -----------------------------------------------------------------------------
create table if not exists price_approvals (
  id            uuid primary key default gen_random_uuid(),
  estimate_id   uuid not null references estimates(id) on delete cascade,
  tier          tier_code not null,
  price         numeric(12,2) not null,
  model_price   numeric(12,2) not null,
  below_floor   boolean not null default false,
  note          text,
  status        text not null default 'pending',
  requested_by  uuid not null references profiles(id),
  requested_at  timestamptz not null default now(),
  decided_by    uuid references profiles(id),
  decided_role  user_role,
  decided_at    timestamptz,
  decision_note text,
  constraint price_approvals_price_whole check (price > 0 and price = round(price)),
  constraint price_approvals_model_price check (model_price >= 0),
  constraint price_approvals_status check (status in ('pending', 'approved', 'declined')),
  constraint price_approvals_decided check (
    (status = 'pending') = (decided_by is null) and (decided_by is null) = (decided_at is null)),
  constraint price_approvals_note_length check (note is null or char_length(note) <= 500),
  constraint price_approvals_decision_note_length check (decision_note is null or char_length(decision_note) <= 500)
);
create index if not exists price_approvals_estimate_idx on price_approvals (estimate_id, tier, requested_at desc);
create index if not exists price_approvals_pending_idx on price_approvals (requested_at) where status = 'pending';
-- The same request is queued once.
create unique index if not exists price_approvals_one_pending on price_approvals (estimate_id, tier, price) where status = 'pending';
alter table price_approvals enable row level security;
revoke all on table price_approvals from anon;

create or replace function tg_price_approval_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    -- A request made through the API is always the asker's own and starts pending.
    if auth.uid() is not null then
      new.requested_by := auth.uid();
      new.requested_at := now();
      new.status := 'pending';
      new.decided_by := null;
      new.decided_role := null;
      new.decided_at := null;
      new.decision_note := null;
    end if;
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'price approval %: a decision cannot be changed', old.id;
  end if;
  if new.estimate_id is distinct from old.estimate_id or new.tier is distinct from old.tier
     or new.price is distinct from old.price or new.model_price is distinct from old.model_price
     or new.below_floor is distinct from old.below_floor or new.note is distinct from old.note
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at then
    raise exception 'price approval %: only the decision can be recorded, not what was asked', old.id;
  end if;
  if new.status <> 'pending' then
    new.decided_by := coalesce(auth.uid(), new.decided_by);
    new.decided_role := coalesce(auth_role(), new.decided_role);
    new.decided_at := now();
  end if;
  return new;
end $$;

drop trigger if exists price_approvals_guard on price_approvals;
create trigger price_approvals_guard before insert or update on price_approvals
  for each row execute function tg_price_approval_guard();
drop trigger if exists price_approvals_audit on price_approvals;
create trigger price_approvals_audit after insert or update or delete on price_approvals
  for each row execute function tg_audit();

drop policy if exists price_approvals_staff_read on price_approvals;
create policy price_approvals_staff_read on price_approvals for select using (can_edit_estimate(estimate_id));
drop policy if exists price_approvals_ask on price_approvals;
create policy price_approvals_ask on price_approvals for insert
  with check (has_role('estimator', 'office') and requested_by = auth.uid() and status = 'pending'
              and can_edit_estimate(estimate_id));
drop policy if exists price_approvals_decide on price_approvals;
create policy price_approvals_decide on price_approvals for update
  using (has_role('owner', 'office') and status = 'pending' and requested_by <> auth.uid())
  with check (has_role('owner', 'office') and requested_by <> auth.uid() and (not below_floor or has_role('owner')));
