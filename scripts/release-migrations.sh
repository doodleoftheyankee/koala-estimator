#!/usr/bin/env bash
# Usage: bash scripts/release-migrations.sh (Postgres 16 on socket /tmp/kpg port 5499; edit PG/url for another server).
# Release step 3: the migrations this branch adds to origin/main (every file in supabase/migrations
# that origin/main does not have) on a production-shaped database (the test stub, which has
# production's default privileges since review B database-B5, plus every migration on origin/main),
# in order, twice; the second run must change nothing. Then origin/main's code against the migrated
# database: crew_job_view keeps every column main reads, in the same order (columns are only
# appended), and main's crew app query runs on it as a crew member and as the office. Then every
# SQL test on that database. Every database made here is dropped.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
PG="postgresql://postgres@/postgres?host=/tmp/kpg&port=5499"
url() { echo "postgresql://postgres@/$1?host=/tmp/kpg&port=5499"; }
A=koala_rel_mig_a
cleanup() { psql "$PG" -qtc "drop database if exists $A" >/dev/null; }
trap cleanup EXIT
cleanup
MAIN_MIGS=$(git ls-tree --name-only origin/main supabase/migrations/ | sort)
NEW=$(comm -13 <(echo "$MAIN_MIGS") <(ls supabase/migrations/*.sql | sort))
if [ -z "$NEW" ]; then echo "No migration here that origin/main does not have."; exit 0; fi

apply_file() { psql "$(url "$1")" -q -v ON_ERROR_STOP=1 -f "$2" >/dev/null; }
apply_main() {
  for f in $MAIN_MIGS; do git show "origin/main:$f" > "$OUT/main-$(basename "$f")"; apply_file "$1" "$OUT/main-$(basename "$f")"; done
}
q() { psql "$(url "$1")" -qAt -v ON_ERROR_STOP=1 -c "$2"; }
snapshot() {
  # Schema with grants and policies, and every row of every table in public, in a fixed order.
  # (pg_dump's per-run \\restrict token is left out: it differs on every dump.)
  pg_dump "$(url "$1")" --schema-only --no-owner -n public -n auth | grep -v '^\\\(un\)\?restrict ' > "$OUT/$2.schema.sql"
  q "$1" "select tablename from pg_tables where schemaname = 'public' order by 1" | while read -r t; do
    echo "== $t"
    q "$1" "select row_to_json(x)::text from public.\"$t\" x order by row_to_json(x)::text"
  done > "$OUT/$2.data.txt"
  q "$1" "select grantee || ' ' || table_name || ' ' || string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','service_role') group by grantee, table_name order by 1" > "$OUT/$2.grants.txt"
}
view_cols() { q "$1" "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '$2'"; }

echo "== A: stub + origin/main's migrations ($(echo $MAIN_MIGS | wc -w) files) + $(echo $NEW | wc -w) new: $(echo $NEW | xargs -n1 basename | tr '\n' ' '), twice"
psql "$PG" -qtc "create database $A" >/dev/null
apply_file $A tests/sql/00_supabase_stub.sql
apply_main $A
snapshot $A 0-main
MAIN_VIEW=$(view_cols $A crew_job_view)
for f in $NEW; do echo "  first run: $f"; apply_file $A "$f"; done
snapshot $A 1-first
for f in $NEW; do echo "  second run: $f"; apply_file $A "$f"; done
snapshot $A 2-second
for k in schema.sql data.txt grants.txt; do
  if cmp -s "$OUT/1-first.$k" "$OUT/2-second.$k"; then echo "  second run changes nothing: $k identical ($(wc -l < "$OUT/2-second.$k") lines)"; else echo "  SECOND RUN CHANGED $k"; diff "$OUT/1-first.$k" "$OUT/2-second.$k" | head -40 || true; exit 1; fi
done
echo "  what the first run changed in rows (lines only in the first-run dump):"
diff <(grep -v '^== ' "$OUT/0-main.data.txt" | sort) <(grep -v '^== ' "$OUT/1-first.data.txt" | sort) | grep '^[<>]' | cut -c1-200 | sed 's/^/    /' | head -40 || true
echo "  what the first run changed in grants:"
diff "$OUT/0-main.grants.txt" "$OUT/1-first.grants.txt" | grep '^[<>]' | sed 's/^/    /' || echo "    nothing"
echo "  what the first run changed in the schema (pg_dump lines added or removed, first 60):"
diff <(sort "$OUT/0-main.schema.sql") <(sort "$OUT/1-first.schema.sql") | grep '^[<>]' | grep -v '^[<>] *$' | grep -v '^[<>] *--' | cut -c1-160 | sed 's/^/    /' | head -60 || true

echo "== origin/main's code on the migrated database"
NEW_VIEW=$(view_cols $A crew_job_view)
case "$NEW_VIEW" in
  "$MAIN_VIEW"*) echo "  crew_job_view keeps main's $(echo "$MAIN_VIEW" | tr ',' '\n' | wc -l) columns in order; appended: ${NEW_VIEW#"$MAIN_VIEW"}" ;;
  *) echo "  CREW_JOB_VIEW CHANGED A COLUMN MAIN READS"; echo "    main: $MAIN_VIEW"; echo "    now:  $NEW_VIEW"; exit 1 ;;
esac
# The columns origin/main's crew app reads (lib/jobs/crew.ts CREW_VIEW_COLUMNS), and its query
# (app/api/crew/jobs/route.ts), as a crew member and as the office.
MAIN_COLS=$(git show origin/main:lib/jobs/crew.ts | node -e "
  const s = require('fs').readFileSync(0, 'utf8');
  const m = s.match(/CREW_VIEW_COLUMNS =([\s\S]*?);/);
  console.log(eval(m[1]));")
q $A "insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f0c1'), ('00000000-0000-0000-0000-00000000f0c2');
      insert into profiles (id, role, full_name) values ('00000000-0000-0000-0000-00000000f0c1', 'crew', 'Release crew'), ('00000000-0000-0000-0000-00000000f0c2', 'office', 'Release office')" >/dev/null
for who in 00000000-0000-0000-0000-00000000f0c1 00000000-0000-0000-0000-00000000f0c2; do
  psql "$(url $A)" -qAt -v ON_ERROR_STOP=1 >/dev/null <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', '$who', false);
select $MAIN_COLS from crew_job_view
 where status in ('scheduled', 'in_progress') or (status = 'completed' and completed_at >= now() - interval '14 days')
 order by scheduled_start asc nulls last, job_id, area_sort limit 1000;
select key, value from app_settings;
select id, status, scheduled_start, scheduled_days, started_at, completed_at, revenue, crew_id from jobs limit 1;
SQL
  echo "  main's crew jobs query, settings read and job read run as $(q $A "select role from profiles where id = '$who'")"
done
q $A "delete from profiles where id in ('00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f0c2'); delete from auth.users where id in ('00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f0c2')" >/dev/null

echo "  SQL tests on this database (after tests/sql/01_grants.sql, as npm run test:db does):"
apply_file $A tests/sql/01_grants.sql
for t in tests/sql/*.test.sql; do psql "$(url $A)" -q -v ON_ERROR_STOP=1 -o /dev/null -f "$t" && echo "    ok $t"; done
echo "done"
