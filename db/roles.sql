-- Database roles: since schema v11 the grants live in deploy/roles_v11.sql (the deploy copies and runs that file).
-- This file includes it, for running by hand from a checkout of the repo:
--
--   psql "$OWNER_DATABASE_URL" -v app_password='…' -v readonly_password='…' -f db/roles.sql
--
-- (The v10 version of this file revoked rights on code_history only; with v11's monthly partitions every partition
-- must be covered too, which deploy/roles_v11.sql does.)

\ir ../deploy/roles_v11.sql
