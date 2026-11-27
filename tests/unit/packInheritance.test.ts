// Option C (schema v11): a sealed case/tray's packs follow it. Every action of the chain, through the services, on the
// JSON file store and on PostgreSQL (embedded): which rows each one writes, what the packs read, and the stock counts
// (decision Q7: every pack counts once, by its effective state).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pack, Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { reportDamaged } from "@/lib/services/damage";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { takeBack } from "@/lib/services/returns";
import { dashboard, recall } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { photoOf } from "../fixtures/damagePhoto";
import { buildSampleSeed } from "../fixtures/sampleNetwork";
import { shipToCustoms } from "../fixtures/shipToCustoms";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
const FIELD = "VF0001";
let batchCode = "";
/** C1, C2: cases (4 packs); T1, T2, T3: trays (6 packs). */
const lot: Record<"C1" | "C2" | "T1" | "T2" | "T3", string> = { C1: "", C2: "", T1: "", T2: "", T3: "" };

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
async function partner(prefix: string) {
  return (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;
}
const packs = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq);
const view = (ps: Pack[]) => ps.map((p) => [p.status, p.locationId, p.followsLot]);
async function verifyLot(lotCode: string) {
  const codes = (await packs(lotCode)).map((p) => p.packCode);
  expect(await verify(ids.qc, { action: "scanLot", code: lotCode })).toMatchObject({ ok: true });
  for (const [i, code] of codes.entries()) expect(await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: codes.slice(0, i) })).toMatchObject({ ok: true });
  expect(await verify(ids.qc, { action: "confirm", lotCode, packCodes: codes })).toMatchObject({ ok: true });
}
/** Every pack, by effective status, from the HQ dashboard (the live stock summary's PACK rows). */
const packCounts = async () => (await dashboard(ids.hq)).packCounts;
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, n) => a + n, 0);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-optionc-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  process.env.VELZA_UPLOAD_DIR = path.join(dir, "uploads");
  await store().reset(buildSampleSeed());
  ids.op = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.vw = await user("WAREHOUSE");
  ids.ss1 = await user("SS", "SS-1");
  ids.hq = await user("TRACE_OWNER");
  ids.VW = await partner("VW-1");
  ids.SS1 = await partner("SS-1");
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  delete process.env.VELZA_UPLOAD_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Option C through the services: packs follow their sealed case/tray", () => {
  it("print and mark printed: new packs follow their lot; marking printed writes the lots only", async () => {
    const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 2, trays: 3 }] });
    if (created.preview) throw new Error("expected a created order");
    const lots = await store().lots.list({ lotCode: created.printOrder.lotCodes });
    batchCode = lots[0].batchCode;
    [lot.C1, lot.C2] = lots.filter((l) => l.lotType === "CASE").map((l) => l.lotCode).sort();
    [lot.T1, lot.T2, lot.T3] = lots.filter((l) => l.lotType === "TRAY").map((l) => l.lotCode).sort();
    const before = await packs(lot.T1);
    expect(before.every((p) => p.status === "GENERATED" && p.followsLot)).toBe(true);
    await markPrinted(ids.op, created.printOrder.id);
    const after = await packs(lot.T1);
    expect(after.every((p) => p.status === "PRINTED" && p.followsLot)).toBe(true);
    // Not written: a pack's own updatedAt stays its creation time.
    expect(after.map((p) => p.updatedAt)).toEqual(before.map((p) => p.updatedAt));
    expect(total(await packCounts())).toBe(2 * 4 + 3 * 6);
  });

  it("QC, the container to Customs, dispatch and receive: the packs read the lot's state and still follow", async () => {
    const all = Object.values(lot);
    for (const code of all) await verifyLot(code);
    expect(view(await packs(lot.C1))).toEqual(Array.from({ length: 4 }, () => ["PACKED", (expect.any(String) as unknown) as string, true]));
    await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: all, invoice: "INV-C-0" });
    expect(await dispatch(ids.vw, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-C-1", codes: all })).toMatchObject({ ok: true });
    expect(view(await packs(lot.T1))).toEqual(Array.from({ length: 6 }, () => ["IN_TRANSIT", ids.VW, true]));
    expect((await store().packs.list({ status: "IN_TRANSIT", inTransitToId: ids.SS1 })).length).toBe(2 * 4 + 3 * 6);
    for (const code of all) expect(await receive(ids.ss1, { code })).toMatchObject({ ok: true });
    expect(view(await packs(lot.T1))).toEqual(Array.from({ length: 6 }, () => ["AT_SS", ids.SS1, true]));
    // A sealed tray's pack still can't move on its own.
    const [p1] = await packs(lot.T1);
    expect(await receive(ids.ss1, { code: p1.packCode })).toMatchObject({ ok: false });
    expect(await packCounts()).toEqual({ AT_SS: 2 * 4 + 3 * 6 });
  });

  it("opening a tray gives each of its packs the tray's state (they no longer follow it), in one transaction", async () => {
    const r = await openLot(ids.ss1, { lotCode: lot.T1 });
    expect(r).toMatchObject({ ok: true });
    expect(r.packs!.map((p) => p.status)).toEqual(Array.from({ length: 6 }, () => "AT_SS"));
    expect(await store().lots.findOne({ lotCode: lot.T1 })).toMatchObject({ status: "OPENED", locationId: ids.SS1 });
    expect(view(await packs(lot.T1))).toEqual(Array.from({ length: 6 }, () => ["AT_SS", ids.SS1, false]));
    // The opened tray's lot row is OPENED; its packs still count as stock at SS-1.
    expect((await packCounts()).AT_SS).toBe(2 * 4 + 3 * 6);
  });

  it("taking back a pack of a sealed case opens that case first: its other packs get the case's state", async () => {
    const [first] = await packs(lot.C2);
    expect(await takeBack(FIELD, { code: first.packCode, reason: "NOT_SELLING" })).toMatchObject({ ok: true, openedLot: lot.C2 });
    expect(view(await packs(lot.C2))).toEqual([
      ["RETURN_IN_TRANSIT", ids.SS1, false],
      ["AT_SS", ids.SS1, false],
      ["AT_SS", ids.SS1, false],
      ["AT_SS", ids.SS1, false],
    ]);
  });

  it("damage: a sealed tray reported whole writes the tray (its packs follow); each report gets its damage_reports row", async () => {
    // One pack of T2 already has a state of its own (quarantined on its own): it keeps it, and isn't counted as damaged.
    const [, , t2third] = await packs(lot.T2);
    await store().packs.update(t2third.id, { status: "QUARANTINED" });
    const r = await reportDamaged(ids.ss1, { code: lot.T2, reason: "crushed", ...photoOf(lot.T2) });
    expect(r).toMatchObject({ ok: true });
    expect(view(await packs(lot.T2))).toEqual(Array.from({ length: 6 }, (_, i) => (i === 2 ? ["QUARANTINED", ids.SS1, false] : ["DAMAGED", ids.SS1, true])));
    // A loose pack of the opened tray, on its own.
    const [, second] = await packs(lot.T1);
    const p = await reportDamaged(ids.ss1, { code: second.packCode, reason: "leaking", ...photoOf(second.packCode) });
    expect(p).toMatchObject({ ok: true });
    const reports = await store().damageReports.list({ partnerId: ids.SS1 });
    expect(reports.map((x) => [x.id, x.code, x.itemKind, x.packsAffected, x.reason, x.reportedBy])).toEqual([
      [r.reportId, lot.T2, "LOT", 5, "crushed", ids.ss1],
      [p.reportId, second.packCode, "PACK", 1, "leaking", ids.ss1],
    ]);
    const counts = await packCounts();
    expect(counts.DAMAGED).toBe(6);
    expect(total(counts)).toBe(2 * 4 + 3 * 6);
  });

  it("stock (Q7): a pack with a state of its own inside a sealed tray counts once, under its own state, never again with the tray", async () => {
    // A pack damaged on its own inside sealed tray T3 (data the v11 upgrade keeps: db_health sealed_lot_packs_with_own_state).
    const [, , third] = await packs(lot.T3);
    await store().packs.update(third.id, { status: "DAMAGED" });
    expect(view(await packs(lot.T3)).map((v) => v[2])).toEqual([true, true, false, true, true, true]);
    const counts = await packCounts();
    expect(counts.DAMAGED).toBe(7);
    expect(total(counts)).toBe(2 * 4 + 3 * 6);
    // The HQ stock row: T3 is still a whole sealed tray at SS-1 (lots count by the lot row).
    const row = (await dashboard(ids.hq)).stock.find((s) => s.partnerId === ids.SS1)!;
    expect(row).toMatchObject({ cases: 2, trays: 2, openedCases: 1, openedTrays: 1 });
  });

  it("recall writes each lot row, and only the packs with a state of their own", async () => {
    await recall(ids.hq, { batchCode, reason: "test recall", confirm: true });
    // Sealed case C1: its packs follow it (RECALLED, before AT_SS), without a state of their own.
    expect((await packs(lot.C1)).map((p) => [p.status, p.statusBeforeRecall, p.followsLot])).toEqual(Array.from({ length: 4 }, () => ["RECALLED", "AT_SS", true]));
    // Sealed tray T3: its damaged pack is recalled on its own and keeps the damage; the others follow the tray.
    expect((await packs(lot.T3)).map((p) => [p.status, p.statusBeforeRecall, p.followsLot])).toEqual([
      ["RECALLED", "AT_SS", true],
      ["RECALLED", "AT_SS", true],
      ["RECALLED", "DAMAGED", false],
      ["RECALLED", "AT_SS", true],
      ["RECALLED", "AT_SS", true],
      ["RECALLED", "AT_SS", true],
    ]);
    // Damaged sealed tray T2: the tray keeps its damage (recalled from DAMAGED), and so do its following packs; its
    // quarantined pack is recalled on its own.
    expect((await packs(lot.T2)).map((p) => [p.status, p.statusBeforeRecall, p.followsLot])).toEqual(
      Array.from({ length: 6 }, (_, i) => (i === 2 ? ["RECALLED", "QUARANTINED", false] : ["RECALLED", "DAMAGED", true])),
    );
    // Opened tray T1: each pack recalled by itself.
    expect((await packs(lot.T1)).map((p) => [p.statusBeforeRecall, p.followsLot])).toEqual([
      ["AT_SS", false],
      ["DAMAGED", false],
      ["AT_SS", false],
      ["AT_SS", false],
      ["AT_SS", false],
      ["AT_SS", false],
    ]);
    // Every pack still counted once.
    expect(total(await packCounts())).toBe(2 * 4 + 3 * 6);
  });
});
