-- =============================================================================
-- Market-based starting values (replaces Phase 1 placeholders)
--
-- Source: owner-supplied research, Oct 2026 — Koala Insulation FDD Item 19
-- benchmarks (job supplies ~28.5% and installer wages ~20.6% of revenue, gross
-- margin ~48-49%, average job ~$3.3-3.5k) and Delaware/Mid-Atlantic wage data.
-- These are ESTIMATES TO CONFIRM; the pricing page keeps flagging them until the
-- owner saves real numbers. The learning loop then corrects labor and waste from
-- actual jobs.
--
-- Pricing math: direct job cost ≈ 52% of revenue. With overhead defined as ALL
-- non-job costs (overhead staff, rent, insurance, vehicles, royalty, brand fund,
-- local marketing ≈ 33% of revenue) the app's overhead_pct is 0.33 / 0.52 ≈ 0.63
-- of direct cost and the target margin is net profit (15%):
--   price = direct × 1.63 / 0.85 ≈ direct / 0.52  → gross margin ≈ 48%.
-- =============================================================================

update app_settings set value = '0.63',
  description = 'All non-job costs (overhead staff, rent, insurance, vehicles, royalty, brand fund, marketing) as % of direct job cost. 0.63 ≈ 33% of revenue — ESTIMATE, confirm'
 where key = 'overhead_pct';
update app_settings set value = '0.15',
  description = 'Target net margin on price after all overhead (≈48% gross margin with overhead 0.63) — ESTIMATE, confirm'
 where key = 'target_margin_pct';
update app_settings set value = '0.05',
  description = 'Lowest net margin allowed without owner approval (≈44% gross margin)'
 where key = 'floor_margin_pct';
update app_settings set value = '0.30',
  description = 'Highest net margin the price optimizer will consider'
 where key = 'ceiling_margin_pct';
update app_settings set value = '1500',
  description = 'Minimum job price ($): setup, travel and cleanup are mostly fixed — ESTIMATE, confirm'
 where key = 'minimum_job_price';

-- No customer-financing partner is contracted yet; never print terms that do not exist.
-- Koala locations commonly use Wisetack, EnerBank USA (Regions), Finance of America or Hearth.
update app_settings
   set value = '{"provider": null, "apr": 0.0899, "term_months": 120, "show": false}',
       description = 'Customer financing shown on quotes. Off until a lender (e.g. Wisetack, EnerBank/Regions, Finance of America, Hearth) gives you program terms — then set provider, APR and term and turn it on. PLACEHOLDER'
 where key = 'financing';

-- Materials: realistic cost per unit before waste; yield loss is the waste factor below.
update materials m set cost_per_unit = v.cost, name = v.name
  from products p, (values
    ('ccsf', 0.47, 'Closed-cell set (~$2,350/set at full yield, per board ft)'),
    ('ocsf', 0.12, 'Open-cell set (~$1,800/set at full yield, per board ft)')
  ) as v(code, cost, name)
 where m.product_id = p.id and p.code = v.code::product_code and m.is_default;

-- Crew: ~$24.50/h average base (helper $16–25, lead $20–32) + ~40% burden ≈ $35 per person-hour.
update crews set blended_hourly_cost = 35.00 where name = 'Crew A' and needs_owner_input;

-- Spray foam rarely hits rated yield (20–30% lower on real jobs): start waste at 1.25 and let
-- the nightly learning correct it. Only the seed set is touched, and only if never recalibrated.
update coefficients c set value = 1.25, prior_value = 1.25
  from coefficient_sets s
 where c.set_id = s.id and s.source = 'seed' and s.status = 'active'
   and c.kind = 'waste_factor' and c.product in ('ocsf', 'ccsf') and c.job_type is null;

-- Good < Better < Best on attics: with blown fiberglass in Good, Good priced above Better.
update tier_templates
   set primary_product = 'cellulose', label = 'Blown Cellulose to Code',
       marketing_bullets = array['Brings your attic to current code R-value', 'Dense cellulose fills gaps and blocks air movement']
 where job_type = 'attic' and tier = 'good' and primary_product = 'fiberglass_blown';
