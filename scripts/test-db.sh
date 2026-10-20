#!/usr/bin/env bash
# Runs migrations + SQL tests against a throwaway Postgres database.
# Usage: DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to a Postgres superuser connection}"
DB="koala_test_$$"
psql "$DATABASE_URL" -qtc "create database $DB" >/dev/null
trap 'psql "$DATABASE_URL" -qtc "drop database if exists $DB" >/dev/null' EXIT
BASE="${DATABASE_URL%%\?*}"
QUERY="${DATABASE_URL#"$BASE"}"
URL="${BASE%/*}/$DB$QUERY"
run() { psql "$URL" -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
run tests/sql/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do run "$f"; done
run tests/sql/01_grants.sql
for t in tests/sql/*.test.sql; do
  echo "• $t"
  psql "$URL" -q -v ON_ERROR_STOP=1 -o /dev/null -f "$t"
done
echo "All database tests passed."
