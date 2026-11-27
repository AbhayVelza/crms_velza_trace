-- Builds a FAKE "Supabase" test database in today's v10 shape (packs carry copies of their lot's state), used to
-- rehearse the migration end to end. Run after the repo's db/schema.sql on an empty scratch database.
\set ON_ERROR_STOP on
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO partners (partner_id, partner_type, name, state, parent_id) VALUES
  ('MF0001','MANUFACTURER','Plant','MH',NULL), ('VW0001','WAREHOUSE','Velza WH','MH',NULL),
  ('SS0001','SS','SS Maha','MH',NULL), ('SS0002','SS','SS Guj','GJ',NULL),
  ('DB0001','DB','DB Pune','MH','SS0001'), ('DB0002','DB','DB Surat','GJ','SS0002'),
  ('RT0001','RETAILER','Shop A','MH','DB0001'), ('RT0002','RETAILER','Shop B','MH','DB0001'), ('RT0003','RETAILER','Taj','MH','SS0001');
INSERT INTO users (login_id, partner_id, name, role, password_hash) VALUES
  ('AD0001',NULL,'Admin','ADMIN','scrypt$x'), ('HQ0001',NULL,'HQ','TRACE_OWNER','scrypt$y'),
  ('MF0001-OP','MF0001','Op','OPERATOR','h'), ('VW0001','VW0001','WH','WAREHOUSE','h'), ('SS0001','SS0001','SS','SS','h'),
  ('DB0001','DB0001','DB','DB','h'), ('RT0001','RT0001','RT','RETAILER','h');
INSERT INTO sessions VALUES ('s1','AD0001',now(),now()+interval '1 day');
INSERT INTO id_counters VALUES ('MF',1),('SS',2),('DB',2),('RT',3),('AD',1),('HQ',1);
INSERT INTO countries (id,code,name) VALUES ('c91','91','India');
INSERT INTO flavours (id,code,name) VALUES ('fLM','LM','Lemon'),('fCO','CO','Cola');
INSERT INTO devices (device_id, manufacturer_id, name) VALUES ('PC1','MF0001','Line 1');
INSERT INTO settings VALUES ('app','{"a":1}');
INSERT INTO batch_code_pool VALUES ('p1','ABC123','PC1','USED',now(),now()), ('p2','XYZ789','PC1','USED',now(),now());
INSERT INTO batches (id,batch_code,country_code,flavour,mfg_date,expiry_date,manufacturer_id,device_id,next_lot,status,synced,print_order_id,created_at,created_by) VALUES
  ('B1','ABC123','91','LM','2026-10-01','2027-10-01','MF0001','PC1',201,'ACTIVE',true,'PO1','2026-10-01','MF0001-OP'),
  ('B2','XYZ789','91','CO','2026-10-05','2027-10-05','MF0001','PC1',101,'ACTIVE',true,'PO2','2026-10-05','MF0001-OP');
INSERT INTO print_orders (print_order_id,created_at,created_by,device_id,manufacturer_id,batch_codes,lot_codes,sticker_count,status,synced,order_kind)
  VALUES ('PO1','2026-10-01','MF0001-OP','PC1','MF0001','{ABC123}','{}',1400,'PRINTED',true,'NEW_BATCH'),
         ('PO2','2026-10-05','MF0001-OP','PC1','MF0001','{XYZ789}','{}',500,'PRINTED',true,'NEW_BATCH');

-- 200 trays (batch ABC123) + 100 cases (XYZ789), all lot rows first.
INSERT INTO codes (code,code_type,country_code,batch_code,flavour,hex_code,lot_type,pack_size,pack_sequence,lot_code,lot_number,manufacturer_id,status,location_id,print_order_id,generated_at,updated_at)
SELECT l.code,'LOT','91',l.b,l.f,l.hex,l.t,l.ps,NULL,l.code,l.n,'MF0001','PACKED','MF0001',l.po,'2026-10-01','2026-10-01'
  FROM (SELECT n, 'ABC123' b, 'LM' f, 'TRAY' t, 4 ps, 'PO1' po, lpad(upper(to_hex(n)),5,'0') hex, '91ABC123LM'||lpad(upper(to_hex(n)),5,'0') code FROM generate_series(1,200) n
        UNION ALL
        SELECT n, 'XYZ789', 'CO', 'CASE', 6, 'PO2', lpad(upper(to_hex(n)),5,'0'), '91XYZ789CO'||lpad(upper(to_hex(n)),5,'0') FROM generate_series(1,100) n) l;
-- Packs (v10: copies of the lot's state).
INSERT INTO codes (code,code_type,country_code,batch_code,flavour,hex_code,lot_type,pack_size,pack_sequence,lot_code,lot_number,manufacturer_id,status,location_id,print_order_id,generated_at,updated_at)
SELECT l.code||l.pack_size||s,'PACK','91',l.batch_code,l.flavour,l.hex_code,l.lot_type,l.pack_size,s,l.code,l.lot_number,'MF0001','PACKED','MF0001',l.print_order_id,'2026-10-01','2026-10-01'
  FROM codes l CROSS JOIN LATERAL generate_series(1, CASE l.pack_size WHEN 4 THEN 6 ELSE 4 END) s WHERE l.code_type='LOT';
COMMIT;

-- Life of the stock (v10 behaviour: lot and every pack updated together).
CREATE TEMP TABLE plan AS
SELECT code, CASE WHEN rn <= 60  THEN 'AT_SS:SS0001'
                  WHEN rn <= 120 THEN 'AT_DB:DB0001'
                  WHEN rn <= 150 THEN 'AT_RETAILER:RT0001'
                  WHEN rn <= 170 THEN 'IN_TRANSIT:DB0002'
                  WHEN rn <= 200 THEN 'AT_CUSTOMS:VW0001'
                  ELSE 'PACKED:MF0001' END AS target
  FROM (SELECT code, row_number() OVER (ORDER BY code) rn FROM codes WHERE code_type='LOT') x;
UPDATE codes c SET status = split_part(p.target,':',1),
                   location_id = CASE WHEN split_part(p.target,':',1)='IN_TRANSIT' THEN 'SS0002' ELSE split_part(p.target,':',2) END,
                   in_transit_to = CASE WHEN split_part(p.target,':',1)='IN_TRANSIT' THEN split_part(p.target,':',2) END,
                   dispatched_at = CASE WHEN split_part(p.target,':',1)='IN_TRANSIT' THEN timestamptz '2026-11-20 10:00+05:30' END,
                   updated_at = '2026-11-20'
  FROM plan p WHERE c.lot_code = p.code;

-- 5 trays opened at DB0001: packs split between two retailers / still at DB, one pack damaged.
WITH o AS (SELECT code FROM codes WHERE code_type='LOT' AND status='AT_DB' ORDER BY code LIMIT 5)
UPDATE codes SET status='OPENED' FROM o WHERE codes.code=o.code;
WITH o AS (SELECT code FROM codes WHERE code_type='LOT' AND status='OPENED')
UPDATE codes p SET status='AT_RETAILER', location_id = CASE WHEN p.pack_sequence <= 2 THEN 'RT0001' ELSE 'RT0002' END
  FROM o WHERE p.lot_code=o.code AND p.code_type='PACK' AND p.pack_sequence <= 4;
UPDATE codes SET status='DAMAGED' WHERE code = (SELECT min(code) FROM codes WHERE code_type='PACK' AND location_id='RT0002');
-- An anomaly: one pack of a sealed tray has a different state (must be kept as own state).
UPDATE codes SET status='QUARANTINED', quarantine_reason='test' WHERE code = (SELECT max(code) FROM codes WHERE code_type='PACK' AND status='AT_SS');
-- A recalled lot that had been opened, and a recalled sealed lot.
UPDATE codes SET status='RECALLED', status_before_recall='OPENED' WHERE code=(SELECT max(code) FROM codes WHERE code_type='LOT' AND status='OPENED');
UPDATE codes SET status='RECALLED', status_before_recall='AT_SS' WHERE lot_code=(SELECT min(code) FROM codes WHERE code_type='LOT' AND status='AT_SS');

-- A container to Customs carrying the AT_CUSTOMS lots, and one older cleared container.
INSERT INTO containers (container_id,container_code,manufacturer_id,status,lot_codes,to_partner_id,created_at,created_by,dispatched_at,received_at)
SELECT 'CT1','MSKU1234567','MF0001','RECEIVED', array_agg(code ORDER BY code),'VW0001','2026-11-10','MF0001-OP','2026-11-10','2026-11-15'
  FROM codes WHERE code_type='LOT' AND status='AT_CUSTOMS';
INSERT INTO containers (container_id,container_code,manufacturer_id,status,lot_codes,to_partner_id,created_at,created_by,dispatched_at,received_at,cleared_at,bill_of_entry)
SELECT 'CT0','MSKU1234567','MF0001','CLEARED', array_agg(code ORDER BY code),'VW0001','2026-10-20','MF0001-OP','2026-10-20','2026-10-25','2026-10-27','BOE1'
  FROM (SELECT code FROM codes WHERE code_type='LOT' AND status='AT_SS' ORDER BY code LIMIT 10) x;

-- History over two months: movements for every lot, scans, a reprint, a failed scan, the damage report.
INSERT INTO code_history (event_id, record_type, code, event, item_kind, location_id, from_id, to_id, status_before, status_after, login_id, event_time)
SELECT 'M'||row_number() OVER (), 'MOVEMENT', code, 'DISPATCHED', 'LOT', 'MF0001', 'MF0001', location_id, 'PACKED', 'IN_TRANSIT', 'MF0001-OP',
       timestamptz '2026-10-15 09:00+05:30' + (row_number() OVER ()) * interval '7 minutes'
  FROM codes WHERE code_type='LOT' AND status <> 'PACKED';
INSERT INTO code_history (event_id, record_type, code, event, location_id, ok, result, login_id, event_time)
SELECT 'S'||g, 'SCAN', '91ABC123LM00001', 'SCANNED', 'SS0001', true, 'OK', 'SS0001', timestamptz '2026-11-01 08:00+05:30' + g * interval '1 hour'
  FROM generate_series(1,500) g;
INSERT INTO code_history (event_id, record_type, code, event, location_id, ok, result, message, event_time)
  VALUES ('F1','SCAN','NOTAREALCODE','SCAN_FAILED','RT0001',false,'UNKNOWN','Unknown code','2026-11-21 12:00+05:30');
INSERT INTO code_history (event_id, record_type, code, event, item_kind, reason, login_id, print_order_id, event_time)
  VALUES ('R1','REPRINT','91ABC123LM00002','REPRINTED','LOT','Torn sticker','MF0001-OP','PO1','2026-10-02 10:00+05:30');
INSERT INTO code_history (event_id, record_type, code, event, item_kind, location_id, from_id, status_before, status_after, reason, login_id, event_time)
SELECT 'D1','MOVEMENT', code, 'DAMAGED','PACK','RT0002','RT0002','AT_RETAILER','DAMAGED','Can dented','RT0001','2026-11-22 15:00+05:30'
  FROM codes WHERE status='DAMAGED';

SELECT stock_summary_rebuild();
