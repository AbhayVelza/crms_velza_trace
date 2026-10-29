// The Store contract, run against every implementation: the JSON file and PostgreSQL (embedded
// PGlite here; the same SQL runs on a real server). Business logic relies on exactly this behaviour.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Batch, Lot, Pack, Partner } from "@/lib/core/types";
import { JsonStore } from "./jsonStore";
import { buildBaseSeed } from "./seedData";
import { createPgliteDriver } from "./sql/driver";
import { SqlStore } from "./sql/sqlStore";
import type { DbSnapshot, Store } from "./Store";

const AT = "2026-10-26T10:00:00.000Z";
const seed = buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" });

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

const withPartners = (): DbSnapshot => ({ ...structuredClone(seed), partners: [plant, ss] });

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
    await store.reprints.append({ id: "r1", at: AT, code: "91AAA111OR0000161", itemKind: "PACK", reason: "torn", userId: "AD0001", deviceId: null });
    await store.appendMovement({ type: "DISPATCHED", itemKind: "LOT", itemCode: "91AAA111OR00001", fromId: "MF0001", toId: "SS0001", fromStatus: "PACKED", toStatus: "IN_TRANSIT", userId: "AD0001", deviceId: null, invoice: "INV-1", note: null });
    expect((await store.movements.list()).map((m) => m.type)).toEqual(["GENERATED", "DISPATCHED"]);
    expect(await store.movements.list({ type: "DISPATCHED" })).toEqual([expect.objectContaining({ invoice: "INV-1", fromId: "MF0001", toId: "SS0001" })]);
    expect(await store.scans.list({ partnerId: "SS0001" })).toEqual([expect.objectContaining({ ok: false, result: "UNKNOWN_CODE", code: "91ZZZZZZOR00001" })]);
    expect(await store.reprints.list()).toEqual([{ id: "r1", at: AT, code: "91AAA111OR0000161", itemKind: "PACK", reason: "torn", userId: "AD0001", deviceId: null }]);
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
  });

  it("refuses a code that doesn't match its parts", async () => {
    await expect(store.lots.create(lot("91AAA111OR00003", { flavour: "GA" }))).rejects.toThrow(/code_matches_parts/);
    await expect(store.packs.create({ ...packs(lot("91AAA111OR00004"))[0], id: "91AAA111OR0000465", packCode: "91AAA111OR0000465", seq: 5 })).rejects.toThrow();
  });

  it("refuses a partner ID that doesn't match its tier, and a second SS in a state", async () => {
    await expect(store.partners.create({ ...ss, id: "DB0009", phone: "9" })).rejects.toThrow(/partner_id_matches_type/);
    await expect(store.partners.create({ ...ss, id: "SS0002", phone: "8" })).rejects.toThrow(/partners_one_ss_per_state/);
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
