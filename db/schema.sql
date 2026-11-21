-- Velza Traceability — PostgreSQL schema v10.
-- Generated from src/lib/store/sql/schema.ts by `npm run db:schema`; do not edit by hand.
-- The app applies this itself on first use (and `npm run db:migrate` does it on demand); every
-- statement is safe to run again.

-- Which version of this schema the database has. The app applies the schema only when it is missing or
-- older, so it can run as a database user without rights to create tables once `npm run db:migrate` has run.
CREATE TABLE IF NOT EXISTS schema_info (
  id          integer PRIMARY KEY CHECK (id = 1),
  version     integer NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================ partners
-- One row per site, filled from the Admin registration form. ID = role prefix + sequence (DB0001).
-- parent_id = the partner it is assigned to: a Distributor's Super Stockist; a Retailer's Distributor,
-- or for a few Retailers their Super Stockist directly.
CREATE TABLE IF NOT EXISTS partners (
  partner_id      text PRIMARY KEY,
  partner_type    text NOT NULL CONSTRAINT partners_partner_type_check CHECK (partner_type IN ('MANUFACTURER', 'WAREHOUSE', 'SS', 'DB', 'RETAILER')),
  name            text NOT NULL,
  place           text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',
  city            text NOT NULL DEFAULT '',
  state           text NOT NULL DEFAULT '',
  pincode         text NOT NULL DEFAULT '',
  contact_person  text NOT NULL DEFAULT '',
  phone           text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  parent_id       text REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  row_no          bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT partner_id_matches_type CHECK (
    partner_id ~ '^(MF|VW|SS|DB|RT)[0-9]{4,}$' AND left(partner_id, 2) = CASE partner_type
      WHEN 'MANUFACTURER' THEN 'MF' WHEN 'WAREHOUSE' THEN 'VW' WHEN 'SS' THEN 'SS' WHEN 'DB' THEN 'DB' ELSE 'RT' END)
);
-- One Super Stockist per state.
-- One Super Stockist per state: the index is (re)built in the v7 section below, where the approval column exists.
CREATE UNIQUE INDEX IF NOT EXISTS partners_email_unique ON partners (lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS partners_parent ON partners (parent_id);

-- ============================================================ users (sign-ins)
-- login_id = the partner ID (DB0001), MF0001-OP / MF0001-QC at the plant, AD0001 / HQ0001 for Velza staff.
CREATE TABLE IF NOT EXISTS users (
  login_id             text PRIMARY KEY CONSTRAINT users_login_id_check CHECK (login_id ~ '^(MF|VW|SS|DB|RT|AD|HQ|VF)[0-9]{4,}(-(OP|QC))?$'),
  partner_id           text REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  name                 text NOT NULL,
  role                 text NOT NULL CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'OPERATOR', 'QC', 'WAREHOUSE', 'SS', 'DB', 'RETAILER', 'TRACE_OWNER', 'VELZA_FIELD')),
  password_hash        text,
  password_changed_at  timestamptz,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz,
  row_no               bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS users_partner ON users (partner_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  text PRIMARY KEY,  -- SHA-256 of the cookie token, never the token itself
  login_id    text NOT NULL REFERENCES users (login_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  row_no      bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS sessions_login ON sessions (login_id);

-- Last number issued per ID sequence (MF, SS, DB, RT, AD, HQ). Numbers are never reused.
CREATE TABLE IF NOT EXISTS id_counters (
  name        text PRIMARY KEY,
  last_value  integer NOT NULL CHECK (last_value >= 0)
);

-- ============================================================ reference lists, devices, settings
CREATE TABLE IF NOT EXISTS countries (
  id      text PRIMARY KEY,
  code    text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{2}$'),
  name    text NOT NULL,
  active  boolean NOT NULL DEFAULT true,
  row_no  bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS flavours (
  id      text PRIMARY KEY,
  code    text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2}$'),
  name    text NOT NULL,
  active  boolean NOT NULL DEFAULT true,
  row_no  bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS devices (
  device_id        text PRIMARY KEY,
  manufacturer_id  text NOT NULL REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  name             text NOT NULL,
  offline          boolean NOT NULL DEFAULT false,
  last_sync_at     timestamptz,
  row_no           bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS settings (
  id    text PRIMARY KEY,
  data  jsonb NOT NULL
);

-- ============================================================ batches and print orders
-- Batch codes handed to a plant device in advance, so a batch code is never issued twice.
CREATE TABLE IF NOT EXISTS batch_code_pool (
  id          text PRIMARY KEY,
  batch_code  text NOT NULL UNIQUE CHECK (batch_code ~ '^[A-Z0-9]{6}$'),
  device_id   text NOT NULL,
  status      text NOT NULL CHECK (status IN ('RESERVED', 'USED', 'RETURNED')),
  issued_at   timestamptz NOT NULL,
  used_at     timestamptz,
  row_no      bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS batches (
  id               text PRIMARY KEY,
  batch_code       text NOT NULL CHECK (batch_code ~ '^[A-Z0-9]{6}$'),
  country_code     text NOT NULL,
  flavour          text NOT NULL,
  mfg_date         date NOT NULL,
  expiry_date      date NOT NULL,
  manufacturer_id  text NOT NULL REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  device_id        text NOT NULL,
  next_lot         integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'RECALLED')),
  synced           boolean NOT NULL,
  print_order_id   text NOT NULL,
  created_at       timestamptz NOT NULL,
  created_by       text NOT NULL,
  recalled_at      timestamptz,
  recall_reason    text,
  row_no           bigint GENERATED ALWAYS AS IDENTITY
);
CREATE UNIQUE INDEX IF NOT EXISTS batches_code_flavour_key ON batches (batch_code, flavour);

CREATE TABLE IF NOT EXISTS print_orders (
  print_order_id   text PRIMARY KEY,
  created_at       timestamptz NOT NULL,
  created_by       text NOT NULL,
  device_id        text NOT NULL,
  manufacturer_id  text NOT NULL,
  batch_codes      text[] NOT NULL,
  lot_codes        text[] NOT NULL,
  sticker_count    integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('CREATED', 'PRINTED')),
  printed_at       timestamptz,
  synced           boolean NOT NULL,
  row_no           bigint GENERATED ALWAYS AS IDENTITY
);

-- ============================================================ containers
-- One trip of a shipping container from the plant to the Velza Warehouse. container_code is the container's
-- own number; containers are reused, so it is unique only among containers still loading or on the road.
CREATE TABLE IF NOT EXISTS containers (
  container_id     text PRIMARY KEY,
  container_code   text NOT NULL CHECK (container_code ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  manufacturer_id  text NOT NULL,
  status           text NOT NULL CONSTRAINT containers_status_check CHECK (status IN ('LOADING', 'IN_TRANSIT', 'RECEIVED', 'CLEARED')),
  lot_codes        text[] NOT NULL,
  to_partner_id    text,
  invoice          text,
  created_at       timestamptz NOT NULL,
  created_by       text NOT NULL,
  dispatched_at    timestamptz,
  dispatched_by    text,
  received_at      timestamptz,
  received_by      text,
  cleared_at       timestamptz,
  cleared_by       text,
  bill_of_entry    text,
  row_no           bigint GENERATED ALWAYS AS IDENTITY
);
CREATE UNIQUE INDEX IF NOT EXISTS containers_one_active_per_code ON containers (container_code) WHERE status IN ('LOADING', 'IN_TRANSIT');
CREATE INDEX IF NOT EXISTS containers_by_receiver ON containers (to_partner_id);
CREATE INDEX IF NOT EXISTS containers_by_manufacturer ON containers (manufacturer_id);

-- ============================================================ codes
-- One row per sticker: a case or tray (LOT) and each of its packs (PACK). The code must equal its
-- parts: country (2) + batch (6) + flavour (2) + hex lot number (5) [+ pack size + pack sequence].
CREATE TABLE IF NOT EXISTS codes (
  code                  text PRIMARY KEY,
  code_type             text NOT NULL CHECK (code_type IN ('LOT', 'PACK')),
  country_code          text NOT NULL CHECK (country_code ~ '^[0-9]{2}$'),
  batch_code            text NOT NULL,
  flavour               text NOT NULL CHECK (flavour ~ '^[A-Z]{2}$'),
  hex_code              text NOT NULL CHECK (hex_code ~ '^[0-9A-F]{5}$'),
  lot_type              text NOT NULL CHECK (lot_type IN ('CASE', 'TRAY')),
  pack_size             integer NOT NULL CHECK (pack_size IN (4, 6)),
  pack_sequence         integer,
  lot_code              text NOT NULL REFERENCES codes (code) DEFERRABLE INITIALLY DEFERRED,
  lot_number            integer NOT NULL,
  mfg_date              date,
  expiry_date           date,
  manufacturer_id       text NOT NULL REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  status                text NOT NULL CONSTRAINT codes_status_check CHECK (
                          status IN ('GENERATED', 'PRINTED', 'PACKED', 'IN_TRANSIT', 'AT_CUSTOMS', 'AT_WAREHOUSE', 'AT_SS', 'AT_DB', 'AT_RETAILER',
                    'OPENED', 'QUARANTINED', 'VOID', 'DAMAGED', 'RETURN_IN_TRANSIT', 'RETURNED', 'EXPIRED', 'RECALLED')),
  location_id           text NOT NULL REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  in_transit_to         text REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  dispatched_at         timestamptz,
  print_order_id        text,
  device_id             text,
  quarantine_reason     text,
  status_before_recall  text,
  synced                boolean NOT NULL DEFAULT true,
  generated_at          timestamptz NOT NULL,
  generated_by          text,
  updated_at            timestamptz NOT NULL,
  row_no                bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT code_matches_parts CHECK (
    code = country_code || batch_code || flavour || hex_code
           || CASE WHEN code_type = 'PACK' THEN pack_size::text || pack_sequence::text ELSE '' END),
  CONSTRAINT pack_fields CHECK (
    (code_type = 'LOT' AND pack_sequence IS NULL AND lot_code = code) OR
    (code_type = 'PACK' AND lot_code = left(code, 15)
      AND pack_sequence BETWEEN 1 AND CASE pack_size WHEN 6 THEN 4 ELSE 6 END)),
  CONSTRAINT lot_type_matches_pack_size CHECK ((lot_type = 'CASE') = (pack_size = 6)),
  CONSTRAINT codes_batch_flavour_fkey FOREIGN KEY (batch_code, flavour) REFERENCES batches (batch_code, flavour) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS codes_lot ON codes (lot_code);
CREATE INDEX IF NOT EXISTS codes_batch ON codes (batch_code);
CREATE INDEX IF NOT EXISTS codes_location ON codes (location_id, status);
CREATE INDEX IF NOT EXISTS codes_in_transit_to ON codes (in_transit_to) WHERE in_transit_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_print_order ON codes (print_order_id);

-- ============================================================ code_history
-- Every movement, scan and reprint, with the full code as scanned (never split). Rows are only
-- ever added. A failed scan of an unknown code is kept too, so code has no foreign key.
CREATE TABLE IF NOT EXISTS code_history (
  history_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       text NOT NULL UNIQUE,
  record_type    text NOT NULL CHECK (record_type IN ('MOVEMENT', 'SCAN', 'REPRINT')),
  code           text NOT NULL,
  event          text NOT NULL,
  item_kind      text,
  context        text,
  location_id    text,
  from_id        text,
  to_id          text,
  status_before  text,
  status_after   text,
  invoice_no     text,
  reason         text,
  ok             boolean NOT NULL DEFAULT true,
  result         text NOT NULL DEFAULT 'OK',
  message        text,
  login_id       text,
  device_id      text,
  event_time     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS code_history_code ON code_history (code);
CREATE INDEX IF NOT EXISTS code_history_type_event ON code_history (record_type, event);
CREATE INDEX IF NOT EXISTS code_history_login ON code_history (login_id);
CREATE INDEX IF NOT EXISTS code_history_location ON code_history (location_id);
CREATE INDEX IF NOT EXISTS code_history_time ON code_history (event_time);

-- Rows of code_history can't be changed or deleted (TRUNCATE by the seed/reset is still allowed).
CREATE OR REPLACE FUNCTION code_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'code_history is append-only: rows cannot be changed or deleted';
END
$$;
DROP TRIGGER IF EXISTS code_history_no_change ON code_history;
CREATE TRIGGER code_history_no_change BEFORE UPDATE OR DELETE ON code_history
  FOR EACH ROW EXECUTE FUNCTION code_history_append_only();

-- ============================================================ upgrade from v1 / v2
-- CREATE TABLE IF NOT EXISTS leaves an existing table's checks as they were, so the checks that changed
-- in v2 and v3 are put back here with the current values (on a new database this replaces them with the same).
-- Rows from before the change must be converted first; if any are left this stops and says how.
DO $$
DECLARE
  n_partners bigint;
  n_users    bigint;
  n_codes    bigint;
  n_history  bigint;
BEGIN
  SELECT count(*) INTO n_partners FROM partners WHERE partner_type IN ('SUPPLIER', 'OUTLET') OR partner_id ~ '^(SP|OT)[0-9]';
  SELECT count(*) INTO n_users FROM users WHERE role IN ('SUPPLIER', 'OUTLET') OR login_id ~ '^(SP|OT)[0-9]';
  SELECT count(*) INTO n_codes FROM codes WHERE status IN ('AT_SUPPLIER', 'AT_OUTLET') OR status_before_recall IN ('AT_SUPPLIER', 'AT_OUTLET');
  SELECT count(*) INTO n_history FROM code_history WHERE status_before IN ('AT_SUPPLIER', 'AT_OUTLET') OR status_after IN ('AT_SUPPLIER', 'AT_OUTLET');
  IF n_partners + n_users + n_codes + n_history > 0 THEN
    RAISE EXCEPTION 'This database still has Supplier/Outlet data from before the chain change (% partners, % sign-ins, % codes, % history rows). Run "npm run db:convert-chain" to convert it (Outlets become Retailers, Suppliers are removed), then start again.',
      n_partners, n_users, n_codes, n_history;
  END IF;
END
$$;
ALTER TABLE partners
  DROP CONSTRAINT IF EXISTS partners_partner_type_check,
  DROP CONSTRAINT IF EXISTS partner_id_matches_type,
  ADD CONSTRAINT partners_partner_type_check CHECK (partner_type IN ('MANUFACTURER', 'WAREHOUSE', 'SS', 'DB', 'RETAILER')),
  ADD CONSTRAINT partner_id_matches_type CHECK (
    partner_id ~ '^(MF|VW|SS|DB|RT)[0-9]{4,}$' AND left(partner_id, 2) = CASE partner_type
      WHEN 'MANUFACTURER' THEN 'MF' WHEN 'WAREHOUSE' THEN 'VW' WHEN 'SS' THEN 'SS' WHEN 'DB' THEN 'DB' ELSE 'RT' END);
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_login_id_check,
  DROP CONSTRAINT IF EXISTS users_role_check,
  ADD CONSTRAINT users_login_id_check CHECK (login_id ~ '^(MF|VW|SS|DB|RT|AD|HQ|VF)[0-9]{4,}(-(OP|QC))?$'),
  ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'OPERATOR', 'QC', 'WAREHOUSE', 'SS', 'DB', 'RETAILER', 'TRACE_OWNER', 'VELZA_FIELD'));
ALTER TABLE codes
  DROP CONSTRAINT IF EXISTS codes_status_check,
  ADD CONSTRAINT codes_status_check CHECK (
    status IN ('GENERATED', 'PRINTED', 'PACKED', 'IN_TRANSIT', 'AT_CUSTOMS', 'AT_WAREHOUSE', 'AT_SS', 'AT_DB', 'AT_RETAILER',
                    'OPENED', 'QUARANTINED', 'VOID', 'DAMAGED', 'RETURN_IN_TRANSIT', 'RETURNED', 'EXPIRED', 'RECALLED'));

-- ============================================================ v3: code integrity
-- Every print order records its kind and request fingerprint (idempotent replays must match exactly),
-- reprints record the order that issued the code, a batch's lot counter can never move backwards, and
-- a code issued by a print order can never be deleted or renamed (TRUNCATE by a reset still works).
-- New columns are nullable: orders and reprints made before v3 keep NULL.
ALTER TABLE print_orders
  ADD COLUMN IF NOT EXISTS order_kind text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE print_orders
  DROP CONSTRAINT IF EXISTS print_orders_order_kind_check,
  ADD CONSTRAINT print_orders_order_kind_check CHECK (order_kind IS NULL OR order_kind IN ('NEW_BATCH', 'CONTINUATION'));
ALTER TABLE code_history ADD COLUMN IF NOT EXISTS print_order_id text;

CREATE OR REPLACE FUNCTION batches_counter_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_lot < OLD.next_lot THEN
    RAISE EXCEPTION 'Batch %: the lot counter cannot move backwards (% → %)', OLD.batch_code, OLD.next_lot, NEW.next_lot
      USING ERRCODE = 'VZ001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS batches_counter_forward_only ON batches;
CREATE TRIGGER batches_counter_forward_only BEFORE UPDATE OF next_lot ON batches
  FOR EACH ROW EXECUTE FUNCTION batches_counter_forward_only();

CREATE OR REPLACE FUNCTION codes_issued_protected() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE' OR NEW.code IS DISTINCT FROM OLD.code)
     AND EXISTS (SELECT 1 FROM print_orders WHERE print_order_id = OLD.print_order_id) THEN
    RAISE EXCEPTION 'Code % was issued by print order % and cannot be deleted or renamed', OLD.code, OLD.print_order_id
      USING ERRCODE = 'VZ002';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS codes_issued_protected ON codes;
CREATE TRIGGER codes_issued_protected BEFORE UPDATE OF code OR DELETE ON codes
  FOR EACH ROW EXECUTE FUNCTION codes_issued_protected();

-- ============================================================ v4: plant query indexes
-- A plant's codes, orders and batches (print order list, reprint list); a PC's unsynced rows (device bar counts,
-- Sync); a PC's reserved batch codes (every print order preview and create). Partial indexes stay small: once
-- synced, a row leaves them.
CREATE INDEX IF NOT EXISTS codes_manufacturer ON codes (manufacturer_id, code_type);
CREATE INDEX IF NOT EXISTS codes_device_unsynced ON codes (device_id) WHERE NOT synced;
CREATE INDEX IF NOT EXISTS print_orders_manufacturer ON print_orders (manufacturer_id);
CREATE INDEX IF NOT EXISTS print_orders_device_unsynced ON print_orders (device_id) WHERE NOT synced;
CREATE INDEX IF NOT EXISTS batches_manufacturer ON batches (manufacturer_id);
CREATE INDEX IF NOT EXISTS batches_device_unsynced ON batches (device_id) WHERE NOT synced;
CREATE INDEX IF NOT EXISTS batch_code_pool_device ON batch_code_pool (device_id, status);

-- ============================================================ v7: self sign-up approval
-- SS, DB and Retailer shops sign themselves up. approval: NULL = approved (every older row, every Retailer),
-- PENDING = a self-signed-up SS or DB waiting for Velza Admin, REJECTED = turned down (kept; ID never reused).
-- A rejected SS no longer holds its state, so the one-SS-per-state index leaves it out.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS approval text;
ALTER TABLE partners
  DROP CONSTRAINT IF EXISTS partners_approval_check,
  ADD CONSTRAINT partners_approval_check CHECK (approval IS NULL OR approval IN ('PENDING', 'REJECTED'));
DROP INDEX IF EXISTS partners_one_ss_per_state;
CREATE UNIQUE INDEX partners_one_ss_per_state ON partners (state) WHERE partner_type = 'SS' AND approval IS DISTINCT FROM 'REJECTED';

-- ============================================================ v8: customs clearance
-- Stock received at Customs is held (AT_CUSTOMS, in the codes check above) until its container is cleared;
-- a container gains CLEARED with who/when and the Bill of Entry. Only containers still loading or on the road
-- hold their number, so a cleared container's number can be used again.
ALTER TABLE containers ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS cleared_by text;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS bill_of_entry text;
ALTER TABLE containers
  DROP CONSTRAINT IF EXISTS containers_status_check,
  ADD CONSTRAINT containers_status_check CHECK (status IN ('LOADING', 'IN_TRANSIT', 'RECEIVED', 'CLEARED'));
DROP INDEX IF EXISTS containers_one_active_per_code;
CREATE UNIQUE INDEX containers_one_active_per_code ON containers (container_code) WHERE status IN ('LOADING', 'IN_TRANSIT');
CREATE INDEX IF NOT EXISTS containers_by_receiver ON containers (to_partner_id);

-- ============================================================ v9: live read model + read-path indexes
-- Read paths that must not grow with the whole ledger: the HQ scan log (newest scans), Customs receiving one case
-- (which container carried it), and NOT_RECEIVED (units in transit, oldest first).
CREATE INDEX IF NOT EXISTS code_history_scans_recent ON code_history (event_time DESC) WHERE record_type = 'SCAN';
CREATE INDEX IF NOT EXISTS containers_lot_codes ON containers USING gin (lot_codes);
CREATE INDEX IF NOT EXISTS codes_in_transit_since ON codes (dispatched_at) WHERE status = 'IN_TRANSIT';

-- Live stock counts. Every change to codes appends signed counts to stock_deltas (inserts only, so concurrent scans
-- never wait for each other or conflict); stock_summary_rollup() folds them into stock_summary. stock_current is
-- always exact: summary + deltas not yet folded in. A pack carries its lot's sync flag (lots.update keeps them equal).
CREATE TABLE IF NOT EXISTS stock_summary (
  location_id  text    NOT NULL,
  status       text    NOT NULL,
  code_type    text    NOT NULL,
  lot_type     text    NOT NULL,
  flavour      text    NOT NULL,
  synced       boolean NOT NULL,
  units        bigint  NOT NULL,
  PRIMARY KEY (location_id, status, code_type, lot_type, flavour, synced)
);
CREATE TABLE IF NOT EXISTS stock_deltas (
  delta_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location_id  text    NOT NULL,
  status       text    NOT NULL,
  code_type    text    NOT NULL,
  lot_type     text    NOT NULL,
  flavour      text    NOT NULL,
  synced       boolean NOT NULL,
  units        bigint  NOT NULL
);
CREATE OR REPLACE VIEW stock_current AS
  SELECT location_id, status, code_type, lot_type, flavour, synced, sum(units)::bigint AS units
    FROM (SELECT location_id, status, code_type, lot_type, flavour, synced, units FROM stock_summary
          UNION ALL
          SELECT location_id, status, code_type, lot_type, flavour, synced, units FROM stock_deltas) AS s
   GROUP BY location_id, status, code_type, lot_type, flavour, synced
  HAVING sum(units) <> 0;

CREATE OR REPLACE FUNCTION stock_on_codes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, count(*)
    FROM stock_new GROUP BY location_id, status, code_type, lot_type, flavour, synced;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION stock_on_codes_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, -count(*)
    FROM stock_old GROUP BY location_id, status, code_type, lot_type, flavour, synced;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION stock_on_codes_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only keys that actually changed get a row (a dispatch moves units; an updated_at change moves nothing).
  INSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, sum(d)
    FROM (SELECT location_id, status, code_type, lot_type, flavour, synced, -1 AS d FROM stock_old
          UNION ALL
          SELECT location_id, status, code_type, lot_type, flavour, synced, 1 FROM stock_new) AS c
   GROUP BY location_id, status, code_type, lot_type, flavour, synced
  HAVING sum(d) <> 0;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION stock_on_codes_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE stock_summary, stock_deltas;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS stock_codes_insert ON codes;
CREATE TRIGGER stock_codes_insert AFTER INSERT ON codes REFERENCING NEW TABLE AS stock_new
  FOR EACH STATEMENT EXECUTE FUNCTION stock_on_codes_insert();
DROP TRIGGER IF EXISTS stock_codes_delete ON codes;
CREATE TRIGGER stock_codes_delete AFTER DELETE ON codes REFERENCING OLD TABLE AS stock_old
  FOR EACH STATEMENT EXECUTE FUNCTION stock_on_codes_delete();
DROP TRIGGER IF EXISTS stock_codes_update ON codes;
CREATE TRIGGER stock_codes_update AFTER UPDATE ON codes REFERENCING OLD TABLE AS stock_old NEW TABLE AS stock_new
  FOR EACH STATEMENT EXECUTE FUNCTION stock_on_codes_update();
DROP TRIGGER IF EXISTS stock_codes_truncate ON codes;
CREATE TRIGGER stock_codes_truncate AFTER TRUNCATE ON codes
  FOR EACH STATEMENT EXECUTE FUNCTION stock_on_codes_truncate();

-- Fold the deltas into the summary (any time is safe). Returns the delta rows folded in. Never waits: if another
-- rollup or a rebuild holds the lock it returns 0 at once (the app calls this by itself now and then, from every
-- instance, next to the jobs container's schedule; `npm run db:stock -- rollup` retries).
CREATE OR REPLACE FUNCTION stock_summary_rollup() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  folded bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('velza_stock_summary')) THEN
    RETURN 0;
  END IF;
  WITH moved AS (DELETE FROM stock_deltas RETURNING location_id, status, code_type, lot_type, flavour, synced, units),
       counted AS (SELECT count(*) AS n FROM moved),
       merged AS (
         INSERT INTO stock_summary AS s (location_id, status, code_type, lot_type, flavour, synced, units)
         SELECT location_id, status, code_type, lot_type, flavour, synced, sum(units)
           FROM moved GROUP BY location_id, status, code_type, lot_type, flavour, synced
         ON CONFLICT (location_id, status, code_type, lot_type, flavour, synced) DO UPDATE SET units = s.units + EXCLUDED.units
         RETURNING 1)
  SELECT n INTO folded FROM counted, (SELECT count(*) FROM merged) AS m;
  DELETE FROM stock_summary WHERE units = 0;
  RETURN folded;
END
$$;
-- Recount the summary from codes (recovery, or after a bulk change made with triggers off). Writes to codes wait
-- until it finishes; at 2 crore codes expect seconds, so run it outside shift peaks.
CREATE OR REPLACE FUNCTION stock_summary_rebuild() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('velza_stock_summary'));
  LOCK TABLE codes IN SHARE MODE;
  DELETE FROM stock_deltas;
  DELETE FROM stock_summary;
  INSERT INTO stock_summary (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, count(*)
    FROM codes GROUP BY location_id, status, code_type, lot_type, flavour, synced;
END
$$;
-- A database upgraded to v9 already holds codes: count them once (a new or empty database gets nothing to count).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_summary) AND NOT EXISTS (SELECT 1 FROM stock_deltas) AND EXISTS (SELECT 1 FROM codes) THEN
    PERFORM stock_summary_rebuild();
  END IF;
END
$$;

-- ============================================================ v10: integrity
-- Links the app always kept, now checked by the database too, and what each container carried as rows.
-- Foreign keys are DEFERRABLE INITIALLY DEFERRED (rows of one transaction are written in different orders) and added
-- NOT VALID first, so existing rows are checked once below, after a check for orphans that names what is wrong.
-- code_history keeps no foreign keys on purpose: a failed scan of an unknown code is kept too.
--
-- container_items: one row per case/tray loaded into a container (containers.lot_codes as rows), kept equal to
-- lot_codes by the app on every container write. No UNIQUE (lot_code): a lot in more than one container over its
-- life is allowed (see latestContainerWithLot, which picks the most recently dispatched one).
CREATE TABLE IF NOT EXISTS container_items (
  container_id text        NOT NULL REFERENCES containers (container_id) DEFERRABLE INITIALLY DEFERRED,
  lot_code     text        NOT NULL REFERENCES codes (code)              DEFERRABLE INITIALLY DEFERRED,
  loaded_at    timestamptz NOT NULL,
  loaded_by    text        REFERENCES users (login_id)                   DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (container_id, lot_code)
);
CREATE INDEX IF NOT EXISTS container_items_lot ON container_items (lot_code);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_orders_manufacturer_id_fkey' AND conrelid = 'print_orders'::regclass) THEN
    ALTER TABLE print_orders ADD CONSTRAINT print_orders_manufacturer_id_fkey
      FOREIGN KEY (manufacturer_id) REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'containers_manufacturer_id_fkey' AND conrelid = 'containers'::regclass) THEN
    ALTER TABLE containers ADD CONSTRAINT containers_manufacturer_id_fkey
      FOREIGN KEY (manufacturer_id) REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'containers_to_partner_id_fkey' AND conrelid = 'containers'::regclass) THEN
    ALTER TABLE containers ADD CONSTRAINT containers_to_partner_id_fkey
      FOREIGN KEY (to_partner_id) REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codes_print_order_id_fkey' AND conrelid = 'codes'::regclass) THEN
    ALTER TABLE codes ADD CONSTRAINT codes_print_order_id_fkey
      FOREIGN KEY (print_order_id) REFERENCES print_orders (print_order_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_code_pool_device_id_fkey' AND conrelid = 'batch_code_pool'::regclass) THEN
    ALTER TABLE batch_code_pool ADD CONSTRAINT batch_code_pool_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES devices (device_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
END
$$;

-- Rows pointing at rows that don't exist stop the upgrade here, named, before anything is validated or copied.
-- Nothing is deleted or changed to make it pass: fix or remove those rows, then start again.
DO $$
DECLARE
  n_orders     bigint;
  n_from       bigint;
  n_to         bigint;
  n_codes      bigint;
  n_pool       bigint;
  n_carried    bigint;
BEGIN
  SELECT count(*) INTO n_orders FROM print_orders o WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.partner_id = o.manufacturer_id);
  SELECT count(*) INTO n_from FROM containers c WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.partner_id = c.manufacturer_id);
  SELECT count(*) INTO n_to FROM containers c
   WHERE c.to_partner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.partner_id = c.to_partner_id);
  SELECT count(*) INTO n_codes FROM codes c
   WHERE c.print_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM print_orders o WHERE o.print_order_id = c.print_order_id);
  SELECT count(*) INTO n_pool FROM batch_code_pool b WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.device_id = b.device_id);
  SELECT count(*) INTO n_carried FROM containers c CROSS JOIN LATERAL unnest(c.lot_codes) AS l(lot_code)
   WHERE NOT EXISTS (SELECT 1 FROM codes k WHERE k.code = l.lot_code);
  IF n_orders + n_from + n_to + n_codes + n_pool + n_carried > 0 THEN
    RAISE EXCEPTION 'Schema v10 found rows that point at rows which do not exist: print_orders with an unknown manufacturer_id: %; containers with an unknown manufacturer_id: %; containers with an unknown to_partner_id: %; codes with an unknown print_order_id: %; batch_code_pool rows with an unknown device_id: %; containers.lot_codes entries that are not codes: %. Nothing was changed. Fix or remove those rows, then start again.',
      n_orders, n_from, n_to, n_codes, n_pool, n_carried;
  END IF;
END
$$;

-- What each container carried, copied once from containers.lot_codes when a database first reaches v10 (the app keeps
-- both equal afterwards). Loaded when the container was opened, by whoever opened it (if that sign-in still exists).
DO $$
BEGIN
  IF COALESCE((SELECT version FROM schema_info WHERE id = 1), 0) < 10 THEN
    INSERT INTO container_items (container_id, lot_code, loaded_at, loaded_by)
    SELECT c.container_id, l.lot_code, c.created_at, u.login_id
      FROM containers c
     CROSS JOIN LATERAL unnest(c.lot_codes) AS l(lot_code)
      LEFT JOIN users u ON u.login_id = c.created_by
    ON CONFLICT (container_id, lot_code) DO NOTHING;
  END IF;
END
$$;

-- Check the existing rows (nothing happens for a constraint that is already valid).
ALTER TABLE print_orders VALIDATE CONSTRAINT print_orders_manufacturer_id_fkey;
ALTER TABLE containers VALIDATE CONSTRAINT containers_manufacturer_id_fkey;
ALTER TABLE containers VALIDATE CONSTRAINT containers_to_partner_id_fkey;
ALTER TABLE codes VALIDATE CONSTRAINT codes_print_order_id_fkey;
ALTER TABLE batch_code_pool VALIDATE CONSTRAINT batch_code_pool_device_id_fkey;

INSERT INTO schema_info (id, version) VALUES (1, 10)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();
