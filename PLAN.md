# Koala Insulation of Newark, DE — Estimator Platform

## Plan

A mobile-first estimating, quoting, and self-calibrating pricing system. Estimators use it
on phones in attics and crawlspaces, often with no signal. Every finished job makes the
next estimate more accurate.

---

## 1. Goals and non-goals

**Goals**
1. An estimator on a phone can go from walking into a house to sending a signed-ready
   good/better/best quote in under 15 minutes, with or without signal.
2. Pricing is fully data-driven. Every rate, cost, margin, and coefficient lives in the
   database, is editable by the owner, and is audit-logged. Nothing is hardcoded.
3. The model gets better on its own: estimate → job → actuals → nightly recalibration,
   with guardrails so a bad night of data can never break pricing.
4. The owner can see why a number is what it is: sample size, confidence, changelog, and
   one-click rollback for every learned coefficient.

**Non-goals for v1**
- Full accounting or payroll. We export to QuickBooks later; we don't replace it.
- Multi-location franchise tenancy. The schema is single-tenant. Section 13 covers this.
- Native iOS/Android apps. The PWA covers offline use and camera access.

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router) + TypeScript (strict) | SSR for the admin pages, client components for the field UI |
| UI | Tailwind + shadcn/ui (Radix) | Accessible primitives and large tap targets for gloved hands |
| DB / Auth / Files | Supabase (Postgres 15, Auth, Storage) | RLS enforces roles at the data layer |
| Hosting | Vercel | Preview deployments per PR; Cron for nightly and weekly jobs |
| Offline | Hand-written service worker (`public/sw.js`) + IndexedDB (Dexie) | Outbox-based sync, described in Section 7 |
| Validation | Zod | One schema shared by the form, the API, and the sync payload |
| PDF | `@react-pdf/renderer` on the server | Deterministic, branded output without a headless browser |
| Email | Resend | Quote delivery, follow-ups, weekly report |
| SMS | Twilio | Follow-up texts. **Needs A2P 10DLC registration, which takes 1–3 weeks. Start early.** |
| Vision | Claude API (latest Sonnet-class vision model; model ID read from config) | Photo takeoff with structured JSON output |
| Maps | Google Maps Distance Matrix + Geocoding | Drive time and job clustering |
| Math | Hand-rolled WLS/logistic in `lib/learning` (no heavy deps) | Small data and full test control |
| Tests | Vitest + fast-check (property tests), Playwright (e2e), pgTAP (RLS) | |

---

## 3. Roles and permissions

| Capability | owner | office | estimator | crew |
|---|---|---|---|---|
| Edit pricing tables, settings, rebates | ✅ | ❌ | ❌ | ❌ |
| Approve or roll back coefficient sets | ✅ | ❌ | ❌ | ❌ |
| View coefficients and learning dashboard | ✅ | ✅ (read) | ❌ | ❌ |
| Leads: create and assign | ✅ | ✅ | own | ❌ |
| Estimates: create and edit | ✅ | ✅ | own | ❌ |
| Send quote / override price | ✅ | ✅ | own; override within ±X% (setting) | ❌ |
| See cost, margin, and overhead breakdown | ✅ | ✅ | configurable (default: no) | ❌ |
| Schedule jobs | ✅ | ✅ | suggest only | ❌ |
| Enter job actuals | ✅ | ✅ | ❌ | assigned jobs only |
| Weekly owner report | ✅ | ❌ | ❌ | ❌ |

These rules are enforced in **Postgres RLS** (see `supabase/migrations/`), not just in the UI. Crew
users never receive price or margin columns: they read jobs through a restricted view
(`crew_job_view`).

---

## 4. Domain model (summary; full DDL in `supabase/migrations/`)

```
customers ─< properties ─< leads ─< estimates ─< estimate_areas
                                        │              │
                                        │              └─< photos ─< photo_analyses ─< photo_corrections
                                        ├─< estimate_options (good / better / best)
                                        │        └─< estimate_lines
                                        ├─< deviation_flags
                                        ├─< estimate_rebates >─ rebate_programs
                                        └─< quotes ─< quote_events
                                               └── jobs ─< job_actuals
                                                     └── crews ─< crew_availability

pricing:   products, materials, labor_roles, crews, job_types, access_levels,
           code_requirements, tier_templates, app_settings
learning:  coefficient_sets ─< coefficients ; coefficient_changes ; learning_runs
           win_models ; lead_score_models ; followup_variant_stats
ops:       followup_sequences ─< followup_steps ; followup_enrollments ; messages ; opt_outs
system:    audit_log (append-only), sync_mutations (idempotency), weekly_reports
```

**Reproducibility rule:** every estimate stores the `coefficient_set_id` it was priced with
and a frozen `pricing_snapshot` (JSON of every rate it used). A quote can always be
re-rendered exactly, and the learning loop always knows which model made which prediction.

---

## 5. Pricing engine (`/lib/pricing`)

This module is pure and deterministic. It does no I/O. Its signature:

```ts
priceEstimate(input: EstimateInput, pricing: PricingSnapshot, coeffs: CoefficientSet): PricedEstimate
```

### 5.1 Per area × product

```
target_R        = input.target_r ?? code_requirements[job_type].min_r     // DE / IECC zone 4A
added_R         = max(0, target_R − current_R)        // when old insulation stays
                  target_R                            // when removal_needed
thickness_in    = added_R / product.r_per_inch
design_qty      = units_needed(product, sqft, thickness_in)   // board-ft, bags, or sq ft
material_qty    = design_qty × coeff(waste_factor | product, job_type)
material_cost   = material_qty × material.cost_per_unit

labor_hours     = coeff(setup_hours | product)
                + design_qty × coeff(labor_hrs_per_unit | product, job_type)
                             × coeff(access_mult | access_level)
removal_hours   = removal_needed ? sqft × coeff(removal_hrs_per_sqft | job_type) × access_mult : 0
labor_cost      = (labor_hours + removal_hours) × crew.blended_hourly_cost
```

### 5.2 Per job

```
crew_days       = ceil((Σ labor_hours) / (crew.size × settings.productive_hours_per_day))
drive_cost      = drive_minutes_one_way × 2 × crew_days × crew.size
                  × coeff(drive_time_factor) × crew.blended_hourly_cost / 60
                  + crew_days × settings.vehicle_cost_per_trip
disposal_cost   = removal ? sqft × settings.disposal_cost_per_sqft : 0
direct_cost     = Σ material + Σ labor + drive + disposal + permit/misc lines
loaded_cost     = direct_cost × (1 + settings.overhead_pct)
price           = loaded_cost / (1 − settings.target_margin_pct)          // margin on price
price           = max(price, settings.minimum_job_price)
price           = round_to(price, settings.price_rounding)                // e.g. nearest $5
```

**Good / Better / Best** options come from `tier_templates`, which the owner edits. For
example, an attic is Good = blown fiberglass to R-49, Better = cellulose to R-60 with air
sealing, Best = removal, air sealing, and cellulose to R-60. The engine prices each option
independently.

**Financing line:** `monthly = PMT(apr, term_months, price)` using the financing settings,
shown as "as low as $X/mo". The financing provider is still an open question (Section 13).

**Invariants**, enforced by property tests:
- Every price is ≥ the minimum job price and the margin is ≥ the floor margin.
- Price is monotonic in sq ft, target R, and access difficulty.
- The same inputs and the same snapshot always produce the same output.
- An empty or missing coefficient falls back to its prior. The engine never sees NaN,
  never sees ≤ 0, and never throws for a valid input.

---

## 6. Self-improving loop (`/lib/learning`): the priority

### 6.1 Data capture
When a job completes, the crew lead enters on the phone, per area × product: actual
material used (sets, bags, or rolls), actual crew hours, crew size, actual drive time,
and notes. The office can add actual material and labor cost from invoices or payroll.
The office or owner verifies the entry, and only verified rows feed learning.
`exclude_from_learning` and a reason let them quarantine odd jobs, such as a callback
or a rework.

### 6.2 What is learned

| Coefficient (`kind`) | Scope | Observation per job |
|---|---|---|
| `waste_factor` | product × job_type | actual_material_qty / design_qty |
| `labor_hrs_per_unit` | product × job_type | actual_hours / design_qty, access-adjusted |
| `access_mult` | access_level | residual ratio after product × job_type |
| `setup_hours` | product | intercept of the hours regression |
| `removal_hrs_per_sqft` | job_type | actual_removal_hours / sqft |
| `drive_time_factor` | global | actual_drive / Google estimate |
| `photo_area_bias` | job_type | confirmed_sqft / ai_sqft (Phase 3) |

### 6.3 Method
- **Recency weighting:** `w = 0.5^(age_days / half_life)`, with half-life = 180 days in
  settings. Effective sample size: `n_eff = (Σw)² / Σw²`.
- **Robustness:** winsorize ratios at the 5th and 95th percentile within each scope, and
  drop jobs with `exclude_from_learning`.
- **Labor model:** a weighted least-squares fit of `hours = setup + units × rate × access_mult`,
  solved in log space per product × job_type, with a ridge penalty that pulls toward the
  current active value. A thin cell barely moves; a cell with plenty of data converges to
  the data.
- **Hierarchical shrinkage** for sparse cells:
  `est = (n_eff × cell_mean + k × parent_mean) / (n_eff + k)`, with parent order
  product×job_type → product → prior. `k` is in settings (default 5).
- **Confidence score (0–100):** combines `n_eff` and the relative standard error:
  `conf = 100 × (1 − exp(−n_eff/8)) × clamp(1 − rel_SE, 0, 1)`. The admin panel shows
  value, prior, Δ, n, n_eff, ±SE, and confidence for every coefficient.

### 6.4 Guardrails ("model updates never break pricing")
1. **Candidate, not live.** The nightly run writes a new `coefficient_sets` row with
   `status='candidate'`. The pricing engine only ever reads `status='active'`.
2. **Hard bounds** per kind (for example `waste_factor ∈ [1.00, 1.60]`). A value outside
   its bounds is clamped and flagged.
3. **Step limit:** at most a ±10% change per coefficient per run (set in settings).
4. **Minimum evidence:** a cell needs `n_eff ≥ 3` to move at all. Below that it keeps its
   parent or prior value.
5. **Backtest gate:** the candidate must not have worse MAPE than the active set on a
   time-ordered holdout (the most recent 20% of jobs). If it does, it is `rejected`.
6. **Promotion:** if `settings.learning_auto_promote = true` and every gate passes, the
   candidate is promoted. Otherwise it waits for owner approval in the admin panel.
7. **Atomic swap** in one transaction: the old set becomes `superseded`, the new set
   becomes `active`. A partial unique index guarantees exactly one active set.
8. **Rollback:** "Restore this version" clones any past set into a new active set.
   History is never rewritten. The clone, the diff, and the reason all land in the
   changelog.
9. **Failure isolation:** if a run throws, it is logged in `learning_runs` with the error,
   the active set is untouched, and the owner is emailed.

### 6.5 Deviation flags (>15%)
On every price change in the UI, and again before a quote is sent, we compare the
estimator's quantities and hours (including manual overrides) against what the active
model predicts for the same inputs. Any line, or the total, that differs by more than
`settings.deviation_threshold` (0.15) creates a `deviation_flag` with machine-written
reasons. Examples:
- "Labor hours 38% above model. Model uses 0.021 hr/sq ft for cellulose in an attic with
  difficult access (n=27, conf 81). You entered 14 hrs; model predicts 10.1 hrs."
- "Material 22% below model. Model waste factor for closed-cell in a rim joist is 1.18
  (n=12). Your quantity implies 0.97."

Before sending, the estimator must acknowledge the flag with a note. The flag outcome
(did actuals prove the estimator or the model right?) is tracked, so the owner can see
when estimator overrides beat the model.

### 6.6 Win-rate and price optimization
- **Data:** every sent quote has an outcome (won, lost, or expired after N days), along
  with price, model cost, job type, lead source, size, and estimator.
- **Model:** weighted logistic regression
  `P(win) = σ(β₀ + β₁·markup + β_jobtype + β_source + β₂·log(size))`, where
  `markup = price / loaded_cost`.
- **Recommendation:** for each new estimate, scan markups across
  `[floor_margin, ceiling_margin]` and maximize **expected profit**
  `= P(win | markup) × (price − loaded_cost)`. Show the recommended price, the win
  probability at that price, and the expected-profit curve next to the estimator's price.
- **Cold start:** with fewer than 40 decided quotes, show win rate by bucket (job type,
  source, price band) only. No recommendation appears until the model has data.
- Win rate is reported by price band, job type, and lead source on the dashboard.

### 6.7 Module layout and tests
```
lib/learning/
  weights.ts          recency weights, n_eff
  robust.ts           winsorize, MAD
  wls.ts              weighted least squares + ridge (closed-form, small matrices)
  shrinkage.ts        hierarchical shrinkage
  confidence.ts
  calibrate.ts        actuals → observations → candidate coefficients
  guardrails.ts       bounds, step limit, min evidence
  backtest.ts         holdout MAPE, active vs candidate
  winRate.ts          logistic regression (IRLS) + expected-profit optimizer
  deviation.ts        estimator vs model diff + reason strings
  leadScore.ts        (Phase 4)
  followupBandit.ts   (Phase 4) Thompson sampling over cadence variants
  index.ts            the only public surface
```
These modules are pure functions over plain arrays; the DB adapter lives in
`lib/learning/io.ts`. Tests use synthetic job generators with known true coefficients.
We assert recovery within tolerance, guardrail behavior (step limits, bounds, rejection on
a worse backtest), idempotency, NaN and empty-data safety, and rollback. CI blocks the
merge if coverage on `lib/learning` and `lib/pricing` falls below 95%.

---

## 7. Offline-first PWA

- **App shell and static assets** are precached by the service worker. The estimator,
  photo capture, and actuals screens work fully offline.
- **Local store (Dexie):** customers, properties, estimates, areas, options, photos (as
  blobs), the cached `PricingSnapshot`, and the active `CoefficientSet`, refreshed on each
  online launch.
- **Writes go to an outbox.** Every mutation has a client-generated UUID (`mutation_id`)
  and record IDs are client UUIDs, so replays are idempotent: the server records applied
  `mutation_id`s in `sync_mutations`.
- **Sync** runs on `online` events, on Background Sync where available, and on app focus.
  Photos upload with resumable uploads to Supabase Storage.
- **Conflicts:** each row has `row_version`. The server rejects stale writes, and the client
  then merges field by field (last-writer-wins per field, with the estimator's
  field values winning on their own drafts). Sent quotes are immutable, so they never
  conflict.
- **Pricing drift:** if an estimate was priced offline against an older pricing version or
  coefficient set, the server re-prices it on sync, shows a diff banner, and requires
  re-confirmation before sending.
- **Online-only actions:** sending a quote, photo AI analysis, and lead lookup. Offline,
  these show "Queued, will send when online". The PDF is generated server-side.

---

## 8. Quotes, PDF, e-sign, delivery

- The quote PDF uses Koala branding (logo, colors, license number, and warranty text, all
  in settings). It lists itemized lines per option, rebates, financing, terms, and an
  expiry date.
- **E-sign:** for v1 we recommend a built-in signing page. The tokenized link has 128-bit
  random tokens and stores only a hash. The customer picks an option and signs by typing
  or drawing. We capture an ESIGN/UETA audit trail (IP, user agent, timestamps, document
  SHA-256, and consent checkbox) and then generate a signed PDF. DocuSign or Dropbox Sign
  can plug in behind the same interface later.
- Quote send is auto-emailed through Resend, with an optional SMS link. Opens, views, and
  signatures are tracked in `quote_events`.
- A sent quote version is **immutable**. A revision creates `quotes.version + 1`.

---

## 9. Photo takeoff (Phase 3)

1. The estimator snaps 1–N photos per area, offline-capable. Photos sync to Storage.
2. A server action sends the photos to Claude vision with a versioned prompt and a JSON
   schema: `{est_sqft, sqft_method, existing_material, existing_depth_in, obstructions[],
   hazards[] (vermiculite/asbestos suspicion, knob-and-tube, mold, rodent, open
   junction boxes, recessed lights non-IC), confidence, notes}`. Reference objects (a
   tape measure, joist spacing of 16"/24" OC) are requested in the capture guide so it
   can measure from scale.
3. The UI shows the AI values next to the estimator's inputs. The estimator **confirms or
   corrects** each field, and the diffs land in `photo_corrections`.
4. Corrections feed `photo_area_bias` and per-field accuracy stats. Over time the UI
   pre-fills only fields whose accuracy clears a threshold.
5. **Safety:** suspected vermiculite (possible asbestos) or knob-and-tube wiring
   **hard-blocks** blown or spray product options for that area until the estimator records
   a disposition. The AI never auto-clears a hazard.

---

## 10. Leads, follow-up, scheduling, rebates, reporting (Phase 4)

- **Lead scoring 0–100:** v0 uses owner-editable weights over source, home age, job size,
  and response time (minutes from lead to first contact). Once there are ≥100 closed
  leads, a logistic model trains nightly, and the score is the calibrated P(close) × 100
  with a "why" breakdown. Home age and size come from **New Castle County parcel data**
  behind an `AssessorProvider` interface; the data source is still to be confirmed
  (Section 13). Results are cached on `properties`.
- **Follow-up automation:** sequences of email and SMS steps for unsigned quotes. Each
  step has 2–3 timing variants, and a Thompson-sampling bandit allocates toward the
  variants that convert. Sequences stop when the quote is signed, the customer replies, or
  they opt out (STOP is honored, per TCPA). Quiet hours are 8pm–9am local.
- **Scheduling suggestions:** the system scores candidate dates on crew capacity fit
  (`crew_availability` minus booked hours), job duration, geographic clustering (haversine
  distance to other jobs that crew has that day or week), and the customer's preferred
  window. It shows the top 3 dates with reasons. Office staff confirm the booking.
- **Rebate finder:** `rebate_programs` stores sponsor (Delmarva Power, Energize Delaware),
  eligibility rules as JSON (job type, product, pre/post R-value, income tier, utility
  account, home type), the amount formula, valid dates, source URL, and
  `last_verified_at`. Eligible rebates attach to the estimate automatically and print on
  the quote. **The office has to keep these current; the program rules change. Any program
  not verified in 90 days shows a warning.**
- **Weekly owner report:** a Vercel Cron job runs Monday at 6:00 ET. It covers revenue
  (signed and completed), close rate, average ticket, estimate accuracy (MAPE of cost and
  hours, trended), the top estimator (by expected profit won, not just volume), quotes
  aging past 7, 14, and 30 days, coefficient changes this week, and flagged deviations.
  It is emailed as HTML and stored in `weekly_reports`.

---

## 11. Audit and security

- `audit_log` is append-only. Updates and deletes are revoked, and only `SECURITY DEFINER`
  triggers write to it. The log is populated by triggers on every pricing table,
  `app_settings`, `coefficient_sets`, `rebate_programs`, `tier_templates`, and on quote
  send, sign, and price override. Each entry has actor, action, before/after JSON, and a
  timestamp.
- The service-role key is server only. Cron endpoints require `CRON_SECRET`. Quote links
  use hashed tokens with expiry.
- Customer PII lives only in `customers`. Storage buckets are private, with signed URLs.
- Rate limits apply on public quote and sign endpoints.

---

## 12. Phased delivery

Each phase ships behind a preview deployment, with tests green and a short demo script.

### Phase 1: Estimator and quotes
- Supabase project, migrations in `supabase/migrations/` (the reviewed `schema.sql` became `20261020000001_init.sql`), seed data (job types, products, access
  levels, zone 4A code minimums, placeholder rates for the owner to fill in).
- Auth (email magic link and passcode), roles, RLS, pgTAP tests per role.
- Admin pricing tables UI (products, materials, crews, settings, tier templates) with
  audit log.
- `lib/pricing` with full unit and property tests. Initial coefficient set v1 uses
  industry-default priors.
- Mobile estimate flow: customer → property → areas → inputs → G/B/B → review. Offline
  with outbox sync.
- Quote PDF, built-in e-sign page, Resend email, quote events.
- **Done when:** an estimator can create and price an estimate in airplane mode, sync it,
  send it, and the customer can sign it on their phone, with every price change audited.

### Phase 2: Actuals and the learning loop
- Crew actuals entry (offline-capable) and office verification.
- `lib/learning` (calibrate, guardrails, backtest, deviation, winRate) with ≥95% coverage.
- Nightly Vercel Cron at 02:15 ET → `learning_runs` → candidate set → gates → promote or
  hold.
- Admin learning dashboard: coefficient table (value, Δ, n, n_eff, conf), changelog,
  diff view, approve, rollback, and the run log.
- Deviation flags in the estimator UI, with the acknowledgment flow.
- Win-rate dashboard and expected-profit price recommendation (behind the cold-start
  threshold).
- **Done when:** seeded synthetic history recovers known coefficients; a corrupted
  actuals batch is rejected by the gates; rollback restores pricing exactly.

### Phase 3: Photo takeoff
- Capture guide UI, Claude vision integration (structured output, prompt versioning, cost
  logging), confirm/correct UI, `photo_corrections` → `photo_area_bias`, hazard
  hard-blocks.

### Phase 4: Leads, follow-up, scheduling, rebates, reports
- Lead intake (web form, manual entry, CSV import), assessor lookup, scoring.
- Follow-up sequences (Resend and Twilio), bandit, opt-out handling.
- Scheduling suggestions and a crew calendar.
- Rebate program admin and auto-attach.
- Weekly owner report.

---

## 13. Open questions (need your input before or during Phase 1)

1. ~~**Repo location.**~~ Resolved: this is its own repo, `koala-estimator`.
2. ~~**Code minimums.**~~ Resolved (Oct 2026): Delaware never adopted the 2021 IECC. Newark
   and New Castle County enforce the **2018 IECC**, zone 4A: ceiling R-49, wood-frame wall
   R-20 or 13+5ci, floor R-19, basement/crawlspace wall R-10ci or R-13. The state adopted the
   2024 IECC on 2026-04-11 and localities follow within about a year; attics stay R-49 but
   walls rise. Better/Best attic options target R-60. Values live in `code_requirements`.
3. **Real numbers.** Material costs per set or bag, crew rates, overhead %, target margin,
   minimum job price. I'll seed obvious placeholders flagged "needs owner input". I need
   your actual sheet to make v1 pricing match how you quote today.
4. **Financing partner.** Not contracted yet (candidates: Wisetack, EnerBank USA/Regions,
   Finance of America, Hearth). The quote line stays off until a lender's terms are entered.
5. **E-sign.** Is the built-in signing page OK for v1, or do you require DocuSign or
   Dropbox Sign?
6. **Rebates.** Do you have the current Energize Delaware and Delmarva Power program
   sheets? I'll model the rules engine, but the dollar amounts must come from current
   program documents, not from me.
7. **Assessor data.** New Castle County parcel search or Delaware FirstMap open data.
   I'll confirm which has a usable API for year built and square footage. Do you
   already use a property data service?
8. **Franchise tenancy.** If other Koala territories might use this, I should add an
   `org_id` to every table now. Adding it later is expensive.
9. **Historical data.** Do you have past estimates and job costs (spreadsheets or CRM)? Even
   50–100 past jobs would let the learning loop start warm instead of cold.
10. **Brand assets.** I need the logo files, brand colors, license number, warranty text,
    and the terms and conditions for the PDF.
