#!/usr/bin/env bash
# Rebuilds lib/pricing/__fixtures__/seeded-rows.json: the pricing rows every migration leaves in a
# new database. Run it after a migration that changes a seeded value, and commit the JSON with it.
#
# Usage: DATABASE_URL=postgres://postgres@localhost:5432/postgres [SEEDED_ROWS_DB=koala_seeded] bash scripts/accuracy/seeded-rows.sh
#   SEEDED_ROWS_DB: a name for the throwaway database this script creates, migrates and drops.
#   It must not exist yet (the script never drops a database it did not create).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to a Postgres superuser connection}"
cd "$(dirname "$0")/../.."
DB="${SEEDED_ROWS_DB:-koala_seeded_rows_$$}"
if [ -n "$(psql "$DATABASE_URL" -qtAc "select 1 from pg_database where datname = '$DB'")" ]; then
  echo "Database $DB already exists; pick another SEEDED_ROWS_DB name." >&2
  exit 1
fi
psql "$DATABASE_URL" -qtc "create database $DB" >/dev/null
trap 'psql "$DATABASE_URL" -qtc "drop database if exists $DB with (force)" >/dev/null' EXIT
BASE="${DATABASE_URL%%\?*}"
QUERY="${DATABASE_URL#"$BASE"}"
URL="${BASE%/*}/$DB$QUERY"
run() { psql "$URL" -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
run tests/sql/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do run "$f"; done
TMP="$(mktemp)"
psql "$URL" -qAt -v ON_ERROR_STOP=1 -f scripts/accuracy/bundle-rows.sql > "$TMP"
node scripts/accuracy/run.mjs scripts/accuracy/stable-rows.ts "$TMP" lib/pricing/__fixtures__/seeded-rows.json
rm -f "$TMP"
