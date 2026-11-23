// A Distributor (DB) or Super Stockist (SS) may open (split) a case or tray of its own stock and dispatch its packs one
// by one to its own Retailers, e.g. a Retailer's order of a few packs, or a large order going through the SS. Retailer
// receipt stays the end of tracking. Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { listDamaged, reportDamaged } from "@/lib/services/damage";
import { dispatch, myPartners, openLot, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { inspectReturn, takeBack } from "@/lib/services/returns";
import { dashboard, lookup, myStock } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { photoOf } from "../fixtures/damagePhoto";
import { buildSampleSeed } from "../fixtures/sampleNetwork";
import { shipToCustoms } from "../fixtures/shipToCustoms";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
const FIELD = "VF0001";
/** C1, C2: cases (4 packs); T1, T2: trays (6 packs). */
const lot: Record<"C1" | "C2" | "T1" | "T2", string> = { C1: "", C2: "", T1: "", T2: "" };

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
async function partner(prefix: string) {
  return (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;
}
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
async function verifyLot(lotCode: string) {
  const packs = await packsOf(lotCode);
  expect(await verify(ids.qc, { action: "scanLot", code: lotCode })).toMatchObject({ ok: true });
  for (const [i, code] of packs.entries()) expect(await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) })).toMatchObject({ ok: true });
  expect(await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs })).toMatchObject({ ok: true });
}
const send = async (from: string, to: string, invoice: string, codes: string[]) =>
  expect(await dispatch(from, { action: "confirm", toPartnerId: to, invoice, codes })).toMatchObject({ ok: true, count: codes.length });
const take = async (who: string, codes: string[]) => {
  for (const code of codes) expect(await receive(who, { code })).toMatchObject({ ok: true });
};
const check = (from: string, to: string, code: string) => dispatch(from, { action: "check", toPartnerId: to, invoice: "INV-CHECK", code });
const counts = async (who: string) => (await myStock(who)).counts;
const hqRow = async (partnerId: string) => (await dashboard(ids.hq)).stock.find((s) => s.partnerId === partnerId);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-split-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  ids.op = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.vw = await user("WAREHOUSE");
  ids.ss1 = await user("SS", "SS-1");
  ids.db1 = await user("DB", "DB-1");
  ids.rt1 = await user("RETAILER", "Retailer-1");
  ids.rt2 = await user("RETAILER", "Retailer-2");
  ids.rt4 = await user("RETAILER", "Retailer-4");
  ids.hq = await user("TRACE_OWNER");
  ids.VW = await partner("VW-1");
  ids.SS1 = await partner("SS-1");
  ids.DB1 = await partner("DB-1");
  ids.RT1 = await partner("Retailer-1"); // DB-1's
  ids.RT2 = await partner("Retailer-2"); // DB-1's
  ids.RT3 = await partner("Retailer-3"); // DB-2's
  ids.RT4 = await partner("Retailer-4"); // SS-1's directly

  const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 2, trays: 2 }] });
  if (created.preview) throw new Error("expected a created order");
  await markPrinted(ids.op, created.printOrder.id);
  const lots = await store().lots.list({ lotCode: created.printOrder.lotCodes });
  const cases = lots.filter((l) => l.lotType === "CASE").map((l) => l.lotCode).sort();
  const trays = lots.filter((l) => l.lotType === "TRAY").map((l) => l.lotCode).sort();
  [lot.C1, lot.C2] = cases;
  [lot.T1, lot.T2] = trays;
  for (const code of [...cases, ...trays]) await verifyLot(code);
  await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: [...cases, ...trays], invoice: "INV-SPLIT-0" });
  await send(ids.vw, ids.SS1, "INV-SPLIT-1", [...cases, ...trays]);
  await take(ids.ss1, [...cases, ...trays]);
  // SS-1 keeps case C1 and sends C2, T1 and T2 to DB-1 sealed.
  await send(ids.ss1, ids.DB1, "INV-SPLIT-2", [lot.C2, lot.T1, lot.T2]);
  await take(ids.db1, [lot.C2, lot.T1, lot.T2]);
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a Distributor or Super Stockist splits a case/tray", () => {
  it("before opening: a sealed pack can't be dispatched alone, and nobody opens what isn't in its own stock", async () => {
    const [t1p1] = await packsOf(lot.T1);
    expect(await check(ids.db1, ids.RT1, t1p1)).toMatchObject({ ok: false, code: "LOT_SEALED" });
    // SS-1 can't open the tray DB-1 holds, DB-1 can't open the case SS-1 holds, a Retailer can't open DB-1's tray.
    expect(await openLot(ids.ss1, { lotCode: lot.T1 })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    expect(await openLot(ids.db1, { lotCode: lot.C1 })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    expect(await openLot(ids.rt1, { lotCode: lot.T1 })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    // Customs and the plant never open a lot.
    await expect(openLot(ids.vw, { lotCode: lot.T1 })).rejects.toMatchObject({ status: 403 });
    await expect(openLot(ids.op, { lotCode: lot.T1 })).rejects.toMatchObject({ status: 403 });
    expect(await counts(ids.db1)).toEqual({ cases: 1, trays: 2, openedCases: 0, openedTrays: 0, loosePacks: 0 });
  });

  it("DB-1 opens tray T1: its 6 packs are loose stock at DB-1, the tray is counted while any of them is there", async () => {
    const r = await openLot(ids.db1, { lotCode: lot.T1 });
    expect(r).toMatchObject({ ok: true });
    expect(r.packs).toHaveLength(6);
    expect(new Set(r.packs!.map((p) => p.status))).toEqual(new Set(["AT_DB"]));
    expect((await store().lots.findOne({ lotCode: lot.T1 }))).toMatchObject({ status: "OPENED", locationId: ids.DB1 });
    expect(await counts(ids.db1)).toEqual({ cases: 1, trays: 2, openedCases: 0, openedTrays: 1, loosePacks: 6 });
    expect(await openLot(ids.db1, { lotCode: lot.T1 })).toMatchObject({ ok: false, code: "WRONG_STATUS" }); // already opened
    // An opened tray no longer moves whole.
    expect(await check(ids.db1, ids.RT1, lot.T1)).toMatchObject({ ok: false, code: "LOT_OPENED" });
  });

  it("its packs go one by one only to DB-1's own Retailers", async () => {
    const [p1] = await packsOf(lot.T1);
    expect(await check(ids.db1, ids.RT1, p1)).toMatchObject({ ok: true, kind: "PACK" });
    expect(await check(ids.db1, ids.RT2, p1)).toMatchObject({ ok: true, kind: "PACK" });
    expect(await check(ids.db1, ids.RT4, p1)).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // SS-1's direct retailer
    expect(await check(ids.db1, ids.RT3, p1)).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // DB-2's retailer
    expect(await check(ids.db1, ids.SS1, p1)).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // never back up the chain
  });

  it("DB-1 sends 2 packs to Retailer-1 and 4 to Retailer-2; both receive single packs", async () => {
    const packs = await packsOf(lot.T1);
    await send(ids.db1, ids.RT1, "INV-RT1", packs.slice(0, 2));
    await send(ids.db1, ids.RT2, "INV-RT2", packs.slice(2));
    // At DB-1 the opened tray has no packs left: only C2 and T2 (sealed) are stock; the 6 packs are on their way.
    expect(await counts(ids.db1)).toEqual({ cases: 1, trays: 1, openedCases: 0, openedTrays: 0, loosePacks: 0 });
    expect((await myStock(ids.db1)).outgoing.filter((o) => o.kind === "PACK")).toHaveLength(6);
    const incoming = (await myStock(ids.rt1)).incoming;
    expect(incoming.map((i) => [i.code, i.kind, i.invoice])).toEqual(packs.slice(0, 2).map((c) => [c, "PACK", "INV-RT1"]));
    // A Retailer receives packs of an opened lot (canReceive), only those addressed to it.
    expect(await receive(ids.rt2, { code: packs[0] })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    await take(ids.rt1, packs.slice(0, 2));
    await take(ids.rt2, packs.slice(2));
    expect(await receive(ids.rt1, { code: packs[0] })).toMatchObject({ ok: false, code: "DUPLICATE_RECEIPT" });
    for (const code of packs) expect((await store().packs.findOne({ packCode: code }))!.status).toBe("AT_RETAILER");
  });

  it("stock figures at DB-1, Retailer-1 and Retailer-2: My stock, My retailers and the HQ dashboard agree", async () => {
    expect(await counts(ids.rt1)).toEqual({ cases: 0, trays: 0, openedCases: 0, openedTrays: 0, loosePacks: 2 });
    expect(await counts(ids.rt2)).toEqual({ cases: 0, trays: 0, openedCases: 0, openedTrays: 0, loosePacks: 4 });
    expect((await myStock(ids.rt1)).inStock.map((i) => i.kind)).toEqual(["PACK", "PACK"]);
    const mine = (await myPartners(ids.db1)).partners;
    expect(mine.find((p) => p.id === ids.RT1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 2, onTheWayFromMe: 0 });
    expect(mine.find((p) => p.id === ids.RT2)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 4, onTheWayFromMe: 0 });
    expect(await hqRow(ids.DB1)).toMatchObject({ cases: 1, trays: 1, openedCases: 0, openedTrays: 0, loosePacks: 0 });
    expect(await hqRow(ids.RT1)).toMatchObject({ cases: 0, trays: 0, loosePacks: 2 });
    expect(await hqRow(ids.RT2)).toMatchObject({ cases: 0, trays: 0, loosePacks: 4 });
  });

  it("SS-1 opens case C1 and sends packs to the Retailer it supplies directly (never to a Distributor's Retailer)", async () => {
    expect(await openLot(ids.ss1, { lotCode: lot.C1 })).toMatchObject({ ok: true });
    const packs = await packsOf(lot.C1);
    expect(packs).toHaveLength(4);
    expect(await counts(ids.ss1)).toEqual({ cases: 1, trays: 0, openedCases: 1, openedTrays: 0, loosePacks: 4 });
    expect(await check(ids.ss1, ids.RT1, packs[0])).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // DB-1's retailer
    expect(await check(ids.ss1, ids.RT3, packs[0])).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // DB-2's (SS-2's chain)
    await send(ids.ss1, ids.RT4, "INV-RT4", packs.slice(0, 2));
    expect((await myPartners(ids.ss1)).partners.find((p) => p.id === ids.RT4)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 0, onTheWayFromMe: 2 });
    await take(ids.rt4, packs.slice(0, 2));
    expect(await counts(ids.rt4)).toEqual({ cases: 0, trays: 0, openedCases: 0, openedTrays: 0, loosePacks: 2 });
    expect(await counts(ids.ss1)).toEqual({ cases: 1, trays: 0, openedCases: 1, openedTrays: 0, loosePacks: 2 });
    const mine = (await myPartners(ids.ss1)).partners;
    expect(mine.find((p) => p.id === ids.RT4)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 2, onTheWayFromMe: 0 });
    expect(mine.find((p) => p.id === ids.DB1)).toMatchObject({ lotsInStock: 2, loosePacksInStock: 0 });
    expect(await hqRow(ids.SS1)).toMatchObject({ cases: 1, trays: 0, openedCases: 1, loosePacks: 2 });
    expect(await hqRow(ids.RT4)).toMatchObject({ cases: 0, trays: 0, loosePacks: 2 });
  });

  it("HQ dashboard status counts include the opened lots and the loose packs", async () => {
    const d = await dashboard(ids.hq);
    expect(d.lotCounts).toMatchObject({ OPENED: 2, AT_DB: 2 });
    // T1: 2 + 4 packs at Retailers; C1: 2 at Retailer-4, 2 still at SS-1; C2 and T2 sealed at DB-1 (4 + 6 packs).
    expect(d.packCounts).toMatchObject({ AT_RETAILER: 8, AT_SS: 2, AT_DB: 10 });
  });

  it("HQ lookup of a pack shows the tray's history, then the pack's own", async () => {
    const [p1] = await packsOf(lot.T1);
    const r = await lookup(ids.hq, p1);
    if (!r.found) throw new Error("not found");
    expect(r).toMatchObject({ kind: "PACK", status: "AT_RETAILER", parent: { code: lot.T1, status: "OPENED" } });
    const steps = r.timeline.filter((t) => t.itemKind !== "BATCH");
    const kinds = steps.map((t) => t.itemKind);
    const firstPack = kinds.indexOf("PACK");
    expect(firstPack).toBeGreaterThan(0);
    expect(kinds.slice(0, firstPack).every((k) => k === "LOT")).toBe(true);
    expect(kinds.slice(firstPack).every((k) => k === "PACK")).toBe(true);
    // The tray: verified, through Customs, SS-1, DB-1, opened at DB-1; then the pack: DB-1 → Retailer-1.
    const trayEvents = steps.slice(0, firstPack).map((t) => t.event);
    expect(trayEvents).toEqual(expect.arrayContaining(["VERIFIED", "DISPATCHED", "RECEIVED", "CUSTOMS_CLEARED"]));
    expect(steps[firstPack - 1]).toMatchObject({ event: "OPENED", itemCode: lot.T1, to: expect.stringMatching(/^DB-1/) });
    expect(steps.slice(firstPack).map((t) => [t.event, t.itemCode, t.invoice])).toEqual([
      ["DISPATCHED", p1, "INV-RT1"],
      ["RECEIVED", p1, "INV-RT1"],
    ]);
    expect(steps.at(-1)).toMatchObject({ from: expect.stringMatching(/^DB-1/), to: expect.stringMatching(/^Retailer-1/) });
  });

  it("damage of one loose pack at DB-1 works; the rest of the case stays loose stock there", async () => {
    expect(await openLot(ids.db1, { lotCode: lot.C2 })).toMatchObject({ ok: true });
    const [d1] = await packsOf(lot.C2);
    expect(await reportDamaged(ids.db1, { code: d1, reason: "Crushed", ...photoOf(d1) })).toMatchObject({ ok: true });
    expect((await store().packs.findOne({ packCode: d1 }))!.status).toBe("DAMAGED");
    expect(await counts(ids.db1)).toEqual({ cases: 1, trays: 1, openedCases: 1, openedTrays: 0, loosePacks: 3 });
    expect((await listDamaged(ids.db1)).counts).toEqual({ cases: 0, trays: 0, packs: 1 });
    expect(await hqRow(ids.DB1)).toMatchObject({ cases: 1, trays: 1, openedCases: 1, loosePacks: 3, damaged: { cases: 0, trays: 0, packs: 1 } });
  });

  it("returns still work: field staff take a loose pack back from DB-1 and from a Retailer; Customs inspects them", async () => {
    const [, back] = await packsOf(lot.C2);
    expect(await takeBack(FIELD, { code: back, reason: "NOT_SELLING" })).toMatchObject({ ok: true, openedLot: null });
    expect(await counts(ids.db1)).toMatchObject({ loosePacks: 2 });
    const [fromRt2] = (await packsOf(lot.T1)).slice(2);
    expect(await takeBack(FIELD, { code: fromRt2, reason: "NEAR_EXPIRY" })).toMatchObject({ ok: true });
    expect(await counts(ids.rt2)).toMatchObject({ loosePacks: 3 });
    for (const code of [back, fromRt2]) expect(await receive(ids.vw, { code })).toMatchObject({ ok: true, status: "RETURNED" });
    expect(await inspectReturn(ids.vw, { code: back, decision: "BACK_TO_STOCK" })).toMatchObject({ ok: true });
    expect((await store().packs.findOne({ packCode: back }))!.status).toBe("AT_WAREHOUSE");
    expect(await inspectReturn(ids.vw, { code: fromRt2, decision: "WRITE_OFF", writeOffAs: "EXPIRED" })).toMatchObject({ ok: true });
    expect((await store().packs.findOne({ packCode: fromRt2 }))!.status).toBe("EXPIRED");
  });
});
