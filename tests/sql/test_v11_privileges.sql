-- Proof that velza_app cannot change or remove history (and other evidence), in every way PostgreSQL offers a
-- non-owner, non-superuser login. Run as velza_app on a test database where test_v11_life_of_a_tray.sql has run
-- (schema applied and deploy/roles_v11.sql run by a non-superuser owner, as on RDS / Lightsail):
--   psql "<velza_app url>" -f tests/sql/test_v11_privileges.sql
-- npm test runs it on embedded PostgreSQL too (src/lib/store/sql/schemaV11.privileges.test.ts).
\set ON_ERROR_STOP on
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.fails(stmt text, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PASS: % (refused: %)', what, SQLERRM; RETURN; END;
  RAISE EXCEPTION 'FAIL: % — statement was accepted: %', what, stmt;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF;
  RAISE NOTICE 'PASS: %', what;
END $$;

DO $$
DECLARE part text := 'code_history_' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY_MM');
BEGIN
  -- Through the parent
  PERFORM pg_temp.fails('UPDATE code_history SET reason = ''x''',                         'UPDATE history (parent)');
  PERFORM pg_temp.fails('DELETE FROM code_history',                                       'DELETE history (parent)');
  PERFORM pg_temp.fails('TRUNCATE code_history',                                          'TRUNCATE history (parent)');
  PERFORM pg_temp.fails('MERGE INTO code_history h USING (SELECT 1) s ON true WHEN MATCHED THEN DELETE', 'MERGE … DELETE history');
  -- Directly on a month and on the safety-net partition
  PERFORM pg_temp.fails(format('UPDATE %I SET reason = ''x''', part),                     'UPDATE a month partition directly');
  PERFORM pg_temp.fails(format('DELETE FROM %I', part),                                   'DELETE from a month partition directly');
  PERFORM pg_temp.fails(format('TRUNCATE %I', part),                                      'TRUNCATE a month partition directly');
  PERFORM pg_temp.fails('DELETE FROM code_history_default',                               'DELETE from the safety-net partition');
  PERFORM pg_temp.fails('TRUNCATE code_history_default',                                  'TRUNCATE the safety-net partition');
  -- Structure: only the owner may change it
  PERFORM pg_temp.fails('ALTER TABLE code_history DISABLE TRIGGER code_history_no_change', 'disable the append-only trigger');
  PERFORM pg_temp.fails('DROP TRIGGER code_history_no_change ON code_history',            'drop the append-only trigger');
  PERFORM pg_temp.fails(format('ALTER TABLE code_history DETACH PARTITION %I', part),     'detach a month');
  PERFORM pg_temp.fails(format('DROP TABLE %I', part),                                    'drop a month');
  PERFORM pg_temp.fails('DROP TABLE code_history',                                        'drop history');
  PERFORM pg_temp.fails('ALTER TABLE code_history RENAME TO x',                           'rename history');
  PERFORM pg_temp.fails('CREATE OR REPLACE FUNCTION code_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$',
                        'replace the trigger function with a no-op');
  PERFORM pg_temp.fails('SET session_replication_role = replica',                         'switch off triggers for the session');
  EXECUTE 'GRANT UPDATE, DELETE ON code_history TO velza_app';   -- accepted with a warning, but grants nothing
  PERFORM pg_temp.ok(NOT has_table_privilege('velza_app', 'code_history', 'UPDATE')
                 AND NOT has_table_privilege('velza_app', 'code_history', 'DELETE'), 'grant itself UPDATE/DELETE (nothing granted)');
  PERFORM pg_temp.fails('ALTER ROLE velza_app SUPERUSER',                                 'make itself superuser');
  PERFORM pg_temp.fails('SET ROLE velza_owner',                                           'become the owner');
  -- Evidence tables
  PERFORM pg_temp.fails('UPDATE damage_reports SET reason = ''x''',                       'UPDATE damage reports');
  PERFORM pg_temp.fails('DELETE FROM damage_reports',                                     'DELETE damage reports');
  PERFORM pg_temp.fails('UPDATE attachments SET sha256 = repeat(''0'', 64)',              'UPDATE photo records');
  PERFORM pg_temp.fails('TRUNCATE attachments',                                           'TRUNCATE photo records');
  -- The guard that keeps a served reprint's id unique for all time (deleting it would let a reprint print twice)
  PERFORM pg_temp.fails('DELETE FROM code_history_once',                                  'DELETE the served-reprint guard');
  PERFORM pg_temp.fails('UPDATE code_history_once SET event_time = now()',                'UPDATE the served-reprint guard');
  PERFORM pg_temp.fails('TRUNCATE code_history_once',                                     'TRUNCATE the served-reprint guard');
  PERFORM pg_temp.fails('INSERT INTO code_history_once VALUES (gen_random_uuid(), now())', 'pre-insert an id into the served-reprint guard');
  PERFORM pg_temp.fails('SELECT code_history_once_guard()',                               'call the guard''s owner-rights function');
  -- Owner-rights functions cannot be abused
  PERFORM pg_temp.fails('SELECT code_history_ensure_partitions(''1900-01-01'')',          'create ~1,500 partitions from year 1900');
  PERFORM pg_temp.fails('SELECT code_history_ensure_partitions((now() - interval ''3 months'')::date)', 'create months before last month (review issue 3)');
  PERFORM pg_temp.fails('SELECT code_history_ensure_partitions(NULL, 999)',               'create partitions 999 months ahead');
  PERFORM pg_temp.fails('SELECT code_history_ensure_partitions(NULL, 25)',                'create partitions 25 months ahead');
  PERFORM pg_temp.fails('SELECT code_history_create_month(''1990-01-01'')',               'create any month directly (owner only)');
  PERFORM pg_temp.fails('SELECT code_history_repair_default()',                           'move rows out of the default partition (owner only)');  -- Inserting is allowed (that is the app's job)
  INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES (gen_random_uuid(), 'SCAN', 'X', 'SCANNED', now());
  PERFORM pg_temp.ok(true, 'INSERT into history still works');
END $$;

-- The read-only login is read-only by its grants, not only by its default setting.
SELECT 'ALL PRIVILEGE TESTS PASSED' AS result;
