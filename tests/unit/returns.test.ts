// Returns: Velza field staff (VELZA_FIELD) scan view-only with the full chain, take stock back from a partner to the
// Velza Warehouse (RETURN_IN_TRANSIT, RETURN_PICKUP logged), a pack taken from a sealed case opens that case first,
// the warehouse receives it as RETURNED and inspects it: back to stock (AT_WAREHOUSE, dispatchable) or write-off
// (DAMAGED / EXPIRED, never dispatchable). HQ's Returns report lists it all.
// Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { reportDamaged } from "@/lib/services/damage";
import { productDetails } from "@/lib/services/details";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { inspectReturn, pendingReturns, returnsReport, takeBack } from "@/lib/services/returns";
import { myStock, publicLookup } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { photoOf } from "../fixtures/damagePhoto";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
let lots: string[] = [];
const FIELD = "VF0001";

const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
const statusOf = async (code: string) => (code.length > 15 ? (await store().packs.findOne({ packCode: code }))!.status : (await store().lots.findOne({ lotCode: code }))!.status);
const send = async (from: string, to: string, invoice: string, codes: string[]) => {
  expect(await dispatch(from, { action: "confirm", toPartnerId: to, invoice, codes })).toMatchObject({ ok: true });
};
const take = async (who: string, codes: string[]) => {
  for (const code of codes) expect(await receive(who, { code })).toMatchObject({ ok: true });
};
const full = async (who: string, code: string) => {
  const r = await productDetails(who, code);
  if (!r.found || !r.full) throw new Error(`no full view of ${code}`);
  return r as typeof r & { full: NonNullable<typeof r.full> };
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-returns-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  process.env.VELZA_UPLOAD_DIR = path.join(dir, "uploads");
  await store().reset(buildSampleSeed());
  const [users, partners] = await Promise.all([store().users.list(), store().partners.list()]);
  const user = (role: Role, prefix?: string) => users.find((u) => u.role === role && (!prefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(prefix)))!.id;
  Object.assign(ids, {
    op: user("OPERATOR"), qc: user("QC"), vw: user("WAREHOUSE"), ss1: user("SS", "SS-1"), ss2: user("SS", "SS-2"), db1: user("DB", "DB-1"),
    rt1: user("RETAILER", "Retailer-1"), rt2: user("RETAILER", "Retailer-2"), hq: user("TRACE_OWNER"), admin: user("ADMIN"),
  });
  for (const [k, prefix] of [["VW", "VW-1"], ["SS1", "SS-1"], ["DB1", "DB-1"], ["RT1", "Retailer-1"], ["RT2", "Retailer-2"]]) ids[k] = partners.find((p) => p.name.startsWith(prefix))!.id;

  // Five Original cases (made 1 Nov 2026, expiring 1 Aug 2027), QC-passed; all go MF → VW → SS-1 → DB-1 → Retailer-1.
  const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 5, trays: 0 }] });
  if (created.preview) throw new Error("expected an order");
  await markPrinted(ids.op, created.printOrder.id);
  lots = created.printOrder.lotCodes;
  for (const lotCode of lots) {
    const packs = await packsOf(lotCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  await send(ids.op, ids.VW, "INV-P1", lots);
  await take(ids.vw, lots);
  await send(ids.vw, ids.SS1, "INV-W1", lots);
  await take(ids.ss1, lots);
  await send(ids.ss1, ids.DB1, "INV-S1", lots);
  await take(ids.db1, lots);
  await send(ids.db1, ids.RT1, "INV-D1", lots);
  await take(ids.rt1, lots);
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  delete process.env.VELZA_UPLOAD_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("field scan is view-only, with the full chain", () => {
  it("shows MF → Velza Warehouse → SS → DB → RT with date and time and invoice, holder, status, dates, days to expiry", async () => {
    const r = await full(FIELD, lots[0]);
    expect(r.supplyChain.map((s) => s.tier)).toEqual(["MANUFACTURER", "WAREHOUSE", "SS", "DB", "RETAILER"]);
    expect(r.supplyChain.map((s) => s.invoice)).toEqual([null, "INV-P1", "INV-W1", "INV-S1", "INV-D1"]);
    for (const s of r.supplyChain.slice(1)) expect(s.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d/); // date AND time
    expect(r).toMatchObject({ status: "AT_RETAILER", mfgDate: "2026-11-01", expiryDate: "2027-08-01", daysToExpiry: expect.any(Number), full: { holder: expect.stringMatching(/^Retailer-1/), holderTier: "Retailer", canTakeBack: true } });
  });

  it("scanning changes nothing: no receive, no movement; the field role cannot receive at all", async () => {
    const before = (await store().movements.list({ itemCode: lots[0] })).length;
    await full(FIELD, lots[0]);
    expect((await store().movements.list({ itemCode: lots[0] })).length).toBe(before);
    expect(await statusOf(lots[0])).toBe("AT_RETAILER");
    await expect(receive(FIELD, { code: lots[0] })).rejects.toMatchObject({ status: 403 });
    await expect(dispatch(FIELD, { action: "check", toPartnerId: ids.VW, invoice: "X", code: lots[0] })).rejects.toMatchObject({ status: 403 });
  });

  it("HQ and Admin see the same full info card (without Take back); partners keep their own limited view", async () => {
    for (const who of [ids.hq, ids.admin]) {
      const r = await full(who, lots[0]);
      expect(r.supplyChain).toHaveLength(5);
      expect(r.full.canTakeBack).toBe(false);
    }
    const ss = await productDetails(ids.ss1, lots[0]);
    expect(ss).toMatchObject({ found: true });
    expect(ss.found && ss.full).toBeUndefined();
    await expect(takeBack(ids.hq, { code: lots[0], reason: "NOT_SELLING" })).rejects.toMatchObject({ status: 403 });
    await expect(takeBack(ids.rt1, { code: lots[0], reason: "NOT_SELLING" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("take back", () => {
  it("a whole case: RETURN_IN_TRANSIT to the warehouse, RETURN_PICKUP logged with user, location, reason, time; it leaves the retailer's stock", async () => {
    const r = await takeBack(FIELD, { code: lots[0], reason: "NOT_SELLING" });
    expect(r).toMatchObject({ ok: true, status: "RETURN_IN_TRANSIT", openedLot: null });
    expect(await store().lots.findOne({ lotCode: lots[0] })).toMatchObject({ status: "RETURN_IN_TRANSIT", locationId: ids.RT1, inTransitToId: ids.VW });
    expect(new Set((await store().packs.list({ lotCode: lots[0] })).map((p) => p.status))).toEqual(new Set(["RETURN_IN_TRANSIT"]));
    const [m] = await store().movements.list({ itemCode: lots[0], type: "RETURN_PICKUP" });
    expect(m).toMatchObject({ userId: FIELD, fromId: ids.RT1, toId: ids.VW, fromStatus: "AT_RETAILER", toStatus: "RETURN_IN_TRANSIT", note: "Not selling", at: expect.any(String) });
    expect((await myStock(ids.rt1)).inStock.map((i) => i.code)).not.toContain(lots[0]);
    expect((await myStock(ids.vw)).incoming.map((i) => i.code)).toContain(lots[0]);
  });

  it("pack return auto-opens its sealed case first; the case's other packs stay at the retailer one by one", async () => {
    expect(await statusOf(lots[1])).toBe("AT_RETAILER");
    const pack = (await packsOf(lots[1]))[1];
    const r = await takeBack(FIELD, { code: pack, reason: "NEAR_EXPIRY" });
    expect(r).toMatchObject({ ok: true, openedLot: lots[1] });
    expect(await statusOf(lots[1])).toBe("OPENED");
    expect(await statusOf(pack)).toBe("RETURN_IN_TRANSIT");
    const opened = await store().movements.list({ itemCode: lots[1], type: "OPENED" });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ userId: FIELD, fromId: ids.RT1 });
    // OPENED is logged before the pickup.
    const [pickup] = await store().movements.list({ itemCode: pack, type: "RETURN_PICKUP" });
    expect(opened[0].at <= pickup.at).toBe(true);
    const stock = await myStock(ids.rt1);
    // A case is 4 packs: the other 3 stay in the retailer's stock, one by one.
    expect(stock.inStock.filter((i) => i.code.startsWith(lots[1]) && i.kind === "PACK").map((i) => i.code)).toHaveLength(3);
    // The field view now shows the case opened and the pack being taken back.
    expect(await full(FIELD, pack)).toMatchObject({ status: "RETURN_IN_TRANSIT", full: { canTakeBack: false, location: expect.stringMatching(/^Being taken back: Retailer-1.* → VW-1/) } });
  });

  it("refused: Other without a note, an opened case, stock not at an SS / DB / Retailer, something already taken back", async () => {
    await expect(takeBack(FIELD, { code: lots[2], reason: "OTHER" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(takeBack(FIELD, { code: lots[1], reason: "DAMAGED" })).rejects.toMatchObject({ code: "LOT_OPENED" });
    await expect(takeBack(FIELD, { code: lots[0], reason: "DAMAGED" })).rejects.toMatchObject({ code: "WRONG_STATUS" });
    await expect(takeBack(FIELD, { code: "91ABCDEFOR00001", reason: "DAMAGED" })).rejects.toMatchObject({ status: 400 });
    expect(await takeBack(FIELD, { code: lots[2], reason: "OTHER", note: "Shop closing down" })).toMatchObject({ ok: true });
    expect((await store().movements.list({ itemCode: lots[2], type: "RETURN_PICKUP" }))[0].note).toBe("Other: Shop closing down");
  });
});

describe("a returned item can't be sold or received elsewhere", () => {
  it("other partners get WRONG_RECEIVER; the old holder can't dispatch, open or report it; the public page says Withdrawn", async () => {
    for (const who of [ids.ss1, ids.ss2, ids.db1, ids.rt1, ids.rt2]) {
      expect(await receive(who, { code: lots[0] })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    }
    expect(await openLot(ids.rt1, { lotCode: lots[0] })).toMatchObject({ ok: false });
    expect(await reportDamaged(ids.rt1, { code: lots[0], reason: "x", ...photoOf(lots[0]) })).toMatchObject({ ok: false });
    expect(await dispatch(ids.db1, { action: "check", toPartnerId: ids.RT2, invoice: "X", code: lots[0] })).toMatchObject({ ok: false });
    expect((await publicLookup(lots[0])).status).toMatchObject({ label: "Withdrawn — do not consume" });
    expect(await statusOf(lots[0])).toBe("RETURN_IN_TRANSIT");
  });
});

describe("the warehouse receives returns and inspects them", () => {
  it("a scan at the warehouse auto-receives it as RETURNED; it waits for inspection and is not stock", async () => {
    expect(await receive(ids.vw, { code: lots[0] })).toMatchObject({ ok: true, status: "RETURNED" });
    expect(await store().lots.findOne({ lotCode: lots[0] })).toMatchObject({ status: "RETURNED", locationId: ids.VW, inTransitToId: null });
    expect((await store().movements.list({ itemCode: lots[0], type: "RECEIVED" })).at(-1)).toMatchObject({ fromStatus: "RETURN_IN_TRANSIT", toStatus: "RETURNED", toId: ids.VW });
    expect(await receive(ids.vw, { code: lots[0] })).toMatchObject({ ok: false });
    for (const code of [(await packsOf(lots[1]))[1], lots[2]]) expect(await receive(ids.vw, { code })).toMatchObject({ ok: true, status: "RETURNED" });
    const pending = await pendingReturns(ids.vw);
    expect(pending.items.map((i) => i.code).sort()).toEqual([lots[0], lots[2], (await packsOf(lots[1]))[1]].sort());
    expect(pending.items.find((i) => i.code === lots[0])).toMatchObject({ item: "Case", flavour: "Original", from: expect.stringMatching(/^Retailer-1/), reason: "Not selling" });
    expect((await myStock(ids.vw)).inStock.map((i) => i.code)).not.toContain(lots[0]);
    // Not dispatchable before the inspection.
    expect(await dispatch(ids.vw, { action: "check", toPartnerId: ids.SS1, invoice: "X", code: lots[0] })).toMatchObject({ ok: false });
    // Only the warehouse inspects.
    await expect(inspectReturn(ids.hq, { code: lots[0], decision: "BACK_TO_STOCK" })).rejects.toMatchObject({ status: 403 });
    await expect(inspectReturn(FIELD, { code: lots[0], decision: "BACK_TO_STOCK" })).rejects.toMatchObject({ status: 403 });
  });

  it("back to stock: AT_WAREHOUSE and it can be dispatched again", async () => {
    expect(await inspectReturn(ids.vw, { code: lots[0], decision: "BACK_TO_STOCK" })).toMatchObject({ ok: true, status: "AT_WAREHOUSE" });
    expect(await statusOf(lots[0])).toBe("AT_WAREHOUSE");
    expect((await myStock(ids.vw)).inStock.map((i) => i.code)).toContain(lots[0]);
    await send(ids.vw, ids.SS1, "INV-W2", [lots[0]]);
    expect(await receive(ids.ss1, { code: lots[0] })).toMatchObject({ ok: true, status: "AT_SS" });
    // A second inspection is refused.
    await expect(inspectReturn(ids.vw, { code: lots[0], decision: "BACK_TO_STOCK" })).rejects.toMatchObject({ code: "WRONG_STATUS" });
  });

  it("write-off: DAMAGED or EXPIRED, never dispatchable; a choice is required", async () => {
    const pack = (await packsOf(lots[1]))[1];
    await expect(inspectReturn(ids.vw, { code: pack, decision: "WRITE_OFF" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(await inspectReturn(ids.vw, { code: pack, decision: "WRITE_OFF", writeOffAs: "EXPIRED" })).toMatchObject({ ok: true, status: "EXPIRED" });
    expect(await inspectReturn(ids.vw, { code: lots[2], decision: "WRITE_OFF", writeOffAs: "DAMAGED" })).toMatchObject({ ok: true, status: "DAMAGED" });
    expect(new Set((await store().packs.list({ lotCode: lots[2] })).map((p) => p.status))).toEqual(new Set(["DAMAGED"]));
    for (const code of [pack, lots[2]]) {
      expect(await dispatch(ids.vw, { action: "check", toPartnerId: ids.SS1, invoice: "X", code })).toMatchObject({ ok: false, code: "WRONG_STATUS" });
    }
    await expect(dispatch(ids.vw, { action: "confirm", toPartnerId: ids.SS1, invoice: "X", codes: [lots[2]] })).rejects.toMatchObject({ status: 400 });
    expect((await myStock(ids.vw)).inStock.map((i) => i.code)).not.toEqual(expect.arrayContaining([pack, lots[2]]));
    expect((await publicLookup(pack)).status).toMatchObject({ label: "Expired — do not consume" });
  });
});

describe("HQ Returns report", () => {
  it("code, item, flavour, batch, expiry, returned from (partner + tier), reason, picked up by, date, final decision", async () => {
    const { rows } = await returnsReport(ids.hq);
    expect(rows).toHaveLength(3);
    const pack = (await packsOf(lots[1]))[1];
    const by = (code: string) => rows.find((r) => r.code === code)!;
    expect(by(lots[0])).toMatchObject({
      item: "Case", flavour: "Original", batch: lots[0].slice(2, 8), expiry: "2027-08-01",
      returnedFrom: expect.stringMatching(/^Retailer-1/), returnedFromTier: "Retailer", reason: "Not selling",
      pickedUpBy: expect.stringMatching(/^Farhan/), date: expect.any(String), decision: "Back to stock",
    });
    expect(by(pack)).toMatchObject({ item: "Pack 2 of 4", reason: "Near expiry", decision: "Written off (EXPIRED)" });
    expect(by(lots[2])).toMatchObject({ reason: "Other: Shop closing down", decision: "Written off (DAMAGED)" });
    await expect(returnsReport(ids.vw)).rejects.toMatchObject({ status: 403 });
    await expect(returnsReport(FIELD)).rejects.toMatchObject({ status: 403 });
  });

  it("the field view of a returned case shows the take-back and the warehouse's decision in its chain", async () => {
    const r = await full(FIELD, lots[0]);
    expect(r.supplyChain.map((s) => [s.tier, !!s.returned])).toEqual([
      ["MANUFACTURER", false], ["WAREHOUSE", false], ["SS", false], ["DB", false], ["RETAILER", false],
      ["WAREHOUSE", true], ["SS", false],
    ]);
    expect(r.full.returns).toEqual([expect.objectContaining({ from: expect.stringMatching(/^Retailer-1/), reason: "Not selling", decision: "Back to stock" })]);
  });
});
