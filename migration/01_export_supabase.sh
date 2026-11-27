#!/usr/bin/env bash
# Step 1 — export the Supabase TEST database (read-only for Supabase: pg_dump only reads).
#
#   SUPABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require' \
#     ./migration/01_export_supabase.sh
#
# Use the SESSION pooler (port 5432) or the direct connection, not the transaction pooler (6543).
# pg_dump must be at least the Supabase server's major version (check with: psql "$SUPABASE_URL" -c 'show server_version').
# Writes: out/supabase_public.dump (custom format) and out/supabase_counts.txt (row counts to compare later).
set -euo pipefail
: "${SUPABASE_URL:?set SUPABASE_URL (session pooler, port 5432)}"
OUT="${OUT:-out}"
mkdir -p "$OUT"

# Our tables only (Supabase keeps its own objects in other schemas; the app's tables are all in public).
TABLES=(schema_info partners users sessions id_counters countries flavours devices settings batch_code_pool batches
        print_orders containers container_items codes code_history stock_summary stock_deltas)
echo "Server version:"; psql "$SUPABASE_URL" -XAtc 'show server_version'
echo "Schema version of the app data:"; psql "$SUPABASE_URL" -XAtc 'select version from public.schema_info'

# --table on a missing table (e.g. container_items before v10) makes pg_dump fail, so keep only those that exist.
EXISTING=$(psql "$SUPABASE_URL" -XAtc "select string_agg(tablename, ' ') from pg_tables where schemaname='public'")
ARGS=()
for t in "${TABLES[@]}"; do if [[ " $EXISTING " == *" $t "* ]]; then ARGS+=(--table "public.$t"); fi; done

pg_dump "$SUPABASE_URL" --format=custom --no-owner --no-privileges "${ARGS[@]}" --file "$OUT/supabase_public.dump"

# Row counts at export time (exact counts; fine for a test database).
psql "$SUPABASE_URL" -XAt -F $'\t' > "$OUT/supabase_counts.txt" <<'SQL'
SELECT 'partners', count(*) FROM public.partners UNION ALL
SELECT 'users', count(*) FROM public.users UNION ALL
SELECT 'codes', count(*) FROM public.codes UNION ALL
SELECT 'code_history', count(*) FROM public.code_history UNION ALL
SELECT 'containers', count(*) FROM public.containers UNION ALL
SELECT 'print_orders', count(*) FROM public.print_orders;
SQL
echo "Exported to $OUT/supabase_public.dump"; cat "$OUT/supabase_counts.txt"
