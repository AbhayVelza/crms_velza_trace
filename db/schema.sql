-- Velza Traceability — PostgreSQL schema v11.
-- Generated from src/lib/store/sql/schema.ts by `npm run db:schema`; do not edit by hand.
-- The app applies this itself on first use (and `npm run db:migrate` does it on demand); every
-- statement is safe to run again.
-- By hand, run it only on a new or quiet database (as the owner, in one transaction: psql -1 -f db/schema.sql). It
-- re-creates the triggers on codes and code_history, so on a database in use it waits for scans and holds new ones for
-- up to its 10 s lock timeout. A database already at this version needs nothing (`npm run db:migrate` leaves it alone).

-- The schema runs as one transaction. If a table it must change is busy (a long report holds it), give up after
-- 10 s instead of making every scan queue behind the waiting change; nothing is changed and it can simply be run again.
SELECT set_config('lock_timeout', '10s', true);

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
-- (codes above and code_history here are the v10 shapes; the v11 section at the end turns them into partitioned tables.)
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
-- History indexes are made in the v11 section (v10's (record_type, event) and (event_time) indexes are gone in v11:
-- making them here would rebuild them over the whole history whenever the schema is run again).

-- Rows of code_history can't be changed or deleted (TRUNCATE by the seed/reset is still allowed). The trigger itself is
-- created in the v11 section, on the partitioned table.
CREATE OR REPLACE FUNCTION code_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'code_history is append-only: rows cannot be changed or deleted';
END
$$;

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
  -- Only a v1 database can hold these values; don't read every code and history row again on a newer one.
  IF COALESCE((SELECT version FROM schema_info WHERE id = 1), 0) >= 2 THEN
    RETURN;
  END IF;
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
-- (Its trigger on codes is created in the v11 section, on the partitioned table.)

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
-- v11: the scan-log index is made on the partitioned history (v11 section); "which container carried this lot" reads
-- container_items (v10), so v9's GIN index on containers.lot_codes is dropped there.
CREATE INDEX IF NOT EXISTS codes_in_transit_since ON codes (dispatched_at) WHERE status = 'IN_TRANSIT';

-- Live stock counts. Every change to codes appends signed counts to stock_deltas (inserts only, so concurrent scans
-- never wait for each other or conflict); stock_summary_rollup() folds them into stock_summary. stock_current is
-- always exact: summary + deltas not yet folded in. A pack carries its lot's sync flag (lots.update keeps them equal).
-- v11 (Option C, decision Q7): every row counts by its EFFECTIVE state. A pack that follows its sealed lot (status NULL)
-- counts under the lot's state; a pack with its own state (opened lot, or damaged/recalled inside a sealed one) counts
-- under its own state only, never again with its lot. So pack totals are the PACK rows of the summary, as in v10: no
-- "lots × 4/6" arithmetic. View stock_recount (v11 section) is the same count straight from codes.
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

-- Only keys that actually changed get a row (a dispatch moves units; an updated_at change moves nothing). Moving a
-- sealed tray moves its following packs with it; a pack taking its own state moves from the tray's key to its own.
CREATE OR REPLACE FUNCTION stock_on_codes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH o AS (SELECT code, code_type, lot_code, status, location_id, lot_type, flavour, synced FROM (SELECT * FROM stock_new LIMIT 0) s),
       n AS (SELECT code, code_type, lot_code, status, location_id, lot_type, flavour, synced FROM stock_new),
       lots AS (SELECT lot_code FROM o UNION SELECT lot_code FROM n),
       a AS (SELECT c.code, c.code_type, c.lot_code, c.status, c.location_id, c.lot_type, c.flavour, c.synced
               FROM lots CROSS JOIN LATERAL (SELECT * FROM codes k WHERE k.lot_code = lots.lot_code) c),
       b AS (SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.code = a.code)
             UNION ALL
             SELECT * FROM o)
  INSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, sum(d)
    FROM (SELECT location_id, status, code_type, lot_type, flavour, synced, 1 AS d FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM a WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM a x JOIN a l ON l.code = x.lot_code
     WHERE x.status IS NULL) ea
          UNION ALL
          SELECT location_id, status, code_type, lot_type, flavour, synced, -1 FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM b WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM b x JOIN b l ON l.code = x.lot_code
     WHERE x.status IS NULL) eb) e
   GROUP BY location_id, status, code_type, lot_type, flavour, synced
  HAVING sum(d) <> 0;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION stock_on_codes_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH o AS (SELECT code, code_type, lot_code, status, location_id, lot_type, flavour, synced FROM stock_old),
       n AS (SELECT code, code_type, lot_code, status, location_id, lot_type, flavour, synced FROM (SELECT * FROM stock_old LIMIT 0) s),
       lots AS (SELECT lot_code FROM o UNION SELECT lot_code FROM n),
       a AS (SELECT c.code, c.code_type, c.lot_code, c.status, c.location_id, c.lot_type, c.flavour, c.synced
               FROM lots CROSS JOIN LATERAL (SELECT * FROM codes k WHERE k.lot_code = lots.lot_code) c),
       b AS (SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.code = a.code)
             UNION ALL
             SELECT * FROM o)
  INSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, sum(d)
    FROM (SELECT location_id, status, code_type, lot_type, flavour, synced, 1 AS d FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM a WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM a x JOIN a l ON l.code = x.lot_code
     WHERE x.status IS NULL) ea
          UNION ALL
          SELECT location_id, status, code_type, lot_type, flavour, synced, -1 FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM b WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM b x JOIN b l ON l.code = x.lot_code
     WHERE x.status IS NULL) eb) e
   GROUP BY location_id, status, code_type, lot_type, flavour, synced
  HAVING sum(d) <> 0;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION stock_on_codes_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH o AS (SELECT code, code_type, lot_code, status, location_id, lot_type, flavour, synced FROM stock_old),
       n AS (SELECT code, code_type, lot_code, status, location_id, lot_type, flavour, synced FROM stock_new),
       lots AS (SELECT lot_code FROM o UNION SELECT lot_code FROM n),
       a AS (SELECT c.code, c.code_type, c.lot_code, c.status, c.location_id, c.lot_type, c.flavour, c.synced
               FROM lots CROSS JOIN LATERAL (SELECT * FROM codes k WHERE k.lot_code = lots.lot_code) c),
       b AS (SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.code = a.code)
             UNION ALL
             SELECT * FROM o)
  INSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, sum(d)
    FROM (SELECT location_id, status, code_type, lot_type, flavour, synced, 1 AS d FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM a WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM a x JOIN a l ON l.code = x.lot_code
     WHERE x.status IS NULL) ea
          UNION ALL
          SELECT location_id, status, code_type, lot_type, flavour, synced, -1 FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM b WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM b x JOIN b l ON l.code = x.lot_code
     WHERE x.status IS NULL) eb) e
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
-- (The stock triggers on codes are created in the v11 section, on the partitioned table.)

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
-- until it finishes (it locks codes in SHARE mode): at full volume that is minutes, so run it only in a maintenance
-- window (`npm run db:stock -- rebuild` lifts its own statement time limit).
CREATE OR REPLACE FUNCTION stock_summary_rebuild() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('velza_stock_summary'));
  LOCK TABLE codes IN SHARE MODE;
  DELETE FROM stock_deltas;
  DELETE FROM stock_summary;
  INSERT INTO stock_summary (location_id, status, code_type, lot_type, flavour, synced, units)
  SELECT location_id, status, code_type, lot_type, flavour, synced, count(*)
    FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM codes WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM codes x JOIN codes l ON l.code = x.lot_code
     WHERE x.status IS NULL) e
   GROUP BY location_id, status, code_type, lot_type, flavour, synced;
END
$$;
-- A database upgraded to v9 already holds codes: count them once (a new or empty database gets nothing to count).
-- (A v10 database moving to v11 is recounted in the v11 section, after its packs follow their lots.)
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
-- lot_codes by the triggers below on every container write, whoever writes it. No UNIQUE (lot_code): a lot in more than one container over its
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
  -- From v10 on the keys are checked by the database itself: nothing to look for (and no need to read every row again).
  IF COALESCE((SELECT version FROM schema_info WHERE id = 1), 0) >= 10 THEN
    RETURN;
  END IF;
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

-- What each container carried, copied once from containers.lot_codes when a database first reaches v10 (the triggers
-- below keep both equal afterwards). Loaded when the container was opened, by whoever opened it (if that sign-in still exists).
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

-- container_items follows containers.lot_codes in the database itself, so any writer (this release, a rolled-back v9
-- release that has never heard of container_items, a hand-written fix) keeps it right. After a container is created or
-- its lot_codes change: items whose lot is no longer in lot_codes go, missing ones are added (loaded when the container
-- was opened if it is new, else now), loaded by whoever opened the container if that sign-in exists. Idempotent.
CREATE OR REPLACE FUNCTION container_items_follow_lot_codes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM container_items i
   WHERE i.container_id = NEW.container_id AND NOT (i.lot_code = ANY (NEW.lot_codes));
  INSERT INTO container_items (container_id, lot_code, loaded_at, loaded_by)
  SELECT NEW.container_id, l.lot_code,
         CASE WHEN TG_OP = 'INSERT' THEN NEW.created_at ELSE now() END,
         (SELECT u.login_id FROM users u WHERE u.login_id = NEW.created_by)
    FROM unnest(NEW.lot_codes) AS l(lot_code)
   WHERE l.lot_code IS NOT NULL
  ON CONFLICT (container_id, lot_code) DO NOTHING;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS container_items_follow ON containers;
CREATE TRIGGER container_items_follow AFTER INSERT OR UPDATE OF lot_codes ON containers
  FOR EACH ROW EXECUTE FUNCTION container_items_follow_lot_codes();

-- A container deleted takes its items with it (the foreign key from container_items would refuse it otherwise).
CREATE OR REPLACE FUNCTION container_items_on_container_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM container_items WHERE container_id = OLD.container_id;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS container_items_delete ON containers;
CREATE TRIGGER container_items_delete BEFORE DELETE ON containers
  FOR EACH ROW EXECUTE FUNCTION container_items_on_container_delete();


-- ============================================================ v11: Option C, partitions, damage photos
-- A new database and an older one take the same path here: the plain codes / code_history tables made above are moved
-- aside, the partitioned v11 tables are created, the rows are copied over (none on a new database) and the old tables
-- dropped. So an upgraded database ends with exactly the schema of a fresh install. Every step checks whether it is
-- still needed, so running this again on a v11 database changes nothing.

-- (a) Move the plain tables aside, with their indexes and identity sequences (the new tables need those names).
DO $$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['codes', 'code_history'] LOOP
    IF (SELECT relkind FROM pg_class WHERE oid = to_regclass(t)) = 'r' THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', t, t || '_v10');
      FOR r IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass(t || '_v10') LOOP
        EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, r.relname || '_v10');
      END LOOP;
      FOR r IN SELECT s.relname FROM pg_depend d JOIN pg_class s ON s.oid = d.objid
                WHERE d.refobjid = to_regclass(t || '_v10') AND d.classid = 'pg_class'::regclass AND s.relkind = 'S' LOOP
        EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', r.relname, r.relname || '_v10');
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- (b) codes, Option C. One row per sticker as before. State columns (status, location_id, in_transit_to, dispatched_at,
-- status_before_recall):
--   LOT row                      always has its own state;
--   PACK row, lot still sealed   all five NULL = "same as my lot" (read through view code_state);
--   PACK row, lot opened         its own state, copied once from the lot when it was opened, then moves alone.
-- Moving a sealed tray rewrites 1 row instead of 7 (a case: 1 instead of 5).
-- HASH-partitioned into 16 parts (codes_p00 … codes_p15), fixed for the life of the table: a lookup by code touches one
-- part; vacuum, index rebuilds and repairs work on 1/16 of the table. fillfactor 90 keeps a lot's frequent updates cheap.
-- Foreign keys are added after the copy below (one check of all rows instead of one per row).
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
  lot_code              text NOT NULL,
  lot_number            integer NOT NULL,
  mfg_date              date,
  expiry_date           date,
  manufacturer_id       text NOT NULL,
  status                text CONSTRAINT codes_status_check CHECK (
                          status IN ('GENERATED', 'PRINTED', 'PACKED', 'IN_TRANSIT', 'AT_CUSTOMS', 'AT_WAREHOUSE', 'AT_SS', 'AT_DB', 'AT_RETAILER',
                    'OPENED', 'QUARANTINED', 'VOID', 'DAMAGED', 'RETURN_IN_TRANSIT', 'RETURNED', 'EXPIRED', 'RECALLED')),
  location_id           text,
  in_transit_to         text,
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
  CONSTRAINT codes_lot_has_state CHECK (code_type = 'PACK' OR (status IS NOT NULL AND location_id IS NOT NULL)),
  CONSTRAINT codes_pack_state_all_or_nothing CHECK (
    code_type = 'LOT'
    OR (status IS NULL AND location_id IS NULL AND in_transit_to IS NULL AND dispatched_at IS NULL AND status_before_recall IS NULL)
    OR (status IS NOT NULL AND location_id IS NOT NULL))
) PARTITION BY HASH (code);
DO $$
BEGIN
  FOR i IN 0..15 LOOP
    IF to_regclass(format('codes_p%s', lpad(i::text, 2, '0'))) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF codes FOR VALUES WITH (MODULUS 16, REMAINDER %s)
                        WITH (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)',
                     'codes_p' || lpad(i::text, 2, '0'), i);
    END IF;
  END LOOP;
END
$$;
-- Packs of a lot (also how a sealed lot's inheriting packs are found).
CREATE INDEX IF NOT EXISTS codes_lot ON codes (lot_code);
CREATE INDEX IF NOT EXISTS codes_batch ON codes (batch_code);
-- State indexes leave inheriting packs out (location_id / status NULL), so they hold lots and loose packs only. Any
-- query with "location_id = $1" can use codes_location (the equality proves location_id IS NOT NULL).
CREATE INDEX IF NOT EXISTS codes_location ON codes (location_id, status) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_in_transit_to ON codes (in_transit_to) WHERE in_transit_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS codes_in_transit_since ON codes (dispatched_at) WHERE status = 'IN_TRANSIT';
CREATE INDEX IF NOT EXISTS codes_print_order ON codes (print_order_id);
CREATE INDEX IF NOT EXISTS codes_manufacturer ON codes (manufacturer_id, code_type);
CREATE INDEX IF NOT EXISTS codes_device_unsynced ON codes (device_id) WHERE NOT synced;
-- Rare states listed across all partners (dashboard, Damaged list: "status = 'DAMAGED'", "status = 'RECALLED' AND
-- status_before_recall = 'DAMAGED'", opened / recalled lots). Serves both halves of the packs repo's state filter: the
-- lots (whose following packs are then found by codes_lot) and the packs with a state of their own. Following packs
-- (status NULL) and the common states are not in it, so it stays small. code_type and status_before_recall in the key
-- keep a big batch recall from being read whole when only its lots, or only its once-damaged codes, are wanted.
CREATE INDEX IF NOT EXISTS codes_rare_status ON codes (status, code_type, status_before_recall)
  WHERE status IN ('DAMAGED', 'RECALLED', 'OPENED', 'QUARANTINED');

-- Effective state of every barcode: a lot (and an opened lot's pack) reads its own row, a sealed pack its lot's.
-- [13] Views are dropped and created (CREATE OR REPLACE VIEW fails when a view's columns change).
DROP VIEW IF EXISTS code_state;
CREATE VIEW code_state AS
SELECT c.code, c.code_type, c.lot_code, c.batch_code, c.flavour, c.lot_type, c.manufacturer_id,
       CASE WHEN c.status IS NULL THEN t.status               ELSE c.status               END AS status,
       CASE WHEN c.status IS NULL THEN t.location_id          ELSE c.location_id          END AS location_id,
       CASE WHEN c.status IS NULL THEN t.in_transit_to        ELSE c.in_transit_to        END AS in_transit_to,
       CASE WHEN c.status IS NULL THEN t.dispatched_at        ELSE c.dispatched_at        END AS dispatched_at,
       CASE WHEN c.status IS NULL THEN t.status_before_recall ELSE c.status_before_recall END AS status_before_recall,
       (c.status IS NULL) AS inherits
  FROM codes c
  JOIN codes t ON t.code = c.lot_code;

-- Copy the v10 rows. A pack whose lot is still sealed AND whose state equals its lot's gets NULL state (it follows its
-- lot). Packs of opened lots, and [5] any pack whose state differs from its sealed lot's, keep their own state (db_health
-- counts the second kind: decision Q7). Stops, changing nothing, unless every barcode's effective state is unchanged.
DO $$
DECLARE
  n_old bigint;
  n_new bigint;
  n_inherit bigint;
  r record;
BEGIN
  IF to_regclass('codes_v10') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO codes (code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, pack_sequence, lot_code,
         lot_number, mfg_date, expiry_date, manufacturer_id, status, location_id, in_transit_to, dispatched_at,
         print_order_id, device_id, quarantine_reason, status_before_recall, synced, generated_at, generated_by,
         updated_at, row_no) OVERRIDING SYSTEM VALUE
  SELECT c.code, c.code_type, c.country_code, c.batch_code, c.flavour, c.hex_code, c.lot_type, c.pack_size, c.pack_sequence, c.lot_code,
         c.lot_number, c.mfg_date, c.expiry_date, c.manufacturer_id,
         CASE WHEN x.inherit THEN NULL ELSE c.status END,
         CASE WHEN x.inherit THEN NULL ELSE c.location_id END,
         CASE WHEN x.inherit THEN NULL ELSE c.in_transit_to END,
         CASE WHEN x.inherit THEN NULL ELSE c.dispatched_at END,
         c.print_order_id, c.device_id, c.quarantine_reason,
         CASE WHEN x.inherit THEN NULL ELSE c.status_before_recall END,
         c.synced, c.generated_at, c.generated_by, c.updated_at, c.row_no
    FROM codes_v10 c
    LEFT JOIN codes_v10 l ON l.code = c.lot_code AND l.code_type = 'LOT'
   CROSS JOIN LATERAL (SELECT COALESCE(
           c.code_type = 'PACK' AND l.code IS NOT NULL AND NOT (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall IS NOT DISTINCT FROM 'OPENED'))
           AND (c.status, c.location_id, c.in_transit_to, c.dispatched_at, c.status_before_recall)
               IS NOT DISTINCT FROM (l.status, l.location_id, l.in_transit_to, l.dispatched_at, l.status_before_recall),
           false) AS inherit) x;
  GET DIAGNOSTICS n_new = ROW_COUNT;
  SELECT count(*) INTO n_old FROM codes_v10;
  IF n_new <> n_old THEN
    RAISE EXCEPTION 'Schema v11: copied % of % codes. Nothing was changed.', n_new, n_old;
  END IF;
  IF EXISTS (SELECT 1 FROM code_state s JOIN codes_v10 o ON o.code = s.code
              WHERE (s.status, s.location_id, s.in_transit_to, s.dispatched_at, s.status_before_recall)
                    IS DISTINCT FROM (o.status, o.location_id, o.in_transit_to, o.dispatched_at, o.status_before_recall)) THEN
    RAISE EXCEPTION 'Schema v11: a code would change state when its packs follow their lot. Nothing was changed.';
  END IF;
  SELECT count(*) INTO n_inherit FROM codes WHERE status IS NULL;
  PERFORM setval(pg_get_serial_sequence('codes', 'row_no'), COALESCE((SELECT max(row_no) FROM codes), 0) + 1, false);
  -- Foreign keys from other tables to the old codes (container_items) are added again below, to the new table.
  FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
            WHERE confrelid = 'codes_v10'::regclass AND conrelid <> 'codes_v10'::regclass LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
  DROP TABLE codes_v10;
  -- The live stock summary now counts lots and loose packs (sealed packs through their lot).
  PERFORM stock_summary_rebuild();
  IF n_new > 0 THEN
    RAISE NOTICE 'Schema v11: % codes copied; % packs now follow their sealed case/tray.', n_new, n_inherit;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'codes'::regclass AND conname = 'codes_lot_code_fkey') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_lot_code_fkey
      FOREIGN KEY (lot_code) REFERENCES codes (code) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'codes'::regclass AND conname = 'codes_manufacturer_id_fkey') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_manufacturer_id_fkey
      FOREIGN KEY (manufacturer_id) REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'codes'::regclass AND conname = 'codes_location_id_fkey') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'codes'::regclass AND conname = 'codes_in_transit_to_fkey') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_in_transit_to_fkey
      FOREIGN KEY (in_transit_to) REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'codes'::regclass AND conname = 'codes_print_order_id_fkey') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_print_order_id_fkey
      FOREIGN KEY (print_order_id) REFERENCES print_orders (print_order_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'codes'::regclass AND conname = 'codes_batch_flavour_fkey') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_batch_flavour_fkey
      FOREIGN KEY (batch_code, flavour) REFERENCES batches (batch_code, flavour) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'container_items'::regclass AND conname = 'container_items_lot_code_fkey') THEN
    ALTER TABLE container_items ADD CONSTRAINT container_items_lot_code_fkey
      FOREIGN KEY (lot_code) REFERENCES codes (code) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- Triggers on codes (v3 integrity, v9 live stock, v11 Option C).
DROP TRIGGER IF EXISTS codes_issued_protected ON codes;
CREATE TRIGGER codes_issued_protected BEFORE UPDATE OF code OR DELETE ON codes
  FOR EACH ROW EXECUTE FUNCTION codes_issued_protected();
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

-- [4] An opened lot (or one recalled after it was opened) must not have inheriting packs: they would report the lot's
-- own status (OPENED) as theirs. Checked at commit, so the app may give the packs their state and open the lot in any
-- order within one transaction. Fires only when a lot becomes opened/recalled or a pack's state is cleared, never on an
-- ordinary move (a sealed tray's dispatch, a loose pack's receive).
CREATE OR REPLACE FUNCTION codes_opened_lot_packs_have_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM codes l WHERE l.code = NEW.lot_code AND l.code_type = 'LOT' AND (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall IS NOT DISTINCT FROM 'OPENED')))
     AND EXISTS (SELECT 1 FROM codes p WHERE p.lot_code = NEW.lot_code AND p.code_type = 'PACK' AND p.status IS NULL) THEN
    RAISE EXCEPTION 'Lot % is opened but some of its packs have no state of their own: when a case/tray is opened, each of its packs takes the lot''s state first', NEW.lot_code
      USING ERRCODE = 'VZ003';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS codes_opened_lot_packs_have_state ON codes;
CREATE CONSTRAINT TRIGGER codes_opened_lot_packs_have_state AFTER INSERT OR UPDATE OF status, status_before_recall ON codes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.code_type = 'LOT' AND (NEW.status = 'OPENED' OR (NEW.status = 'RECALLED' AND NEW.status_before_recall = 'OPENED')))
  EXECUTE FUNCTION codes_opened_lot_packs_have_state();
DROP TRIGGER IF EXISTS codes_pack_state_cleared ON codes;
CREATE CONSTRAINT TRIGGER codes_pack_state_cleared AFTER UPDATE OF status ON codes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.code_type = 'PACK' AND NEW.status IS NULL AND OLD.status IS NOT NULL)
  EXECUTE FUNCTION codes_opened_lot_packs_have_state();
-- A pack inserted without state of its own under a lot that is already opened (an import, a hand-written fix) would also
-- report the lot's OPENED as its status. Checked per INSERT statement over the new rows (one lookup of each new
-- following pack's lot by its key), not per row at commit, so a print order inserting thousands of packs stays cheap.
-- (A lot inserted or opened after its packs, in the same transaction, is checked by the trigger above.)
CREATE OR REPLACE FUNCTION codes_new_packs_under_opened_lot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad text;
BEGIN
  SELECT n.lot_code INTO bad
    FROM new_codes n
   CROSS JOIN LATERAL (SELECT 1 FROM codes l WHERE l.code = n.lot_code AND l.code_type = 'LOT' AND (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall IS NOT DISTINCT FROM 'OPENED'))) o
   WHERE n.code_type = 'PACK' AND n.status IS NULL
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Lot % is opened: a pack added to it needs a state of its own', bad USING ERRCODE = 'VZ003';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS codes_new_packs_under_opened_lot ON codes;
CREATE TRIGGER codes_new_packs_under_opened_lot AFTER INSERT ON codes REFERENCING NEW TABLE AS new_codes
  FOR EACH STATEMENT EXECUTE FUNCTION codes_new_packs_under_opened_lot();

-- (c) damage reports and their photos. A report is the DAMAGED movement of a code: report_id = that movement's event_id
-- (no foreign key: history is partitioned; the app writes both in one transaction). Photos live in an object store
-- (S3, or the disk for dev and the pilot); the database keeps the key, type, size and SHA-256 of each file.
CREATE TABLE IF NOT EXISTS damage_reports (
  report_id       uuid        PRIMARY KEY,
  code            text        NOT NULL REFERENCES codes (code) DEFERRABLE INITIALLY DEFERRED,
  item_kind       text        NOT NULL CHECK (item_kind IN ('LOT', 'PACK')),
  partner_id      text        NOT NULL REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  reason          text        NOT NULL CHECK (length(btrim(reason)) > 0),
  packs_affected  integer     NOT NULL CHECK (packs_affected > 0),
  reported_by     text        REFERENCES users (login_id) DEFERRABLE INITIALLY DEFERRED,
  reported_at     timestamptz NOT NULL
);
-- A partner's reports (newest first), a code's reports, and all reports in a date range (HQ).
CREATE INDEX IF NOT EXISTS damage_reports_partner_time ON damage_reports (partner_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS damage_reports_code ON damage_reports (code);
CREATE INDEX IF NOT EXISTS damage_reports_time ON damage_reports (reported_at DESC);

-- One row per photo file. seq 0 = the barcode photo, 1..4 = photos of the damage. The unique (report_id, seq) also
-- serves "the photos of this report".
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id      uuid        NOT NULL REFERENCES damage_reports (report_id) DEFERRABLE INITIALLY DEFERRED,
  kind           text        NOT NULL CHECK (kind IN ('BARCODE_PHOTO', 'DAMAGE_PHOTO')),
  seq            smallint    NOT NULL CHECK (seq BETWEEN 0 AND 4),
  storage_key    text        NOT NULL UNIQUE CHECK (storage_key ~ '^[A-Za-z0-9/_.-]+$' AND length(storage_key) <= 512),
  content_type   text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes     integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  sha256         text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at    timestamptz NOT NULL,
  CONSTRAINT attachments_report_seq UNIQUE (report_id, seq),
  CONSTRAINT attachments_kind_matches_seq CHECK ((kind = 'BARCODE_PHOTO') = (seq = 0))
);

-- (d) code_history, partitioned by month of event_time (India time). Old months can be archived and detached as a
-- unit; indexes stay per month and small. PostgreSQL needs the partition column in every unique key, so the event id
-- is unique per (event_id, event_time); the app makes it unique by itself (random UUIDs). event_id is uuid: the app
-- must check an id looks like a UUID before looking it up (the SQL store answers "not found" for anything else).
CREATE TABLE IF NOT EXISTS code_history (
  history_id     bigint      GENERATED ALWAYS AS IDENTITY,
  event_id       uuid        NOT NULL,
  record_type    text        NOT NULL CHECK (record_type IN ('MOVEMENT', 'SCAN', 'REPRINT')),
  code           text        NOT NULL,
  event          text        NOT NULL,
  item_kind      text,
  context        text,
  location_id    text,
  from_id        text,
  to_id          text,
  status_before  text,
  status_after   text,
  invoice_no     text,
  reason         text,
  ok             boolean     NOT NULL DEFAULT true,
  result         text        NOT NULL DEFAULT 'OK',
  message        text,
  login_id       text,
  device_id      text,
  print_order_id text,
  -- When the SERVER recorded the event (the app's clock, never a client's): the partition key, so a device with a
  -- wrong clock can never decide which month a row goes to (decision Q6).
  event_time     timestamptz NOT NULL,
  -- The time the device itself reported, kept as information only, when a client sends one. NULL otherwise: no request
  -- carries a device time today (every event is timed by the server), and rows from before v11 have none.
  device_at      timestamptz,
  PRIMARY KEY (history_id, event_time),
  CONSTRAINT code_history_event_id_key UNIQUE (event_id, event_time)
) PARTITION BY RANGE (event_time);
-- Safety net: a row dated in a month that has no partition (a plant PC with a wrong clock) lands here instead of
-- failing the scan. It should stay empty; db_health and the daily job report any rows in it.
CREATE TABLE IF NOT EXISTS code_history_default PARTITION OF code_history DEFAULT;

-- Indexes = the app's read paths, nothing more (each full index costs 6–40 bytes per row, at crores of rows a year).
CREATE INDEX IF NOT EXISTS code_history_code ON code_history (code);                  -- a code's timeline
CREATE INDEX IF NOT EXISTS code_history_login ON code_history (login_id);             -- a sign-in's activity / delete check
CREATE INDEX IF NOT EXISTS code_history_location ON code_history (location_id);       -- a partner's activity / delete check
CREATE INDEX IF NOT EXISTS code_history_scans_recent ON code_history (event_time DESC) WHERE record_type = 'SCAN';  -- HQ scan log
-- Time ranges (reports, exports, archive): rows arrive in time order, so a BRIN index does it for almost no space.
CREATE INDEX IF NOT EXISTS code_history_time_brin ON code_history USING brin (event_time) WITH (pages_per_range = 64);
-- The rare events the app lists on their own (damage, returns, reprints served, recalls …) and failed scans: small
-- partial indexes instead of one (record_type, event) index over every row.
CREATE INDEX IF NOT EXISTS code_history_rare_events ON code_history (event, event_time)
  WHERE event NOT IN ('SCANNED', 'DISPATCHED', 'RECEIVED', 'GENERATED', 'PRINTED', 'VERIFIED');
CREATE INDEX IF NOT EXISTS code_history_failed_scans ON code_history (event_time) WHERE record_type = 'SCAN' AND NOT ok;
-- [6] Every reprint (plant reprint list, HQ) and every public QR lookup (HQ alerts) without reading the whole history.
-- Both are a small share of rows. (Partner-delete checks on from_id / to_id stay on the existing indexes: see
-- docs/DATABASE_PHASE1_REVIEW.md §5 item 5, an app change, instead of indexing every row twice more.)
CREATE INDEX IF NOT EXISTS code_history_reprints ON code_history (event_time) WHERE record_type = 'REPRINT';
CREATE INDEX IF NOT EXISTS code_history_public_lookups ON code_history (event_time) WHERE context = 'PUBLIC_LOOKUP';

DROP TRIGGER IF EXISTS code_history_no_change ON code_history;
CREATE TRIGGER code_history_no_change BEFORE UPDATE OR DELETE ON code_history
  FOR EACH ROW EXECUTE FUNCTION code_history_append_only();

-- Event ids are unique per (event_id, event_time) only. The app's ids are random, except one: the row that marks a
-- logged reprint as printed (REPRINT_SERVED) has a fixed id per reprint, so a reprint prints once, also between
-- concurrent requests. That id stays unique for all time here (a second use fails with a unique violation). Append-only
-- like the history. The same row moved by code_history_repair_default() (same id and time) is not a second use.
-- Only this trigger writes it: the app role may read it but not insert (deploy/roles_v11.sql), so nobody can pre-insert
-- an id to block a reprint; the trigger function runs with the owner's rights (search_path pinned, not callable).
CREATE TABLE IF NOT EXISTS code_history_once (
  event_id    uuid        PRIMARY KEY,
  event_time  timestamptz NOT NULL
);
CREATE OR REPLACE FUNCTION code_history_once_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO code_history_once (event_id, event_time) VALUES (NEW.event_id, NEW.event_time) ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM code_history_once WHERE event_id = NEW.event_id AND event_time = NEW.event_time) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "code_history_once_pkey": event % (%) was already recorded', NEW.event_id, NEW.event
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION code_history_once_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS code_history_once ON code_history;
CREATE TRIGGER code_history_once AFTER INSERT ON code_history
  FOR EACH ROW WHEN (NEW.event = 'REPRINT_SERVED') EXECUTE FUNCTION code_history_once_guard();
DROP TRIGGER IF EXISTS code_history_once_no_change ON code_history_once;
CREATE TRIGGER code_history_once_no_change BEFORE UPDATE OR DELETE ON code_history_once
  FOR EACH ROW EXECUTE FUNCTION code_history_append_only();

-- One month of history (India time) as a partition. Owner only; the app and the jobs go through
-- code_history_ensure_partitions(). Returns true if it made the month.
-- [1] The month is created as a plain table and then ATTACHed: ATTACH takes only a SHARE UPDATE EXCLUSIVE lock on the
--     history parent (CREATE TABLE … PARTITION OF would take ACCESS EXCLUSIVE on it, blocking every insert and read).
--     It does take ACCESS EXCLUSIVE on the default partition while it checks that no row there belongs to the new
--     month (an empty table: an instant). Inserts routed to the month partitions don't touch the default and carry on;
--     a read of history that isn't limited to recent months (it opens every partition, the default too) can make the
--     ATTACH wait, and reads that start meanwhile queue behind it. So it waits at most 5 s for its locks and tries 3
--     times, a few seconds once a month at worst. (A CHECK constraint on the default partition would not avoid this:
--     adding one needs the same lock and a scan.)
-- [2] A month whose rows already sit in the default partition can't be attached (PostgreSQL refuses), which would make
--     the daily job fail every day: such a month is skipped with a warning; code_history_repair_default() moves them.
CREATE OR REPLACE FUNCTION code_history_create_month(p_month date) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  m     date := date_trunc('month', p_month)::date;
  part  text := format('code_history_%s', to_char(date_trunc('month', p_month), 'YYYY_MM'));
  lo    timestamptz := date_trunc('month', p_month)::date::timestamp AT TIME ZONE 'Asia/Kolkata';
  hi    timestamptz := (date_trunc('month', p_month) + interval '1 month')::date::timestamp AT TIME ZONE 'Asia/Kolkata';
BEGIN
  IF to_regclass(part) IS NOT NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = 'code_history_default'::regclass)
     AND EXISTS (SELECT 1 FROM code_history_default WHERE event_time >= lo AND event_time < hi) THEN
    RAISE WARNING 'History month % not created: rows of it are in code_history_default. As the owner run: SELECT code_history_repair_default();', to_char(m, 'YYYY-MM');
    RETURN false;
  END IF;
  FOR attempt IN 1..3 LOOP
    BEGIN
      EXECUTE format('CREATE TABLE %I (LIKE code_history INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
                        WITH (autovacuum_vacuum_insert_scale_factor = 0.05)', part);
      EXECUTE format('ALTER TABLE code_history ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = 3 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(attempt);
    END;
  END LOOP;
  -- Insert and read only for the app, like the whole history (roles_v11.sql does the same for every month).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_app') THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM velza_app', part);
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION code_history_create_month(date) FROM PUBLIC;

-- Make sure the months from p_from (default: this month) to p_months_ahead months after this month exist. Returns how
-- many it made. Owner rights (SECURITY DEFINER), so the app and the jobs container can call it as velza_app without
-- being able to create tables. [3] Callers can only start from last month on and look at most 24 months ahead; older
-- months (a data migration) are made by the owner with code_history_create_month().
CREATE OR REPLACE FUNCTION code_history_ensure_partitions(p_from date DEFAULT NULL, p_months_ahead integer DEFAULT 3)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  this_m  date := date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)::date;
  m       date;
  made    integer := 0;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'p_months_ahead must be between 0 and 24 (got %)', p_months_ahead USING ERRCODE = '22023';
  END IF;
  m := date_trunc('month', COALESCE(p_from, this_m))::date;
  IF m < (this_m - interval '1 month')::date THEN
    RAISE EXCEPTION 'p_from % is before last month; older months are created by the owner with code_history_create_month()', p_from
      USING ERRCODE = '22023';
  END IF;
  WHILE m <= (this_m + make_interval(months => p_months_ahead))::date LOOP
    IF code_history_create_month(m) THEN
      made := made + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN made;
END
$$;
REVOKE ALL ON FUNCTION code_history_ensure_partitions(date, integer) FROM PUBLIC;

-- [2] Owner only, in a quiet moment (it locks the history for a few seconds): move every row of the default partition
-- into its own month. Detach the default, create the months its rows belong to, copy the rows (same ids and times),
-- empty the detached table and attach it again. All in the caller's transaction: either everything moves or nothing.
-- Returns the rows moved.
CREATE OR REPLACE FUNCTION code_history_repair_default() RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  m      date;
  moved  bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM code_history_default) THEN
    RETURN 0;
  END IF;
  ALTER TABLE code_history DETACH PARTITION code_history_default;
  FOR m IN SELECT DISTINCT date_trunc('month', event_time AT TIME ZONE 'Asia/Kolkata')::date FROM code_history_default LOOP
    PERFORM code_history_create_month(m);
  END LOOP;
  INSERT INTO code_history (history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id,
         status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id,
         event_time, device_at) OVERRIDING SYSTEM VALUE
  SELECT history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id,
         status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id,
         event_time, device_at FROM code_history_default ORDER BY history_id;
  GET DIAGNOSTICS moved = ROW_COUNT;
  -- Detached, the table has no append-only trigger; it is emptied and becomes the (empty) safety net again.
  TRUNCATE code_history_default;
  ALTER TABLE code_history ATTACH PARTITION code_history_default DEFAULT;
  RETURN moved;
END
$$;
REVOKE ALL ON FUNCTION code_history_repair_default() FROM PUBLIC;

-- Copy the v10 history into its months (one partition per month that has rows, plus this month and the next 3). Same
-- history ids and times; an event id that is not a UUID (hand-made test rows: the app always used random UUIDs) becomes
-- the md5 uuid of the old id, the same on every run. A damage report is made from every DAMAGED movement (the app
-- writes them itself from v11). On a new database there is nothing to copy.
DO $$
DECLARE
  m      date;
  n_old  bigint;
  n_new  bigint;
BEGIN
  IF to_regclass('code_history_v10') IS NULL THEN
    PERFORM code_history_ensure_partitions();
    RETURN;
  END IF;
  FOR m IN SELECT DISTINCT date_trunc('month', event_time AT TIME ZONE 'Asia/Kolkata')::date FROM code_history_v10 LOOP
    PERFORM code_history_create_month(m);
  END LOOP;
  PERFORM code_history_ensure_partitions();
  INSERT INTO code_history (history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id,
         status_before, status_after, invoice_no, reason, ok, result, message, login_id, device_id, print_order_id,
         event_time) OVERRIDING SYSTEM VALUE
  SELECT history_id,
         CASE WHEN event_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN event_id::uuid ELSE md5(event_id)::uuid END,
         record_type, code, event, item_kind, context, location_id, from_id, to_id, status_before, status_after,
         invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time
    FROM code_history_v10 ORDER BY history_id;
  GET DIAGNOSTICS n_new = ROW_COUNT;
  SELECT count(*) INTO n_old FROM code_history_v10;
  IF n_new <> n_old THEN
    RAISE EXCEPTION 'Schema v11: copied % of % history rows. Nothing was changed.', n_new, n_old;
  END IF;
  PERFORM setval(pg_get_serial_sequence('code_history', 'history_id'), COALESCE((SELECT max(history_id) FROM code_history), 0) + 1, false);
  INSERT INTO damage_reports (report_id, code, item_kind, partner_id, reason, packs_affected, reported_by, reported_at)
  SELECT h.event_id, h.code,
         COALESCE(h.item_kind, k.code_type),
         h.from_id,
         COALESCE(NULLIF(btrim(h.reason), ''), '(no reason recorded)'),
         CASE WHEN k.code_type = 'PACK' THEN 1
              WHEN h.status_before = 'OPENED' THEN GREATEST(1, (SELECT count(*) FROM codes p
                                                                 WHERE p.lot_code = h.code AND p.code_type = 'PACK'
                                                                   AND p.status = 'DAMAGED' AND p.location_id = h.from_id))
              WHEN k.lot_type = 'CASE' THEN 4 ELSE 6 END,
         (SELECT u.login_id FROM users u WHERE u.login_id = h.login_id),
         h.event_time
    FROM code_history h
    JOIN codes k ON k.code = h.code
   WHERE h.record_type = 'MOVEMENT' AND h.event = 'DAMAGED'
     AND EXISTS (SELECT 1 FROM partners p WHERE p.partner_id = h.from_id)
  ON CONFLICT (report_id) DO NOTHING;
  DROP TABLE code_history_v10;
  IF n_new > 0 THEN
    RAISE NOTICE 'Schema v11: % history rows copied into monthly partitions.', n_new;
  END IF;
END
$$;

-- (e) operations views and the daily job.
-- One row the daily job and dashboards read. Anything other than 0 in the first four needs a look:
--   history_rows_without_partition   rows in the default partition ([2]: run code_history_repair_default());
--   stock_deltas_pending             deltas not folded yet (large = the rollup is not running);
--   expired_sessions                 sessions the daily job removes;
--   opened_lot_packs_without_state   [4] should stay 0 (the database refuses it);
--   sealed_lot_packs_with_own_state  [5] packs with their own state inside a sealed lot (damaged, recalled, voided or
--                                    quarantined on their own, or rows migrated that way). The EXPECTED case, not an
--                                    error and not a double count (decision Q7): each counts once, under its own state,
--                                    and not with its lot (see stock_recount). Information only; not part of "ok".
-- It reads every lot and loose pack: for the daily job, not for a page that refreshes.
-- stock_recount: the live stock counted straight from codes, by effective state (what stock_current must always
-- equal; npm run db:stock -- check compares them). Reads every code: for jobs only.
DROP VIEW IF EXISTS stock_recount;
CREATE VIEW stock_recount AS
SELECT location_id, status, code_type, lot_type, flavour, synced, count(*)::bigint AS units
  FROM (
    SELECT location_id, status, code_type, lot_type, flavour, synced FROM codes WHERE status IS NOT NULL
    UNION ALL
    SELECT l.location_id, l.status, x.code_type, x.lot_type, x.flavour, l.synced
      FROM codes x JOIN codes l ON l.code = x.lot_code
     WHERE x.status IS NULL) e
 GROUP BY location_id, status, code_type, lot_type, flavour, synced;
DROP VIEW IF EXISTS db_health;
CREATE VIEW db_health AS
SELECT
  (SELECT count(*) FROM code_history_default)                                AS history_rows_without_partition,
  (SELECT count(*) FROM stock_deltas)                                        AS stock_deltas_pending,
  (SELECT count(*) FROM sessions WHERE expires_at < now())                   AS expired_sessions,
  (SELECT count(*) FROM codes p JOIN codes l ON l.code = p.lot_code
    WHERE p.code_type = 'PACK' AND p.status IS NULL AND l.code_type = 'LOT' AND (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall IS NOT DISTINCT FROM 'OPENED')))     AS opened_lot_packs_without_state,
  (SELECT count(*) FROM codes p JOIN codes l ON l.code = p.lot_code
    WHERE p.code_type = 'PACK' AND p.status IS NOT NULL AND l.code_type = 'LOT' AND NOT (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall IS NOT DISTINCT FROM 'OPENED'))) AS sealed_lot_packs_with_own_state;

-- Size of every table (a partitioned table with all its parts), largest first: dashboards and the capacity check.
DROP VIEW IF EXISTS db_table_sizes;
CREATE VIEW db_table_sizes AS
SELECT c.relname                                         AS table_name,
       count(*) FILTER (WHERE c.relkind = 'p')           AS parts,
       sum(GREATEST(r.reltuples, 0))::bigint             AS approx_rows,
       pg_size_pretty(sum(pg_table_size(r.oid)))         AS data,
       pg_size_pretty(sum(pg_indexes_size(r.oid)))       AS indexes,
       sum(pg_total_relation_size(r.oid))                AS total_bytes
  FROM pg_class c
 CROSS JOIN LATERAL (SELECT t.relid FROM pg_partition_tree(c.oid) t WHERE t.isleaf AND c.relkind = 'p'
                     UNION ALL SELECT c.oid WHERE c.relkind = 'r') leaf
  JOIN pg_class r ON r.oid = leaf.relid
 WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
 GROUP BY c.relname
 ORDER BY total_bytes DESC NULLS LAST;

-- One row per history month: its range, approximate rows and size, and how many whole months old it is (the archive
-- procedure picks months older than the retention period from here).
DROP VIEW IF EXISTS db_history_partitions;
CREATE VIEW db_history_partitions AS
SELECT c.relname                                         AS partition_name,
       pg_get_expr(c.relpartbound, c.oid)                AS range,
       c.reltuples::bigint                               AS approx_rows,
       pg_size_pretty(pg_total_relation_size(c.oid))     AS size,
       CASE WHEN c.relname ~ '^code_history_[0-9]{4}_[0-9]{2}$' THEN
         (extract(year FROM age(date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date),
                                to_date(right(c.relname, 7), 'YYYY_MM'))) * 12
        + extract(month FROM age(date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date),
                                 to_date(right(c.relname, 7), 'YYYY_MM'))))::int END AS months_old
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'code_history'::regclass
 ORDER BY c.relname;

-- The daily job (jobs container, as velza_app): the next 3 months of history exist, sign-in sessions that expired over
-- a day ago are removed, and the health numbers come back so the job can log them and alert when "ok" is false.
-- Owner rights only to create months; everything else the app may do anyway.
CREATE OR REPLACE FUNCTION velza_daily_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made     integer;
  removed  bigint;
  h        record;
BEGIN
  made := code_history_ensure_partitions(NULL, 3);
  DELETE FROM sessions WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS removed = ROW_COUNT;
  SELECT * INTO h FROM db_health;
  RETURN jsonb_build_object(
    'partitions_created',               made,
    'sessions_removed',                 removed,
    'history_rows_without_partition',   h.history_rows_without_partition,
    'stock_deltas_pending',             h.stock_deltas_pending,
    'opened_lot_packs_without_state',   h.opened_lot_packs_without_state,
    'sealed_lot_packs_with_own_state',  h.sealed_lot_packs_with_own_state,
    'ok', h.history_rows_without_partition = 0 AND h.opened_lot_packs_without_state = 0);
END
$$;
REVOKE ALL ON FUNCTION velza_daily_maintenance() FROM PUBLIC;

-- (f) the rest of v11.
DROP INDEX IF EXISTS containers_lot_codes;                                         -- container_items_lot replaces it
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);              -- the daily removal of expired sessions
ALTER TABLE stock_deltas SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_insert_scale_factor = 0.01);

-- Permanent records stay add-and-read-only for the app between this migration and the roles step of the deploy
-- (deploy/roles_v11.sql does the same; this only matters where the velza_app role exists).
DO $$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velza_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON code_history, code_history_once, damage_reports, attachments FROM velza_app;
    REVOKE INSERT ON code_history_once FROM velza_app;
    FOR r IN SELECT inhrelid::regclass AS part FROM pg_inherits WHERE inhparent = 'code_history'::regclass LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM velza_app', r.part);
    END LOOP;
  END IF;
END
$$;

INSERT INTO schema_info (id, version) VALUES (1, 11)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();
