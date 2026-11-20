#!/usr/bin/env bash
# Usage: bash scripts/release-migrations.sh (Postgres 16 on socket /tmp/kpg port 5499; edit PG/url for another server).
# Release step 3: the two new migrations (and any later one not on origin/main yet) on a
# production-shaped database (the test stub, which has production's default privileges since
# review B database-B5, plus every migration on origin/main), in order, twice; the second run must change nothing. Then the blower door migration alone on
# main's schema (no accuracy migration) with its SQL test, to show it relies on nothing the
# accuracy migration changed. Every database made here is dropped.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
PG="postgresql://postgres@/postgres?host=/tmp/kpg&port=5499"
url() { echo "postgresql://postgres@/$1?host=/tmp/kpg&port=5499"; }
A=koala_rel_mig_a
B=koala_rel_mig_b
cleanup() { psql "$PG" -qtc "drop database if exists $A" >/dev/null; psql "$PG" -qtc "drop database if exists $B" >/dev/null; }
trap cleanup EXIT
cleanup
MAIN_MIGS=$(git ls-tree --name-only origin/main supabase/migrations/ | sort)
# The release's two migrations, then every migration here that origin/main does not have yet (the
# PIN sign-in migration), in file order.
LATER="$(comm -13 <(echo "$MAIN_MIGS") <(ls supabase/migrations/*.sql | sort) | tr '\n' ' ')"
NEW="supabase/migrations/20261119000001_accuracy.sql supabase/migrations/20261120000001_blower_door.sql $LATER"

apply_file() { psql "$(url "$1")" -q -v ON_ERROR_STOP=1 -f "$2" >/dev/null; }
apply_main() {
  for f in $MAIN_MIGS; do git show "origin/main:$f" > "$OUT/main-$(basename "$f")"; apply_file "$1" "$OUT/main-$(basename "$f")"; done
}
snapshot() {
  # Schema with grants and policies, and every row of every table in public, in a fixed order.
  # (pg_dump's per-run \\restrict token is left out: it differs on every dump.)
  pg_dump "$(url "$1")" --schema-only --no-owner -n public -n auth | grep -v '^\\\(un\)\?restrict ' > "$OUT/$2.schema.sql"
  psql "$(url "$1")" -qAt -c "select tablename from pg_tables where schemaname = 'public' order by 1" | while read -r t; do
    echo "== $t"
    psql "$(url "$1")" -qAt -c "select row_to_json(x)::text from public.\"$t\" x order by row_to_json(x)::text"
  done > "$OUT/$2.data.txt"
  psql "$(url "$1")" -qAt -c "select grantee || ' ' || table_name || ' ' || string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','service_role') group by grantee, table_name order by 1" > "$OUT/$2.grants.txt"
}

echo "== A: stub + origin/main's migrations ($(echo $MAIN_MIGS | wc -w) files) + accuracy + blower door, twice"
psql "$PG" -qtc "create database $A" >/dev/null
apply_file $A tests/sql/00_supabase_stub.sql
apply_main $A
snapshot $A 0-main
for f in $NEW; do echo "  first run: $f"; apply_file $A "$f"; done
snapshot $A 1-first
for f in $NEW; do echo "  second run: $f"; apply_file $A "$f"; done
snapshot $A 2-second
psql "$(url $A)" -qAt -c "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where nspname = 'public' union select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where nspname = 'public'" | sort -u > "$OUT/names-with-accuracy.txt"
for k in schema.sql data.txt grants.txt; do
  if cmp -s "$OUT/1-first.$k" "$OUT/2-second.$k"; then echo "  second run changes nothing: $k identical ($(wc -l < "$OUT/2-second.$k") lines)"; else echo "  SECOND RUN CHANGED $k"; diff "$OUT/1-first.$k" "$OUT/2-second.$k" | head -40 || true; fi
done
echo "  what the first run changed in rows (lines only in the first-run dump):"
diff <(grep -v '^== ' "$OUT/0-main.data.txt" | sort) <(grep -v '^== ' "$OUT/1-first.data.txt" | sort) | grep '^[<>]' | cut -c1-160 | sed 's/^/    /' | head -40 || true
echo "  blower door objects' grants (production's default privileges, then the migration's revokes):"
grep -E ' blower_door_tests ' "$OUT/2-second.grants.txt" | sed 's/^/    /'
echo "  pin_attempts and pin_device_attempts grants (the service role only; anon and authenticated must not be listed):"
grep -E ' pin_(device_)?attempts ' "$OUT/2-second.grants.txt" | sed 's/^/    /'
psql "$(url $A)" -qAt -c "select p.proname || ' ' || coalesce(array_to_string(p.proacl, ','), 'default') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('sync_blower_door_test','blower_door_context','can_see_blower_door','can_record_blower_door','tg_blower_door_tests_job_estimate') order by 1" | sed 's/^/    /'
echo "  SQL tests on this database (after tests/sql/01_grants.sql, as npm run test:db does):"
apply_file $A tests/sql/01_grants.sql
for t in tests/sql/*.test.sql; do psql "$(url $A)" -q -v ON_ERROR_STOP=1 -o /dev/null -f "$t" && echo "    ok $t"; done

echo "== B: stub + origin/main's migrations + the blower door migration alone (no accuracy migration)"
psql "$PG" -qtc "create database $B" >/dev/null
apply_file $B tests/sql/00_supabase_stub.sql
apply_main $B
apply_file $B supabase/migrations/20261120000001_blower_door.sql
apply_file $B supabase/migrations/20261120000001_blower_door.sql
apply_file $B tests/sql/01_grants.sql
psql "$(url $B)" -q -v ON_ERROR_STOP=1 -o /dev/null -f tests/sql/50_blower_door.test.sql && echo "    ok tests/sql/50_blower_door.test.sql (blower door without the accuracy migration, applied twice)"
# The later migrations on B too, so the names compared below are the accuracy migration's only.
for f in $LATER; do apply_file $B "$f"; done
echo "  names the blower door migration uses that only the accuracy migration creates:"
ONLY_ACC=$(comm -23 "$OUT/names-with-accuracy.txt" <(psql "$(url $B)" -qAt -c "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where nspname = 'public' union select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where nspname = 'public'" | sort -u))
found=0
for name in $ONLY_ACC; do
  if grep -qw "$name" supabase/migrations/20261120000001_blower_door.sql; then echo "    USES $name"; found=1; fi
done
[ "$found" = 0 ] && echo "    none (checked $(echo $ONLY_ACC | wc -w) names the accuracy migration adds: $(echo $ONLY_ACC | tr '\n' ' '))"
echo "  app_settings keys the blower door migration reads or writes:"
grep -o "key *= *'[a-z_]*'\|'blower_door'" supabase/migrations/20261120000001_blower_door.sql | sort | uniq -c | sed 's/^/    /'
echo "  app_settings keys the accuracy migration writes:"
grep -o "where key = '[a-z_]*'\\|^values ('[a-z_]*'" supabase/migrations/20261119000001_accuracy.sql | sort | uniq -c | sed 's/^/    /'
echo "done"
