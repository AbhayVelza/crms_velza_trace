import { describe, expect, it } from "vitest";
import {
  canDispatch,
  canOpenLot,
  canReceive,
  canReprint,
  canStartVerification,
  canVoid,
  checkVerifyPackScan,
  dispatchPatch,
  evaluateVerification,
  isAssignedDestination,
  packStatusForLot,
  publicStatus,
  receivePatch,
  recallPatch,
  type MovableItem,
} from "./rules";
import type { Partner, PartnerType } from "./types";

const partner = (id: string, type: PartnerType, parentId: string | null = null): Partner => ({ id, type, name: id, city: "Pune", territory: "", parentId, active: true });
const MFG = partner("mfg", "MANUFACTURER");
const SS1 = partner("ss1", "SS");
const SS2 = partner("ss2", "SS");
const DB1 = partner("db1", "DB", "ss1");
const DB2 = partner("db2", "DB", "ss2");
const SUP1 = partner("sup1", "SUPPLIER");
const OUT1 = partner("out1", "OUTLET");

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

  it("enforces next tier only", () => {
    expect(canDispatch({ ...base, item: lot(), receiver: DB1 })).toMatchObject({ ok: false, code: "WRONG_DESTINATION" });
    const atSS = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canDispatch({ ...base, sender: SS1, receiver: SS2, item: atSS })).toMatchObject({ code: "WRONG_DESTINATION" });
    expect(canDispatch({ ...base, sender: SS1, receiver: DB1, item: atSS })).toEqual({ ok: true });
    expect(canDispatch({ ...base, sender: OUT1, receiver: null, item: lot() })).toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("lets a Super Stockist supply only its assigned distributors", () => {
    const atSS1 = lot({ status: "AT_SS", locationId: "ss1" });
    expect(canDispatch({ ...base, sender: SS1, receiver: DB2, item: atSS1 })).toMatchObject({ ok: false, code: "WRONG_DESTINATION", message: expect.stringMatching(/assigned distributors/) });
    expect(canDispatch({ ...base, sender: SS1, receiver: { ...DB1, parentId: null }, item: atSS1 })).toMatchObject({ code: "WRONG_DESTINATION" });
    expect(isAssignedDestination(SS2, DB2)).toBe(true);
    expect(isAssignedDestination(SS2, DB1)).toBe(false);
    // Other tiers are not territory-bound
    expect(isAssignedDestination(MFG, SS2)).toBe(true);
    expect(isAssignedDestination(DB1, SUP1)).toBe(true);
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
    const pack: MovableItem = { ...lot({ status: "AT_SUPPLIER", locationId: "sup1" }), kind: "PACK", code: "91ABC123OR0000162" };
    const sup = { ...base, sender: SUP1, receiver: OUT1 };
    expect(canDispatch({ ...sup, item: pack, parentLotStatus: "AT_SUPPLIER" })).toMatchObject({ code: "LOT_SEALED" });
    expect(canDispatch({ ...sup, item: pack, parentLotStatus: "OPENED" })).toEqual({ ok: true });
    expect(canDispatch({ ...sup, item: lot({ status: "OPENED", locationId: "sup1" }) })).toMatchObject({ code: "LOT_OPENED" });
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
    expect(receivePatch(OUT1).status).toBe("AT_OUTLET");
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
  it("open lot: supplier/outlet only, at their location", () => {
    const atSup = lot({ status: "AT_SUPPLIER", locationId: "sup1" });
    expect(canOpenLot(atSup, SUP1)).toEqual({ ok: true });
    expect(canOpenLot(atSup, OUT1)).toMatchObject({ code: "NOT_AT_LOCATION" });
    expect(canOpenLot(lot({ status: "AT_SS", locationId: "ss1" }), SS1)).toMatchObject({ code: "NOT_ALLOWED" });
    expect(canOpenLot({ ...atSup, status: "OPENED" }, SUP1)).toMatchObject({ code: "WRONG_STATUS" });
    expect(canOpenLot(lot({ status: "AT_OUTLET", locationId: "out1" }), OUT1)).toEqual({ ok: true });
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

  it("recall keeps the previous status and skips VOID", () => {
    expect(recallPatch("AT_DB")).toEqual({ status: "RECALLED", statusBeforeRecall: "AT_DB" });
    expect(recallPatch("VOID")).toBeNull();
    expect(recallPatch("RECALLED")).toBeNull();
  });

  it("packs mirror the lot until opened", () => {
    expect(packStatusForLot("IN_TRANSIT", "PACKED")).toBe("IN_TRANSIT");
    expect(packStatusForLot("OPENED", "AT_SUPPLIER")).toBe("AT_SUPPLIER");
  });

  it("public status labels", () => {
    expect(publicStatus(true, "AT_OUTLET").label).toBe("Genuine Velza product");
    expect(publicStatus(true, "RECALLED").label).toBe("Recalled — do not consume");
    expect(publicStatus(false, null).label).toBe("Unregistered code");
  });
});
