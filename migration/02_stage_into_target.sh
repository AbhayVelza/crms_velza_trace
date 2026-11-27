#!/usr/bin/env bash
# Step 2 — put the Supabase data next to the new tables, in a schema called "src" of the NEW AWS database.
#
#   SCRATCH_URL='postgresql://postgres@localhost:55432/postgres'      # a throwaway local Postgres (see below)
#   TARGET_URL='postgresql://velza_owner:…@<aws-endpoint>:5432/velza?sslmode=verify-full&sslrootcert=global-bundle.pem'
#   ./migration/02_stage_into_target.sh
#
# Why a scratch database: pg_restore cannot rename a schema, so the dump is restored into a throwaway Postgres first,
# its "public" is renamed to "src", its triggers/functions are dropped (src is read-only data), and that is copied to
# the target. Works on RDS/Lightsail with no superuser and no extensions.
#
# Scratch Postgres, e.g. with Docker (use the same major version as Supabase, or newer):
#   docker run -d --name velza-scratch -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17
set -euo pipefail
: "${SCRATCH_URL:?}"; : "${TARGET_URL:?}"
OUT="${OUT:-out}"

# The scratch server's URL with the database name replaced by velza_src, keeping any ?query (sslmode=…) intact
# (review issue 9: cutting at the last "/" broke a URL with a query string).
case "$SCRATCH_URL" in
  postgres://*/*|postgresql://*/*) ;;
  *) echo "SCRATCH_URL must be a postgres:// URL with a database name, e.g. postgresql://postgres@localhost:55432/postgres" >&2; exit 1 ;;
esac
SCRATCH_BASE="${SCRATCH_URL%%\?*}"
SCRATCH_QUERY=""
[[ "$SCRATCH_URL" == *\?* ]] && SCRATCH_QUERY="?${SCRATCH_URL#*\?}"
SCRATCH_DB_URL="${SCRATCH_BASE%/*}/velza_src${SCRATCH_QUERY}"
psql "$SCRATCH_URL" -X -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS velza_src' -c 'CREATE DATABASE velza_src'
# Tables, data, keys and indexes only: the dump has no functions (pg_dump --table leaves them out), so skip triggers.
pg_restore --list "$OUT/supabase_public.dump" | grep -v ' TRIGGER ' > "$OUT/restore.list"
pg_restore --no-owner --no-privileges --exit-on-error --use-list "$OUT/restore.list" -d "$SCRATCH_DB_URL" "$OUT/supabase_public.dump"

psql "$SCRATCH_DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
-- Keep tables + data only: triggers and functions in src would refer to the target's tables by name.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tgname, tgrelid::regclass AS tbl FROM pg_trigger WHERE NOT tgisinternal
             AND tgrelid::regclass::text NOT LIKE 'pg_%' LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.tbl);
  END LOOP;
END $$;
DROP VIEW IF EXISTS public.stock_current, public.code_state CASCADE;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('DROP FUNCTION %s CASCADE', r.f);
  END LOOP;
END $$;
ALTER SCHEMA public RENAME TO src;
SQL

# Plain SQL so a newer pg_dump's session settings (e.g. transaction_timeout on PG17) can be filtered for a PG16 target.
pg_dump "$SCRATCH_DB_URL" --schema=src --no-owner --no-privileges --format=plain \
  | grep -v '^SET transaction_timeout' > "$OUT/src_schema.sql"

psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -c "SELECT 1 FROM schema_info WHERE version = 11" | grep -q 1 \
  || { echo "Target is not an empty v11 database (run db/bootstrap_aws.sql, psql -1 -f db/schema.sql, deploy/roles_v11.sql first)"; exit 1; }
psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS src CASCADE'
psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 -f "$OUT/src_schema.sql"
psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA src FROM PUBLIC'
echo "Staged: schema src in the target database. Next: psql \"\$TARGET_URL\" -f migration/03_transform.sql"
