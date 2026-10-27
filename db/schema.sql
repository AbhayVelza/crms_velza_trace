-- Velza Traceability — PostgreSQL schema v2.
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
  partner_type    text NOT NULL CONSTRAINT partners_partner_type_check CHECK (partner_type IN ('MANUFACTURER', 'SS', 'DB', 'RETAILER')),
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
    partner_id ~ '^(MF|SS|DB|RT)[0-9]{4,}$' AND left(partner_id, 2) = CASE partner_type
      WHEN 'MANUFACTURER' THEN 'MF' WHEN 'SS' THEN 'SS' WHEN 'DB' THEN 'DB' ELSE 'RT' END)
);
-- One Super Stockist per state.
CREATE UNIQUE INDEX IF NOT EXISTS partners_one_ss_per_state ON partners (state) WHERE partner_type = 'SS';
CREATE UNIQUE INDEX IF NOT EXISTS partners_email_unique ON partners (lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS partners_parent ON partners (parent_id);

-- ============================================================ users (sign-ins)
-- login_id = the partner ID (DB0001), MF0001-OP / MF0001-QC at the plant, AD0001 / HQ0001 for Velza staff.
CREATE TABLE IF NOT EXISTS users (
  login_id             text PRIMARY KEY CONSTRAINT users_login_id_check CHECK (login_id ~ '^(MF|SS|DB|RT|AD|HQ)[0-9]{4,}(-(OP|QC))?$'),
  partner_id           text REFERENCES partners (partner_id) DEFERRABLE INITIALLY DEFERRED,
  name                 text NOT NULL,
  role                 text NOT NULL CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'OPERATOR', 'QC', 'SS', 'DB', 'RETAILER', 'TRACE_OWNER')),
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
  batch_code       text NOT NULL UNIQUE CHECK (batch_code ~ '^[A-Z0-9]{6}$'),
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

-- ============================================================ codes
-- One row per sticker: a case or tray (LOT) and each of its packs (PACK). The code must equal its
-- parts: country (2) + batch (6) + flavour (2) + hex lot number (5) [+ pack size + pack sequence].
CREATE TABLE IF NOT EXISTS codes (
  code                  text PRIMARY KEY,
  code_type             text NOT NULL CHECK (code_type IN ('LOT', 'PACK')),
  country_code          text NOT NULL CHECK (country_code ~ '^[0-9]{2}$'),
  batch_code            text NOT NULL REFERENCES batches (batch_code) DEFERRABLE INITIALLY DEFERRED,
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
                          status IN ('GENERATED', 'PRINTED', 'PACKED', 'IN_TRANSIT', 'AT_SS', 'AT_DB', 'AT_RETAILER',
                    'OPENED', 'QUARANTINED', 'VOID', 'DAMAGED', 'RETURNED', 'RECALLED')),
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
  CONSTRAINT lot_type_matches_pack_size CHECK ((lot_type = 'CASE') = (pack_size = 6))
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

-- ============================================================ upgrade from v1
-- CREATE TABLE IF NOT EXISTS leaves an existing table's checks as they were, so the checks that changed
-- in v2 are put back here with the v2 values (on a new database this replaces them with the same).
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
  ADD CONSTRAINT partners_partner_type_check CHECK (partner_type IN ('MANUFACTURER', 'SS', 'DB', 'RETAILER')),
  ADD CONSTRAINT partner_id_matches_type CHECK (
    partner_id ~ '^(MF|SS|DB|RT)[0-9]{4,}$' AND left(partner_id, 2) = CASE partner_type
      WHEN 'MANUFACTURER' THEN 'MF' WHEN 'SS' THEN 'SS' WHEN 'DB' THEN 'DB' ELSE 'RT' END);
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_login_id_check,
  DROP CONSTRAINT IF EXISTS users_role_check,
  ADD CONSTRAINT users_login_id_check CHECK (login_id ~ '^(MF|SS|DB|RT|AD|HQ)[0-9]{4,}(-(OP|QC))?$'),
  ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'OPERATOR', 'QC', 'SS', 'DB', 'RETAILER', 'TRACE_OWNER'));
ALTER TABLE codes
  DROP CONSTRAINT IF EXISTS codes_status_check,
  ADD CONSTRAINT codes_status_check CHECK (
    status IN ('GENERATED', 'PRINTED', 'PACKED', 'IN_TRANSIT', 'AT_SS', 'AT_DB', 'AT_RETAILER',
                    'OPENED', 'QUARANTINED', 'VOID', 'DAMAGED', 'RETURNED', 'RECALLED'));

INSERT INTO schema_info (id, version) VALUES (1, 2)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();
