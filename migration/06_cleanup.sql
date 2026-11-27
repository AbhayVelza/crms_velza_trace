-- Step 6 — after the report has been checked and saved: remove the staged Supabase copy from the AWS database.
--   psql "$TARGET_URL" -f migration/06_cleanup.sql
-- (Keep out/supabase_public.dump in the backup bucket for 30 days in case anything must be compared later.)
DROP SCHEMA IF EXISTS src CASCADE;
VACUUM (ANALYZE) codes, code_history, containers, container_items, stock_summary;
