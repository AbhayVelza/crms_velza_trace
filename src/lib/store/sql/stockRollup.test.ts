// The live stock summary folds its deltas by itself (no jobs container on Vercel): at most once per interval per
// process, after a successful transaction or a stock summary read, outside the caller's transaction, never failing
// or delaying the request. Embedded PostgreSQL (PGlite); the same SQL runs on a real server.

import { afterEach, describe, expect, it, vi } from "vitest";

// next/server's after() throws outside a request scope (as in scripts and these tests); one test plays a request.
const nextAfter = vi.hoisted(() => ({
  fn: (() => {
    throw new Error("`after` was called outside a request scope");
  }) as (task: unknown) => void,
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: unknown) => nextAfter.fn(task) }));
import type { Batch, Lot, Pack, Partner, PrintOrder } from "@/lib/core/types";
import { buildBaseSeed } from "../seedData";
import type { DbSnapshot } from "../Store";
import { createPgliteDriver, type SqlDriver } from "./driver";
import { SqlStore } from "./sqlStore";

const AT = "2026-11-20T10:00:00.000Z";
const plant: Partner = {
  id: "MF0001",
  type: "MANUFACTURER",
  name: "Plant",
  place: "Chakan",
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
const ss: Partner = { ...plant, id: "SS0001", type: "SS", name: "SS Maharashtra" };
const batch: Batch = {
  id: "batch-AAA111",
  code: "AAA111",
  country: "91",
  flavour: "OR",
  mfgDate: "2026-11-01",
  expiryDate: "2027-05-01",
  manufacturerId: "MF0001",
  deviceId: "dev-1",
  nextLot: 1,
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
const seed = (): DbSnapshot => ({
  ...buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" }),
  partners: [plant, ss],
  devices: [{ id: "dev-1", manufacturerId: "MF0001", name: "Plant PC", offline: false, lastSyncAt: null }],
  batches: [batch],
  printOrders: [order],
});

const lotCode = (n: number) => `91AAA111OR${n.toString(16).toUpperCase().padStart(5, "0")}`;
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
const packsOf = (l: Lot): Pack[] =>
  [1, 2, 3, 4].map((seq) => ({
    id: `${l.lotCode}6${seq}`,
    packCode: `${l.lotCode}6${seq}`,
    lotCode: l.lotCode,
    seq,
    packSize: 6,
    status: "PACKED",
    locationId: "MF0001",
    inTransitToId: null,
    dispatchedAt: null,
    statusBeforeRecall: null,
    createdAt: AT,
    updatedAt: AT,
  }));

// What stock_current must always equal: a full recount of codes by effective state (view stock_recount, v11 Option C: a
// pack that follows its sealed lot counts under the lot's state), the logic of `npm run db:stock -- check`.
const KEY = "location_id, status, code_type, lot_type, flavour, synced";
const recount = `SELECT ${KEY}, units FROM stock_recount ORDER BY ${KEY}`;
const current = `SELECT ${KEY}, units FROM stock_current ORDER BY ${KEY}`;
const deltaRows = async (d: SqlDriver) => Number((await d.query<{ n: string }>(`SELECT count(*) AS n FROM stock_deltas`))[0].n);

const stores: SqlStore[] = [];
async function open(stockRollupIntervalMs?: number) {
  const store = new SqlStore(() => createPgliteDriver(), seed, { stockRollupIntervalMs });
  stores.push(store);
  return { store, d: await store.driver() };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((s) => s.close()));
});

/** Many small write transactions: create lots with packs, dispatch some, receive them, damage a pack. */
async function manyWrites(store: SqlStore, lots = 30) {
  for (let n = 1; n <= lots; n++) {
    const l = lot(n);
    await store.transaction(async (tx) => {
      await tx.lots.create(l);
      await tx.packs.createMany(packsOf(l));
    });
  }
  for (let n = 1; n <= lots; n += 2) {
    const code = lotCode(n);
    await store.transaction(async (tx) => {
      await tx.lots.update(code, { status: "IN_TRANSIT", inTransitToId: "SS0001", dispatchedAt: AT });
      await tx.packs.updateWhere({ lotCode: code }, { status: "IN_TRANSIT", inTransitToId: "SS0001", dispatchedAt: AT });
    });
    await store.transaction(async (tx) => {
      await tx.lots.update(code, { status: "AT_SS", locationId: "SS0001", inTransitToId: null, dispatchedAt: null });
      await tx.packs.updateWhere({ lotCode: code }, { status: "AT_SS", locationId: "SS0001", inTransitToId: null, dispatchedAt: null });
    });
  }
  await store.transaction((tx) => tx.packs.update(`${lotCode(2)}63`, { status: "DAMAGED" }));
}

describe("in-app stock rollup", () => {
  it("after many writes stock_deltas is folded and stock_current still equals a recount of codes", async () => {
    const { store, d } = await open(0); // every transaction may fold (the default is once a minute)
    await manyWrites(store);
    await store.stockRollupIdle();
    // The last write's deltas were folded by the rollup that followed it.
    expect(await deltaRows(d)).toBe(0);
    expect(Number((await d.query<{ n: string }>(`SELECT count(*) AS n FROM stock_summary`))[0].n)).toBeGreaterThan(0);
    expect(await d.query(current)).toEqual(await d.query(recount));
    // The store's own summary read agrees too.
    const units = (await store.stockSummary()).reduce((s, r) => s + r.units, 0);
    expect(units).toBe(30 * 5);
  });

  it("runs at most once per interval per process (default: a minute)", async () => {
    const { store, d } = await open();
    const alone = vi.spyOn(d, "alone");
    await manyWrites(store, 6);
    await store.stockSummary();
    await store.stockRollupIdle();
    expect(alone.mock.calls.filter(([sql]) => sql.includes("stock_summary_rollup"))).toHaveLength(1);
    // Later deltas wait for the next run (counts are exact meanwhile).
    expect(await deltaRows(d)).toBeGreaterThan(0);
    expect(await d.query(current)).toEqual(await d.query(recount));
  });

  it("a stock summary read starts a rollup too", async () => {
    const { store, d } = await open(Number.POSITIVE_INFINITY); // nothing folds while writing
    await manyWrites(store, 4);
    expect(await deltaRows(d)).toBeGreaterThan(0);
    const reading = new SqlStore(async () => d, null, { stockRollupIntervalMs: 0 });
    await reading.stockSummary();
    await reading.stockRollupIdle();
    expect(await deltaRows(d)).toBe(0);
    expect(await d.query(current)).toEqual(await d.query(recount));
  });

  it("a failing rollup never fails or changes the user's transaction; it is logged", async () => {
    const { store, d } = await open(0);
    await d.exec(`CREATE OR REPLACE FUNCTION stock_summary_rollup() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;`);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const l = lot(1);
    await expect(store.transaction((tx) => tx.lots.create(l))).resolves.toMatchObject({ lotCode: l.lotCode });
    await store.stockRollupIdle();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Stock summary rollup failed"), expect.stringContaining("boom"));
    expect(await store.lots.get(l.lotCode)).toMatchObject({ status: "PACKED" });
    // The next transaction works normally too (the failure did not spoil the single embedded connection).
    await expect(store.transaction((tx) => tx.packs.createMany(packsOf(l)))).resolves.toBeUndefined();
    expect(await d.query(current)).toEqual(await d.query(recount));
  });

  it("inside a request the rollup is handed to after(), and the request still doesn't wait for it", async () => {
    const { store, d } = await open(Number.POSITIVE_INFINITY);
    await manyWrites(store, 3);
    const tasks: unknown[] = [];
    nextAfter.fn = (task) => void tasks.push(task);
    // Hold the rollup until the test lets it go: the caller's call must come back before that.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realAlone = d.alone.bind(d);
    vi.spyOn(d, "alone").mockImplementation(async (sql, params) => {
      await gate;
      return realAlone(sql, params);
    });
    try {
      const reading = new SqlStore(async () => d, null, { stockRollupIntervalMs: 0 });
      const units = (await reading.stockSummary()).reduce((s, r) => s + r.units, 0);
      expect(units).toBeGreaterThan(0);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toBeInstanceOf(Promise);
      expect(await deltaRows(d)).toBeGreaterThan(0); // not folded yet: the read did not wait
      release();
      await tasks[0];
      await reading.stockRollupIdle();
      expect(await deltaRows(d)).toBe(0);
      expect(await d.query(current)).toEqual(await d.query(recount));
    } finally {
      nextAfter.fn = () => {
        throw new Error("`after` was called outside a request scope");
      };
    }
  });

  it("stock_summary_rollup() never waits for another rollup: it takes the lock with pg_try_advisory_xact_lock", async () => {
    // PGlite has a single session (advisory locks can't be contended here); check the function itself.
    const { d } = await open();
    const [fn] = await d.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'stock_summary_rollup'`);
    expect(fn.src).toContain("pg_try_advisory_xact_lock(hashtext('velza_stock_summary'))");
    expect(fn.src).not.toMatch(/PERFORM pg_advisory_xact_lock/);
    // Rebuild still waits for the lock (it must not run beside a rollup).
    const [rebuild] = await d.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'stock_summary_rebuild'`);
    expect(rebuild.src).toContain("PERFORM pg_advisory_xact_lock(hashtext('velza_stock_summary'))");
  });
});
