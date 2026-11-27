-- =====================================================================================================
-- Velza — one-time bootstrap of a NEW AWS PostgreSQL 16/17 server (RDS, Aurora or Lightsail managed DB).
-- From velza_db_v11_aws/db/bootstrap_aws.sql, with docs/DATABASE_PHASE1_REVIEW.md §1b issue 14 fixed.
-- Run ONCE, connected as the master user AWS created (RDS: the "master username"; Lightsail: dbmasteruser),
-- to the default "postgres" database:
--
--   psql "host=<endpoint> port=5432 dbname=postgres user=<master> sslmode=verify-full sslrootcert=global-bundle.pem" \
--        -v owner_password='…' -f db/bootstrap_aws.sql
--
-- Result:
--   * role velza_owner  — owns the velza database and every table in it. Only deploys/migrations log in as it
--                          (MIGRATE_DATABASE_URL). The AWS master user is kept for emergencies only.
--   * database velza     — nobody else can connect until deploy/roles_v11.sql grants it.
-- Safe to run again. An existing role's password is NOT changed.
--
-- Then, as velza_owner: the schema (`npm run db:migrate`, or `psql -1 -f db/schema.sql` for a database that will
-- receive migrated data: it adds no rows), then deploy/roles_v11.sql.
--
-- Lightsail through our Terraform: SKIP this file. Terraform already creates database "velza" with master user
-- velza_owner (its password is in SSM), so velza_owner already owns the database; go straight to the schema.
-- RDS / Aurora: run it, unless the master user itself is named velza_owner (then skip it the same way). Run by
-- velza_owner by mistake, it no longer fails (a login can't give itself CREATEROLE, so that step is skipped).
-- =====================================================================================================

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE velza_owner LOGIN PASSWORD %L', :'owner_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_owner') \gexec
-- CREATEROLE so roles_v11.sql (run as velza_owner) can create velza_app / velza_readonly. On PostgreSQL 16+ a
-- CREATEROLE role can only manage the roles it created itself, never the master user or rds_* roles.
-- Only the master user can grant it (a login can't change its own attributes).
SELECT 'ALTER ROLE velza_owner CREATEROLE' WHERE current_user <> 'velza_owner' \gexec
ALTER ROLE velza_owner SET statement_timeout = '0';         -- migrations and partition jobs may run long

-- On RDS the master user must be a member of a role to create a database owned by it.
SELECT 'GRANT velza_owner TO CURRENT_USER' WHERE current_user <> 'velza_owner'
   AND NOT pg_has_role(current_user, 'velza_owner', 'SET') \gexec

SELECT 'CREATE DATABASE velza OWNER velza_owner ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'velza') \gexec

REVOKE ALL ON DATABASE velza FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE velza TO velza_owner;

-- Business time zone for reports; the app always stores timestamptz (an exact instant), so this changes display only.
ALTER DATABASE velza SET timezone TO 'Asia/Kolkata';

\connect velza
-- PostgreSQL 15+: schema public belongs to the database owner (velza_owner) and PUBLIC cannot create in it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
