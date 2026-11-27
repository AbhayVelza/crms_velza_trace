-- Functional test of schema v11 (Option C, partitions, S3 attachments, roles). Run as velza_app on a NEW,
-- empty test database (never on a real one):  psql "<velza_app url>" -f tests/sql/test_v11_life_of_a_tray.sql
-- Prints PASS lines; any failure stops with an error. npm test runs it on embedded PostgreSQL too
-- (src/lib/store/sql/schemaV11.privileges.test.ts), after the schema and deploy/roles_v11.sql.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF;
  RAISE NOTICE 'PASS: %', what;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.fails(stmt text, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PASS: % (refused: %)', what, SQLERRM; RETURN; END;
  RAISE EXCEPTION 'FAIL: % — statement was accepted: %', what, stmt;
END $$;
SET client_min_messages = notice;

-- ---------------------------------------------------------------- master data
BEGIN;
INSERT INTO partners (partner_id, partner_type, name, state) VALUES
  ('MF0001','MANUFACTURER','Plant','MH'), ('VW0001','WAREHOUSE','Velza WH','MH'),
  ('SS0001','SS','SS Maha','MH'), ('DB0001','DB','DB Pune','MH'), ('RT0001','RETAILER','Shop A','MH'), ('RT0002','RETAILER','Shop B','MH');
UPDATE partners SET parent_id = 'SS0001' WHERE partner_id = 'DB0001';
UPDATE partners SET parent_id = 'DB0001' WHERE partner_id IN ('RT0001','RT0002');
INSERT INTO users (login_id, partner_id, name, role) VALUES ('MF0001-OP','MF0001','Op','OPERATOR'), ('DB0001','DB0001','DB','DB');
INSERT INTO devices (device_id, manufacturer_id, name) VALUES ('PC1','MF0001','Line 1 PC');
INSERT INTO batches (id,batch_code,country_code,flavour,mfg_date,expiry_date,manufacturer_id,device_id,next_lot,status,synced,print_order_id,created_at,created_by)
  VALUES ('B1','ABC123','91','LM','2026-11-01','2027-11-01','MF0001','PC1',2,'ACTIVE',true,'PO1',now(),'MF0001-OP');
INSERT INTO print_orders (print_order_id,created_at,created_by,device_id,manufacturer_id,batch_codes,lot_codes,sticker_count,status,synced)
  VALUES ('PO1',now(),'MF0001-OP','PC1','MF0001','{ABC123}','{91ABC123LM00001}',7,'PRINTED',true);
-- A tray (6 packs of 4) printed: the lot row has state, the 6 pack rows inherit (NULL state).
INSERT INTO codes (code,code_type,country_code,batch_code,flavour,hex_code,lot_type,pack_size,pack_sequence,lot_code,lot_number,manufacturer_id,status,location_id,print_order_id,generated_at,updated_at)
  VALUES ('91ABC123LM00001','LOT','91','ABC123','LM','00001','TRAY',4,NULL,'91ABC123LM00001',1,'MF0001','PACKED','MF0001','PO1',now(),now());
INSERT INTO codes (code,code_type,country_code,batch_code,flavour,hex_code,lot_type,pack_size,pack_sequence,lot_code,lot_number,manufacturer_id,status,location_id,print_order_id,generated_at,updated_at)
  SELECT '91ABC123LM000014'||s,'PACK','91','ABC123','LM','00001','TRAY',4,s,'91ABC123LM00001',1,'MF0001',NULL,NULL,'PO1',now(),now()
    FROM generate_series(1,6) s;
COMMIT;

SELECT pg_temp.ok((SELECT count(*) FROM codes) = 7, 'tray + 6 packs stored as 7 identity rows');
SELECT pg_temp.ok((SELECT count(*) FROM codes WHERE status IS NOT NULL) = 1, 'only the tray row carries state while sealed');
SELECT pg_temp.ok((SELECT bool_and(status = 'PACKED' AND location_id = 'MF0001') FROM code_state WHERE lot_code = '91ABC123LM00001'),
                  'code_state: every pack reports the tray''s status/location');

-- ---------------------------------------------------------------- moving a sealed tray rewrites ONE row
DO $$
DECLARE n int;
BEGIN
  UPDATE codes SET status='IN_TRANSIT', in_transit_to='SS0001', dispatched_at=now(), updated_at=now() WHERE code='91ABC123LM00001';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 1, 'dispatching the sealed tray updates 1 row (v10 updated 7)');
END $$;
SELECT pg_temp.ok((SELECT bool_and(status='IN_TRANSIT' AND in_transit_to='SS0001') FROM code_state WHERE lot_code='91ABC123LM00001'),
                  'packs follow the tray into transit');
SELECT pg_temp.ok((SELECT units FROM stock_current WHERE code_type='PACK' AND status='IN_TRANSIT') = 6,
                  'stock: the 6 following packs count under the tray''s state (decision Q7)');
UPDATE codes SET status='AT_SS', location_id='SS0001', in_transit_to=NULL, dispatched_at=NULL, updated_at=now() WHERE code='91ABC123LM00001';
UPDATE codes SET status='AT_DB', location_id='DB0001', updated_at=now() WHERE code='91ABC123LM00001';

-- ---------------------------------------------------------------- integrity checks (Option C)
SELECT pg_temp.fails($$UPDATE codes SET status='AT_DB' WHERE code='91ABC123LM0000141'$$, 'pack with status but no location is refused');
SELECT pg_temp.fails($$UPDATE codes SET status=NULL WHERE code='91ABC123LM00001'$$, 'lot row without state is refused');
SELECT pg_temp.fails($$UPDATE codes SET dispatched_at=now() WHERE code='91ABC123LM0000141'$$, 'inherited pack with partial state is refused');

-- ---------------------------------------------------------------- DB opens the tray: packs get their own state once
BEGIN;
UPDATE codes p SET status=l.status, location_id=l.location_id, in_transit_to=l.in_transit_to,
                   dispatched_at=l.dispatched_at, status_before_recall=l.status_before_recall, updated_at=now()
  FROM codes l WHERE l.code='91ABC123LM00001' AND p.lot_code=l.code AND p.code_type='PACK' AND p.status IS NULL;
UPDATE codes SET status='OPENED', updated_at=now() WHERE code='91ABC123LM00001';
COMMIT;
SELECT pg_temp.ok((SELECT count(*) FROM codes WHERE lot_code='91ABC123LM00001' AND code_type='PACK' AND status='AT_DB' AND location_id='DB0001') = 6,
                  'after opening: 6 packs have own state AT_DB at DB0001');
-- DB dispatches 2 packs to RT0001 and 4 to RT0002; they receive.
UPDATE codes SET status='AT_RETAILER', location_id='RT0001', updated_at=now() WHERE code IN ('91ABC123LM0000141','91ABC123LM0000142');
UPDATE codes SET status='AT_RETAILER', location_id='RT0002', updated_at=now() WHERE lot_code='91ABC123LM00001' AND code_type='PACK' AND location_id='DB0001';
SELECT pg_temp.ok((SELECT count(*) FROM code_state WHERE location_id='RT0002' AND code_type='PACK') = 4, 'RT0002 holds 4 loose packs');

-- ---------------------------------------------------------------- live stock summary matches a recount
SELECT stock_summary_rollup();
SELECT pg_temp.ok(NOT EXISTS (
  (SELECT location_id,status,code_type,lot_type,flavour,synced,units FROM stock_current
   EXCEPT SELECT location_id,status,code_type,lot_type,flavour,synced,units FROM stock_recount)
  UNION ALL
  (SELECT location_id,status,code_type,lot_type,flavour,synced,units FROM stock_recount
   EXCEPT SELECT location_id,status,code_type,lot_type,flavour,synced,units FROM stock_current)), 'stock_current = recount of every code by its effective state');

-- ---------------------------------------------------------------- history: partitions + append-only
INSERT INTO code_history (event_id, record_type, code, event, location_id, login_id, event_time)
  VALUES ('00000000-0000-4000-8000-000000000001','MOVEMENT','91ABC123LM00001','DISPATCHED','MF0001','MF0001-OP', now()),
         ('00000000-0000-4000-8000-000000000002','SCAN','91ABC123LM0000141','SCANNED','RT0001','DB0001', now());
SELECT pg_temp.ok((SELECT tableoid::regclass::text FROM code_history WHERE event_id='00000000-0000-4000-8000-000000000001') = 'code_history_' || to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY_MM'),
                  'history row lands in this month''s partition');
SELECT pg_temp.fails($$UPDATE code_history SET reason='x' WHERE event_id='00000000-0000-4000-8000-000000000001'$$, 'app cannot UPDATE history');
SELECT pg_temp.fails($$DELETE FROM code_history WHERE event_id='00000000-0000-4000-8000-000000000001'$$, 'app cannot DELETE history');
SELECT pg_temp.fails(format('DELETE FROM %I', 'code_history_' || to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY_MM')), 'app cannot DELETE from a partition directly');
SELECT pg_temp.fails($$TRUNCATE code_history$$, 'app cannot TRUNCATE history');
SELECT pg_temp.fails($$INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES ('00000000-0000-4000-8000-000000000001','SCAN','X','SCANNED', (SELECT event_time FROM code_history WHERE event_id='00000000-0000-4000-8000-000000000001'))$$,
                     'duplicate event id is refused');
-- A row 2 years ahead has no partition yet: it is kept (default partition), and db_health shows it.
INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES ('00000000-0000-4000-8000-000000000003','SCAN','UNKNOWNCODE','SCAN_FAILED', now() + interval '2 years');
SELECT pg_temp.ok((SELECT history_rows_without_partition FROM db_health) = 1, 'db_health reports a history row outside the monthly partitions');
SELECT pg_temp.ok(code_history_ensure_partitions() = 0, 'app can call code_history_ensure_partitions() (nothing new to create)');
SELECT pg_temp.fails($$CREATE TABLE hack (x int)$$, 'app cannot create tables');

-- ---------------------------------------------------------------- damage report + photo record (S3)
BEGIN;
UPDATE codes SET status='DAMAGED', updated_at=now() WHERE code='91ABC123LM0000143';
INSERT INTO code_history (event_id, record_type, code, event, item_kind, from_id, status_before, status_after, login_id, event_time)
  VALUES ('00000000-0000-4000-8000-000000000004','MOVEMENT','91ABC123LM0000143','DAMAGED','PACK','RT0002','AT_RETAILER','DAMAGED','DB0001', now());
INSERT INTO damage_reports (report_id, code, item_kind, partner_id, reason, packs_affected, reported_by, reported_at)
  VALUES ('00000000-0000-4000-8000-000000000004','91ABC123LM0000143','PACK','RT0002','Can dented',1,'DB0001',now());
INSERT INTO attachments VALUES ('00000000-0000-4000-8000-0000000000a0','00000000-0000-4000-8000-000000000004','BARCODE_PHOTO',0,'damage/2026/11/E4/0.jpg','image/jpeg',120000,repeat('a',64),now()),
                               ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000004','DAMAGE_PHOTO',1,'damage/2026/11/E4/1.jpg','image/jpeg', 90000,repeat('b',64),now());
COMMIT;
SELECT pg_temp.ok((SELECT count(*) FROM attachments WHERE report_id='00000000-0000-4000-8000-000000000004') = 2, 'damage report with 2 photo records stored');
SELECT pg_temp.fails($$INSERT INTO attachments VALUES ('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-000000000004','DAMAGE_PHOTO',0,'damage/x.jpg','image/jpeg',1,repeat('c',64),now())$$, 'seq 0 must be the barcode photo');
SELECT pg_temp.fails($$INSERT INTO attachments VALUES ('00000000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-000000000004','DAMAGE_PHOTO',2,'damage/y.gif','image/gif',1,repeat('c',64),now())$$, 'only JPEG/PNG/WebP photos');
SELECT pg_temp.fails($$UPDATE damage_reports SET reason='edited' WHERE report_id='00000000-0000-4000-8000-000000000004'$$, 'app cannot edit a damage report');
SELECT pg_temp.fails($$DELETE FROM attachments$$, 'app cannot delete photo records');

-- ---------------------------------------------------------------- other v10 rules still hold
SELECT pg_temp.fails($$UPDATE batches SET next_lot = 1 WHERE id='B1'$$, 'batch lot counter cannot go backwards');
SELECT pg_temp.fails($$DELETE FROM codes WHERE code='91ABC123LM0000146'$$, 'issued code cannot be deleted');
SELECT pg_temp.fails($$INSERT INTO partners (partner_id, partner_type, name, state) VALUES ('SS0002','SS','Second SS','MH')$$, 'one SS per state');

-- ---------------------------------------------------------------- cloud / operations objects
SELECT pg_temp.ok((SELECT count(*) FROM pg_inherits WHERE inhparent = 'codes'::regclass) = 16, 'codes is split into 16 hash partitions');
SELECT pg_temp.ok((SELECT count(DISTINCT tableoid) FROM codes WHERE lot_code = '91ABC123LM00001') > 1, 'a tray and its packs may live in different partitions (FKs still hold)');
SELECT pg_temp.fails($$SELECT * FROM code_history WHERE event_id = 'not-a-uuid'$$, 'malformed event id is an error (app must validate ids first)');
SELECT pg_temp.ok((velza_daily_maintenance() ->> 'history_rows_without_partition')::int = 1, 'velza_daily_maintenance() runs as app and reports the stray history row');
SELECT pg_temp.ok((SELECT count(*) FROM db_table_sizes WHERE table_name IN ('codes', 'code_history')) = 2, 'db_table_sizes lists codes and code_history');
SELECT pg_temp.ok((SELECT count(*) FROM db_history_partitions WHERE months_old = 0) = 1, 'db_history_partitions shows this month');

SELECT 'ALL TESTS PASSED' AS result;
