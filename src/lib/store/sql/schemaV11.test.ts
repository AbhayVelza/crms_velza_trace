// Schema v11 on embedded PostgreSQL (the same SQL runs on a real server): Option C (a sealed pack follows its lot),
// codes and code_history partitioned, damage reports + attachments, and the fixes of docs/DATABASE_PHASE1_REVIEW.md
// §1b (issue numbers in brackets). The v10 database these tests upgrade is made with tests/sql/schema_v10.sql (the
// db/schema.sql of the v10 release, frozen) and tests/sql/make_fake_supabase_v10.sql (v10-shaped data: 300 lots, 1,600
// packs carrying their lot's state, opened lots, a recalled lot, an odd pack, containers, 703 history rows over two
// months with non-UUID ids).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reprintServedId } from "@/lib/services/printOrders";
import type { Batch, Lot, Pack, Partner, PrintOrder } from "@/lib/core/types";
import { buildBaseSeed } from "../seedData";
import type { DbSnapshot } from "../Store";
import { createPgliteDriver, type SqlDriver } from "./driver";
import { schemaFingerprint } from "./fingerprint";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
import { SqlStore } from "./sqlStore";

const root = process.cwd();
const V10_SQL = readFileSync(path.join(root, "tests", "sql", "schema_v10.sql"), "utf8");
const FAKE_V10 = readFileSync(path.join(root, "tests", "sql", "make_fake_supabase_v10.sql"), "utf8").replace(/^\\set.*$/gm, "");
/** A REPRINT_SERVED row as the v10 app wrote it (id "reprint-served:<reprint id>"), to check the v11 id mapping. */
const REPRINT_ID = "5f0c3a2e-1b7d-4e8a-9c61-2d4f6b8a0e13";
const SERVED_V10 = `INSERT INTO code_history (event_id, record_type, code, event, item_kind, login_id, event_time)
  VALUES ('reprint-served:${REPRINT_ID}', 'MOVEMENT', '91ABC123LM00002', 'REPRINT_SERVED', 'LOT', 'MF0001-OP', '2026-10-02 11:00+05:30')`;

const drivers: SqlDriver[] = [];
const stores: SqlStore[] = [];
async function db() {
  const d = await createPgliteDriver();
  drivers.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(drivers.splice(0).map((d) => d.close().catch(() => undefined)));
});

/** A v10 database with the fake data (and one served reprint). */
async function v10WithData() {
  const d = await db();
  await d.exec(V10_SQL);
  await d.exec(FAKE_V10);
  await d.exec(SERVED_V10);
  return d;
}
const count = async (d: SqlDriver, sql: string) => Number((await d.query<{ n: string }>(sql))[0].n);
const STOCK_KEY = "location_id, status, code_type, lot_type, flavour, synced";
const STATE = "status, location_id, in_transit_to, to_char(dispatched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS dispatched_at, status_before_recall";

describe("schema v11: install and upgrade", () => {
  it("is the current schema version", () => {
    expect(SCHEMA_VERSION).toBe(11);
  });

  it("an upgraded v10 database (empty or with data) has exactly the schema of a fresh install, also after running it again", async () => {
    const fresh = await db();
    await fresh.exec(SCHEMA_SQL);
    const expected = await schemaFingerprint(fresh.query);
    expect(expected.length).toBeGreaterThan(500);

    const empty = await db();
    await empty.exec(V10_SQL);
    await empty.exec(SCHEMA_SQL);
    expect(await schemaFingerprint(empty.query)).toEqual(expected);

    const withData = await v10WithData();
    await withData.exec(SCHEMA_SQL);
    expect(await schemaFingerprint(withData.query)).toEqual(expected);

    await fresh.exec(SCHEMA_SQL);
    expect(await schemaFingerprint(fresh.query)).toEqual(expected);
    for (const d of [fresh, empty, withData]) expect(await d.query(`SELECT version FROM schema_info`)).toEqual([{ version: 11 }]);
    // No v10 table is left behind.
    expect(await withData.query(`SELECT to_regclass('codes_v10') AS a, to_regclass('code_history_v10') AS b`)).toEqual([{ a: null, b: null }]);
  });

  it("the app upgrades a v10 database on its next start and every row survives: same effective state, same history", async () => {
    const d = await v10WithData();
    const before = {
      codes: await d.query(`SELECT code, ${STATE} FROM codes ORDER BY code`),
      history: await d.query(
        `SELECT history_id, event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id, status_before, status_after,
                invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time FROM code_history ORDER BY history_id`,
      ),
      items: await d.query(`SELECT container_id, lot_code FROM container_items ORDER BY 1, 2`),
      maxRow: await count(d, `SELECT max(row_no) AS n FROM codes`),
      maxHistory: await count(d, `SELECT max(history_id) AS n FROM code_history`),
      stock: await d.query(`SELECT ${STOCK_KEY}, units FROM stock_current ORDER BY ${STOCK_KEY}`),
    };
    const store = new SqlStore(async () => d, null, { stockRollupIntervalMs: Number.POSITIVE_INFINITY });
    stores.push(store);
    await store.driver(); // the next start of the app (version 10 < 11)
    expect(await d.query(`SELECT version FROM schema_info`)).toEqual([{ version: 11 }]);

    // Every barcode reports the same state as before (code_state), though sealed packs no longer store it.
    expect(await d.query(`SELECT code, ${STATE} FROM code_state ORDER BY code`)).toEqual(before.codes);
    const kinds = await d.query<{ kind: string; n: string }>(
      `SELECT CASE WHEN code_type = 'LOT' THEN 'lot' WHEN status IS NULL THEN 'inherits' ELSE 'own' END AS kind, count(*) AS n FROM codes GROUP BY 1 ORDER BY 1`,
    );
    // 5 opened trays × 6 packs keep their own state, plus the quarantined pack of a sealed tray [5]; the rest follow their lot.
    expect(kinds.map((k) => [k.kind, Number(k.n)])).toEqual([["inherits", 1569], ["lot", 300], ["own", 31]]);
    expect(await d.query(`SELECT opened_lot_packs_without_state, sealed_lot_packs_with_own_state FROM db_health`)).toEqual([
      { opened_lot_packs_without_state: 0, sealed_lot_packs_with_own_state: 1 },
    ]);

    // History: same ids (non-UUIDs as the md5 uuid of the old text), times and content; rows in their months.
    const after = await d.query<Record<string, unknown>>(
      `SELECT history_id, event_id::text AS event_id, record_type, code, event, item_kind, context, location_id, from_id, to_id, status_before, status_after,
              invoice_no, reason, ok, result, message, login_id, device_id, print_order_id, event_time FROM code_history ORDER BY history_id`,
    );
    expect(after).toHaveLength(before.history.length);
    const md5uuid = (t: string) => {
      const h = createHash("md5").update(t).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    expect(after).toEqual(before.history.map((r) => ({ ...r, event_id: md5uuid(String(r.event_id)) })));
    expect(await count(d, `SELECT count(*) AS n FROM code_history_default`)).toBe(0);
    expect((await d.query<{ m: string }>(`SELECT DISTINCT tableoid::regclass::text AS m FROM code_history ORDER BY 1`)).map((r) => r.m)).toEqual([
      "code_history_2026_10",
      "code_history_2026_11",
    ]);
    // The reprint served before the upgrade is found under the id the app now computes for it (so it can't print again).
    expect(await store.movements.list({ id: reprintServedId(REPRINT_ID) })).toEqual([expect.objectContaining({ type: "REPRINT_SERVED", itemCode: "91ABC123LM00002" })]);
    expect(await count(d, `SELECT count(*) AS n FROM code_history_once`)).toBe(1);

    // The DAMAGED movement became a damage report (one pack).
    expect(await d.query(`SELECT code, item_kind, partner_id, reason, packs_affected, reported_by FROM damage_reports`)).toEqual([
      expect.objectContaining({ item_kind: "PACK", partner_id: "RT0002", reason: "Can dented", packs_affected: 1, reported_by: "RT0001" }),
    ]);
    // What containers carried is unchanged and still checked against codes.
    expect(await d.query(`SELECT container_id, lot_code FROM container_items ORDER BY 1, 2`)).toEqual(before.items);
    await expect(d.exec(`INSERT INTO container_items (container_id, lot_code, loaded_at) VALUES ('CT1', '91ZZZ999OR00001', now())`)).rejects.toThrow(
      /container_items_lot_code_fkey/,
    );

    // Live stock is exactly what it was in v10 (Q7: every code by its effective state, the quarantined pack of a sealed
    // tray under its own state only), and equals the recount (npm run db:stock -- check).
    expect(await d.query(`SELECT ${STOCK_KEY}, units FROM stock_current ORDER BY ${STOCK_KEY}`)).toEqual(before.stock);
    expect(await d.query(`SELECT ${STOCK_KEY}, units FROM stock_recount ORDER BY ${STOCK_KEY}`)).toEqual(before.stock);
    // History rows from before v11 have no device time (Q6).
    expect(await count(d, `SELECT count(*) AS n FROM code_history WHERE device_at IS NOT NULL`)).toBe(0);
    // Identity numbers continue after the copied ones.
    await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES (gen_random_uuid(), 'SCAN', 'X', 'SCANNED', now())`);
    expect(await count(d, `SELECT max(history_id) AS n FROM code_history`)).toBe(before.maxHistory + 1);
    await d.exec(`UPDATE batches SET next_lot = 202 WHERE batch_code = 'ABC123'`);
    await d.exec(
      `INSERT INTO codes (code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, lot_code, lot_number, manufacturer_id, status, location_id, generated_at, updated_at)
       VALUES ('91ABC123LM000C9', 'LOT', '91', 'ABC123', 'LM', '000C9', 'TRAY', 4, '91ABC123LM000C9', 201, 'MF0001', 'GENERATED', 'MF0001', now(), now())`,
    );
    expect(await count(d, `SELECT row_no AS n FROM codes WHERE code = '91ABC123LM000C9'`)).toBe(before.maxRow + 1);
  });

  it("an upgrade that fails its own check changes nothing: still the plain v10 tables, the same rows, version 10", async () => {
    const d = await v10WithData();
    const snapshot = async () => ({
      kinds: await d.query(`SELECT c.relname, c.relkind FROM pg_class c WHERE c.relname IN ('codes', 'code_history', 'codes_v10', 'code_history_v10') ORDER BY 1`),
      codes: await d.query(`SELECT code, ${STATE}, row_no FROM codes ORDER BY code`),
      history: await count(d, `SELECT count(*) AS n FROM code_history`),
      version: await d.query(`SELECT version FROM schema_info`),
      tables: await d.query(`SELECT to_regclass('damage_reports') AS a, to_regclass('code_history_once') AS b`),
    });
    const before = await snapshot();
    expect(before.kinds).toEqual([{ relname: "code_history", relkind: "r" }, { relname: "codes", relkind: "r" }]);
    // A copy that would let a pack with a state of its own (the quarantined one) follow its tray: the upgrade's own
    // effective-state check must refuse it.
    const tuple = "(c.status, c.location_id, c.in_transit_to, c.dispatched_at, c.status_before_recall)\n               IS NOT DISTINCT FROM (l.status, l.location_id, l.in_transit_to, l.dispatched_at, l.status_before_recall)";
    expect(SCHEMA_SQL).toContain(tuple);
    await expect(d.exec(SCHEMA_SQL.replace(tuple, "true"))).rejects.toThrow(/a code would change state when its packs follow their lot\. Nothing was changed/);
    expect(await snapshot()).toEqual(before);
  });

  it("a v10 database with no data upgrades too, and `npm run db:migrate` leaves a current database alone unless forced [12]", async () => {
    const d = await db();
    await d.exec(V10_SQL);
    const store = new SqlStore(async () => d, null, { stockRollupIntervalMs: Number.POSITIVE_INFINITY });
    stores.push(store);
    await store.migrate();
    expect(await d.query(`SELECT version FROM schema_info`)).toEqual([{ version: 11 }]);
    // A dropped index stays dropped on a plain migrate (the schema is not run again) and comes back with --force.
    await d.exec(`DROP INDEX codes_batch`);
    await store.migrate();
    expect(await d.query(`SELECT to_regclass('codes_batch') AS i`)).toEqual([{ i: null }]);
    await store.migrate({ force: true });
    expect(await d.query(`SELECT to_regclass('codes_batch')::text AS i`)).toEqual([{ i: "codes_batch" }]);
    // The schema waits at most 10 s for a lock before giving up (and changes nothing then).
    expect(SCHEMA_SQL.trimStart().split("\n").find((l) => !l.startsWith("--"))).toBe(`SELECT set_config('lock_timeout', '10s', true);`);
  });

  it("views are dropped and created, not CREATE OR REPLACE, so a changed column list can't fail an upgrade [13]", () => {
    for (const view of ["code_state", "db_health", "db_table_sizes", "db_history_partitions"]) {
      expect(SCHEMA_SQL).toContain(`DROP VIEW IF EXISTS ${view};\nCREATE VIEW ${view} AS`);
      expect(SCHEMA_SQL).not.toContain(`CREATE OR REPLACE VIEW ${view}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------- the store on v11

const AT = "2026-11-26T08:00:00.000Z";
const partner = (id: string, type: Partner["type"], state = "Maharashtra"): Partner => ({
  id,
  type,
  name: id,
  place: "",
  address: "",
  city: "Pune",
  state,
  pincode: "",
  contactPerson: "",
  phone: "",
  email: "",
  parentId: null,
  active: true,
  approval: null,
  createdAt: AT,
  createdBy: "AD0001",
});
const batch: Batch = {
  id: "batch-AAA111",
  code: "AAA111",
  country: "91",
  flavour: "OR",
  mfgDate: "2026-11-01",
  expiryDate: "2027-05-01",
  manufacturerId: "MF0001",
  deviceId: "dev-1",
  nextLot: 10,
  status: "ACTIVE",
  synced: true,
  printOrderId: "po-1",
  createdAt: AT,
  createdBy: "AD0001",
  recalledAt: null,
  recallReason: null,
};
const order: PrintOrder = {
  id: "po-1",
  createdAt: AT,
  createdBy: "AD0001",
  deviceId: "dev-1",
  manufacturerId: "MF0001",
  batchCodes: ["AAA111"],
  lotCodes: [],
  stickerCount: 0,
  status: "PRINTED",
  printedAt: AT,
  synced: true,
  kind: "NEW_BATCH",
  requestFingerprint: null,
};
const TRAY = "91AAA111OR00001";
const trayLot: Lot = {
  id: TRAY,
  lotCode: TRAY,
  batchCode: "AAA111",
  flavour: "OR",
  lotType: "TRAY",
  packSize: 4,
  lotNumber: 1,
  status: "AT_SS",
  locationId: "SS0001",
  inTransitToId: null,
  dispatchedAt: null,
  printOrderId: "po-1",
  manufacturerId: "MF0001",
  deviceId: "dev-1",
  synced: true,
  quarantineReason: null,
  statusBeforeRecall: null,
  createdAt: AT,
  updatedAt: AT,
};
const packOf = (seq: number): Pack => ({
  id: `${TRAY}4${seq}`,
  packCode: `${TRAY}4${seq}`,
  lotCode: TRAY,
  seq,
  packSize: 4,
  status: "AT_SS",
  locationId: "SS0001",
  inTransitToId: null,
  dispatchedAt: null,
  statusBeforeRecall: null,
  createdAt: AT,
  updatedAt: AT,
});
const data = (): DbSnapshot => ({
  ...buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" }),
  partners: [partner("MF0001", "MANUFACTURER"), partner("SS0001", "SS"), partner("DB0001", "DB")],
  devices: [{ id: "dev-1", manufacturerId: "MF0001", name: "Plant PC", offline: false, lastSyncAt: null }],
  batches: [batch],
  printOrders: [order],
  lots: [trayLot],
  packs: [1, 2, 3, 4, 5, 6].map(packOf),
});

async function openStore(stockRollupIntervalMs = Number.POSITIVE_INFINITY) {
  const store = new SqlStore(() => createPgliteDriver(), () => data(), { stockRollupIntervalMs });
  stores.push(store);
  const d = await store.driver();
  return { store, d };
}
/** Clear the packs' own state: they follow the tray (what the Option C store will write for a sealed lot). */
const packsFollow = (d: SqlDriver) =>
  d.exec(`UPDATE codes SET status = NULL, location_id = NULL, in_transit_to = NULL, dispatched_at = NULL, status_before_recall = NULL
           WHERE lot_code = '${TRAY}' AND code_type = 'PACK'`);

describe("schema v11: Option C, history and photos", () => {
  /** Live stock (lots and packs) and the recount from codes, which must always agree. */
  const stock = async (d: SqlDriver) => {
    const live = await d.query<{ code_type: string; status: string; location_id: string; units: number }>(
      `SELECT code_type, status, location_id, units::int AS units FROM stock_current ORDER BY 1, 2, 3`,
    );
    expect(await d.query(`SELECT ${STOCK_KEY}, units FROM stock_recount ORDER BY ${STOCK_KEY}`)).toEqual(
      await d.query(`SELECT ${STOCK_KEY}, units FROM stock_current ORDER BY ${STOCK_KEY}`),
    );
    return live;
  };

  it("a sealed tray's packs follow it: one row moves, every pack reports the tray's state, stock follows too", async () => {
    const { d } = await openStore();
    await packsFollow(d);
    expect(await stock(d)).toEqual([
      { code_type: "LOT", status: "AT_SS", location_id: "SS0001", units: 1 },
      { code_type: "PACK", status: "AT_SS", location_id: "SS0001", units: 6 },
    ]);
    await d.exec(`UPDATE codes SET status = 'IN_TRANSIT', in_transit_to = 'DB0001', dispatched_at = now() WHERE code = '${TRAY}'`);
    expect(await d.query(`SELECT DISTINCT status, location_id, in_transit_to FROM code_state WHERE lot_code = '${TRAY}'`)).toEqual([
      { status: "IN_TRANSIT", location_id: "SS0001", in_transit_to: "DB0001" },
    ]);
    // Moving the one tray row moves its 6 following packs in the stock too.
    expect(await stock(d)).toEqual([
      { code_type: "LOT", status: "IN_TRANSIT", location_id: "SS0001", units: 1 },
      { code_type: "PACK", status: "IN_TRANSIT", location_id: "SS0001", units: 6 },
    ]);
    // A pack with a status but no place, or a lot without state, is refused.
    await expect(d.exec(`UPDATE codes SET status = 'AT_DB' WHERE code = '${TRAY}41'`)).rejects.toThrow(/codes_pack_state_all_or_nothing/);
    await expect(d.exec(`UPDATE codes SET status = NULL WHERE code = '${TRAY}'`)).rejects.toThrow(/codes_lot_has_state/);
  });

  it("[4] a lot can't be opened (or recalled from opened) while a pack still follows it; giving the packs state first works", async () => {
    const { d } = await openStore();
    await packsFollow(d);
    await expect(d.exec(`UPDATE codes SET status = 'OPENED' WHERE code = '${TRAY}'`)).rejects.toMatchObject({ code: "VZ003" });
    await expect(d.exec(`UPDATE codes SET status = 'RECALLED', status_before_recall = 'OPENED' WHERE code = '${TRAY}'`)).rejects.toMatchObject({ code: "VZ003" });
    // Checked at commit: packs first, then the lot, or the other way round, in one transaction.
    await d.transaction(async (q) => {
      await q(`UPDATE codes SET status = 'OPENED' WHERE code = $1`, [TRAY]);
      await q(
        `UPDATE codes p SET status = 'AT_SS', location_id = 'SS0001' WHERE p.lot_code = $1 AND p.code_type = 'PACK' AND p.status IS NULL`,
        [TRAY],
      );
    });
    expect(await count(d, `SELECT count(*) AS n FROM codes WHERE lot_code = '${TRAY}' AND code_type = 'PACK' AND status = 'AT_SS'`)).toBe(6);
    // An opened lot's pack can't go back to following it.
    await expect(d.exec(`UPDATE codes SET status = NULL, location_id = NULL WHERE code = '${TRAY}41'`)).rejects.toMatchObject({ code: "VZ003" });
    // Loose packs move on their own and count one by one.
    await d.exec(`UPDATE codes SET status = 'AT_DB', location_id = 'DB0001' WHERE code IN ('${TRAY}41', '${TRAY}42')`);
    expect(await d.query(`SELECT location_id, code_type, units::int AS units FROM stock_current WHERE code_type = 'PACK' ORDER BY 1`)).toEqual([
      { location_id: "DB0001", code_type: "PACK", units: 2 },
      { location_id: "SS0001", code_type: "PACK", units: 4 },
    ]);
  });

  it("Q7: a pack with its own state inside a sealed tray counts under its own state only, never again with the tray", async () => {
    const { d } = await openStore();
    await packsFollow(d);
    // One pack damaged, one recalled, inside the still sealed tray (the tray keeps its own state).
    await d.exec(`UPDATE codes SET status = 'DAMAGED', location_id = 'SS0001' WHERE code = '${TRAY}41'`);
    await d.exec(`UPDATE codes SET status = 'RECALLED', location_id = 'SS0001', status_before_recall = 'AT_SS' WHERE code = '${TRAY}42'`);
    expect(await stock(d)).toEqual([
      { code_type: "LOT", status: "AT_SS", location_id: "SS0001", units: 1 },
      { code_type: "PACK", status: "AT_SS", location_id: "SS0001", units: 4 },
      { code_type: "PACK", status: "DAMAGED", location_id: "SS0001", units: 1 },
      { code_type: "PACK", status: "RECALLED", location_id: "SS0001", units: 1 },
    ]);
    // The tray moves on: 4 packs go with it, the two with their own state stay where they are.
    await d.exec(`UPDATE codes SET status = 'AT_DB', location_id = 'DB0001' WHERE code = '${TRAY}'`);
    expect(await stock(d)).toEqual([
      { code_type: "LOT", status: "AT_DB", location_id: "DB0001", units: 1 },
      { code_type: "PACK", status: "AT_DB", location_id: "DB0001", units: 4 },
      { code_type: "PACK", status: "DAMAGED", location_id: "SS0001", units: 1 },
      { code_type: "PACK", status: "RECALLED", location_id: "SS0001", units: 1 },
    ]);
    // The expected case, reported for information only (not a fault).
    expect(await d.query(`SELECT sealed_lot_packs_with_own_state FROM db_health`)).toEqual([{ sealed_lot_packs_with_own_state: 2 }]);
    // A rebuild, a delete and a reset agree with the triggers.
    await d.query(`SELECT stock_summary_rebuild()`);
    expect(await stock(d)).toHaveLength(4);
    // A tray and a following pack inserted in one statement, then deleted (codes not issued by a print order).
    await d.exec(`INSERT INTO codes (code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, pack_sequence, lot_code, lot_number, manufacturer_id, status, location_id, generated_at, updated_at)
                  VALUES ('91AAA111OR00002', 'LOT', '91', 'AAA111', 'OR', '00002', 'TRAY', 4, NULL, '91AAA111OR00002', 2, 'MF0001', 'PACKED', 'MF0001', now(), now()),
                         ('91AAA111OR0000241', 'PACK', '91', 'AAA111', 'OR', '00002', 'TRAY', 4, 1, '91AAA111OR00002', 2, 'MF0001', NULL, NULL, now(), now())`);
    expect(await stock(d)).toContainEqual({ code_type: "PACK", status: "PACKED", location_id: "MF0001", units: 1 });
    await d.exec(`DELETE FROM codes WHERE lot_code = '91AAA111OR00002'`);
    expect(await stock(d)).toHaveLength(4);
  });

  it("a pack inserted without state of its own under an opened lot is refused [4]", async () => {
    const { d } = await openStore();
    const LOT = "91AAA111OR00003";
    const cols = "code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, pack_sequence, lot_code, lot_number, manufacturer_id, status, location_id, generated_at, updated_at";
    await d.exec(`INSERT INTO codes (${cols}) VALUES ('${LOT}', 'LOT', '91', 'AAA111', 'OR', '00003', 'TRAY', 4, NULL, '${LOT}', 3, 'MF0001', 'OPENED', 'SS0001', now(), now())`);
    const pack = (state: string) =>
      d.exec(`INSERT INTO codes (${cols}) VALUES ('${LOT}41', 'PACK', '91', 'AAA111', 'OR', '00003', 'TRAY', 4, 1, '${LOT}', 3, 'MF0001', ${state}, now(), now())`);
    await expect(pack("NULL, NULL")).rejects.toMatchObject({ code: "VZ003" });
    await pack("'AT_SS', 'SS0001'");
    expect(await count(d, `SELECT count(*) AS n FROM codes WHERE lot_code = '${LOT}'`)).toBe(2);
  });

  it("Q6: history is placed by the server's time; a device's own time is only recorded (device_at, NULL unless sent)", async () => {
    const { store, d } = await openStore();
    const m = await store.appendMovement({ type: "RECEIVED", itemKind: "LOT", itemCode: TRAY, fromId: "MF0001", toId: "SS0001", fromStatus: "IN_TRANSIT", toStatus: "AT_SS", userId: "AD0001", deviceId: null, invoice: null, note: null });
    expect(await d.query(`SELECT device_at FROM code_history WHERE event_id = '${m.id}'`)).toEqual([{ device_at: null }]);
    // A device time far in the future changes nothing about where the row goes.
    await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time, device_at) VALUES (gen_random_uuid(), 'SCAN', 'X', 'SCANNED', now(), now() + interval '3 years')`);
    expect(await count(d, `SELECT count(*) AS n FROM code_history_default`)).toBe(0);
    expect(await d.query(`SELECT pg_get_partkeydef('code_history'::regclass) AS k`)).toEqual([{ k: "RANGE (event_time)" }]);
  });

  it("history ids are UUIDs: an id that is not one is simply not found (no database error)", async () => {
    const { store } = await openStore();
    const m = await store.appendMovement({ type: "RECEIVED", itemKind: "LOT", itemCode: TRAY, fromId: "MF0001", toId: "SS0001", fromStatus: "IN_TRANSIT", toStatus: "AT_SS", userId: "AD0001", deviceId: null, invoice: null, note: null });
    expect(await store.movements.list({ id: m.id })).toEqual([expect.objectContaining({ id: m.id, type: "RECEIVED" })]);
    expect(await store.movements.list({ id: "not-a-uuid" })).toEqual([]);
    expect(await store.movements.list({ id: "reprint-served:x" })).toEqual([]);
    expect((await store.movements.list({ id: ["nope", m.id] })).map((r) => r.id)).toEqual([m.id]);
    expect(await store.reprints.list({ id: "1" })).toEqual([]);
    expect(await store.scans.list({ id: [] })).toEqual([]);
  });

  it("a served reprint's fixed id can be written once for all time, even in another month", async () => {
    const { d } = await openStore();
    const id = reprintServedId(REPRINT_ID);
    const served = (at: string) =>
      d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES ('${id}', 'MOVEMENT', '${TRAY}', 'REPRINT_SERVED', '${at}')`);
    await served(new Date().toISOString());
    await expect(served(new Date(Date.now() + 40 * 86_400_000).toISOString())).rejects.toMatchObject({ code: "23505" });
    // Other events with equal ids at different times are not this table's business (random UUIDs never repeat).
    expect(await count(d, `SELECT count(*) AS n FROM code_history_once`)).toBe(1);
  });

  it("damage reports and photo records: a report per DAMAGED event, photos 0 (barcode) to 4, only images, SHA-256", async () => {
    const { d } = await openStore();
    const report = "00000000-0000-4000-8000-000000000004";
    await d.exec(`INSERT INTO damage_reports (report_id, code, item_kind, partner_id, reason, packs_affected, reported_by, reported_at)
                  VALUES ('${report}', '${TRAY}41', 'PACK', 'SS0001', 'Can dented', 1, 'AD0001', now())`);
    const photo = (seq: number, kind: string, type = "image/jpeg") =>
      d.exec(`INSERT INTO attachments (report_id, kind, seq, storage_key, content_type, size_bytes, sha256, uploaded_at)
              VALUES ('${report}', '${kind}', ${seq}, 'damage/2026/11/${report}/${seq}.jpg', '${type}', 1000, repeat('a', 64), now())`);
    await photo(0, "BARCODE_PHOTO");
    await photo(1, "DAMAGE_PHOTO");
    await expect(photo(2, "BARCODE_PHOTO")).rejects.toThrow(/attachments_kind_matches_seq/);
    await expect(photo(3, "DAMAGE_PHOTO", "image/gif")).rejects.toThrow(/content_type/);
    await expect(photo(1, "DAMAGE_PHOTO")).rejects.toThrow(/storage_key|attachments_report_seq/);
    await expect(
      d.exec(`INSERT INTO damage_reports (report_id, code, item_kind, partner_id, reason, packs_affected, reported_at) VALUES (gen_random_uuid(), '${TRAY}', 'LOT', 'SS0001', '  ', 6, now())`),
    ).rejects.toThrow(/reason/);
  });

  it("a reset (seed, JSON import) empties the v11 tables too", async () => {
    const { store, d } = await openStore();
    await d.exec(`INSERT INTO damage_reports (report_id, code, item_kind, partner_id, reason, packs_affected, reported_at)
                  VALUES (gen_random_uuid(), '${TRAY}', 'LOT', 'SS0001', 'Crushed', 6, now())`);
    await store.reset(data());
    expect(await count(d, `SELECT count(*) AS n FROM damage_reports`)).toBe(0);
    expect(await count(d, `SELECT count(*) AS n FROM codes`)).toBe(7);
  });

  it("[6] reprints and public lookups have small indexes of their own; whole-history indexes of v10 are gone", async () => {
    const { d } = await openStore();
    const indexes = (await d.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'code_history'`)).map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(["code_history_reprints", "code_history_public_lookups", "code_history_rare_events", "code_history_failed_scans", "code_history_time_brin"]));
    expect(indexes).not.toContain("code_history_type_event");
    expect(indexes).not.toContain("code_history_time");
    /** Definitions of the indexes a query's plan uses (on the history months, the copies of the parent's indexes). */
    const indexesUsed = async (sql: string) => {
      const plan = await d.transaction(async (q) => {
        await q(`SET LOCAL enable_seqscan = off`);
        return (await q<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`)).map((r) => r["QUERY PLAN"]).join("\n");
      });
      const names = [...plan.matchAll(/Index (?:Only )?Scan (?:Backward )?(?:using|on) (\S+)/g)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(0);
      return (await d.query<{ def: string }>(`SELECT DISTINCT pg_get_indexdef(c.oid) AS def FROM pg_class c WHERE c.relname = ANY($1::text[])`, [names])).map((r) => r.def);
    };
    for (const def of await indexesUsed(`SELECT * FROM code_history WHERE record_type = 'REPRINT' AND event_time > now() - interval '90 days'`)) {
      expect(def).toContain(`WHERE (record_type = 'REPRINT'::text)`);
    }
    for (const def of await indexesUsed(`SELECT * FROM code_history WHERE context = 'PUBLIC_LOOKUP' AND event_time > now() - interval '30 days'`)) {
      expect(def).toContain(`WHERE (context = 'PUBLIC_LOOKUP'::text)`);
    }
    // A sealed pack is not in the state index (it holds lots and loose packs only).
    expect(
      (await d.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'codes_location'`))[0].indexdef,
    ).toMatch(/WHERE \(location_id IS NOT NULL\)/);
  });

  it("rare states (dashboard, Damaged list): both halves of the packs filter and the lots read codes_rare_status, never all of codes", async () => {
    // The store over a driver that records its statements, so the plans checked are those of the real store queries.
    const d = await db();
    const sent: { sql: string; params?: unknown[] }[] = [];
    const recording: SqlDriver = {
      label: d.label,
      query: (async (sql: string, params?: unknown[]) => (sent.push({ sql, params }), d.query(sql, params))) as SqlDriver["query"],
      alone: (sql, params) => d.alone(sql, params),
      exec: (sql) => d.exec(sql),
      transaction: (fn, opts) => d.transaction(fn, opts),
      close: () => d.close(),
    };
    const store = new SqlStore(async () => recording, () => data(), { stockRollupIntervalMs: Number.POSITIVE_INFINITY });
    stores.push(store);
    await store.driver();
    // 3,000 sealed trays at SS0001 (21,000 rows), packs following. A few rare ones: 5 trays DAMAGED, 3 RECALLED after
    // damage, 3 RECALLED from AT_SS (a batch recall), and in two sealed trays one pack with a state of its own.
    const lot = (i: string) => `'91AAA111OR' || upper(lpad(to_hex(${i}), 5, '0'))`;
    await d.exec(`
      INSERT INTO codes (code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, pack_sequence, lot_code, lot_number, manufacturer_id, status, location_id, generated_at, updated_at)
      SELECT ${lot("i")}, 'LOT', '91', 'AAA111', 'OR', upper(lpad(to_hex(i), 5, '0')), 'TRAY', 4, NULL, ${lot("i")}, i, 'MF0001', 'AT_SS', 'SS0001', now(), now()
        FROM generate_series(16, 3015) i
      UNION ALL
      SELECT ${lot("i")} || '4' || s, 'PACK', '91', 'AAA111', 'OR', upper(lpad(to_hex(i), 5, '0')), 'TRAY', 4, s, ${lot("i")}, i, 'MF0001', NULL, NULL, now(), now()
        FROM generate_series(16, 3015) i CROSS JOIN generate_series(1, 6) s;
      UPDATE codes SET status = 'DAMAGED' WHERE code_type = 'LOT' AND lot_number BETWEEN 16 AND 20;
      UPDATE codes SET status = 'RECALLED', status_before_recall = 'DAMAGED' WHERE code_type = 'LOT' AND lot_number BETWEEN 21 AND 23;
      UPDATE codes SET status = 'RECALLED', status_before_recall = 'AT_SS' WHERE code_type = 'LOT' AND lot_number BETWEEN 24 AND 26;
      UPDATE codes SET status = 'DAMAGED', location_id = 'SS0001' WHERE code = ${lot("100")} || '41';
      UPDATE codes SET status = 'RECALLED', location_id = 'SS0001', status_before_recall = 'DAMAGED' WHERE code = ${lot("101")} || '41';
      ANALYZE codes;`);

    /** Runs a store read, then EXPLAINs the statement it sent: [index used (parent name), alias] of every scan of codes. */
    const scans = async (read: () => Promise<unknown[]>, expected: number) => {
      sent.length = 0;
      expect(await read()).toHaveLength(expected);
      const { sql, params } = sent.at(-1)!;
      // As in the [6] test, seq scans off; and hash/merge joins off: at 21,000 rows, reading every pack once (seq scan,
      // or a whole other index) and hashing them costs less than 16 codes_lot probes (one per partition) per rare tray,
      // which it stops doing long before crores of rows (a full read grows with the table, the probes don't). The
      // planner still has to find an index for every scan of codes.
      const [row] = await d.transaction(async (q) => {
        await q(`SET LOCAL enable_seqscan = off`);
        await q(`SET LOCAL enable_hashjoin = off`);
        await q(`SET LOCAL enable_mergejoin = off`);
        return q<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      });
      const raw = row["QUERY PLAN"];
      const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
      type PlanNode = { "Node Type": string; "Relation Name"?: string; Alias?: string; "Index Name"?: string; Plans?: PlanNode[] };
      const found: { node: string; index: string | null; alias: string }[] = [];
      const indexesBelow = (n: PlanNode): string[] => [...(n["Index Name"] ? [n["Index Name"]] : []), ...(n.Plans ?? []).flatMap(indexesBelow)];
      const walk = (n: PlanNode) => {
        if (n["Relation Name"]?.startsWith("codes")) {
          // A bitmap heap scan names its table; the index is on the bitmap index scan below it.
          const [index = null] = n["Node Type"] === "Bitmap Heap Scan" ? indexesBelow(n) : n["Index Name"] ? [n["Index Name"]] : [];
          found.push({ node: n["Node Type"], index, alias: n.Alias ?? "" });
        }
        (n.Plans ?? []).forEach(walk);
      };
      walk(plan[0].Plan);
      expect(found.length).toBeGreaterThan(0);
      // Each partition's index is a child of the parent index declared on codes.
      const parents = await d.query<{ child: string; parent: string }>(
        `SELECT c.relname AS child, p.relname AS parent FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
          WHERE c.relname = ANY($1::text[])`,
        [found.map((f) => f.index).filter(Boolean)],
      );
      const parentOf = new Map(parents.map((r) => [r.child, r.parent]));
      return found.map((f) => [f.index === null ? f.node : (parentOf.get(f.index) ?? f.index), f.alias.replace(/_\d+$/, "")]);
    };
    const RARE = "codes_rare_status";
    const only = (pairs: string[][], index: string) => expect(new Set(pairs.map(([i]) => i))).toEqual(new Set([index]));

    // Packs with a state of their own: their own rows, by the index (one scan per partition, no other access to codes).
    only(await scans(() => store.packs.list({ status: "DAMAGED", followsLot: false }), 1), RARE);
    only(await scans(() => store.packs.list({ status: "RECALLED", statusBeforeRecall: "DAMAGED", followsLot: false }), 1), RARE);
    // Packs following their tray: the tray by the index, then its packs by codes_lot.
    for (const pairs of [
      await scans(() => store.packs.list({ status: "DAMAGED", followsLot: true }), 30),
      await scans(() => store.packs.list({ status: "RECALLED", statusBeforeRecall: "DAMAGED", followsLot: true }), 18),
    ]) {
      only(pairs.filter(([, alias]) => alias === "l"), RARE);
      only(pairs.filter(([, alias]) => alias === "p"), "codes_lot");
    }
    // The calls the dashboard and the Damaged list make (both halves in one UNION ALL), and the lots.
    for (const pairs of [
      await scans(() => store.packs.list({ status: "DAMAGED" }), 31),
      await scans(() => store.packs.list({ status: "RECALLED", statusBeforeRecall: "DAMAGED" }), 19),
    ]) {
      expect(new Set(pairs.map(([i]) => i))).toEqual(new Set([RARE, "codes_lot"]));
    }
    only(await scans(() => store.lots.list({ status: "DAMAGED" }), 5), RARE);
    only(await scans(() => store.lots.list({ status: "RECALLED", statusBeforeRecall: "DAMAGED" }), 3), RARE);
    only(await scans(() => store.lots.list({ status: "RECALLED", synced: true }), 6), RARE);
    // Following packs and the common states are not in it.
    expect(await count(d, `SELECT count(*) AS n FROM codes WHERE status IN ('DAMAGED', 'RECALLED', 'OPENED', 'QUARANTINED')`)).toBe(13);
    expect((await d.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = '${RARE}'`))[0].indexdef).toContain(
      "WHERE (status = ANY (ARRAY['DAMAGED'::text, 'RECALLED'::text, 'OPENED'::text, 'QUARANTINED'::text]))",
    );
  });
});

// ---------------------------------------------------------------------------------------------- history months

const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000); // the India-time wall clock of an instant
const monthName = (offset: number) => {
  const now = ist(new Date());
  const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `code_history_${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
};
/** Noon on the 15th of the month `offset` months from now (India time), as an instant. */
const midMonth = (offset: number) => {
  const now = ist(new Date());
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15, 6, 30)).toISOString();
};

describe("schema v11: history months", () => {
  it("[1] a month is made as a plain table and ATTACHed (inserts carry on; not PARTITION OF), waiting at most 5 s for locks", async () => {
    const { d } = await openStore();
    const [fn] = await d.query<{ src: string; config: string[] }>(`SELECT prosrc AS src, proconfig AS config FROM pg_proc WHERE proname = 'code_history_create_month'`);
    expect(fn.src).toMatch(/CREATE TABLE %I \(LIKE code_history/);
    expect(fn.src).toMatch(/ALTER TABLE code_history ATTACH PARTITION %I/);
    expect(fn.src).not.toMatch(/PARTITION OF code_history FOR VALUES/);
    expect(fn.config).toContain("lock_timeout=5s");
    // This month and the next three exist; a month made by it behaves like the others.
    for (const o of [0, 1, 2, 3]) expect(await d.query(`SELECT to_regclass('${monthName(o)}')::text AS t`)).toEqual([{ t: monthName(o) }]);
    expect(await d.query(`SELECT code_history_ensure_partitions(NULL, 5) AS n`)).toEqual([{ n: 2 }]);
    await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES (gen_random_uuid(), 'SCAN', 'X', 'SCANNED', '${midMonth(5)}')`);
    expect(await d.query(`SELECT tableoid::regclass::text AS t FROM code_history`)).toEqual([{ t: monthName(5) }]);
    await expect(d.exec(`DELETE FROM ${monthName(5)}`)).rejects.toThrow(/append-only/);
    // Its indexes were made by the ATTACH.
    expect(await count(d, `SELECT count(*) AS n FROM pg_indexes WHERE tablename = '${monthName(5)}'`)).toBe(
      await count(d, `SELECT count(*) AS n FROM pg_indexes WHERE tablename = '${monthName(0)}'`),
    );
  });

  it("[2] rows dated in a month without a partition don't stop the daily job; the owner's repair moves them into their month", async () => {
    const { d } = await openStore();
    const stray = "00000000-0000-4000-8000-0000000000aa";
    const served = reprintServedId(REPRINT_ID);
    // A plant PC with its clock 8 months ahead: the rows land in the default partition (a scan and a served reprint).
    await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES
                    ('${stray}', 'SCAN', 'X', 'SCANNED', '${midMonth(8)}'),
                    ('${served}', 'MOVEMENT', '${TRAY}', 'REPRINT_SERVED', '${midMonth(8)}')`);
    expect(await count(d, `SELECT count(*) AS n FROM code_history_default`)).toBe(2);
    // Making months up to that one skips it (PostgreSQL would refuse it) instead of failing, and says so.
    expect(await d.query(`SELECT code_history_ensure_partitions(NULL, 10) AS n`)).toEqual([{ n: 6 }]); // +4…+10 except +8
    expect(await d.query(`SELECT to_regclass('${monthName(8)}') AS t`)).toEqual([{ t: null }]);
    const daily = (await d.query<{ r: Record<string, unknown> }>(`SELECT velza_daily_maintenance() AS r`))[0].r;
    expect(daily).toMatchObject({ ok: false, history_rows_without_partition: 2, partitions_created: 0 });

    expect(await d.query(`SELECT code_history_repair_default() AS n`)).toEqual([{ n: 2 }]);
    expect(await count(d, `SELECT count(*) AS n FROM code_history_default`)).toBe(0);
    expect(await d.query(`SELECT event_id::text AS id, tableoid::regclass::text AS t FROM code_history ORDER BY history_id`)).toEqual([
      { id: stray, t: monthName(8) },
      { id: served, t: monthName(8) },
    ]);
    // The default partition is the safety net again: attached, append-only, empty.
    expect(await d.query(`SELECT count(*)::int AS n FROM pg_inherits WHERE inhrelid = 'code_history_default'::regclass`)).toEqual([{ n: 1 }]);
    await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES (gen_random_uuid(), 'SCAN', 'Y', 'SCANNED', '${midMonth(30)}')`);
    await expect(d.exec(`DELETE FROM code_history_default`)).rejects.toThrow(/append-only/);
    expect((await d.query<{ r: Record<string, unknown> }>(`SELECT velza_daily_maintenance() AS r`))[0].r).toMatchObject({ history_rows_without_partition: 1 });
    // The served reprint keeps its once-only guard after the move.
    expect(await count(d, `SELECT count(*) AS n FROM code_history_once`)).toBe(1);
  });

  it("[3] callers can only make months from last month on, at most 24 months ahead", async () => {
    const { d } = await openStore();
    await expect(d.query(`SELECT code_history_ensure_partitions('1900-01-01')`)).rejects.toThrow(/before last month/);
    await expect(d.query(`SELECT code_history_ensure_partitions((now() - interval '2 months')::date)`)).rejects.toThrow(/before last month/);
    await expect(d.query(`SELECT code_history_ensure_partitions(NULL, 25)`)).rejects.toThrow(/between 0 and 24/);
    expect(await d.query(`SELECT code_history_ensure_partitions((now() - interval '1 month')::date, 0) AS n`)).toEqual([{ n: 1 }]);
    // The owner makes any month it needs (a data migration) one at a time.
    expect(await d.query(`SELECT code_history_create_month('2020-01-01') AS made`)).toEqual([{ made: true }]);
    expect(await d.query(`SELECT code_history_create_month('2020-01-31') AS made`)).toEqual([{ made: false }]);
  });

  it("months follow India time, whatever the session's time zone", async () => {
    const { d } = await openStore();
    await d.exec(`SET TIME ZONE 'America/New_York'`);
    await d.exec(`SELECT code_history_create_month('2026-11-01'), code_history_create_month('2026-12-01')`);
    const range = (await d.query<{ range: string }>(`SELECT range FROM db_history_partitions WHERE partition_name = 'code_history_2026_12'`))[0].range;
    await d.exec(`SET TIME ZONE 'UTC'`);
    // 1 Dec 00:00 IST = 30 Nov 18:30 UTC.
    expect(range).toContain("2026-11-30 13:30:00-05");
    await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES
                    (gen_random_uuid(), 'SCAN', 'A', 'SCANNED', '2026-11-30 23:59:59.999+05:30'),
                    (gen_random_uuid(), 'SCAN', 'B', 'SCANNED', '2026-12-01 00:00:00+05:30')`);
    expect(await d.query(`SELECT code, tableoid::regclass::text AS t FROM code_history ORDER BY code`)).toEqual([
      { code: "A", t: "code_history_2026_11" },
      { code: "B", t: "code_history_2026_12" },
    ]);
  });

  it("the app keeps the next months made by itself where no job runs (at most every few hours per process)", async () => {
    const { store, d } = await openStore(0);
    await d.exec(`DROP TABLE ${monthName(3)}`);
    await store.transaction((tx) => tx.lots.update(TRAY, { updatedAt: AT }));
    await store.stockRollupIdle();
    expect(await d.query(`SELECT to_regclass('${monthName(3)}')::text AS t`)).toEqual([{ t: monthName(3) }]);
  });

  it("db_table_sizes and db_history_partitions describe the database", async () => {
    const { d } = await openStore();
    const sizes = await d.query<{ table_name: string; parts: string }>(`SELECT table_name, parts FROM db_table_sizes WHERE table_name IN ('codes', 'code_history') ORDER BY 1`);
    // parts = the partitions holding the rows: 4 months + the default; 16 hash parts.
    expect(sizes.map((s) => [s.table_name, Number(s.parts)])).toEqual([["code_history", 5], ["codes", 16]]);
    expect(await count(d, `SELECT count(*) AS n FROM db_history_partitions WHERE months_old = 0`)).toBe(1);
    expect(await count(d, `SELECT count(*) AS n FROM pg_inherits WHERE inhparent = 'codes'::regclass`)).toBe(16);
  });
});
