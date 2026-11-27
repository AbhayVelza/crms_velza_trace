-- Database roles for schema v11 (from velza_db_v11_aws/db/roles_v11.sql, with docs/DATABASE_PHASE1_REVIEW.md §1b fixed).
-- Run after the schema is at v11 (`npm run db:migrate`), connected as the role that owns the schema (velza_owner on
-- AWS and the Lightsail pilot; the project owner on Neon / Supabase):
--
--   psql "$MIGRATE_DATABASE_URL" -v app_password='…' -v readonly_password='…' -f deploy/roles_v11.sql
--
-- deploy/remote-deploy.sh runs it on every deploy, with the passwords from Parameter Store / migrate.env. Passwords are
-- never in this file or the repo.
--
-- The model (CLAUDE.md, SECURITY.md):
--   owner           the MIGRATOR: only deploys use it (MIGRATE_DATABASE_URL, present only during a deploy). Owns every
--                   table and function. The only role that can change or remove history (a reset of a test site,
--                   archiving a month) or run code_history_create_month() / code_history_repair_default().
--   velza_app       the app and the jobs container (DATABASE_URL). Reads and writes rows; no DDL (cannot create, change
--                   or drop tables, so a bug or a leaked password can't alter the schema). History (code_history, every
--                   monthly partition, the default partition, code_history_once), damage reports and photo records are
--                   add-and-read only (code_history_once: read only, its trigger writes it). At most 100
--                   connections. May call code_history_ensure_partitions() (last month onwards, at most 24 months
--                   ahead) and velza_daily_maintenance().
--   velza_readonly  reports, BI tools, people querying by hand, backups (pg_dump). SELECT only: that is what makes it
--                   read-only. Its default_transaction_read_only setting is a convenience the user can switch off for
--                   a session; the grants are the protection.
-- Safe to run again (it re-applies the grants; passwords are set again).

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE velza_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_app') \gexec
SELECT format('CREATE ROLE velza_readonly LOGIN PASSWORD %L', :'readonly_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_readonly') \gexec
ALTER ROLE velza_app PASSWORD :'app_password';
ALTER ROLE velza_readonly PASSWORD :'readonly_password';

SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO velza_app, velza_readonly', current_database()) \gexec

-- Neither role may create objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO velza_app, velza_readonly;

-- Rows of every table, existing and future (tables and history months the owner creates later get the same grants).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO velza_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO velza_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO velza_readonly;
-- pg_dump reads each sequence's current value, so backups need SELECT on sequences too.
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO velza_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velza_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO velza_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO velza_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO velza_readonly;

-- Permanent records: add and read only (after the grants above, so a re-run keeps them revoked). The append-only
-- triggers refuse UPDATE / DELETE too; this also holds if a trigger is ever dropped, and covers TRUNCATE.
-- code_history: the parent AND every partition (a partition can be addressed directly). Months made later by
-- code_history_create_month() revoke the same on themselves.
REVOKE UPDATE, DELETE, TRUNCATE ON code_history, code_history_once FROM velza_app;
-- code_history_once is written only by its trigger (owner rights): the app can't pre-insert an id to block a reprint.
REVOKE INSERT ON code_history_once FROM velza_app;
SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM velza_app', i.inhrelid::regclass)
  FROM pg_inherits i
 WHERE i.inhparent = 'code_history'::regclass \gexec
REVOKE UPDATE, DELETE, TRUNCATE ON damage_reports, attachments FROM velza_app;
-- The live stock summary is only ever changed by its triggers and functions; nobody truncates it by hand.
REVOKE TRUNCATE ON stock_summary, stock_deltas FROM velza_app;

-- Owner-rights functions. Only these two are for the app and the jobs; code_history_create_month() and
-- code_history_repair_default() stay with the owner (the schema revokes them from PUBLIC).
GRANT EXECUTE ON FUNCTION code_history_ensure_partitions(date, integer) TO velza_app;
GRANT EXECUTE ON FUNCTION velza_daily_maintenance() TO velza_app;

-- Time limits. Jobs that read every code (the stock check and rebuild) lift statement_timeout for their own transaction.
ALTER ROLE velza_readonly SET statement_timeout = '120s';
ALTER ROLE velza_readonly SET default_transaction_read_only = on;
ALTER ROLE velza_app SET statement_timeout = '30s';
ALTER ROLE velza_app SET idle_in_transaction_session_timeout = '60s';
-- A lock wait over 10 s fails the request with 55P03, which the API answers as 409 "busy, try again".
ALTER ROLE velza_app SET lock_timeout = '10s';
-- Connections: at most 100 for the app and jobs together (RDS max_connections = 150 leaves room for the owner, the
-- read-only role and AWS's own; docs/DATABASE_GO_LIVE.md §2, GO_LIVE_ARCHITECTURE.md). Size PG_POOL_MAX × tasks under it.
ALTER ROLE velza_app CONNECTION LIMIT 100;
