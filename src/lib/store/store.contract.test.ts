// The Store contract, run against every implementation: the JSON file and PostgreSQL (embedded
// PGlite here; the same SQL runs on a real server). Business logic relies on exactly this behaviour.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Batch, Lot, Pack, Partner, PrintOrder } from "@/lib/core/types";
import { JsonStore } from "./jsonStore";
import { buildBaseSeed } from "./seedData";
import { createPgliteDriver } from "./sql/driver";
import { SqlStore } from "./sql/sqlStore";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./sql/schema";
import type { DbSnapshot, StockSummaryRow, Store } from "./Store";

const AT = "2026-10-26T10:00:00.000Z";
/** A history row's id: the app uses random UUIDs, and the SQL store keeps event ids as uuid (schema v11). */
const R1 = "0b6f2c1e-7d1a-4c3e-9a51-3f4e8d2c1b01";
const seed =buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" });

const plant: Partner = {
  id: "MF0001",
  type: "MANUFACTURER",
  name: "Plant",
  place: "Chakan",
  address: "Plot 1",
  city: "Pune",
  state: "Maharashtra",
  pincode: "410501",
  contactPerson: "Manoj",
  phone: "+91 98000 00001",
  email: "plant@example.com",
  parentId: null,
  active: true,
  approval: null, // approved (the SQL store always returns the column; JSON keeps what was written)
  createdAt: AT,
  createdBy: "AD0001",
};
const ss: Partner = { ...plant, id: "SS0001", type: "SS", name: "SS Maharashtra", phone: "+91 98000 00002", email: "" };
/** A retailer its Super Stockist supplies directly. */
const retailer: Partner = { ...ss, id: "RT0001", type: "RETAILER", name: "Retailer Colaba", phone: "+91 98000 00003", parentId: "SS0001" };

const batch = (code: string, over: Partial<Batch> = {}): Batch => ({
  id: `batch-${code}`,
  code,
  country: "91",
  flavour: "OR",
  mfgDate: "2026-10-01",
  expiryDate: "2027-04-01",
  manufacturerId: "MF0001",
  deviceId: "dev-1",
  nextLot: 1,
  status: "ACTIVE",
  synced: true,
  printOrderId: "po-1",
  createdAt: AT,
  createdBy: "MF0001-OP",
  recalledAt: null,
  recallReason: null,
  ...over,
});

const lot = (code: string, over: Partial<Lot> = {}): Lot => ({
  id: code,
  lotCode: code,
  batchCode: code.slice(2, 8),
  flavour: code.slice(8, 10),
  lotType: "CASE",
  packSize: 6,
  lotNumber: parseInt(code.slice(10), 16),
  status: "GENERATED",
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
  ...over,
});

const packs = (l: Lot): Pack[] =>
  [1, 2, 3, 4].map((seq) => ({
    id: `${l.lotCode}6${seq}`,
    packCode: `${l.lotCode}6${seq}`,
    lotCode: l.lotCode,
    seq,
    packSize: 6,
    status: "GENERATED",
    locationId: "MF0001",
    inTransitToId: null,
    dispatchedAt: null,
    statusBeforeRecall: null,
    createdAt: AT,
    updatedAt: AT,
  }));

/** The print orders the lots below name (schema v10 checks codes → print_orders). */
const order = (id: string): PrintOrder => ({
  id,
  createdAt: AT,
  createdBy: "MF0001-OP",
  deviceId: "dev-1",
  manufacturerId: "MF0001",
  batchCodes: ["AAA111"],
  lotCodes: [],
  stickerCount: 0,
  status: "CREATED",
  printedAt: null,
  synced: true,
  kind: "NEW_BATCH",
  requestFingerprint: null,
});

const withPartners = (): DbSnapshot => ({ ...structuredClone(seed), partners: [plant, ss], printOrders: [order("po-1"), order("po-2")] });

interface Impl {
  name: string;
  open(): Promise<Store>;
  close(store: Store): Promise<void>;
}

const dirs: string[] = [];
const IMPLS: Impl[] = [
  {
    name: "JSON file",
    async open() {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-contract-"));
      dirs.push(dir);
      return new JsonStore(path.join(dir, "db.json"), () => withPartners());
    },
    async close() {},
  },
  {
    name: "PostgreSQL (embedded)",
    async open() {
      return new SqlStore(() => createPgliteDriver(), () => withPartners());
    },
    async close(store) {
      await (store as SqlStore).close();
    },
  },
];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

describe.each(IMPLS)("Store contract: $name", (impl) => {
  let store: Store;
  beforeAll(async () => {
    store = await impl.open();
    // First use of an empty store sets up the first-run seed.
    expect((await store.users.list()).map((u) => u.id)).toEqual(["AD0001", "HQ0001"]);
  });
  afterAll(async () => {
    await impl.close(store);
  });
  beforeEach(async () => {
    await store.reset(withPartners());
  });

  it("starts from the seed: two staff sign-ins, no activity", async () => {
    expect((await store.users.list()).map((u) => u.id)).toEqual(["AD0001", "HQ0001"]);
    expect((await store.flavours.list()).map((f) => f.code)).toEqual(["OR", "GA", "NS", "MN"]);
    expect(await store.lots.list()).toEqual([]);
  });

  it("round-trips every field, timestamps and dates included", async () => {
    expect(await store.partners.get("MF0001")).toEqual(plant);
    const u = (await store.users.get("AD0001"))!;
    expect(u.passwordHash).toMatch(/^scrypt\$/);
    expect(u.passwordChangedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await store.batches.create(batch("AAA111"));
    expect(await store.batches.findOne({ code: "AAA111" })).toEqual(batch("AAA111"));
    const l = lot("91AAA111OR00001");
    await store.lots.create(l);
    await store.packs.createMany(packs(l));
    expect(await store.lots.get(l.id)).toEqual(l);
    expect(await store.packs.list({ lotCode: l.lotCode })).toEqual(packs(l));
    expect(await store.packs.get(`${l.lotCode}63`)).toEqual(packs(l)[2]);
  });

  it("round-trips a retailer, its sign-in and stock at a retailer", async () => {
    await store.partners.create(retailer);
    expect(await store.partners.get("RT0001")).toEqual(retailer);
    const login = { id: "RT0001", name: "Imran", role: "RETAILER" as const, partnerId: "RT0001", active: true, passwordHash: null, passwordChangedAt: null, createdAt: AT, lastLoginAt: null };
    await store.users.create(login);
    expect(await store.users.get("RT0001")).toEqual(login);
    await store.batches.create(batch("AAA111"));
    const l = lot("91AAA111OR00001", { status: "OPENED", locationId: "RT0001" });
    const ps = packs(l).map((p) => ({ ...p, status: "AT_RETAILER" as const, locationId: "RT0001" }));
    await store.lots.create(l);
    await store.packs.createMany(ps);
    await store.lots.update(l.id, { status: "RECALLED", statusBeforeRecall: "OPENED" });
    await store.packs.update(ps[0].id, { status: "RECALLED", statusBeforeRecall: "AT_RETAILER" });
    expect(await store.packs.get(ps[0].id)).toMatchObject({ status: "RECALLED", statusBeforeRecall: "AT_RETAILER", locationId: "RT0001" });
    expect((await store.packs.list({ status: "AT_RETAILER", locationId: "RT0001" })).map((p) => p.seq)).toEqual([2, 3, 4]);
    expect(await store.nextSequence("RT")).toBe(1);
  });

  it("filters by equality, null included, and lists in insertion order", async () => {
    await store.partners.create({ ...ss, id: "SS0002", state: "Goa", phone: "3", parentId: null });
    await store.partners.create({ ...ss, id: "DB0001", type: "DB", name: "DB", phone: "4", parentId: "SS0001" });
    await store.partners.create(retailer);
    await store.partners.create({ ...retailer, id: "RT0002", phone: "5", parentId: "DB0001" });
    expect((await store.partners.list({ parentId: null })).map((p) => p.id)).toEqual(["MF0001", "SS0001", "SS0002"]);
    expect((await store.partners.list({ type: "SS", active: true })).map((p) => p.id)).toEqual(["SS0001", "SS0002"]);
    expect(await store.partners.findOne({ parentId: "SS0001" })).toMatchObject({ id: "DB0001" });
    // An SS's partners: its distributors and the retailers assigned to it directly; a DB's: its retailers.
    expect((await store.partners.list({ parentId: "SS0001" })).map((p) => [p.id, p.type])).toEqual([
      ["DB0001", "DB"],
      ["RT0001", "RETAILER"],
    ]);
    expect((await store.partners.list({ parentId: "DB0001", type: "RETAILER" })).map((p) => p.id)).toEqual(["RT0002"]);
    expect(await store.partners.findOne({ name: "nobody" })).toBeNull();
    expect(await store.partners.get("XX0000")).toBeNull();
  });

  it("filters by 'any of' a list (with equality, null included), in insertion order; an empty list matches nothing", async () => {
    await store.partners.create({ ...ss, id: "DB0001", type: "DB", name: "DB", phone: "4", parentId: "SS0001" });
    await store.partners.create(retailer);
    await store.partners.create({ ...retailer, id: "RT0002", phone: "5", parentId: "DB0001" });
    expect((await store.partners.list({ id: ["RT0002", "MF0001", "XX0000"] })).map((p) => p.id)).toEqual(["MF0001", "RT0002"]);
    expect((await store.partners.list({ parentId: ["SS0001", "DB0001"], type: "RETAILER" })).map((p) => p.id)).toEqual(["RT0001", "RT0002"]);
    expect((await store.partners.list({ parentId: [null, "DB0001"] })).map((p) => p.id)).toEqual(["MF0001", "SS0001", "RT0002"]);
    expect(await store.partners.list({ id: [] })).toEqual([]);
    expect(await store.partners.findOne({ type: ["DB", "RETAILER"] })).toMatchObject({ id: "DB0001" });

    // Lots and packs share one table in PostgreSQL: a list on either never returns the other's rows.
    await store.batches.create(batch("AAA111"));
    const [a, b] = [lot("91AAA111OR00001"), lot("91AAA111OR00002", { status: "IN_TRANSIT", locationId: "SS0001", inTransitToId: "RT0001" })];
    await store.lots.createMany([a, b]);
    await store.packs.createMany([...packs(a), ...packs(b)]);
    expect((await store.lots.list({ lotCode: [b.lotCode, `${a.lotCode}61`] })).map((l) => l.id)).toEqual([b.lotCode]);
    expect((await store.packs.list({ lotCode: [a.lotCode, b.lotCode], seq: [1, 4] })).map((p) => p.id)).toEqual([`${a.lotCode}61`, `${a.lotCode}64`, `${b.lotCode}61`, `${b.lotCode}64`]);
    expect((await store.lots.list({ inTransitToId: ["RT0001"], synced: [true] })).map((l) => l.id)).toEqual([b.lotCode]);

    // The ledger too (the trace timeline reads one item's history this way).
    for (const [code, type] of [[a.lotCode, "PRINTED"], [b.lotCode, "PRINTED"], ["AAA111", "RECALLED"], [a.lotCode, "VERIFIED"]] as const) {
      await store.appendMovement({ type, itemKind: code.length === 6 ? "BATCH" : "LOT", itemCode: code, fromId: null, toId: null, fromStatus: null, toStatus: null, userId: null, deviceId: null, invoice: null, note: null });
    }
    expect((await store.movements.list({ itemCode: [a.lotCode, "AAA111"] })).map((m) => [m.itemCode, m.type])).toEqual([
      [a.lotCode, "PRINTED"],
      ["AAA111", "RECALLED"],
      [a.lotCode, "VERIFIED"],
    ]);
  });

  it("updates and deletes; a missing row is NotFound", async () => {
    expect(await store.partners.update("SS0001", { name: "Renamed", active: false })).toMatchObject({ id: "SS0001", name: "Renamed", active: false });
    await expect(store.partners.update("SS0099", { name: "x" })).rejects.toThrow(/not found/);
    await store.sessions.create({ id: "abc", userId: "AD0001", createdAt: AT, expiresAt: AT });
    await store.sessions.delete("abc");
    await expect(store.sessions.delete("abc")).rejects.toThrow(/not found/);
  });

  it("updateWhere patches only the matching rows in one call and returns their ids in insertion order", async () => {
    await store.batches.create(batch("AAA111"));
    const [a, b, c] = ["91AAA111OR00001", "91AAA111OR00002", "91AAA111OR00003"].map((code, i) => lot(code, { printOrderId: i < 2 ? "po-1" : "po-2" }));
    await store.lots.createMany([a, b, c]);
    await store.packs.createMany([...packs(a), ...packs(b), ...packs(c)]);
    await store.lots.update(b.id, { status: "VOID" });
    await store.packs.update(`${a.lotCode}62`, { status: "VOID" });

    // Only GENERATED lots of po-1: a (not b, which is VOID, nor c, another order).
    expect(await store.lots.updateWhere({ printOrderId: "po-1", status: "GENERATED" }, { status: "PRINTED", updatedAt: "2026-11-04T10:00:00.000Z" })).toEqual([a.id]);
    expect((await store.lots.list()).map((l) => [l.id, l.status, l.updatedAt])).toEqual([
      [a.id, "PRINTED", "2026-11-04T10:00:00.000Z"],
      [b.id, "VOID", AT],
      [c.id, "GENERATED", AT],
    ]);
    // Packs of a list of lots, by status: a's VOID pack and every other lot's packs stay as they are.
    expect(await store.packs.updateWhere({ lotCode: [a.lotCode], status: "GENERATED" }, { status: "PRINTED" })).toEqual([`${a.lotCode}61`, `${a.lotCode}63`, `${a.lotCode}64`]);
    expect((await store.packs.list({ status: "PRINTED" })).map((p) => p.id)).toEqual([`${a.lotCode}61`, `${a.lotCode}63`, `${a.lotCode}64`]);
    expect((await store.packs.list({ lotCode: [b.lotCode, c.lotCode] })).every((p) => p.status === "GENERATED")).toBe(true);
    // Lots and packs share one table in PostgreSQL: a lot update never touches pack rows, and the other way round.
    expect(await store.packs.updateWhere({ lotCode: [a.lotCode] }, { locationId: "SS0001" })).toHaveLength(4);
    expect((await store.lots.get(a.id))!.locationId).toBe("MF0001");
    // Repeating changes nothing; an empty "any of" list matches nothing; an empty filter is refused.
    expect(await store.lots.updateWhere({ printOrderId: "po-1", status: "GENERATED" }, { status: "PRINTED" })).toEqual([]);
    expect(await store.packs.updateWhere({ lotCode: [] }, { status: "VOID" })).toEqual([]);
    await expect(store.lots.updateWhere({}, { status: "VOID" })).rejects.toThrow(/needs a filter/);
    expect((await store.lots.list({ status: "VOID" })).map((l) => l.id)).toEqual([b.id]);
  });

  it("updateWhere inside a transaction rolls back with it; a lot counter still cannot move backwards", async () => {
    await store.batches.create(batch("AAA111", { nextLot: 5 }));
    await store.lots.createMany([lot("91AAA111OR00001")]);
    await expect(
      store.transaction(async (tx) => {
        await tx.lots.updateWhere({ batchCode: "AAA111" }, { status: "PRINTED" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await store.lots.get("91AAA111OR00001"))!.status).toBe("GENERATED");
    await expect(store.batches.updateWhere({ code: "AAA111" }, { nextLot: 2 })).rejects.toThrow(/backwards/);
    expect((await store.batches.findOne({ code: "AAA111" }))!.nextLot).toBe(5);
  });

  it("appendMovements appends every movement, in order, with ids and times", async () => {
    const m = (itemCode: string) => ({ type: "PRINTED" as const, itemKind: "LOT" as const, itemCode, fromId: "MF0001", toId: "MF0001", fromStatus: "GENERATED" as const, toStatus: "PRINTED" as const, userId: "AD0001", deviceId: null, invoice: null, note: null });
    await store.appendMovement({ ...m("first"), type: "GENERATED" });
    const codes = Array.from({ length: 1234 }, (_, i) => `91AAA111OR${(i + 1).toString(16).toUpperCase().padStart(5, "0")}`);
    const rows = await store.appendMovements(codes.map(m));
    expect(rows).toHaveLength(1234);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1234);
    const listed = await store.movements.list({ type: "PRINTED" });
    expect(listed.map((r) => r.itemCode)).toEqual(codes);
    expect(listed[0]).toEqual(rows[0]);
    expect((await store.movements.list()).map((r) => r.itemCode)[0]).toBe("first");
    expect(await store.appendMovements([])).toEqual([]);
  });

  it("rolls back a failed transaction", async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.batches.create(batch("AAA111"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.batches.list()).toHaveLength(0);
  });

  it("nextLotNumber allocates atomically with no overlap under concurrency, and stops at 1869F", async () => {
    await store.batches.create(batch("AAA111"));
    const firsts = await Promise.all(Array.from({ length: 20 }, () => store.nextLotNumber("AAA111", 3)));
    const numbers = firsts.flatMap((f) => [f, f + 1, f + 2]);
    expect(new Set(numbers).size).toBe(60);
    expect(Math.min(...numbers)).toBe(1);
    expect((await store.batches.findOne({ code: "AAA111" }))?.nextLot).toBe(61);
    await store.batches.create(batch("BBB222", { id: "b2", nextLot: 0x1869f }));
    expect(await store.nextLotNumber("BBB222", 1)).toBe(0x1869f);
    await expect(store.nextLotNumber("BBB222", 1)).rejects.toThrow(/1869F/);
    await expect(store.nextLotNumber("ZZZ999", 1)).rejects.toThrow(/not found/);
  });

  it("issues ID sequence numbers once each, even concurrently", async () => {
    const got = await Promise.all(Array.from({ length: 15 }, () => store.nextSequence("DB")));
    expect(got.sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(await store.nextSequence("AD")).toBe(2); // AD0001 is the seeded Velza Admin
  });

  it("keeps movements, scans and reprints apart, in order", async () => {
    await store.appendMovement({ type: "GENERATED", itemKind: "LOT", itemCode: "91AAA111OR00001", fromId: null, toId: "MF0001", fromStatus: null, toStatus: "GENERATED", userId: "AD0001", deviceId: null, invoice: null, note: null });
    await store.appendScan({ context: "RECEIVE", code: "91ZZZZZZOR00001", ok: false, result: "UNKNOWN_CODE", message: "Unknown", userId: "AD0001", partnerId: "SS0001", deviceId: null });
    await store.reprints.append({ id: R1, at: AT, code: "91AAA111OR0000161", itemKind: "PACK", reason: "torn", userId: "AD0001", deviceId: null, printOrderId: null });
    await store.appendMovement({ type: "DISPATCHED", itemKind: "LOT", itemCode: "91AAA111OR00001", fromId: "MF0001", toId: "SS0001", fromStatus: "PACKED", toStatus: "IN_TRANSIT", userId: "AD0001", deviceId: null, invoice: "INV-1", note: null });
    expect((await store.movements.list()).map((m) => m.type)).toEqual(["GENERATED", "DISPATCHED"]);
    expect(await store.movements.list({ type: "DISPATCHED" })).toEqual([expect.objectContaining({ invoice: "INV-1", fromId: "MF0001", toId: "SS0001" })]);
    expect(await store.scans.list({ partnerId: "SS0001" })).toEqual([expect.objectContaining({ ok: false, result: "UNKNOWN_CODE", code: "91ZZZZZZOR00001" })]);
    expect(await store.reprints.list()).toEqual([{ id: R1, at: AT, code: "91AAA111OR0000161", itemKind: "PACK", reason: "torn", userId: "AD0001", deviceId: null, printOrderId: null }]);
  });

  it("settings fall back to defaults and can be updated", async () => {
    expect((await store.getSettings()).notReceivedThresholdDays).toBe(3);
    await store.updateSettings({ demoMode: true, lotSticker: { widthMm: 90, heightMm: 40 } });
    expect(await store.getSettings()).toMatchObject({ demoMode: true, lotSticker: { widthMm: 90, heightMm: 40 }, poolIssueSize: 10 });
  });

  it("returns copies, so callers can't change data without update()", async () => {
    const [u] = await store.users.list();
    u.name = "changed";
    expect((await store.users.get(u.id))?.name).not.toBe("changed");
  });

  it("snapshot → reset → snapshot gives the same data", async () => {
    await store.batches.create(batch("AAA111"));
    const l = lot("91AAA111OR00001");
    await store.lots.create(l);
    await store.packs.createMany(packs(l));
    await store.nextSequence("MF");
    await store.appendMovement({ type: "GENERATED", itemKind: "LOT", itemCode: l.lotCode, fromId: null, toId: "MF0001", fromStatus: null, toStatus: "GENERATED", userId: "AD0001", deviceId: null, invoice: null, note: "x" });
    const before = await store.snapshot();
    await store.reset(before);
    expect(await store.snapshot()).toEqual(before);
    expect(before.sequences).toEqual(expect.arrayContaining([{ id: "MF", value: 1 }]));
  });

  it("recentScans: the newest scans first, equal times in the order recorded, at most `limit`", async () => {
    const scan = (code: string, at: string) => ({ context: "RECEIVE" as const, code, ok: false, result: "UNKNOWN_CODE", message: "Unknown", userId: null, partnerId: "SS0001", deviceId: null, at });
    await store.appendScan(scan("A", "2026-11-01T10:00:00.000Z"));
    await store.appendScan(scan("B", "2026-11-03T10:00:00.000Z"));
    await store.appendScan(scan("C", "2026-11-02T10:00:00.000Z"));
    await store.appendScan(scan("D", "2026-11-03T10:00:00.000Z"));
    expect((await store.recentScans(3)).map((s) => s.code)).toEqual(["B", "D", "C"]);
    expect((await store.recentScans(10)).map((s) => s.code)).toEqual(["B", "D", "C", "A"]);
    expect(await store.recentScans(0)).toEqual([]);
    expect((await store.recentScans(1))[0]).toMatchObject({ code: "B", context: "RECEIVE", ok: false, result: "UNKNOWN_CODE", partnerId: "SS0001", at: "2026-11-03T10:00:00.000Z" });
  });

  it("latestContainerWithLot: the latest container to that receiver, in those statuses, that carried the lot", async () => {
    const base = { manufacturerId: "MF0001", invoice: "INV", createdAt: AT, createdBy: "MF0001-OP", dispatchedBy: null, receivedAt: null, receivedBy: null };
    const box = (id: string, code: string, over: Record<string, unknown>) => ({ ...base, id, code, status: "RECEIVED" as const, lotCodes: ["91AAA111OR00001"], toId: "SS0001", dispatchedAt: "2026-11-01T00:00:00.000Z", ...over });
    // The lots the containers carry (PostgreSQL checks container_items → codes, v10).
    await store.batches.create(batch("AAA111"));
    await store.lots.createMany(["91AAA111OR00001", "91AAA111OR00002", "91AAA111OR00009"].map((code) => lot(code)));
    await store.containers.create(box("c-old", "CONT001", { status: "CLEARED", dispatchedAt: "2026-11-01T00:00:00.000Z" }));
    await store.containers.create(box("c-new", "CONT002", { dispatchedAt: "2026-11-05T00:00:00.000Z", lotCodes: ["91AAA111OR00009", "91AAA111OR00001"] }));
    await store.containers.create(box("c-other-receiver", "CONT003", { toId: "MF0001", dispatchedAt: "2026-11-09T00:00:00.000Z" }));
    await store.containers.create(box("c-loading", "CONT004", { status: "LOADING", dispatchedAt: null }));
    await store.containers.create(box("c-other-lot", "CONT005", { lotCodes: ["91AAA111OR00002"], dispatchedAt: "2026-11-09T00:00:00.000Z" }));
    const statuses = ["IN_TRANSIT", "RECEIVED", "CLEARED"] as const;
    expect((await store.latestContainerWithLot("SS0001", "91AAA111OR00001", statuses))?.id).toBe("c-new");
    expect((await store.latestContainerWithLot("SS0001", "91AAA111OR00001", ["CLEARED"]))?.id).toBe("c-old");
    expect(await store.latestContainerWithLot("SS0001", "91AAA111OR00007", statuses)).toBeNull();
    expect((await store.latestContainerWithLot("SS0001", "91AAA111OR00001", ["LOADING"]))?.id).toBe("c-loading");
  });

  it("stockSummary: units per location, status, kind, lot type, flavour and sync flag, following every change", async () => {
    await store.batches.create(batch("AAA111"));
    const sort = (rows: StockSummaryRow[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const row = (over: Partial<StockSummaryRow>): StockSummaryRow => ({ locationId: "MF0001", status: "GENERATED", kind: "LOT", lotType: "CASE", flavour: "OR", synced: true, units: 1, ...over });
    expect(await store.stockSummary()).toEqual([]);
    const a = lot("91AAA111OR00001");
    const b = lot("91AAA111OR00002", { synced: false });
    await store.lots.createMany([a, b]);
    await store.packs.createMany([...packs(a), ...packs(b)]);
    expect(sort(await store.stockSummary())).toEqual(
      sort([row({}), row({ kind: "PACK", units: 4 }), row({ synced: false }), row({ kind: "PACK", units: 4, synced: false })]),
    );
    // A lot dispatched, one pack moved on its own, and the unsynced lot synced (its packs follow).
    await store.lots.update(a.id, { status: "AT_SS", locationId: "SS0001" });
    await store.packs.update(`${a.lotCode}61`, { status: "AT_SS", locationId: "SS0001" });
    await store.lots.update(b.id, { synced: true });
    expect(sort(await store.stockSummary())).toEqual(
      sort([
        row({ locationId: "SS0001", status: "AT_SS" }),
        row({ locationId: "SS0001", status: "AT_SS", kind: "PACK" }),
        row({}), // the second lot, now synced
        row({ kind: "PACK", units: 7 }), // 3 left of the first lot + the second lot's 4, now synced
      ]),
    );
  });
});

describe("PostgreSQL only: the schema guards the data", () => {
  let store: SqlStore;
  beforeAll(() => {
    store = new SqlStore(() => createPgliteDriver(), () => withPartners());
  });
  afterAll(async () => {
    await store.close();
  });
  beforeEach(async () => {
    await store.reset(withPartners());
    await store.batches.create(batch("AAA111"));
  });

  const sql = async (text: string, params: unknown[] = []) => (await store.driver()).query(text, params);

  it("stores each sticker as one codes row with every field of its code", async () => {
    const l = lot("91AAA111OR0001F");
    await store.lots.create(l);
    await store.packs.createMany(packs(l));
    const rows = await sql(
      `SELECT code, code_type, country_code, batch_code, flavour, hex_code, lot_type, pack_size, pack_sequence, lot_code, lot_number,
              to_char(mfg_date, 'YYYY-MM-DD') AS mfg, to_char(expiry_date, 'YYYY-MM-DD') AS exp, manufacturer_id, generated_by, synced
         FROM codes ORDER BY row_no`,
    );
    expect(rows).toHaveLength(5); // 1 case + 4 packs = 5 stickers
    expect(rows[0]).toEqual({ code: "91AAA111OR0001F", code_type: "LOT", country_code: "91", batch_code: "AAA111", flavour: "OR", hex_code: "0001F", lot_type: "CASE", pack_size: 6, pack_sequence: null, lot_code: "91AAA111OR0001F", lot_number: 31, mfg: "2026-10-01", exp: "2027-04-01", manufacturer_id: "MF0001", generated_by: "MF0001-OP", synced: true });
    expect(rows[3]).toMatchObject({ code: "91AAA111OR0001F63", code_type: "PACK", hex_code: "0001F", pack_size: 6, pack_sequence: 3, lot_code: "91AAA111OR0001F", mfg: "2026-10-01", manufacturer_id: "MF0001" });
  });

  it("a lot's sync flag is copied to its pack rows", async () => {
    await store.batches.update("batch-AAA111", { synced: false });
    const l = lot("91AAA111OR00002", { synced: false });
    await store.lots.create(l);
    await store.packs.createMany(packs(l));
    expect(await sql(`SELECT DISTINCT synced FROM codes`)).toEqual([{ synced: false }]);
    await store.lots.update(l.id, { synced: true });
    expect(await sql(`SELECT DISTINCT synced FROM codes`)).toEqual([{ synced: true }]);
    // The same through a bulk update (Sync): the lots' packs follow, other lots' packs do not.
    const m = lot("91AAA111OR00003", { synced: false, deviceId: "dev-2" });
    const n = lot("91AAA111OR00004", { synced: false, deviceId: "dev-3" });
    await store.lots.createMany([m, n]);
    await store.packs.createMany([...packs(m), ...packs(n)]);
    await sql(`UPDATE codes SET synced = false WHERE lot_code = ANY($1::text[])`, [[m.lotCode, n.lotCode]]);
    expect(await store.lots.updateWhere({ deviceId: "dev-2", synced: false }, { synced: true })).toEqual([m.id]);
    expect(await sql(`SELECT lot_code, bool_and(synced) AS synced FROM codes WHERE lot_code = ANY($1::text[]) GROUP BY lot_code ORDER BY lot_code`, [[m.lotCode, n.lotCode]])).toEqual([
      { lot_code: m.lotCode, synced: true },
      { lot_code: n.lotCode, synced: false },
    ]);
  });

  it("has the v4 indexes for the plant's queries", async () => {
    const names = (await sql(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`)).map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining(["codes_manufacturer", "codes_device_unsynced", "print_orders_manufacturer", "print_orders_device_unsynced", "batches_manufacturer", "batches_device_unsynced", "batch_code_pool_device"]),
    );
    expect(await sql(`SELECT version FROM schema_info`)).toEqual([{ version: SCHEMA_VERSION }]); // v5: Velza Warehouse; v6: returns; v7: self sign-up approval; v8: customs clearance; v9: live read model; v10: integrity; v11: Option C + partitions
  });

  it("v9: the stock summary stays exact through inserts, moves, sync, deletes, rollup, rebuild and an upgrade", async () => {
    // What stock_current must always equal: a full recount of codes.
    const recount = `SELECT location_id, status, code_type, lot_type, flavour, synced, count(*)::bigint AS units FROM codes
                      GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4, 5, 6`;
    const current = `SELECT location_id, status, code_type, lot_type, flavour, synced, units FROM stock_current ORDER BY 1, 2, 3, 4, 5, 6`;
    const same = async () => expect(await sql(current)).toEqual(await sql(recount));
    const l1 = lot("91AAA111OR00001");
    const l2 = lot("91AAA111OR00002", { synced: false });
    await store.lots.createMany([l1, l2]);
    await store.packs.createMany([...packs(l1), ...packs(l2)]);
    await same();
    // Bulk moves in one statement (a container), a sync, a single-pack move and a delete.
    await sql(`UPDATE codes SET status = 'IN_TRANSIT', in_transit_to = 'SS0001' WHERE lot_code = $1`, [l1.lotCode]);
    await store.lots.updateWhere({ deviceId: "dev-1", synced: false }, { synced: true });
    await store.packs.update(`${l2.lotCode}62`, { status: "DAMAGED" });
    await sql(`UPDATE codes SET updated_at = now()`); // touches every row, changes no key: no delta rows
    const deltasBefore = Number((await sql(`SELECT count(*) AS n FROM stock_deltas`))[0].n);
    await sql(`UPDATE codes SET updated_at = now()`);
    expect(Number((await sql(`SELECT count(*) AS n FROM stock_deltas`))[0].n)).toBe(deltasBefore);
    await same();
    // Codes issued by a print order are protected (and, since v10, keep their print order): free one for the delete test.
    await sql(`UPDATE codes SET print_order_id = NULL WHERE code = $1`, [`${l2.lotCode}64`]);
    await sql(`DELETE FROM codes WHERE code = $1`, [`${l2.lotCode}64`]);
    await same();
    // Rollup folds every delta into the summary and changes nothing visible.
    expect(Number((await sql(`SELECT stock_summary_rollup() AS n`))[0].n)).toBeGreaterThan(0);
    expect(await sql(`SELECT count(*)::int AS n FROM stock_deltas`)).toEqual([{ n: 0 }]);
    expect(await sql(`SELECT count(*)::int AS n FROM stock_summary WHERE units = 0`)).toEqual([{ n: 0 }]);
    await same();
    // A wrong summary is put right by a rebuild.
    await sql(`UPDATE stock_summary SET units = units + 100`);
    await sql(`SELECT stock_summary_rebuild()`);
    await same();
    // Upgrading a v8 database that already holds codes fills the summary once.
    await sql(`DELETE FROM stock_summary`);
    await sql(`DELETE FROM stock_deltas`);
    await sql(`UPDATE schema_info SET version = 8`);
    await (await store.driver()).exec(SCHEMA_SQL);
    await same();
    expect(await sql(`SELECT version FROM schema_info`)).toEqual([{ version: SCHEMA_VERSION }]);
    // A reset (TRUNCATE) empties it too.
    await store.reset(withPartners());
    expect(await sql(current)).toEqual([]);
  });

  it("never moves the schema backwards: older code on a newer database leaves it as it is (rollback)", async () => {
    // Pretend a later release already upgraded this database.
    await sql(`UPDATE schema_info SET version = 99`);
    const driver = await store.driver();
    const older = new SqlStore(async () => driver, () => withPartners());
    expect((await older.users.list()).map((u) => u.id)).toEqual(["AD0001", "HQ0001"]); // the app still works
    await older.migrate(); // and a migration run by the older release is a no-op
    expect(await sql(`SELECT version FROM schema_info`)).toEqual([{ version: 99 }]);
    // An older database is still upgraded.
    await sql(`UPDATE schema_info SET version = 8`);
    await older.migrate();
    expect(await sql(`SELECT version FROM schema_info`)).toEqual([{ version: SCHEMA_VERSION }]);
  });

  it("v9: has the read-path indexes (v11: container_items_lot replaces the GIN index on containers.lot_codes)", async () => {
    const names = (await sql(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`)).map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(expect.arrayContaining(["code_history_scans_recent", "container_items_lot", "codes_in_transit_since"]));
    expect(names).not.toContain("containers_lot_codes");
  });

  it("v8: allows AT_CUSTOMS and CLEARED, keeps clearance fields, and reuses a cleared container's number", async () => {
    const held = lot("91AAA111OR00005", { status: "AT_CUSTOMS" });
    await store.lots.create(held);
    expect((await store.lots.findOne({ lotCode: held.lotCode }))?.status).toBe("AT_CUSTOMS");
    const base = { code: "MSCU1234567", manufacturerId: "MF0001", lotCodes: [held.lotCode], toId: null, invoice: "INV-C", createdAt: "2026-11-16T00:00:00.000Z", createdBy: "MF0001-OP", dispatchedAt: null, dispatchedBy: null, receivedAt: null, receivedBy: null };
    await store.containers.create({ ...base, id: "c-1", status: "CLEARED", clearedAt: "2026-11-16T05:00:00.000Z", clearedBy: "VW0001", billOfEntry: "BE-1234567" });
    expect(await store.containers.get("c-1")).toMatchObject({ status: "CLEARED", clearedAt: "2026-11-16T05:00:00.000Z", clearedBy: "VW0001", billOfEntry: "BE-1234567" });
    await store.containers.create({ ...base, id: "c-2", status: "LOADING" });
    await expect(store.containers.create({ ...base, id: "c-3", status: "IN_TRANSIT" })).rejects.toThrow(/containers_one_active_per_code/);
    await expect(store.containers.create({ ...base, id: "c-4", status: "HELD" as never })).rejects.toThrow(/containers_status_check/);
  });

  it("refuses a code that doesn't match its parts", async () => {
    await expect(store.lots.create(lot("91AAA111OR00003", { flavour: "GA" }))).rejects.toThrow(/code_matches_parts/);
    await expect(store.packs.create({ ...packs(lot("91AAA111OR00004"))[0], id: "91AAA111OR0000465", packCode: "91AAA111OR0000465", seq: 5 })).rejects.toThrow();
  });

  it("refuses a partner ID that doesn't match its tier, and a second SS in a state", async () => {
    await expect(store.partners.create({ ...ss, id: "DB0009", phone: "9" })).rejects.toThrow(/partner_id_matches_type/);
    await expect(store.partners.create({ ...ss, id: "SS0002", phone: "8" })).rejects.toThrow(/partners_one_ss_per_state/);
    // v7: a rejected SS sign-up does not hold its state; a pending one does; an unknown approval is refused.
    await store.partners.create({ ...ss, id: "SS0003", phone: "7", state: "Goa", approval: "REJECTED", active: false });
    await store.partners.create({ ...ss, id: "SS0004", phone: "6", state: "Goa", approval: "PENDING", active: false });
    await expect(store.partners.create({ ...ss, id: "SS0005", phone: "5", state: "Goa" })).rejects.toThrow(/partners_one_ss_per_state/);
    await expect(store.partners.create({ ...ss, id: "SS0006", phone: "4", state: "Kerala", approval: "MAYBE" as never })).rejects.toThrow(/partners_approval_check/);
    await expect(store.partners.create({ ...retailer, id: "DB0009" })).rejects.toThrow(/partner_id_matches_type/);
    await expect(store.partners.create({ ...retailer, id: "RT0009", type: "DB" })).rejects.toThrow(/partner_id_matches_type/);
    await store.partners.create({ ...retailer, id: "RT0009" });
  });

  it("has no Supplier or Outlet tier: their types, IDs, roles and statuses are refused", async () => {
    // Values of the old chain, which the types no longer allow.
    const old = <T>(v: string) => v as unknown as T;
    await expect(store.partners.create({ ...retailer, type: old<Partner["type"]>("OUTLET") })).rejects.toThrow(/partner_type_check|partner_id_matches_type/);
    await expect(store.partners.create({ ...retailer, id: "SP0001", type: old<Partner["type"]>("SUPPLIER") })).rejects.toThrow(/partner_type_check|partner_id_matches_type/);
    await expect(store.partners.create({ ...retailer, id: "OT0001" })).rejects.toThrow(/partner_id_matches_type/);
    const login = { id: "RT0001", name: "x", role: old<"RETAILER">("OUTLET"), partnerId: null, active: true, passwordHash: null, passwordChangedAt: null, createdAt: AT, lastLoginAt: null };
    await expect(store.users.create(login)).rejects.toThrow(/users_role_check/);
    await expect(store.users.create({ ...login, id: "OT0001", role: "ADMIN" })).rejects.toThrow(/users_login_id_check/);
    await expect(store.lots.create(lot("91AAA111OR00005", { status: old<Lot["status"]>("AT_OUTLET") }))).rejects.toThrow(/codes_status_check/);
    await expect(store.lots.create(lot("91AAA111OR00006", { status: old<Lot["status"]>("AT_SUPPLIER") }))).rejects.toThrow(/codes_status_check/);
    await store.partners.create(retailer);
    await store.lots.create(lot("91AAA111OR00007", { status: "AT_RETAILER", locationId: "RT0001" }));
  });

  it("code_history can only be added to", async () => {
    await store.appendScan({ context: "RECEIVE", code: "91ZZZZZZOR00001", ok: false, result: "UNKNOWN_CODE", message: "Unknown", userId: null, partnerId: "SS0001", deviceId: null });
    await expect(sql(`UPDATE code_history SET code = 'x'`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM code_history`)).rejects.toThrow(/append-only/);
    expect(await sql(`SELECT record_type, event, code, ok, result, location_id FROM code_history`)).toEqual([
      { record_type: "SCAN", event: "SCAN_FAILED", code: "91ZZZZZZOR00001", ok: false, result: "UNKNOWN_CODE", location_id: "SS0001" },
    ]);
  });

  it("deleting a sign-in removes its sessions; a partner with sign-ins can't be removed underneath them", async () => {
    await store.users.create({ id: "SS0001", name: "SS", role: "SS", partnerId: "SS0001", active: true, passwordHash: null, passwordChangedAt: null, createdAt: AT, lastLoginAt: null });
    await store.sessions.create({ id: "s1", userId: "SS0001", createdAt: AT, expiresAt: AT });
    await expect(store.partners.delete("SS0001")).rejects.toThrow(/foreign key/);
    await store.users.delete("SS0001");
    expect(await store.sessions.list()).toEqual([]);
  });
});
