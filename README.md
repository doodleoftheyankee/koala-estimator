# Koala Estimator

This is the estimating and quoting app for **Koala Insulation of Newark, DE**. Estimators
use it on their phones, including with no signal in attics and crawlspaces. It produces
good/better/best quotes from owner-controlled pricing, emails a branded PDF to the
customer, and the customer signs online. Crews record what each job actually took, and a
nightly learning run tunes the pricing coefficients from those actuals.

See [PLAN.md](PLAN.md) for the full design and roadmap.

**Status: Phases 1 and 2 built** (estimator and quotes; crew actuals and the learning loop).
Phase 3 adds photo takeoff. Phase 4 adds leads, follow-up, scheduling, rebates and the
weekly report.

---

## What's in Phase 1

| Area | Where |
|---|---|
| Pricing engine (pure, deterministic, property-tested) | `lib/pricing/` |
| Database schema, row-level security, audit log, offline sync function | `supabase/migrations/` |
| Database tests (roles, sync idempotency and conflicts, audit, coefficient rollback) | `tests/sql/`, `scripts/test-db.sh` |
| Offline field app (IndexedDB plus an outbox that syncs automatically) | `app/field/`, `lib/offline/`, `public/sw.js` |
| Sync API (the server always re-prices; idempotent; checks row versions) | `app/api/sync`, `lib/sync/` |
| Quote PDF, email, customer signing page | `lib/quotes/`, `app/api/quotes`, `app/q/[token]`, `app/api/public/` |
| Admin pricing tables, team invites, estimate list | `app/admin/`, `app/estimates/` |
| Sign-in with an emailed code (no passwords) | `app/login`, `app/auth/`, `proxy.ts` |

## What's in Phase 2

| Area | Where |
|---|---|
| Learning loop (pure, ~100% test coverage): weighted fits, shrinkage, guardrails, backtest, win model, deviation flags | `lib/learning/` |
| Nightly run (Vercel Cron, 07:15 UTC) and **Run learning now** | `app/api/cron/nightly`, `lib/learning/nightly.ts` |
| Learning dashboard: coefficients with sample size and confidence, candidate diff, approve, reject, restore, changelog, accuracy, win rates | `app/admin/learning/` |
| Crew app: today's jobs (no prices), start/complete, actuals entry that works offline | `app/crew/`, `lib/offline/crew*`, `app/api/crew/` |
| Office jobs: schedule and assign crews, actuals vs estimate, costs, verify, exclude from learning | `app/jobs/`, `lib/jobs/` |
| Estimator line changes (quantity or hours, with a reason) and deviation flags that must be explained before sending | `app/field/OptionLines.tsx`, `lib/field/` |
| Win chance and a recommended price on each option (once there are enough decided quotes) | `app/field/OptionsStep.tsx`, `lib/field/priceAdvice.ts` |
| Migration: jobs from signed quotes, crew access through functions, actuals sync, flags | `supabase/migrations/20261021000001_phase2.sql` |

### How learning works
1. A signed quote becomes a job. The office assigns a crew and a start date on **Jobs**.
2. On site, the crew taps **Start job**, enters material used and person-hours per area plus
   drive time, days and crew size, then **Complete job**. This works without signal; it
   syncs when the phone reconnects. Crews never see prices or costs.
3. The office checks the numbers on the job page, adds costs if it wants margins, and taps
   **Verify actuals**. Verified rows are locked for the crew. Rows from callbacks or rework
   can be excluded from learning.
4. Each night the learning run fits waste factors, hours per unit, access multipliers and
   the drive factor from verified jobs. Recent jobs count more. Thin data is pulled toward
   the current value. Every candidate must pass four gates (enough evidence, at most ±10%
   per night, within bounds, sane values) and a backtest against recent jobs. A candidate
   that passes waits for the owner on **Learning** unless auto-promote is turned on.
5. Approving switches pricing right away. Any earlier set can be restored from History.
   Every change is in the changelog with who, when and why.

When an estimator changes a line by more than 15% from the model, the app explains what
the model assumed and asks for a note. A quote cannot be sent until every flag has one.
After the job, each flag records whether the estimator or the model was closer.

### How a price is made
For each area and each tier (good, better, best), the engine works out:
- the R-value still needed, then the thickness, then the design quantity;
- the material quantity, which is the design quantity × the learned **waste factor**;
- labor hours: setup + units × learned **hours per unit** × learned **access multiplier**.

It then adds removal, disposal, and drive cost. Drive cost is minutes × trips × crew
size × the learned **drive factor**.

`price = direct cost × (1 + overhead) / (1 − target margin)`. The result is never below
the minimum job price and is rounded *up* to the nearest $5 (or whatever rounding the owner
sets).

All rates, margins and coefficients come from the database and are editable on
**Pricing**. Nothing is hardcoded. The full formulas are in PLAN.md §5.

### Guardrails
- An estimator may move a price at most ±10% (configurable) from the model price, and
  must give a reason.
- Only the owner can send a price below the floor margin.
- When a phone syncs, the server re-prices the estimate and stores its own numbers.
- Before a quote goes out, the server checks that the prices the phone showed still match
  the current pricing.
- Sent quotes cannot be changed. Editing a sent quote creates a new version.
- Every change to settings, materials, crews, tiers or coefficients, every price change on
  an estimate, and every quote sent or signed is written to `audit_log` with who did it.

---

## Setup

### 1. Supabase
1. Create a project at supabase.com (Postgres 15 or newer).
2. Apply the migrations in order. Either:
   - with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`, or
   - paste each file from `supabase/migrations/` into the SQL Editor, oldest first.
3. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign
   up". Only invited users can sign in.
4. **Authentication → URL Configuration:** set the Site URL to your app URL and add
   `https://<your-domain>/auth/confirm` to the Redirect URLs.
5. **Authentication → Email Templates → Magic Link:** include both the code and a link
   that goes through `/auth/confirm`:
   ```html
   <h2>Your Koala Estimator sign-in code</h2>
   <p style="font-size:24px;font-weight:bold">{{ .Token }}</p>
   <p>Or <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">sign in on this device</a>.</p>
   ```
   Do the same for the **Invite user** template, using `type=invite`.

### 2. Environment
Copy `.env.example` to `.env.local` and fill it in. In Vercel, set the same variables
under Project → Settings → Environment Variables.

| Variable | Needed for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything |
| `SUPABASE_SERVICE_ROLE_KEY` | creating quotes and PDFs, the signing page, invites (server only) |
| `APP_URL` | links in quote emails |
| `RESEND_API_KEY`, `QUOTE_FROM_EMAIL`, `OFFICE_NOTIFY_EMAIL` | email. Without these, quotes still work: the estimator gets a link to share by hand. |
| `GOOGLE_MAPS_API_KEY` | the drive-time lookup button (optional) |
| `CRON_SECRET` | the nightly learning run. Vercel Cron sends it automatically; without it the run is disabled. Any long random string. |
| `OWNER_REPORT_EMAIL` | where the nightly run sends "a new pricing candidate is waiting" (optional) |

### 3. First owner account
```bash
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  npm run bootstrap:owner -- --email you@koala.example --name "Owner Name"
```
After that, invite everyone else from **Team** in the app.

### 4. Replace the placeholders (owner)
The seed data is clearly marked **placeholder**. The Pricing page shows a banner until
each item is filled in:
- Material costs and coverage, crew rates, overhead, target and floor margin, minimum job
  price, disposal and vehicle cost.
- **Energy code edition.** Newark and New Castle County enforce the 2018 IECC, so the seed
  uses zone 4A attic R-49 (the 2024 IECC, adopted by the state in April 2026, keeps R-49 for
  attics but raises walls). Better and Best attic options go to R-60.
- Financing: the quote line is off until you sign up with a lender and enter its terms.
- Branding (license number, phone, colors), quote terms, warranty text, shop address.
- The learned coefficients start from industry rules of thumb. The nightly learning run
  replaces them with your own job data as crews enter actuals.

### 5. Deploy
Import the repository in Vercel (framework: Next.js) and set the environment variables.
`vercel.json` schedules the nightly learning run; the Hobby plan allows one run a day.
Then on your phone, open `/field` (estimators) or `/crew` (crews) once with signal and use
**Add to Home Screen**.

To run the learning job by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/nightly`,
or press **Run learning now** on the Learning page.

---

## Development

```bash
npm install
npm run dev            # http://localhost:3000
npm run typecheck
npm run lint
npm test               # unit and property tests
npm run test:coverage  # fails if pricing/learning coverage drops below 95% lines
DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db   # migrations + SQL tests
```

`npm run test:db` creates a throwaway database, applies a small stand-in for Supabase's
`auth` schema (`tests/sql/00_supabase_stub.sql`), runs every migration, then runs
`tests/sql/*.test.sql` as each role.

### End-to-end test (local)
`scripts/e2e.sh` runs the real app against real Postgres and PostgREST. A ~100-line
stand-in (`tests/e2e/mock-supabase.mjs`) covers Supabase Auth and Storage. Playwright then
drives a phone-sized browser through these steps:
1. Create an estimate, change a line by 20% and explain the flag, sync, and send the quote.
2. As the customer, open the link, draw a signature and sign.
3. Check the database and audit log.
4. Create an estimate with the network cut, then reconnect and confirm it synced.
5. Confirm the owner can edit pricing (with an audit entry) and an estimator is kept out
   of admin.
6. As the office, assign the job to Crew A. As the crew, on a phone, start the job, enter
   actuals and complete it (and see no prices). As the office, verify the actuals.
7. Run the nightly learning job through its cron endpoint (and check it refuses a request
   without the secret), then open the Learning page and press **Run learning now**.

```bash
DATABASE_URL=postgres://postgres@localhost:5432/postgres \
POSTGREST_BIN=/path/to/postgrest NODE_PATH=$(npm root -g) \
  bash scripts/e2e.sh   # needs `playwright` + Chromium installed
```

### Offline model
- Estimates are saved to IndexedDB on every change. Each edit gets a new `mutationId`.
- The outbox syncs on reconnect, when the app comes back to the foreground, every 60
  seconds, and a few seconds after an edit. The server dedupes by `mutationId`.
- If an estimate changed on another device in the meantime, the server returns a conflict
  instead of writing. The estimator chooses **Keep mine** or **Use the other version**.
- Sending a quote and the drive-time lookup need a connection. Everything else works
  offline once `/field` has been opened online at least once.

### Known limits
- The public quote and signing endpoints are protected by 256-bit unguessable tokens but
  have no rate limiting yet. Add Vercel Firewall rate-limit rules for
  `/api/public/*` before launch.
- The app icons are a placeholder "K". Swap in Koala's logo in `public/icons/`.
- Rebates, lead scoring, follow-ups and scheduling suggestions are not built yet (Phase 4).
- The learning loop needs verified jobs before it changes anything: a coefficient moves only
  with the equivalent of at least 3 recent jobs behind it (older jobs count for less), and
  the win model trains after 40 decided quotes. Until then the starting values and win
  rates by price bucket are used. All of these are settings on the Learning page.
