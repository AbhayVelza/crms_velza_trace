-- Database roles for production. Run once, connected as the role that owns the schema (on Neon: the project
-- owner, e.g. neondb_owner; on a self-managed server: the role that ran the first `npm run db:migrate`):
--
--   psql "$OWNER_DATABASE_URL" -v app_password='…' -v readonly_password='…' -f db/roles.sql
--
-- Afterwards:
--   - the owner role is the MIGRATOR: only deploys use it (DATABASE_URL in /srv/velza/shared/migrate.env);
--   - velza_app is what the app and the cron jobs use (DATABASE_URL in /srv/velza/shared/.env.local). It reads and
--     writes rows but cannot create, change or drop tables, so a bug or a leaked password can't alter the schema;
--   - velza_readonly is for reports, BI tools and people querying by hand.
-- Safe to run again (it re-applies the grants; passwords are set again).

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE velza_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_app') \gexec
SELECT format('CREATE ROLE velza_readonly LOGIN PASSWORD %L', :'readonly_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_readonly') \gexec
ALTER ROLE velza_app PASSWORD :'app_password';
ALTER ROLE velza_readonly PASSWORD :'readonly_password';

-- Neither role may create objects; the app role can't change the schema even through a bug.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO velza_app, velza_readonly;

-- Rows of every table, existing and future (tables the owner creates in later migrations get the same grants).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO velza_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO velza_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO velza_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velza_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO velza_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO velza_readonly;

-- Reports run on a read replica when there is one; keep heavy ad-hoc queries from holding locks for long.
ALTER ROLE velza_readonly SET statement_timeout = '120s';
ALTER ROLE velza_app SET statement_timeout = '30s';
ALTER ROLE velza_app SET idle_in_transaction_session_timeout = '60s';
