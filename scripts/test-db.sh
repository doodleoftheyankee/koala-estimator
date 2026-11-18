#!/usr/bin/env bash
# Runs migrations + SQL tests against a throwaway Postgres database.
# Usage: DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db
#
# Newark parity: the pilot store's pricing rows are captured just before the multi-location
# migrations and again right after them (filtered to that store). They must be identical, and
# lib/server/newarkParity.test.ts builds both into pricing bundles and prices a fixed set of
# estimates with each: same hash, same price on every option, to the cent.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to a Postgres superuser connection}"
DB="koala_test_$$"
PARITY_DIR="$(mktemp -d)"
psql "$DATABASE_URL" -qtc "create database $DB" >/dev/null
trap 'psql "$DATABASE_URL" -qtc "drop database if exists $DB" >/dev/null; rm -rf "$PARITY_DIR"' EXIT
BASE="${DATABASE_URL%%\?*}"
QUERY="${DATABASE_URL#"$BASE"}"
URL="${BASE%/*}/$DB$QUERY"
run() { psql "$URL" -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
dump() { psql "$URL" -qAt -v ON_ERROR_STOP=1 -v loc_filter="$1" -f tests/sql/parity/pricing_rows.sql > "$2"; }

FIRST_LOCATION_MIGRATION="20261119000001_locations.sql"
run tests/sql/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do
  if [[ "$(basename "$f")" == "$FIRST_LOCATION_MIGRATION" ]]; then dump "true" "$PARITY_DIR/before.json"; fi
  run "$f"
done
PILOT="$(psql "$URL" -qAt -c "select id from locations order by created_at limit 1")"
dump "location_id = '$PILOT'" "$PARITY_DIR/after.json"
if ! cmp -s "$PARITY_DIR/before.json" "$PARITY_DIR/after.json"; then
  echo "Newark parity: the pilot store's pricing rows changed across the multi-location migrations" >&2
  diff <(tr ',' '\n' < "$PARITY_DIR/before.json") <(tr ',' '\n' < "$PARITY_DIR/after.json") >&2 || true
  exit 1
fi
echo "• Newark parity: pricing rows identical before and after the multi-location migrations"

run tests/sql/01_grants.sql
for t in tests/sql/*.test.sql; do
  echo "• $t"
  psql "$URL" -q -v ON_ERROR_STOP=1 -o /dev/null -f "$t"
done

NEWARK_PARITY_BEFORE="$PARITY_DIR/before.json" NEWARK_PARITY_AFTER="$PARITY_DIR/after.json" \
  npx vitest run lib/server/newarkParity.test.ts
echo "All database tests passed."
