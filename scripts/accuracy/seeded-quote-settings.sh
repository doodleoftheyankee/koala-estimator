#!/usr/bin/env bash
# Rebuilds lib/quotes/__fixtures__/seeded-quote-settings.json: the app_settings rows a quote is built
# from (lib/quotes/settings.ts QUOTE_SETTING_KEYS, plus the two profile keys a new database does not
# have), exactly as every migration leaves them in a new database. lib/quotes/owner-decisions-2.test.ts
# builds a quote, its PDF and its email from them. Run it after a migration that changes one of these
# rows, and commit the JSON with it.
#
# Usage: DATABASE_URL=postgres://postgres@localhost:5432/postgres [SEEDED_QUOTE_DB=koala_seeded_q] bash scripts/accuracy/seeded-quote-settings.sh
#   SEEDED_QUOTE_DB: a name for the throwaway database this script creates, migrates and drops.
#   It must not exist yet (the script never drops a database it did not create).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to a Postgres superuser connection}"
cd "$(dirname "$0")/../.."
DB="${SEEDED_QUOTE_DB:-koala_seeded_quote_$$}"
if [ -n "$(psql "$DATABASE_URL" -qtAc "select 1 from pg_database where datname = '$DB'")" ]; then
  echo "Database $DB already exists; pick another SEEDED_QUOTE_DB name." >&2
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
psql "$URL" -qAt -v ON_ERROR_STOP=1 -c "
  select jsonb_pretty(jsonb_build_object(
    'about', 'app_settings rows a quote is built from, as every migration in supabase/migrations leaves them in a new database (scripts/accuracy/seeded-quote-settings.sh)',
    'rows', coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value, 'description', description) order by key), '[]'::jsonb)))
    from app_settings
   where key in ('branding', 'quote_terms', 'warranty_text', 'quote_valid_days', 'default_city', 'default_state', 'quote_number_prefix', 'shop_address')" \
  > lib/quotes/__fixtures__/seeded-quote-settings.json
echo "Wrote lib/quotes/__fixtures__/seeded-quote-settings.json"
