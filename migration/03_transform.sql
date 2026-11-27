-- Step 3 — copy the staged Supabase data (schema src) into the v11 tables (schema public) of the NEW AWS database.
-- Run as velza_owner:   psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f migration/03_transform.sql
--
-- One transaction: either everything is copied AND every check at the end passes, or nothing is kept.
-- Reads src only; never touches Supabase. Accepts source schema v8, v9 or v10.
-- (Dev, test and pilot databases don't need this: `npm run db:migrate` upgrades them in place with the same rules.)
--
-- What changes on the way (the same rules as the in-place upgrade in src/lib/store/sql/schema.ts):
--   * Option C: a pack whose case/tray is still sealed AND whose state equals its lot's gets NULL state (inherits).
--     Packs of opened lots, and any pack whose state differs from its lot, keep their own state.
--   * code_history goes into monthly partitions: one for every month that has rows, plus this month and 3 ahead.
--   * damage_reports: one row per DAMAGED movement (photos: see 05_upload_photos.sh).
--   * event ids become uuid. The app has always used random UUIDs; any other id (hand-made test rows, and the v10
--     app's "reprint-served:<id>" rows) gets a fixed uuid made from it (md5), so it stays unique and the same on every
--     run, and a served reprint keeps the id the v11 app looks for. 04_report.sql lists how many.
--   * sessions are NOT copied: everyone signs in again on the new site.
--   * stock_summary is recounted from the new codes (the Supabase summary counted every pack row).
-- Identity numbers (row_no, history_id) are kept, so "newest first" ordering is unchanged.
-- Every check at the end compares the whole of what matters: each barcode's effective state, every history row column
-- by column, and the stock per place, flavour and lot type, live summary included (review issues 10 and 11).
-- Loading crores of codes this way is slow at COMMIT (deferred foreign keys, review issue 16): fine for test data.

\set ON_ERROR_STOP on
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL statement_timeout = 0;

-- Event id → uuid (see above).
CREATE OR REPLACE FUNCTION pg_temp.vz_uuid(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t::uuid ELSE md5(t)::uuid END
$$;

-- ------------------------------------------------------------------ guards
DO $$
DECLARE v int; n bigint;
BEGIN
  IF to_regclass('src.codes') IS NULL THEN RAISE EXCEPTION 'Schema src is not staged (run 02_stage_into_target.sh)'; END IF;
  SELECT version INTO v FROM src.schema_info WHERE id = 1;
  IF v IS NULL OR v NOT BETWEEN 8 AND 10 THEN RAISE EXCEPTION 'Source schema v% is not supported (expected v8–v10)', v; END IF;
  IF (SELECT version FROM public.schema_info WHERE id = 1) IS DISTINCT FROM 11 THEN RAISE EXCEPTION 'Target is not schema v11'; END IF;
  -- Sign-ins and reference lists too: `npm run db:migrate` on an empty database adds the first-start sign-ins and lists,
  -- which would collide with the copied ones. Make the target with the schema file instead (it adds no rows).
  SELECT (SELECT count(*) FROM public.partners) + (SELECT count(*) FROM public.users) + (SELECT count(*) FROM public.countries)
       + (SELECT count(*) FROM public.flavours) + (SELECT count(*) FROM public.codes) + (SELECT count(*) FROM public.code_history) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Target already has data (% rows). Migrate only into a new, empty v11 database, made with: psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/schema.sql', n;
  END IF;
  RAISE NOTICE 'Migrating from source schema v%', v;
END $$;

-- ------------------------------------------------------------------ master data
INSERT INTO partners (partner_id, partner_type, name, place, address, city, state, pincode, contact_person, phone, email,
                      parent_id, active, approval, created_at, created_by, row_no)
OVERRIDING SYSTEM VALUE
SELECT partner_id, partner_type, name, place, address, city, state, pincode, contact_person, phone, email,
       parent_id, active, approval, created_at, created_by, row_no
  FROM src.partners;

INSERT INTO users (login_id, partner_id, name, role, password_hash, password_changed_at, active, created_at, last_login_at, row_no)
OVERRIDING SYSTEM VALUE
SELECT login_id, partner_id, name, role, password_hash, password_changed_at, active, created_at, last_login_at, row_no
  FROM src.users;

INSERT INTO id_counters (name, last_value) SELECT name, last_value FROM src.id_counters;
INSERT INTO countries (id, code, name, active, row_no) OVERRIDING SYSTEM VALUE SELECT id, code, name, active, row_no FROM src.countries;
INSERT INTO flavours  (id, code, name, active, row_no) OVERRIDING SYSTEM VALUE SELECT id, code, name, active, row_no FROM src.flavours;
INSERT INTO devices (device_id, manufacturer_id, name, offline, last_sync_at, row_no) OVERRIDING SYSTEM VALUE
SELECT device_id, manufacturer_id, name, offline, last_sync_at, row_no FROM src.devices;
INSERT INTO settings (id, data) SELECT id, data FROM src.settings;

-- ------------------------------------------------------------------ batches, print orders
INSERT INTO batch_code_pool (id, batch_code, device_id, status, issued_at, used_at, row_no) OVERRIDING SYSTEM VALUE
SELECT id, batch_code, device_id, status, issued_at, used_at, row_no FROM src.batch_code_pool;

INSERT INTO batches (id, batch_code, country_code, flavour, mfg_date, expiry_date, manufacturer_id, device_id, next_lot, status,
                     synced, print_order_id, created_at, created_by, recalled_at, recall_reason, row_no)
OVERRIDING SYSTEM VALUE
SELECT id, batch_code, country_code, flavour, mfg_date, expiry_date, manufacturer_id, device_id, next_lot, status,
       synced, print_order_id, created_at, created_by, recalled_at, recall_reason, row_no
  FROM src.batches;

INSERT INTO print_orders (print_order_id, created_at, created_by, device_id, manufacturer_id, batch_codes, lot_codes, sticker_count,
                          status, printed_at, synced, order_kind, request_fingerprint, row_no)
OVERRIDING SYSTEM VALUE
SELECT print_order_id, created_at, created_by, device_id, manufacturer_id, batch_codes, lot_codes, sticker_count,
       status, printed_at, synced, order_kind, request_fingerprint, row_no
  FROM src.print_orders;

-- ------------------------------------------------------------------ codes (Option C)
INSERT INTO codes (code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, pack_sequence, lot_code,
                   lot_number, mfg_date, expiry_date, manufacturer_id,
                   status, location_id, in_transit_to, dispatched_at, status_before_recall,
                   print_order_id, device_id, quarantine_reason, synced, generated_at, generated_by, updated_at, row_no)
OVERRIDING SYSTEM VALUE
SELECT c.code, c.code_type, c.country_code, c.batch_code, c.flavour, c.hex_code, c.lot_type, c.pack_size, c.pack_sequence, c.lot_code,
       c.lot_number, c.mfg_date, c.expiry_date, c.manufacturer_id,
       CASE WHEN x.inherit THEN NULL ELSE c.status               END,
       CASE WHEN x.inherit THEN NULL ELSE c.location_id          END,
       CASE WHEN x.inherit THEN NULL ELSE c.in_transit_to        END,
       CASE WHEN x.inherit THEN NULL ELSE c.dispatched_at        END,
       CASE WHEN x.inherit THEN NULL ELSE c.status_before_recall END,
       c.print_order_id, c.device_id, c.quarantine_reason, c.synced, c.generated_at, c.generated_by, c.updated_at, c.row_no
  FROM src.codes c
  JOIN src.codes l ON l.code = c.lot_code
 CROSS JOIN LATERAL (SELECT COALESCE(
         c.code_type = 'PACK'
     AND NOT (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall IS NOT DISTINCT FROM 'OPENED'))
     AND c.status               IS NOT DISTINCT FROM l.status
     AND c.location_id          IS NOT DISTINCT FROM l.location_id
     AND c.in_transit_to        IS NOT DISTINCT FROM l.in_transit_to
     AND c.dispatched_at        IS NOT DISTINCT FROM l.dispatched_at
     AND c.status_before_recall IS NOT DISTINCT FROM l.status_before_recall, false) AS inherit) x;

-- ------------------------------------------------------------------ containers (+ what they carried)
-- container_items first (v10 sources), so the trigger on containers keeps their original loaded_at / loaded_by.
DO $$
BEGIN
  IF to_regclass('src.container_items') IS NOT NULL THEN
    INSERT INTO container_items (container_id, lot_code, loaded_at, loaded_by)
    SELECT container_id, lot_code, loaded_at, loaded_by FROM src.container_items;
  END IF;
END $$;
INSERT INTO containers (container_id, container_code, manufacturer_id, status, lot_codes, to_partner_id, invoice, created_at, created_by,
                        dispatched_at, dispatched_by, received_at, received_by, cleared_at, cleared_by, bill_of_entry, row_no)
OVERRIDING SYSTEM VALUE
SELECT container_id, container_code, manufacturer_id, status, lot_codes, to_partner_id, invoice, created_at, created_by,
       dispatched_at, dispatched_by, received_at, received_by, cleared_at, cleared_by, bill_of_entry, row_no
  FROM src.containers;

-- ------------------------------------------------------------------ history (into monthly partitions)
-- One partition for every month that has rows (owner-only function: the app's code_history_ensure_partitions() only
-- makes last month onwards, review issue 3), then this month and the next 3. Months without rows get none.
SELECT count(*) FILTER (WHERE code_history_create_month(m)) AS partitions_created
  FROM (SELECT DISTINCT date_trunc('month', event_time AT TIME ZONE 'Asia/Kolkata')::date AS m FROM src.code_history) months;
SELECT code_history_ensure_partitions() AS partitions_ahead;

INSERT INTO code_history (history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id,
                          status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id,
                          print_order_id, event_time)
OVERRIDING SYSTEM VALUE
SELECT history_id, pg_temp.vz_uuid(event_id), record_type, code, event, item_kind, context, location_id, from_id, to_id,
       status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id,
       print_order_id, event_time
  FROM src.code_history
 ORDER BY history_id;

-- ------------------------------------------------------------------ damage reports (from DAMAGED movements)
INSERT INTO damage_reports (report_id, code, item_kind, partner_id, reason, packs_affected, reported_by, reported_at)
SELECT pg_temp.vz_uuid(h.event_id), h.code,
       COALESCE(h.item_kind, CASE WHEN length(h.code) = 15 THEN 'LOT' ELSE 'PACK' END),
       h.from_id,
       COALESCE(NULLIF(btrim(h.reason), ''), '(no reason recorded)'),
       CASE WHEN length(h.code) <> 15 THEN 1                                    -- a single pack
            WHEN h.status_before = 'OPENED' THEN GREATEST(1, (SELECT count(*) FROM src.codes p   -- packs of an opened lot left there
                                                               WHERE p.lot_code = h.code AND p.code_type = 'PACK'
                                                                 AND p.status = 'DAMAGED' AND p.location_id = h.from_id))
            WHEN k.lot_type = 'CASE' THEN 4 ELSE 6 END,                           -- a whole sealed case / tray
       (SELECT u.login_id FROM users u WHERE u.login_id = h.login_id),
       h.event_time
  FROM src.code_history h
  JOIN codes k ON k.code = h.code
 WHERE h.record_type = 'MOVEMENT' AND h.event = 'DAMAGED'
   AND h.from_id IS NOT NULL AND EXISTS (SELECT 1 FROM partners p WHERE p.partner_id = h.from_id);

-- ------------------------------------------------------------------ identity counters continue after the copied numbers
DO $$
DECLARE r record; mx bigint;
BEGIN
  FOR r IN SELECT c.relname AS tbl, a.attname AS col
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attidentity <> ''
              AND NOT c.relispartition LOOP
    EXECUTE format('SELECT max(%I) FROM %I', r.col, r.tbl) INTO mx;
    PERFORM setval(pg_get_serial_sequence(format('%I', r.tbl), r.col), COALESCE(mx, 0) + 1, false);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ live stock counts, from the new codes
SELECT stock_summary_rebuild();

-- ------------------------------------------------------------------ checks: any failure rolls everything back
DO $$
DECLARE
  bad bigint;
  msg text := '';
BEGIN
  -- 1. Same rows in every table.
  IF (SELECT count(*) FROM partners)       <> (SELECT count(*) FROM src.partners)       THEN msg := msg || ' partners;'; END IF;
  IF (SELECT count(*) FROM users)          <> (SELECT count(*) FROM src.users)          THEN msg := msg || ' users;'; END IF;
  IF (SELECT count(*) FROM batches)        <> (SELECT count(*) FROM src.batches)        THEN msg := msg || ' batches;'; END IF;
  IF (SELECT count(*) FROM print_orders)   <> (SELECT count(*) FROM src.print_orders)   THEN msg := msg || ' print_orders;'; END IF;
  IF (SELECT count(*) FROM containers)     <> (SELECT count(*) FROM src.containers)     THEN msg := msg || ' containers;'; END IF;
  IF (SELECT count(*) FROM codes)          <> (SELECT count(*) FROM src.codes)          THEN msg := msg || ' codes;'; END IF;
  IF (SELECT count(*) FROM code_history)   <> (SELECT count(*) FROM src.code_history)   THEN msg := msg || ' code_history;'; END IF;
  -- 2. THE Option C check: every barcode's effective state equals what Supabase had.
  SELECT count(*) INTO bad
    FROM code_state s JOIN src.codes o ON o.code = s.code
   WHERE (s.status, s.location_id, s.in_transit_to, s.dispatched_at, s.status_before_recall)
         IS DISTINCT FROM (o.status, o.location_id, o.in_transit_to, o.dispatched_at, o.status_before_recall);
  IF bad > 0 THEN msg := msg || format(' %s codes changed state;', bad); END IF;
  -- 3. History copied exactly: every column of every row, both ways (review issue 10; EXCEPT treats NULLs as equal).
  SELECT count(*) INTO bad FROM (
    (SELECT history_id, pg_temp.vz_uuid(event_id), record_type, code, event, item_kind, context, location_id, from_id, to_id,
            status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time
       FROM src.code_history
     EXCEPT ALL
     SELECT history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id,
            status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time
       FROM code_history)
    UNION ALL
    (SELECT history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id,
            status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time
       FROM code_history
     EXCEPT ALL
     SELECT history_id, pg_temp.vz_uuid(event_id), record_type, code, event, item_kind, context, location_id, from_id, to_id,
            status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time
       FROM src.code_history)) d;
  IF bad > 0 THEN msg := msg || format(' %s history rows differ;', bad); END IF;
  -- 3b. Stock as Supabase counts it (review issue 11), live summary included, so the HQ dashboard shows the same stock.
  --     The v11 summary counts every code by its effective state (decision Q7), which is what Supabase's rows say:
  --     lots and packs per place, status, kind, lot type and flavour must be equal, key for key.
  SELECT count(*) INTO bad FROM (
    SELECT * FROM (SELECT location_id, status, code_type, lot_type, flavour, count(*)::bigint AS n FROM src.codes GROUP BY 1, 2, 3, 4, 5) a
    FULL JOIN (SELECT location_id, status, code_type, lot_type, flavour, sum(units)::bigint AS n FROM stock_current GROUP BY 1, 2, 3, 4, 5) b
      USING (location_id, status, code_type, lot_type, flavour)
     WHERE a.n IS DISTINCT FROM b.n) d;
  IF bad > 0 THEN msg := msg || format(' %s stock counts differ;', bad); END IF;
  -- 4. Nothing fell outside the monthly partitions; opened lots have no inheriting packs.
  IF (SELECT history_rows_without_partition FROM db_health) > 0 THEN msg := msg || ' history rows in the default partition;'; END IF;
  IF (SELECT opened_lot_packs_without_state FROM db_health) > 0 THEN msg := msg || ' opened-lot packs without state;'; END IF;
  -- 5. Every container's lot list and its rows agree.
  SELECT count(*) INTO bad FROM containers c
   WHERE (SELECT coalesce(array_agg(lot_code ORDER BY lot_code), '{}') FROM container_items i WHERE i.container_id = c.container_id)
         IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT l ORDER BY l), '{}') FROM unnest(c.lot_codes) l);
  IF bad > 0 THEN msg := msg || format(' %s containers whose items differ from lot_codes;', bad); END IF;

  IF msg <> '' THEN RAISE EXCEPTION 'Migration checks FAILED, nothing was kept:%', msg; END IF;
  RAISE NOTICE 'All migration checks passed.';
END $$;

COMMIT;
ANALYZE partners, users, batches, print_orders, containers, container_items, codes, code_history, damage_reports, stock_summary;
