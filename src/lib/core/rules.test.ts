import { describe, expect, it } from "vitest";
import {
  canDispatch,
  canReportDamaged,
  canOpenLot,
  canReceive,
  canReprint,
  lotStatusAfterReprint,
  canStartVerification,
  canVoid,
  checkVerifyPackScan,
  dispatchPatch,
  evaluateVerification,
  assignedPluralOf,
  assignedTypesOf,
  isAssignedDestination,
  packStatusForLot,
  publicStatus,
  receivePatch,
  recallPatch,
  type MovableItem,
} from "./rules";
import type { Partner, PartnerType } from "./types";

const partner = (id: string, type: PartnerType, parentId: string | null = null): Partner => ({
  id,
  type,
  name: id,
  place: "",
  address: "",
  city: "Pune",
  state: "Maharashtra",
  pincode: "",
  contactPerson: "",
  phone: "",
  email: "",
  parentId,
  active: true,
  createdAt: "2026-10-26T00:00:00.000Z",
  createdBy: null,
});
const MFG = partner("mfg", "MANUFACTURER");
const SS1 = partner("ss1", "SS");
const SS2 = partner("ss2", "SS");
const DB1 = partner("db1", "DB", "ss1");
const DB2 = partner("db2", "DB", "ss2");
const RT1 = partner("rt1", "RETAILER", "db1");
const RT2 = partner("rt2", "RETAILER", "db2");
/** One of the few retailers supplied by their Super Stockist directly. */
const RT3 = partner("rt3", "RETAILER", "ss1");

const lot = (over: Partial<MovableItem> = {}): MovableItem => ({
  kind: "LOT",
  code: "91ABC123OR00001",
  status: "PACKED",
  locationId: "mfg",
  inTransitToId: null,
  synced: true,
  ...over,
});

describe("canDispatch", () => {
  const base = { parentLotStatus: null, sender: MFG, receiver: SS1, invoice: "INV-001" };

  it("allows a packed, synced lot at the manufacturer to go to an SS", () => {
    expect(canDispatch({ ...base, item: lot() })).toEqual({ ok: true });
  });

  it("enforces the destination tiers: MF → SS → DB or Retailer, DB → Retailer", () => {
    expect(canDispatch({ ...base, item: lot(), receiver: DB1 })).toMatchObject({ ok: false, code: "WRONG_DESTINATION" });
    expect(canDispatch({ ...base, item: lot(), receiver: RT3 })).toMatchObject({ ok: false, code: "WRONG_DESTINATION", message: expect.stringMatching(/MANUFACTURER can only dispatch to SS, not RETAILER/) });
    const atSS = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canDispatch({ ...base, sender: SS1, receiver: SS2, item: atSS })).toMatchObject({ code: "WRONG_DESTINATION", message: expect.stringMatching(/SS can only dispatch to DB or RETAILER, not SS/) });
    expect(canDispatch({ ...base, sender: SS1, receiver: MFG, item: atSS })).toMatchObject({ code: "WRONG_DESTINATION" });
    expect(canDispatch({ ...base, sender: SS1, receiver: DB1, item: atSS })).toEqual({ ok: true });
    const atDB = lot({ status: "AT_DB", locationId: "db1" });
    for (const receiver of [MFG, SS1, DB2]) {
      expect(canDispatch({ ...base, sender: DB1, receiver, item: atDB })).toMatchObject({ code: "WRONG_DESTINATION", message: expect.stringMatching(/DB can only dispatch to RETAILER/) });
    }
  });

  it("a Retailer is the last tier and cannot dispatch", () => {
    const atRT = lot({ status: "AT_RETAILER", locationId: "rt1" });
    expect(canDispatch({ ...base, sender: RT1, receiver: null, item: atRT })).toMatchObject({ code: "NOT_ALLOWED", message: expect.stringMatching(/last tier/) });
    expect(canDispatch({ ...base, sender: RT1, receiver: RT2, item: atRT })).toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("lets a Super Stockist supply only its assigned distributors", () => {
    const atSS1 = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canDispatch({ ...base, sender: SS1, receiver: DB2, item: atSS1 })).toMatchObject({ ok: false, code: "WRONG_DESTINATION", message: expect.stringMatching(/assigned distributors/) });
    expect(canDispatch({ ...base, sender: SS1, receiver: { ...DB1, parentId: null }, item: atSS1 })).toMatchObject({ code: "WRONG_DESTINATION" });
    expect(isAssignedDestination(SS2, DB2)).toBe(true);
    expect(isAssignedDestination(SS2, DB1)).toBe(false);
    // The manufacturer may supply any Super Stockist
    expect(isAssignedDestination(MFG, SS2)).toBe(true);
  });

  it("never dispatches to an inactive partner, even an assigned one", () => {
    const atSS1 = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canDispatch({ ...base, sender: SS1, receiver: { ...DB1, active: false }, item: atSS1 })).toMatchObject({ code: "WRONG_DESTINATION", message: expect.stringMatching(/inactive/) });
  });

  it("lets a Distributor supply only its assigned retailers", () => {
    expect(isAssignedDestination(DB1, RT1)).toBe(true);
    expect(isAssignedDestination(DB1, RT2)).toBe(false);
    expect(isAssignedDestination(DB1, RT3)).toBe(false); // assigned to the SS directly
    expect(isAssignedDestination(DB1, { ...RT1, parentId: null })).toBe(false);
    const atDB = lot({ status: "AT_DB", locationId: "db1" });
    expect(canDispatch({ ...base, sender: DB1, receiver: RT1, item: atDB })).toEqual({ ok: true });
    expect(canDispatch({ ...base, sender: DB1, receiver: RT2, item: atDB })).toMatchObject({ code: "WRONG_DESTINATION", message: expect.stringMatching(/assigned retailers/) });
    expect(canDispatch({ ...base, sender: DB1, receiver: RT3, item: atDB })).toMatchObject({ code: "WRONG_DESTINATION", message: expect.stringMatching(/assigned retailers/) });
  });

  it("lets a Super Stockist supply the retailers assigned to it directly, not its distributors' retailers", () => {
    expect(isAssignedDestination(SS1, RT3)).toBe(true);
    expect(isAssignedDestination(SS1, RT1)).toBe(false); // RT1 is DB1's, and DB1 is SS1's
    expect(isAssignedDestination(SS2, RT3)).toBe(false);
    const atSS1 = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canDispatch({ ...base, sender: SS1, receiver: RT3, item: atSS1 })).toEqual({ ok: true });
    expect(canDispatch({ ...base, sender: SS1, receiver: RT1, item: atSS1 })).toMatchObject({ ok: false, code: "WRONG_DESTINATION", message: expect.stringMatching(/assigned retailers/) });
    const atSS2 = lot({ status: "AT_SS", locationId: "ss2" });
    expect(canDispatch({ ...base, sender: SS2, receiver: RT3, item: atSS2 })).toMatchObject({ code: "WRONG_DESTINATION", message: expect.stringMatching(/assigned retailers/) });
  });

  it("lists the tiers assigned to each tier", () => {
    expect(assignedTypesOf("SS")).toEqual(["DB", "RETAILER"]);
    expect(assignedTypesOf("DB")).toEqual(["RETAILER"]);
    expect(assignedTypesOf("MANUFACTURER")).toEqual([]);
    expect(assignedTypesOf("RETAILER")).toEqual([]);
    expect(assignedPluralOf("SS")).toBe("distributors and retailers");
    expect(assignedPluralOf("DB")).toBe("retailers");
    expect(assignedPluralOf("MANUFACTURER")).toBe("");
    expect(assignedPluralOf("RETAILER")).toBe("");
  });

  it("requires an invoice", () => {
    expect(canDispatch({ ...base, invoice: "  ", item: lot() })).toMatchObject({ code: "INVOICE_REQUIRED" });
  });

  it("blocks unsynced lots", () => {
    expect(canDispatch({ ...base, item: lot({ synced: false }) })).toMatchObject({ code: "UNSYNCED" });
  });

  it("blocks recalled/quarantined/void", () => {
    for (const status of ["RECALLED", "QUARANTINED", "VOID"] as const) {
      expect(canDispatch({ ...base, item: lot({ status }) })).toMatchObject({ code: "BLOCKED_CODE" });
    }
    expect(canDispatch({ ...base, item: lot({ status: "DAMAGED" }) })).toMatchObject({ code: "WRONG_STATUS" });
  });

  it("requires the item at the sender's location with the sender's status", () => {
    expect(canDispatch({ ...base, item: lot({ locationId: "elsewhere" }) })).toMatchObject({ code: "NOT_AT_LOCATION" });
    expect(canDispatch({ ...base, item: lot({ status: "PRINTED" }) })).toMatchObject({ code: "WRONG_STATUS" });
    expect(canDispatch({ ...base, item: lot({ status: "IN_TRANSIT", inTransitToId: "ss1" }) })).toMatchObject({
      code: "WRONG_STATUS",
    });
  });

  it("packs move alone only after their lot is opened; opened lots don't move", () => {
    // Only Retailers open lots, but the rule itself is generic.
    const pack: MovableItem = { ...lot({ status: "AT_DB", locationId: "db1" }), kind: "PACK", code: "91ABC123OR0000162" };
    const db = { ...base, sender: DB1, receiver: RT1 };
    expect(canDispatch({ ...db, item: pack, parentLotStatus: "AT_DB" })).toMatchObject({ code: "LOT_SEALED" });
    expect(canDispatch({ ...db, item: pack, parentLotStatus: "OPENED" })).toEqual({ ok: true });
    expect(canDispatch({ ...db, item: lot({ status: "OPENED", locationId: "db1" }) })).toMatchObject({ code: "LOT_OPENED" });
  });

  it("dispatchPatch sets IN_TRANSIT to the receiver", () => {
    expect(dispatchPatch("ss1", "2026-01-01T00:00:00.000Z")).toEqual({
      status: "IN_TRANSIT",
      inTransitToId: "ss1",
      dispatchedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("canReceive", () => {
  const inTransit = lot({ status: "IN_TRANSIT", inTransitToId: "ss1" });

  it("accepts the intended receiver", () => {
    expect(canReceive({ item: inTransit, parentLotStatus: null, receiver: SS1 })).toEqual({ ok: true });
    expect(receivePatch(SS1)).toEqual({ status: "AT_SS", locationId: "ss1", inTransitToId: null, dispatchedAt: null });
    expect(receivePatch(DB1).status).toBe("AT_DB");
    expect(receivePatch(RT1)).toEqual({ status: "AT_RETAILER", locationId: "rt1", inTransitToId: null, dispatchedAt: null });
    expect(receivePatch(RT3).status).toBe("AT_RETAILER");
  });

  it("rejects anyone else with WRONG_RECEIVER", () => {
    expect(canReceive({ item: inTransit, parentLotStatus: null, receiver: SS2 })).toMatchObject({ code: "WRONG_RECEIVER" });
    expect(canReceive({ item: lot(), parentLotStatus: null, receiver: SS1 })).toMatchObject({ code: "WRONG_RECEIVER" });
  });

  it("flags a second receipt as DUPLICATE_RECEIPT", () => {
    const received = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canReceive({ item: received, parentLotStatus: null, receiver: SS1 })).toMatchObject({ code: "DUPLICATE_RECEIPT" });
  });

  it("flags blocked codes", () => {
    const recalled = lot({ status: "RECALLED", inTransitToId: "ss1" });
    expect(canReceive({ item: recalled, parentLotStatus: null, receiver: SS1 })).toMatchObject({ code: "BLOCKED_CODE" });
  });

  it("rejects a pack of a sealed lot", () => {
    const pack: MovableItem = { ...inTransit, kind: "PACK", code: "91ABC123OR0000161" };
    expect(canReceive({ item: pack, parentLotStatus: "IN_TRANSIT", receiver: SS1 })).toMatchObject({ code: "LOT_SEALED" });
    expect(canReceive({ item: pack, parentLotStatus: "OPENED", receiver: SS1 })).toEqual({ ok: true });
  });
});

describe("verification", () => {
  const caseLot = { lotCode: "91ABC123OR00001", lotType: "CASE" as const, status: "PRINTED" as const };
  const packs = ["91ABC123OR0000161", "91ABC123OR0000162", "91ABC123OR0000163", "91ABC123OR0000164"];

  it("only PRINTED lots can be verified", () => {
    expect(canStartVerification(caseLot)).toEqual({ ok: true });
    expect(canStartVerification({ ...caseLot, status: "GENERATED" })).toMatchObject({ code: "NOT_PRINTED" });
    expect(canStartVerification({ ...caseLot, status: "PACKED" })).toMatchObject({ code: "WRONG_STATUS" });
    expect(canStartVerification({ ...caseLot, status: "VOID" })).toMatchObject({ code: "BLOCKED_CODE" });
  });

  it("live scan check: wrong lot and duplicates are red", () => {
    expect(checkVerifyPackScan(caseLot, packs[0], [])).toEqual({ ok: true });
    expect(checkVerifyPackScan(caseLot, packs[0], [packs[0]])).toMatchObject({ code: "DUPLICATE_SCAN" });
    expect(checkVerifyPackScan(caseLot, "91ABC123OR0000261", [])).toMatchObject({ code: "WRONG_LOT" });
    expect(checkVerifyPackScan(caseLot, "91ABC123OR0000141", [])).toMatchObject({ code: "WRONG_LOT" });
  });

  it("passes with exactly the 4 packs of a case (any order)", () => {
    expect(evaluateVerification(caseLot, [...packs].reverse())).toEqual({ pass: true });
  });

  it("passes with the 6 packs of a tray", () => {
    const tray = { lotCode: "91ABC123OR00003", lotType: "TRAY" as const, status: "PRINTED" as const };
    const p = [1, 2, 3, 4, 5, 6].map((s) => `91ABC123OR000034${s}`);
    expect(evaluateVerification(tray, p)).toEqual({ pass: true });
    expect(evaluateVerification(tray, p.slice(0, 4)).pass).toBe(false);
  });

  it("fails on short count, foreign packs, duplicates, wrong status", () => {
    const short = evaluateVerification(caseLot, packs.slice(0, 3));
    expect(short).toMatchObject({ pass: false });
    expect(!short.pass && short.reason).toMatch(/expected 4 packs, scanned 3/);
    const foreign = evaluateVerification(caseLot, [...packs.slice(0, 3), "91ABC123OR0000261"]);
    expect(!foreign.pass && foreign.reason).toMatch(/not from this lot/);
    const dup = evaluateVerification(caseLot, [packs[0], packs[0], packs[1], packs[2]]);
    expect(!dup.pass && dup.reason).toMatch(/duplicates/);
    expect(evaluateVerification({ ...caseLot, status: "PACKED" }, packs).pass).toBe(false);
  });
});

describe("open, void, reprint, recall", () => {
  it("open lot: Retailers only, at their location", () => {
    const atRT = lot({ status: "AT_RETAILER", locationId: "rt1" });
    expect(canOpenLot(atRT, RT1)).toEqual({ ok: true });
    expect(canOpenLot(lot({ status: "AT_RETAILER", locationId: "rt3" }), RT3)).toEqual({ ok: true }); // supplied by its SS directly
    expect(canOpenLot(atRT, RT2)).toMatchObject({ code: "NOT_AT_LOCATION" });
    expect(canOpenLot({ ...atRT, status: "OPENED" }, RT1)).toMatchObject({ code: "WRONG_STATUS" });
    expect(canOpenLot(lot({ status: "AT_SS", locationId: "ss1" }), SS1)).toMatchObject({ code: "NOT_ALLOWED", message: "Only a Retailer can open a lot" });
    expect(canOpenLot(lot({ status: "AT_DB", locationId: "db1" }), DB1)).toMatchObject({ code: "NOT_ALLOWED" });
    expect(canOpenLot(lot(), MFG)).toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("void: only unpasted/misprinted lots", () => {
    expect(canVoid({ lotCode: "x", status: "PRINTED" })).toEqual({ ok: true });
    expect(canVoid({ lotCode: "x", status: "GENERATED" })).toEqual({ ok: true });
    expect(canVoid({ lotCode: "x", status: "PACKED" })).toMatchObject({ ok: false });
    expect(canVoid({ lotCode: "x", status: "VOID" })).toMatchObject({ ok: false });
  });

  it("reprint: reason required, only at manufacturer", () => {
    expect(canReprint({ code: "x", status: "PACKED" }, "torn")).toEqual({ ok: true });
    expect(canReprint({ code: "x", status: "PACKED" }, " ")).toMatchObject({ code: "REASON_REQUIRED" });
    expect(canReprint({ code: "x", status: "AT_SS" }, "torn")).toMatchObject({ code: "WRONG_STATUS" });
  });

  it("a reprint sends a quarantined lot back to QC; other statuses stay", () => {
    expect(lotStatusAfterReprint("QUARANTINED")).toBe("PRINTED");
    expect(lotStatusAfterReprint("PACKED")).toBe("PACKED");
    expect(lotStatusAfterReprint("PRINTED")).toBe("PRINTED");
  });

  it("recall keeps the previous status and skips VOID", () => {
    expect(recallPatch("AT_DB")).toEqual({ status: "RECALLED", statusBeforeRecall: "AT_DB" });
    expect(recallPatch("VOID")).toBeNull();
    expect(recallPatch("RECALLED")).toBeNull();
  });

  it("packs mirror the lot until opened", () => {
    expect(packStatusForLot("IN_TRANSIT", "PACKED")).toBe("IN_TRANSIT");
    expect(packStatusForLot("OPENED", "AT_RETAILER")).toBe("AT_RETAILER");
  });

  it("public status labels", () => {
    expect(publicStatus(true, "AT_RETAILER").label).toBe("Genuine Velza product");
    expect(publicStatus(true, "RECALLED").label).toBe("Recalled — do not consume");
    expect(publicStatus(false, null).label).toBe("Unregistered code");
  });
});

describe("damaged", () => {
  const atSS = lot({ status: "AT_SS", locationId: "ss1" });
  const pack = (over: Partial<MovableItem> = {}): MovableItem => ({ ...atSS, kind: "PACK", code: "91ABC123OR0000162", ...over });
  const dmg = (item: MovableItem, partnerArg: Partner, parentLotStatus: MovableItem["status"] | null = null, reason = "Crushed") =>
    canReportDamaged({ item, parentLotStatus, partner: partnerArg, reason });

  it("lets the partner holding a sealed lot report it, with a reason", () => {
    expect(dmg(atSS, SS1)).toEqual({ ok: true });
    expect(dmg(lot(), MFG)).toEqual({ ok: true }); // packed at the plant
    expect(dmg(atSS, SS1, null, "  ")).toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("refuses stock held elsewhere, in transit, or not packed yet", () => {
    expect(dmg(atSS, SS2)).toMatchObject({ code: "NOT_AT_LOCATION" });
    expect(dmg(lot({ status: "IN_TRANSIT", locationId: "mfg", inTransitToId: "ss1" }), SS1)).toMatchObject({ code: "NOT_AT_LOCATION", message: expect.stringMatching(/receive it first/) });
    expect(dmg(lot({ status: "PRINTED" }), MFG)).toMatchObject({ code: "NOT_AT_LOCATION", message: expect.stringMatching(/Void lot/) });
  });

  it("a pack is reported alone only once its lot is opened", () => {
    expect(dmg(pack(), SS1, "AT_SS")).toMatchObject({ code: "LOT_SEALED", message: expect.not.stringMatching(/open the lot/) });
    expect(dmg(pack({ status: "AT_DB", locationId: "db1" }), DB1, "AT_DB")).toMatchObject({ code: "LOT_SEALED", message: expect.not.stringMatching(/open the lot/) });
    expect(dmg(pack({ status: "AT_RETAILER", locationId: "rt1" }), RT1, "AT_RETAILER")).toMatchObject({ code: "LOT_SEALED", message: expect.stringMatching(/open the lot/) });
    expect(dmg(pack({ status: "AT_RETAILER", locationId: "rt1" }), RT1, "OPENED")).toEqual({ ok: true });
  });

  it("an opened case or tray is still reported whole, if any of its packs are still here", () => {
    const opened = lot({ status: "OPENED", locationId: "rt1" });
    expect(canReportDamaged({ item: opened, parentLotStatus: null, partner: RT1, reason: "Leaking", packsHere: 2 })).toEqual({ ok: true });
    expect(dmg(opened, RT1)).toMatchObject({ code: "NOT_AT_LOCATION", message: expect.stringMatching(/None of the packs/) });
    expect(canReportDamaged({ item: opened, parentLotStatus: null, partner: RT2, reason: "Leaking", packsHere: 1 })).toMatchObject({
      code: "NOT_AT_LOCATION",
      message: expect.stringMatching(/opened before it reached .* report its 1 pack/),
    });
  });

  it("refuses units already damaged or blocked", () => {
    expect(dmg(lot({ status: "DAMAGED", locationId: "ss1" }), SS1)).toMatchObject({ code: "WRONG_STATUS", message: expect.stringMatching(/already reported/) });
    expect(dmg(lot({ status: "RECALLED", locationId: "ss1" }), SS1)).toMatchObject({ code: "BLOCKED_CODE" });
  });

  it("a damaged unit can no longer be dispatched", () => {
    const damaged = lot({ status: "DAMAGED", locationId: "ss1" });
    expect(canDispatch({ item: damaged, parentLotStatus: null, sender: SS1, receiver: DB1, invoice: "INV-1" })).toMatchObject({ ok: false, code: "WRONG_STATUS" });
  });
});
