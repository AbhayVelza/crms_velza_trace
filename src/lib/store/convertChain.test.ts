// Converting data from the old chain (… → Distributor → Supplier → Outlet) to the current one
// (… → Distributor → Retailer, a few Retailers under their Super Stockist directly).

import { describe, expect, it } from "vitest";
import { convertChain } from "./convertChain";
import { buildBaseSeed } from "./seedData";
import type { DbSnapshot } from "./Store";

const AT = "2026-10-26T10:00:00.000Z";
const base = buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" });

type Rec = Record<string, unknown>;

// Rows of the old chain hold values the app's types no longer allow, so they are built as plain records.
const partner = (id: string, type: string, name: string, parentId: string | null = null): Rec => ({
  id,
  type,
  name,
  place: "",
  address: "",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "",
  contactPerson: "",
  phone: "",
  email: "",
  parentId,
  active: true,
  createdAt: AT,
  createdBy: "AD0001",
});
const user = (id: string, role: string, partnerId: string | null): Rec => ({
  id,
  name: `Person ${id}`,
  role,
  partnerId,
  active: true,
  passwordHash: null,
  passwordChangedAt: null,
  createdAt: AT,
  lastLoginAt: null,
});
const lot = (lotCode: string, over: Rec = {}): Rec => ({
  id: lotCode,
  lotCode,
  batchCode: lotCode.slice(2, 8),
  flavour: "OR",
  lotType: "CASE",
  packSize: 6,
  lotNumber: 1,
  status: "AT_DB",
  locationId: "DB0001",
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
const pack = (lotCode: string, seq: number, over: Rec = {}): Rec => ({
  id: `${lotCode}6${seq}`,
  packCode: `${lotCode}6${seq}`,
  lotCode,
  seq,
  packSize: 6,
  status: "AT_DB",
  locationId: "DB0001",
  inTransitToId: null,
  dispatchedAt: null,
  statusBeforeRecall: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const movement = (id: string, over: Rec): Rec => ({
  id,
  at: AT,
  type: "RECEIVED",
  itemKind: "LOT",
  itemCode: "91AAA111OR00001",
  fromId: null,
  toId: null,
  fromStatus: "IN_TRANSIT",
  toStatus: null,
  userId: null,
  deviceId: null,
  invoice: "INV-1",
  note: null,
  ...over,
});
const scan = (id: string, over: Rec): Rec => ({
  id,
  at: AT,
  context: "RECEIVE",
  code: "91AAA111OR00001",
  ok: true,
  result: "OK",
  message: "received",
  userId: null,
  partnerId: null,
  deviceId: null,
  ...over,
});

const snapshot = (over: Partial<Record<keyof DbSnapshot, Rec[]>>): DbSnapshot => ({ ...structuredClone(base), ...over }) as unknown as DbSnapshot;

/** The old chain: one Supplier under DB0001 with two Outlets, one Supplier assigned to nobody with one Outlet. */
function oldChain(over: Partial<Record<keyof DbSnapshot, Rec[]>> = {}): DbSnapshot {
  return snapshot({
    partners: [
      partner("MF0001", "MANUFACTURER", "Plant"),
      partner("SS0001", "SS", "Konkan SS"),
      partner("DB0001", "DB", "Thane Distributors", "SS0001"),
      partner("SP0001", "SUPPLIER", "Andheri Traders", "DB0001"),
      partner("SP0002", "SUPPLIER", "Baner Traders"),
      partner("OT0001", "OUTLET", "Bandra Fresh Mart", "SP0001"),
      partner("OT0002", "OUTLET", "Powai Corner Store", "SP0001"),
      partner("OT0003", "OUTLET", "Aundh Cafe", "SP0002"),
    ],
    users: [
      ...(structuredClone(base.users) as unknown as Rec[]),
      user("MF0001-OP", "OPERATOR", "MF0001"),
      user("SS0001", "SS", "SS0001"),
      user("DB0001", "DB", "DB0001"),
      user("SP0001", "SUPPLIER", "SP0001"),
      user("SP0002", "SUPPLIER", "SP0002"),
      user("OT0001", "OUTLET", "OT0001"),
      user("OT0002", "OUTLET", "OT0002"),
      user("OT0003", "OUTLET", "OT0003"),
    ],
    sessions: [
      { id: "s-sp1", userId: "SP0001", createdAt: AT, expiresAt: AT },
      { id: "s-ot1", userId: "OT0001", createdAt: AT, expiresAt: AT },
      { id: "s-db1", userId: "DB0001", createdAt: AT, expiresAt: AT },
    ],
    sequences: [
      ...(structuredClone(base.sequences) as unknown as Rec[]),
      { id: "MF", value: 1 },
      { id: "SS", value: 1 },
      { id: "DB", value: 1 },
      { id: "SP", value: 2 },
      { id: "OT", value: 3 },
    ],
    lots: [
      lot("91AAA111OR00001", { status: "OPENED", locationId: "OT0001" }),
      lot("91AAA111OR00002", { status: "RECALLED", statusBeforeRecall: "AT_OUTLET", locationId: "OT0002" }),
      lot("91AAA111OR00003", { status: "IN_TRANSIT", locationId: "DB0001", inTransitToId: "OT0003" }),
    ],
    packs: [1, 2, 3, 4].map((seq) => pack("91AAA111OR00001", seq, { status: "AT_OUTLET", locationId: "OT0001" })),
    movements: [
      movement("m1", { fromId: "DB0001", toId: "OT0001", toStatus: "AT_OUTLET", userId: "OT0001" }),
      movement("m2", { type: "OPENED", fromId: "OT0001", toId: "OT0001", fromStatus: "AT_OUTLET", toStatus: "OPENED", userId: "OT0001", invoice: null }),
    ],
    scans: [scan("sc1", { userId: "OT0001", partnerId: "OT0001" })],
    ...over,
  });
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const seq = (data: DbSnapshot, id: string) => data.sequences.find((s) => s.id === id)?.value;

describe("convertChain", () => {
  it("removes the Suppliers, their sign-ins and sessions; Outlets become Retailers under the Supplier's Distributor", () => {
    const { data, report } = convertChain(oldChain());
    expect(ids(data.partners)).toEqual(["MF0001", "SS0001", "DB0001", "RT0001", "RT0002", "RT0003"]);
    expect(data.partners.filter((p) => p.id.startsWith("RT")).map((p) => [p.id, p.type, p.name, p.parentId])).toEqual([
      ["RT0001", "RETAILER", "Bandra Fresh Mart", "DB0001"],
      ["RT0002", "RETAILER", "Powai Corner Store", "DB0001"],
      ["RT0003", "RETAILER", "Aundh Cafe", null], // its Supplier was assigned to nobody
    ]);
    expect(ids(data.users)).toEqual(["AD0001", "HQ0001", "MF0001-OP", "SS0001", "DB0001", "RT0001", "RT0002", "RT0003"]);
    expect(data.users.filter((u) => u.id.startsWith("RT")).map((u) => [u.id, u.role, u.partnerId])).toEqual([
      ["RT0001", "RETAILER", "RT0001"],
      ["RT0002", "RETAILER", "RT0002"],
      ["RT0003", "RETAILER", "RT0003"],
    ]);
    expect(data.sessions.map((s) => [s.id, s.userId])).toEqual([
      ["s-ot1", "RT0001"],
      ["s-db1", "DB0001"],
    ]);
    expect(report.join("\n")).toMatch(/Removed Supplier Andheri Traders \(SP0001\)/);
    expect(report.join("\n")).toMatch(/OT0001 → RT0001/);
  });

  it("renames AT_OUTLET → AT_RETAILER and every Outlet ID in stock and history", () => {
    const { data } = convertChain(oldChain());
    expect(data.lots.map((l) => [l.lotCode, l.status, l.statusBeforeRecall, l.locationId, l.inTransitToId])).toEqual([
      ["91AAA111OR00001", "OPENED", null, "RT0001", null],
      ["91AAA111OR00002", "RECALLED", "AT_RETAILER", "RT0002", null],
      ["91AAA111OR00003", "IN_TRANSIT", null, "DB0001", "RT0003"],
    ]);
    expect(data.packs.every((p) => p.status === "AT_RETAILER" && p.locationId === "RT0001")).toBe(true);
    expect(data.movements.map((m) => [m.fromId, m.toId, m.fromStatus, m.toStatus, m.userId])).toEqual([
      ["DB0001", "RT0001", "IN_TRANSIT", "AT_RETAILER", "RT0001"],
      ["RT0001", "RT0001", "AT_RETAILER", "OPENED", "RT0001"],
    ]);
    expect(data.scans.map((s) => [s.userId, s.partnerId])).toEqual([["RT0001", "RT0001"]]);
    // Nothing of the old chain is left anywhere.
    expect(JSON.stringify(data)).not.toMatch(/SUPPLIER|OUTLET|AT_SUPPLIER|AT_OUTLET|"SP[0-9]|"OT[0-9]/);
  });

  it("renames IDs only, never what was typed or scanned, or free text", () => {
    const old = oldChain();
    (old.scans as unknown as Rec[])[0].code = "OT0001";
    (old.movements as unknown as Rec[])[0].note = "OT0001";
    const { data } = convertChain(old);
    expect(data.scans[0]).toMatchObject({ code: "OT0001", userId: "RT0001", partnerId: "RT0001" });
    expect(data.movements[0]).toMatchObject({ note: "OT0001", toId: "RT0001" });
  });

  it("drops the SP and OT sequences and sets RT, so the next Retailer gets the next number", () => {
    const { data, report } = convertChain(oldChain());
    expect(data.sequences.map((s) => s.id)).not.toContain("SP");
    expect(data.sequences.map((s) => s.id)).not.toContain("OT");
    expect(seq(data, "RT")).toBe(3);
    expect([seq(data, "AD"), seq(data, "MF"), seq(data, "DB")]).toEqual([1, 1, 1]);
    expect(report.join("\n")).toMatch(/RT0004/);
  });

  it("numbers Outlets after Retailers that already exist, and after RT numbers already issued", () => {
    const withRetailer = (rtSeq: number) =>
      snapshot({
        partners: [partner("DB0001", "DB", "Thane"), partner("RT0001", "RETAILER", "Existing", "DB0001"), partner("OT0007", "OUTLET", "Old outlet", "DB0001")],
        users: [user("RT0001", "RETAILER", "RT0001"), user("OT0007", "OUTLET", "OT0007")],
        sequences: [
          { id: "RT", value: rtSeq },
          { id: "OT", value: 7 },
        ],
      });
    const a = convertChain(withRetailer(1)).data;
    expect(a.partners.map((p) => [p.id, p.type])).toEqual([
      ["DB0001", "DB"],
      ["RT0001", "RETAILER"],
      ["RT0002", "RETAILER"],
    ]);
    expect(a.users.map((u) => [u.id, u.role, u.partnerId])).toEqual([
      ["RT0001", "RETAILER", "RT0001"],
      ["RT0002", "RETAILER", "RT0002"],
    ]);
    expect(a.sequences).toEqual([{ id: "RT", value: 2 }]);
    // Numbers are never reused: RT0002–RT0005 were issued (and deleted) before.
    const b = convertChain(withRetailer(5)).data;
    expect(ids(b.partners)).toEqual(["DB0001", "RT0001", "RT0006"]);
    expect(b.sequences).toEqual([{ id: "RT", value: 6 }]);
  });

  it("converts records keyed by UUIDs too: types and parents change, IDs stay", () => {
    const [db, sup, out] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const { data } = convertChain(
      snapshot({
        partners: [partner(db, "DB", "Thane"), partner(sup, "SUPPLIER", "Andheri Traders", db), partner(out, "OUTLET", "Bandra", sup)],
        users: [user("u-out", "OUTLET", out), user("u-sup", "SUPPLIER", sup)],
        lots: [lot("91AAA111OR00001", { status: "AT_OUTLET", locationId: out })],
      }),
    );
    expect(data.partners.map((p) => [p.id, p.type, p.parentId])).toEqual([
      [db, "DB", null],
      [out, "RETAILER", db],
    ]);
    expect(data.users.map((u) => [u.id, u.role, u.partnerId])).toEqual([["u-out", "RETAILER", out]]);
    expect(data.lots[0]).toMatchObject({ status: "AT_RETAILER", locationId: out });
  });

  it("adds the registration form and sign-in fields to partners and people entered before them", () => {
    const old = (id: string, type: string, name: string, territory: string, parentId: string | null = null): Rec => ({ id, type, name, city: "Pune", territory, parentId, active: true });
    const [ss, db] = [crypto.randomUUID(), crypto.randomUUID()];
    const { data, report } = convertChain(
      snapshot({
        partners: [old(ss, "SS", "pune_ss", "East Maharashtra"), old(db, "DB", "nagpur_db", "", ss)],
        users: [{ id: "u-ss", name: "Mana", role: "SS", partnerId: ss, active: true }],
      }),
      AT,
    );
    expect(data.partners[0]).toEqual({
      id: ss,
      type: "SS",
      name: "pune_ss",
      place: "East Maharashtra",
      address: "",
      city: "Pune",
      state: "",
      pincode: "",
      contactPerson: "",
      phone: "",
      email: "",
      parentId: null,
      active: true,
      createdAt: AT,
      createdBy: null,
    });
    expect(data.partners[1]).toMatchObject({ place: "", phone: "", parentId: ss });
    expect(data.partners[1]).not.toHaveProperty("territory");
    expect(data.users[0]).toMatchObject({ passwordHash: null, passwordChangedAt: null, createdAt: AT, lastLoginAt: null });
    expect(report.join("\n")).toMatch(/2 partners entered before it .*pune_ss \(territory "East Maharashtra" kept as its place\), nagpur_db/);
    expect(report.join("\n")).toMatch(/Pick the state of pune_ss/);
    expect(report.join("\n")).toMatch(/1 person entered before sign-in existed.*: Mana/);
    expect(convertChain(data).report).toEqual(["Nothing to convert: no Suppliers, Outlets, old statuses or incomplete records found."]);
  });

  it("never changes its input", () => {
    const input = oldChain();
    const copy = structuredClone(input);
    convertChain(input);
    expect(input).toEqual(copy);
  });

  it("is idempotent: converted data, or data already on the current chain, comes back unchanged", () => {
    const once = convertChain(oldChain()).data;
    const twice = convertChain(once);
    expect(twice.data).toEqual(once);
    expect(twice.report).toHaveLength(1);
    expect(twice.report[0]).toMatch(/Nothing to convert/);
    const clean = snapshot({
      partners: [partner("DB0001", "DB", "Thane"), partner("RT0001", "RETAILER", "Shop", "DB0001")],
      sequences: [...(structuredClone(base.sequences) as unknown as Rec[]), { id: "DB", value: 1 }, { id: "RT", value: 1 }],
    });
    expect(convertChain(clean).data).toEqual(clean);
  });

  describe("refuses, changing nothing, while a Supplier has stock or history", () => {
    const refused = (over: Partial<Record<keyof DbSnapshot, Rec[]>>) => () => convertChain(oldChain(over));

    it("a Supplier holding stock", () => {
      const lots = [lot("91AAA111OR00009", { status: "AT_SUPPLIER", locationId: "SP0001" })];
      expect(refused({ lots })).toThrow(/Cannot remove the Supplier tier/);
      expect(refused({ lots })).toThrow(/Andheri Traders \(SP0001\).*91AAA111OR00009/);
    });

    it("stock on the way to a Supplier", () => {
      expect(refused({ lots: [lot("91AAA111OR00009", { status: "IN_TRANSIT", locationId: "DB0001", inTransitToId: "SP0002" })] })).toThrow(/Baner Traders \(SP0002\)/);
      expect(refused({ packs: [pack("91AAA111OR00009", 1, { status: "IN_TRANSIT", locationId: "DB0001", inTransitToId: "SP0001" })] })).toThrow(/Cannot remove the Supplier tier/);
    });

    it("a Supplier named in history: movements, scans", () => {
      expect(refused({ movements: [movement("m9", { fromId: "DB0001", toId: "SP0001", toStatus: "AT_SUPPLIER" })] })).toThrow(/Cannot remove the Supplier tier/);
      expect(refused({ scans: [scan("sc9", { userId: "SP0002", partnerId: null })] })).toThrow(/Baner Traders \(SP0002\).*history/);
    });

    it("an AT_SUPPLIER status anywhere", () => {
      expect(refused({ lots: [lot("91AAA111OR00009", { status: "RECALLED", statusBeforeRecall: "AT_SUPPLIER" })] })).toThrow(/AT_SUPPLIER/);
    });

    it("leaves the input as it was", () => {
      const input = oldChain({ lots: [lot("91AAA111OR00009", { status: "AT_SUPPLIER", locationId: "SP0001" })] });
      const copy = structuredClone(input);
      expect(() => convertChain(input)).toThrow();
      expect(input).toEqual(copy);
    });
  });
});
