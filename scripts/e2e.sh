#!/usr/bin/env bash
# Local end-to-end test: real Postgres + PostgREST behind a tiny Supabase stand-in
# (tests/e2e/mock-supabase.mjs), a production build of the app, and Playwright driving a phone.
# Covers: offline-capable estimate -> sync -> quote PDF -> customer e-sign -> DB/audit checks,
# an estimate created fully offline that syncs on reconnect, owner/estimator access, and Phase 2:
# crew actuals on a phone, office verification, the nightly learning cron and the dashboard.
#
# Requires: DATABASE_URL (Postgres 15+ superuser), POSTGREST_BIN (PostgREST 12 binary),
# and the `playwright` package with Chromium (set CHROMIUM_PATH to use a preinstalled one).
set -euo pipefail
: "${DATABASE_URL:?}" "${POSTGREST_BIN:?}"
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"; export E2E_STORAGE="$WORK/storage" E2E_SHOTS="$WORK/shots"; mkdir -p "$E2E_STORAGE" "$E2E_SHOTS"
BASE="${DATABASE_URL%%\?*}"; QUERY="${DATABASE_URL#"$BASE"}"; export E2E_DB_URL="${BASE%/*}/koala_e2e$QUERY"
pids=(); cleanup() { for p in "${pids[@]}"; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done; }; trap cleanup EXIT

psql "$DATABASE_URL" -q -c "drop database if exists koala_e2e with (force)" -c "create database koala_e2e"
D() { psql "$E2E_DB_URL" -q -v ON_ERROR_STOP=1 "$@"; }
D -f tests/sql/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do D -f "$f"; done
D -f tests/sql/01_grants.sql
D -c "do \$\$ begin create role authenticator login noinherit; exception when duplicate_object then null; end \$\$" -c "grant anon, authenticated, service_role to authenticator"
D -c "insert into auth.users (id, email) select (u->>'id')::uuid, u->>'email' from jsonb_array_elements('$(cat tests/e2e/users.json)'::jsonb) u"
D -c "insert into profiles (id, role, full_name, email) select (u->>'id')::uuid, (u->>'role')::user_role, u->>'name', u->>'email' from jsonb_array_elements('$(cat tests/e2e/users.json)'::jsonb) u"

D -c "insert into crew_members (crew_id, profile_id, is_lead) select c.id, '33333333-3333-4333-8333-333333333333', true from crews c where c.name = 'Crew A'"

AUTH_URL="$(echo "$E2E_DB_URL" | sed -E 's#^(postgres(ql)?://)([^@/]*@)?#\1authenticator@#')"
cat > "$WORK/pgrst.conf" <<CONF
db-uri = "$AUTH_URL"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "e2e-super-secret-jwt-token-with-at-least-32-characters"
server-port = 3001
CONF
"$POSTGREST_BIN" "$WORK/pgrst.conf" > "$WORK/pgrst.log" 2>&1 & pids+=($!)
node tests/e2e/mock-supabase.mjs > "$WORK/mock.log" 2>&1 & pids+=($!)

export NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 APP_URL=http://localhost:3000 NEXT_TELEMETRY_DISABLED=1 CRON_SECRET=e2e-cron-secret
NEXT_PUBLIC_SUPABASE_ANON_KEY="$(node -e "import('./tests/e2e/jwt.mjs').then(m=>console.log(m.ANON))")"
SUPABASE_SERVICE_ROLE_KEY="$(node -e "import('./tests/e2e/jwt.mjs').then(m=>console.log(m.SERVICE))")"
export NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY
npx next build > "$WORK/build.log"
# Run next directly (not through npx) so the cleanup kills the server itself.
node node_modules/next/dist/bin/next start -p 3000 > "$WORK/next.log" 2>&1 & pids+=($!)
for _ in $(seq 1 30); do curl -sf http://localhost:3000/login >/dev/null && break; sleep 1; done

node tests/e2e/run.mjs
echo "Screenshots: $E2E_SHOTS"
