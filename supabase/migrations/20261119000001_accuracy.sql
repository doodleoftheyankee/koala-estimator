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

-- Dense-pack wall cellulose (OD7, S1-F9). A wall is blown dense, so a 25 lb bag covers far less
-- than on an attic floor: Greenfiber SANCTUARY (INS765) bag chart, dense-pack 2x4 walls (3.5 in):
-- about 35 sq ft per bag = 122.5 sq ft x in per bag. Starts at the current cellulose bag cost.
-- Needs owner input: confirm the coverage and cost with your supplier.
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
