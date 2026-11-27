// Schema v10 upgrade on embedded PostgreSQL (the same SQL runs on a real server): a v9 database gains the foreign keys
// (validated) and container_items (filled from containers.lot_codes); rows pointing at missing rows stop the upgrade
// with a message naming them and change nothing; data loaded by a reset / import is checked the same way; triggers keep
// container_items equal to lot_codes whoever writes containers (a rolled-back v9 release writes only lot_codes).

import { afterEach, describe, expect, it } from "vitest";
import type { BatchCodePoolEntry, Container, Device, Lot, Partner, PrintOrder } from "@/lib/core/types";
import { buildBaseSeed } from "../seedData";
import type { DbSnapshot } from "../Store";
import { createPgliteDriver, type SqlDriver } from "./driver";
import { SCHEMA_VERSION } from "./schema";
import { SqlStore } from "./sqlStore";

const AT = "2026-11-18T08:00:00.000Z";
const plant: Partner = {
  id: "MF0001",
  type: "MANUFACTURER",
  name: "Plant",
  place: "",
  address: "",
  city: "Pune",
  state: "Maharashtra",
  pincode: "",
  contactPerson: "",
  phone: "",
  email: "",
  parentId: null,
  active: true,
  approval: null,
  createdAt: AT,
  createdBy: "AD0001",
};
const customs: Partner = { ...plant, id: "VW0001", type: "WAREHOUSE", name: "Customs", city: "Thane" };
const device: Device = { id: "dev-1", manufacturerId: "MF0001", name: "Plant PC", offline: false, lastSyncAt: null };
const pool = (code: string, status: BatchCodePoolEntry["status"] = "RESERVED", deviceId = "dev-1"): BatchCodePoolEntry => ({ id: `pool-${code}`, code, deviceId, status, issuedAt: AT, usedAt: null });
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
const lotCode = (n: number) => `91AAA111OR0000${n}`;
const lot = (n: number): Lot => ({
  id: lotCode(n),
  lotCode: lotCode(n),
  batchCode: "AAA111",
  flavour: "OR",
  lotType: "CASE",
  packSize: 6,
  lotNumber: n,
  status: "PACKED",
  locationId: "MF0001",
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
});
const container = (id: string, code: string, lotCodes: string[], over: Partial<Container> = {}): Container => ({
  id,
  code,
  manufacturerId: "MF0001",
  status: "CLEARED",
  lotCodes,
  toId: "VW0001",
  invoice: "INV-1",
  createdAt: AT,
  createdBy: "AD0001",
  dispatchedAt: AT,
  dispatchedBy: "AD0001",
  receivedAt: AT,
  receivedBy: "AD0001",
  ...over,
});
const data = (): DbSnapshot => ({
  ...buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" }),
  partners: [plant, customs],
  devices: [device],
  batchCodePool: [pool("AAA111", "USED"), pool("BBB222")],
  batches: [
    {
      id: "batch-AAA111",
      code: "AAA111",
      country: "91",
      flavour: "OR",
      mfgDate: "2026-11-01",
      expiryDate: "2027-05-01",
      manufacturerId: "MF0001",
      deviceId: "dev-1",
      nextLot: 4,
      status: "ACTIVE",
      synced: true,
      printOrderId: "po-1",
      createdAt: AT,
      createdBy: "AD0001",
      recalledAt: null,
      recallReason: null,
    },
  ],
  printOrders: [order],
  lots: [lot(1), lot(2), lot(3)],
  containers: [
    container("c-1", "CONT0001", [lotCode(1), lotCode(2)], { createdAt: "2026-11-17T06:00:00.000Z" }),
    // Opened by a sign-in that no longer exists: its lots are back-filled with loaded_by NULL.
    container("c-2", "CONT0002", [lotCode(3)], { createdBy: "MF0001-OP", status: "LOADING", toId: null, dispatchedAt: null }),
  ],
});

const FKS = ["print_orders_manufacturer_id_fkey", "containers_manufacturer_id_fkey", "containers_to_partner_id_fkey", "codes_print_order_id_fkey", "batch_code_pool_device_id_fkey"];

/** Turn a v10 database back into what v9 had: no container_items or its triggers, none of the five foreign keys, version 9. */
async function makeV9(d: SqlDriver) {
  await d.exec(`
    DROP TRIGGER container_items_follow ON containers;
    DROP TRIGGER container_items_delete ON containers;
    DROP FUNCTION container_items_follow_lot_codes();
    DROP FUNCTION container_items_on_container_delete();
    DROP TABLE container_items;
    ALTER TABLE print_orders DROP CONSTRAINT print_orders_manufacturer_id_fkey;
    ALTER TABLE containers DROP CONSTRAINT containers_manufacturer_id_fkey, DROP CONSTRAINT containers_to_partner_id_fkey;
    ALTER TABLE codes DROP CONSTRAINT codes_print_order_id_fkey;
    ALTER TABLE batch_code_pool DROP CONSTRAINT batch_code_pool_device_id_fkey;
    UPDATE schema_info SET version = 9;
  `);
}

const stores: SqlStore[] = [];
async function openWith(snapshot: DbSnapshot) {
  const store = new SqlStore(() => createPgliteDriver(), () => snapshot, { stockRollupIntervalMs: Number.POSITIVE_INFINITY });
  stores.push(store);
  const d = await store.driver();
  return { store, d };
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});

const version = async (d: SqlDriver) => Number((await d.query<{ version: number }>(`SELECT version FROM schema_info`))[0].version);

describe("schema v10", () => {
  it("is part of the current schema", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10); // v11 builds on it (schemaV11.test.ts)
  });

  it("upgrades a v9 database: container_items back-filled from lot_codes, the five foreign keys validated", async () => {
    const { d } = await openWith(data());
    await makeV9(d);
    expect(await d.query(`SELECT to_regclass('container_items') AS t`)).toEqual([{ t: null }]);

    // The next start of the app on this database upgrades it (driver() applies the schema when the version is older).
    const upgraded = new SqlStore(async () => d, null, { stockRollupIntervalMs: Number.POSITIVE_INFINITY });
    await upgraded.driver();
    expect(await version(d)).toBe(SCHEMA_VERSION);

    const items = await d.query<{ container_id: string; lot_code: string; loaded_at: string; loaded_by: string | null }>(
      `SELECT container_id, lot_code, to_char(loaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS loaded_at, loaded_by FROM container_items ORDER BY container_id, lot_code`,
    );
    expect(items).toEqual([
      { container_id: "c-1", lot_code: lotCode(1), loaded_at: "2026-11-17T06:00:00.000Z", loaded_by: "AD0001" },
      { container_id: "c-1", lot_code: lotCode(2), loaded_at: "2026-11-17T06:00:00.000Z", loaded_by: "AD0001" },
      { container_id: "c-2", lot_code: lotCode(3), loaded_at: AT, loaded_by: null }, // MF0001-OP is not a sign-in here
    ]);

    const fks = await d.query<{ conname: string; convalidated: boolean; condeferrable: boolean; condeferred: boolean }>(
      // conparentid = 0: the table's own constraint, not its copies on the partitions of codes (v11).
      `SELECT conname, convalidated, condeferrable, condeferred FROM pg_constraint WHERE conname = ANY($1::text[]) AND conparentid = 0 ORDER BY conname`,
      [FKS],
    );
    expect(fks).toEqual([...FKS].sort().map((conname) => ({ conname, convalidated: true, condeferrable: true, condeferred: true })));
    // A lot may be in several containers over its life: no unique index on lot_code alone.
    const unique = await d.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'container_items' AND indexdef ILIKE '%UNIQUE%' AND indexname <> 'container_items_pkey'`);
    expect(unique).toEqual([]);

    // Running the schema again (npm run db:migrate) changes nothing: no second back-fill, constraints stay.
    await upgraded.migrate();
    expect((await d.query(`SELECT count(*)::int AS n FROM container_items`))[0]).toEqual({ n: 3 });
    expect(await version(d)).toBe(SCHEMA_VERSION);
  });

  it("stops the upgrade on rows that point at missing rows, names them, and changes nothing", async () => {
    const { d } = await openWith(data());
    await makeV9(d);
    await d.exec(`
      INSERT INTO batch_code_pool (id, batch_code, device_id, status, issued_at) VALUES ('pool-ghost', 'GHO999', 'gone-pc', 'RESERVED', now());
      INSERT INTO print_orders (print_order_id, created_at, created_by, device_id, manufacturer_id, batch_codes, lot_codes, sticker_count, status, synced)
        VALUES ('po-ghost', now(), 'AD0001', 'dev-1', 'MF0999', '{}', '{}', 0, 'CREATED', true);
      UPDATE containers SET lot_codes = lot_codes || '{91ZZZ999OR00001}' WHERE container_id = 'c-1';
    `);
    const upgrade = new SqlStore(async () => d, null);
    const failure = await upgrade.driver().then(
      () => null,
      (e: Error) => e.message,
    );
    expect(failure).toMatch(/Schema v10 found rows that point at rows which do not exist/);
    expect(failure).toMatch(/print_orders with an unknown manufacturer_id: 1;/);
    expect(failure).toMatch(/containers with an unknown manufacturer_id: 0;/);
    expect(failure).toMatch(/codes with an unknown print_order_id: 0;/);
    expect(failure).toMatch(/batch_code_pool rows with an unknown device_id: 1;/);
    expect(failure).toMatch(/containers\.lot_codes entries that are not codes: 1\./);
    // Nothing changed: still v9, no new table, no constraint, the orphan rows still there.
    expect(await version(d)).toBe(9);
    expect(await d.query(`SELECT to_regclass('container_items') AS t`)).toEqual([{ t: null }]);
    expect(await d.query(`SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`, [FKS])).toEqual([]);
    expect((await d.query(`SELECT count(*)::int AS n FROM batch_code_pool WHERE device_id = 'gone-pc'`))[0]).toEqual({ n: 1 });
  });

  it("the database refuses new orphans: a code naming a missing print order, a pool row of a missing device", async () => {
    const { store } = await openWith(data());
    await expect(store.lots.create({ ...lot(4), printOrderId: "po-missing" })).rejects.toThrow(/codes_print_order_id_fkey/);
    await expect(store.batchCodePool.create(pool("CCC333", "RESERVED", "no-such-pc"))).rejects.toThrow(/batch_code_pool_device_id_fkey/);
    await expect(store.containers.create(container("c-9", "CONT0009", [], { toId: "SS0404" }))).rejects.toThrow(/containers_to_partner_id_fkey/);
    await expect(store.printOrders.create({ ...order, id: "po-9", manufacturerId: "MF0404" })).rejects.toThrow(/print_orders_manufacturer_id_fkey/);
    // History is permanent: a device with batch codes issued to it can't be deleted underneath them.
    await expect(store.devices.delete("dev-1")).rejects.toThrow(/batch_code_pool_device_id_fkey/);
    expect(await store.devices.get("dev-1")).not.toBeNull();
  });

  it("container_items follows containers written with plain SQL, as a rolled-back v9 release would (no app code)", async () => {
    const { d } = await openWith(data());
    const items = async () =>
      (await d.query<{ container_id: string; lot_code: string; fresh: boolean; loaded_by: string | null }>(
        `SELECT container_id, lot_code, loaded_at > now() - interval '1 hour' AS fresh, loaded_by FROM container_items ORDER BY container_id, lot_code`,
      )).map((r) => `${r.container_id}|${r.lot_code}|${r.fresh ? "now" : "opened"}|${r.loaded_by}`);
    const cols = `container_id, container_code, manufacturer_id, status, lot_codes, to_partner_id, created_at, created_by`;

    // A new container: its lots count as loaded when it was opened, by whoever opened it (NULL if not a sign-in).
    await d.exec(`INSERT INTO containers (${cols}) VALUES ('c-3', 'CONT0003', 'MF0001', 'LOADING', '{}', NULL, '${AT}', 'AD0001')`);
    await d.exec(`INSERT INTO containers (${cols}) VALUES ('c-4', 'CONT0004', 'MF0001', 'LOADING', ARRAY['${lotCode(1)}'], NULL, '${AT}', 'MF0001-OP')`);
    expect((await items()).filter((r) => /^c-[34]/.test(r))).toEqual([`c-4|${lotCode(1)}|opened|null`]);

    // Lots loaded later are stamped now; lots taken out go; a write that leaves lot_codes alone changes nothing.
    await d.exec(`UPDATE containers SET lot_codes = ARRAY['${lotCode(2)}', '${lotCode(3)}'] WHERE container_id = 'c-3'`);
    await d.exec(`UPDATE containers SET lot_codes = ARRAY['${lotCode(3)}'] WHERE container_id = 'c-3'`);
    await d.exec(`UPDATE containers SET status = 'IN_TRANSIT', to_partner_id = 'VW0001', dispatched_at = now() WHERE container_id = 'c-3'`);
    expect((await items()).filter((r) => r.startsWith("c-3"))).toEqual([`c-3|${lotCode(3)}|now|AD0001`]);

    // Every container still matches its array, the old ones too.
    const pairs = async () => (await d.query<{ p: string }>(`SELECT container_id || '|' || unnest(lot_codes) AS p FROM containers ORDER BY 1`)).map((r) => r.p);
    expect((await items()).map((r) => r.split("|").slice(0, 2).join("|"))).toEqual(await pairs());

    // Deleting a container takes its items with it (the deferred foreign key would refuse the commit otherwise).
    await d.exec(`DELETE FROM containers WHERE container_id IN ('c-3', 'c-4')`);
    expect((await items()).filter((r) => /^c-[34]/.test(r))).toEqual([]);
    expect((await items()).map((r) => r.split("|").slice(0, 2).join("|"))).toEqual(await pairs());

    // Applying the schema again (db:migrate) keeps one trigger of each.
    await new SqlStore(async () => d, null, { stockRollupIntervalMs: Number.POSITIVE_INFINITY }).migrate();
    const triggers = await d.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'containers'::regclass AND NOT tgisinternal ORDER BY tgname`);
    expect(triggers.map((t) => t.tgname)).toEqual(["container_items_delete", "container_items_follow"]);
  });

  it("a reset / JSON import whose data refers to missing rows is refused with a clear message; the old data stays", async () => {
    const { store } = await openWith(data());
    const bad = data();
    bad.devices = []; // pool rows still name dev-1
    await expect(store.reset(bad)).rejects.toThrow(/The data refers to rows that are not in it: .*batch_code_pool_device_id_fkey.*Nothing was changed\./);
    expect((await store.devices.list()).map((x) => x.id)).toEqual(["dev-1"]);
    expect(await store.batchCodePool.list()).toHaveLength(2);
  });
});
