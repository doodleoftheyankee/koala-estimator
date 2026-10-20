# Koala Estimator

This is the estimating and quoting app for **Koala Insulation of Newark, DE**. Estimators
use it on their phones, including with no signal in attics and crawlspaces. It produces
good/better/best quotes from owner-controlled pricing, emails a branded PDF to the
customer, and the customer signs online. Every estimate stores the exact pricing it used,
so the learning loop in Phase 2 can compare estimates against actual job costs.

See [PLAN.md](PLAN.md) for the full design and roadmap.

**Status: Phase 1 (estimator + quotes).** Phase 2 adds crew actuals and nightly
coefficient learning. Phase 3 adds photo takeoff. Phase 4 adds leads, follow-up,
scheduling, rebates and the weekly report.

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
- **Energy code edition.** The seed uses 2021 IECC zone 4A (attic R-60). Confirm what
  Newark and New Castle County enforce; under 2018 IECC the attic minimum is R-49.
- Financing partner, APR and term.
- Branding (license number, phone, colors), quote terms, warranty text, shop address.
- The learned coefficients start from industry rules of thumb. Phase 2 replaces them with
  your own job data.

### 5. Deploy
Import the repository in Vercel (framework: Next.js) and set the environment variables.
Then on your phone, open `/field` once with signal and use **Add to Home Screen**.

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
1. Create an estimate, sync it, and send the quote.
2. As the customer, open the link, draw a signature and sign.
3. Check the database and audit log.
4. Create an estimate with the network cut, then reconnect and confirm it synced.
5. Confirm the owner can edit pricing (with an audit entry) and an estimator is kept out
   of admin.

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

### Known limits in Phase 1
- The public quote and signing endpoints are protected by 256-bit unguessable tokens but
  have no rate limiting yet. Add Vercel Firewall rate-limit rules for
  `/api/public/*` before launch.
- The app icons are a placeholder "K". Swap in Koala's logo in `public/icons/`.
- Rebates, lead scoring, follow-ups and scheduling are not built yet (Phase 4). Deviation
  flags and the learning loop are not built yet (Phase 2).
