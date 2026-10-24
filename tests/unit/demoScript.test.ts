// The demo script of spec section 9.1, end to end through the services (same code the API routes call).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { buildBaseSeed } from "@/lib/store/seedData";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { reprint, setDeviceOffline, sync, voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted, stickerForReprint, stickersForOrder } from "@/lib/services/printOrders";
import { alerts, dashboard, lookup, myStock, publicLookup, recall } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
async function partner(prefix: string) {
  return (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;
}
async function verifyLot(qc: string, lotCode: string) {
  const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
  expect(await verify(qc, { action: "scanLot", code: lotCode })).toMatchObject({ ok: true });
  for (const [i, code] of packs.entries()) {
    expect(await verify(qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) })).toMatchObject({ ok: true });
  }
  return verify(qc, { action: "confirm", lotCode, packCodes: packs });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-demo-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildBaseSeed());
  ids.operator = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.ss1 = await user("SS", "SS-1");
  ids.ss2 = await user("SS", "SS-2");
  ids.db1 = await user("DB", "DB-1");
  ids.sup1 = await user("SUPPLIER", "Supplier-1");
  ids.out1 = await user("OUTLET", "Outlet-1");
  ids.hq = await user("TRACE_OWNER");
  ids.SS1 = await partner("SS-1");
  ids.DB1 = await partner("DB-1");
  ids.SUP1 = await partner("Supplier-1");
  ids.OUT1 = await partner("Outlet-1");
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("demo script 9.1", () => {
  const today = "2026-10-24";
  const expiry = "2027-07-24";
  let orig: string; // Original batch code
  let ga: string; // Green Apple batch code
  let orderId: string;
  let lots: string[];

  it("1. operator creates 2 batches; summary shows lots 00001–00003 and 00001, 24 stickers; print", async () => {
    const batches = [
      { flavour: "OR", mfgDate: today, expiryDate: expiry, cases: 2, trays: 1 },
      { flavour: "GA", mfgDate: today, expiryDate: expiry, cases: 0, trays: 1 },
    ];
    const preview = await createPrintOrder(ids.operator, { batches, preview: true });
    expect(preview.plan.ok).toBe(true);
    expect(preview.plan.batches[0].lotRange).toEqual(["00001", "00003"]);
    expect(preview.plan.batches[1].lotRange).toEqual(["00001", "00001"]);
    expect(preview.plan.batches.map((b) => b.stickerCount)).toEqual([17, 7]);
    expect(preview.plan.totalStickers).toBe(24);

    const created = await createPrintOrder(ids.operator, { batches });
    if (created.preview) throw new Error("expected created order");
    orderId = created.printOrder.id;
    [orig, ga] = created.printOrder.batchCodes;
    expect(created.printOrder.batchCodes).toEqual(preview.plan.batches.map((b) => b.batchCode));
    lots = created.printOrder.lotCodes;
    expect(lots).toEqual([`91${orig}OR00001`, `91${orig}OR00002`, `91${orig}OR00003`, `91${ga}GA00001`]);
    expect(created.printOrder.stickerCount).toBe(24);

    const sheet = await stickersForOrder(ids.operator, orderId);
    expect(sheet.stickers).toHaveLength(24);
    expect(sheet.stickers[0]).toMatchObject({ kind: "LOT", header: "CASE | ORIGINAL | 4 x 6 = 24 CANS" });
    expect(sheet.stickers[1]).toMatchObject({ kind: "PACK", header: "PACK 1 of 4 | 6 CANS", code: `91${orig}OR0000161` });
    expect(sheet.stickers[17]).toMatchObject({ kind: "LOT", header: "TRAY | GREEN APPLE | 6 x 4 = 24 CANS" });

    // Not printed yet → cannot verify
    expect(await verify(ids.qc, { action: "scanLot", code: lots[0] })).toMatchObject({ ok: false, code: "NOT_PRINTED" });
    expect((await markPrinted(ids.operator, orderId)).lotsPrinted).toBe(4);
  });

  it("2. supervisor verifies every lot; a pack from another lot is rejected", async () => {
    await verify(ids.qc, { action: "scanLot", code: lots[0] });
    const wrong = await verify(ids.qc, { action: "scanPack", lotCode: lots[0], code: `91${orig}OR0000261`, scanned: [] });
    expect(wrong).toMatchObject({ ok: false, code: "WRONG_LOT" });
    const dup = await verify(ids.qc, { action: "scanPack", lotCode: lots[0], code: `91${orig}OR0000161`, scanned: [`91${orig}OR0000161`] });
    expect(dup).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" });
    for (const lot of lots) expect(await verifyLot(ids.qc, lot)).toMatchObject({ ok: true });
    expect((await store().lots.list()).every((l) => l.status === "PACKED")).toBe(true);
    expect((await store().packs.list()).every((p) => p.status === "PACKED")).toBe(true);
  });

  it("3. operator dispatches the 2 Original cases to SS-1 with INV-001", async () => {
    const noInvoice = await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "", code: lots[0] });
    expect(noInvoice).toMatchObject({ ok: false, code: "INVOICE_REQUIRED" });
    const wrongTier = await dispatch(ids.operator, { action: "check", toPartnerId: ids.DB1, invoice: "INV-001", code: lots[0] });
    expect(wrongTier).toMatchObject({ ok: false, code: "WRONG_DESTINATION" });
    for (const code of [lots[0], lots[1]]) {
      expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "INV-001", code })).toMatchObject({ ok: true });
    }
    const r = await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-001", codes: [lots[0], lots[1]] });
    expect(r).toMatchObject({ ok: true, count: 2 });
    const l0 = await store().lots.findOne({ lotCode: lots[0] });
    expect(l0).toMatchObject({ status: "IN_TRANSIT", inTransitToId: ids.SS1 });
  });

  it("4. SS-2 receiving → WRONG_RECEIVER alert; SS-1 receives both → AT_SS", async () => {
    expect(await receive(ids.ss2, { code: lots[0] })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    expect((await alerts(ids.hq)).some((a) => a.type === "WRONG_RECEIVER" && a.code === lots[0])).toBe(true);
    for (const code of [lots[0], lots[1]]) expect(await receive(ids.ss1, { code })).toMatchObject({ ok: true, status: "AT_SS" });
    expect(await receive(ids.ss1, { code: lots[0] })).toMatchObject({ ok: false, code: "DUPLICATE_RECEIPT" });
    expect((await myStock(ids.ss1)).inStock.map((s) => s.code).sort()).toEqual([lots[0], lots[1]]);
  });

  it("5. one case SS-1 → DB-1 → Supplier-1; supplier opens it and sends pack …62 to Outlet-1, who receives it", async () => {
    const c = lots[0];
    const pack62 = `${c}62`;
    expect(await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.DB1, invoice: "INV-002", codes: [c] })).toMatchObject({ ok: true });
    expect(await receive(ids.db1, { code: c })).toMatchObject({ ok: true, status: "AT_DB" });
    expect(await dispatch(ids.db1, { action: "confirm", toPartnerId: ids.SUP1, invoice: "INV-003", codes: [c] })).toMatchObject({ ok: true });
    expect(await receive(ids.sup1, { code: c })).toMatchObject({ ok: true, status: "AT_SUPPLIER" });

    // Sealed: a pack can't move before the lot is opened
    expect(await dispatch(ids.sup1, { action: "check", toPartnerId: ids.OUT1, invoice: "INV-004", code: pack62 })).toMatchObject({ ok: false, code: "LOT_SEALED" });
    expect(await openLot(ids.sup1, { lotCode: c })).toMatchObject({ ok: true });
    expect(await dispatch(ids.sup1, { action: "check", toPartnerId: ids.OUT1, invoice: "INV-004", code: c })).toMatchObject({ ok: false, code: "LOT_OPENED" });
    expect(await dispatch(ids.sup1, { action: "confirm", toPartnerId: ids.OUT1, invoice: "INV-004", codes: [pack62] })).toMatchObject({ ok: true });
    expect(await receive(ids.out1, { code: pack62 })).toMatchObject({ ok: true, status: "AT_OUTLET" });
  });

  it("6. HQ search: case timeline shows every step; pack …62 is AT_OUTLET", async () => {
    const c = await lookup(ids.hq, lots[0]);
    if (!c.found) throw new Error("not found");
    expect(c.status).toBe("OPENED");
    expect(c.timeline.map((t) => t.event)).toEqual(["GENERATED", "PRINTED", "VERIFIED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "OPENED"]);
    expect(c.timeline.filter((t) => t.event === "DISPATCHED").map((t) => t.invoice)).toEqual(["INV-001", "INV-002", "INV-003"]);
    expect(c.children).toHaveLength(4);
    const p = await lookup(ids.hq, `${lots[0]}62`);
    if (!p.found) throw new Error("not found");
    expect(p.status).toBe("AT_OUTLET");
    expect(p.location).toMatch(/Outlet-1/);
    expect(p.parent?.code).toBe(lots[0]);
    expect(p.timeline.at(-1)).toMatchObject({ event: "RECEIVED", invoice: "INV-004" });
  });

  it("7. made-up code → UNKNOWN_CODE; recall Green Apple → RECALLED and public page says Recalled", async () => {
    const fake = await receive(ids.ss1, { code: "91ZZZZZZOR00001" });
    expect(fake).toMatchObject({ ok: false, code: "UNKNOWN_CODE" });
    expect(await lookup(ids.hq, "91ZZZZZZOR00001")).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
    expect((await alerts(ids.hq)).some((a) => a.type === "UNKNOWN_CODE")).toBe(true);

    const report = await recall(ids.hq, { batchCode: ga, reason: "Taste complaint" });
    expect(report.batch.status).toBe("RECALLED");
    expect(report.items[0]).toMatchObject({ code: lots[3], status: "RECALLED", statusBeforeRecall: "PACKED" });
    expect(report.items[0].lastLocation).toMatch(/Demo Manufacturer/);
    const pub = await publicLookup(lots[3]);
    expect(pub.status.label).toBe("Recalled — do not consume");
    expect(pub).not.toHaveProperty("timeline");
    expect(JSON.stringify(pub)).not.toMatch(/Demo Manufacturer|INV-/);
    expect((await publicLookup(lots[1])).status.label).toBe("Genuine Velza product");
    expect((await publicLookup("91ZZZZZZOR00001")).status.label).toBe("Unregistered code");
    // Scanning a recalled code raises BLOCKED_CODE
    expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "X", code: lots[3] })).toMatchObject({ code: "BLOCKED_CODE" });
    expect((await alerts(ids.hq)).some((a) => a.type === "BLOCKED_CODE")).toBe(true);
  });

  it("8. device offline: create + verify a batch, dispatch blocked; sync → dispatch works", async () => {
    const device = (await store().devices.list())[0];
    await setDeviceOffline(ids.operator, device.id, { offline: true });
    const poolBefore = (await store().batchCodePool.list({ status: "RESERVED" })).length;
    const created = await createPrintOrder(ids.operator, { batches: [{ flavour: "NS", mfgDate: today, expiryDate: expiry, cases: 1, trays: 0 }] });
    if (created.preview) throw new Error("expected order");
    const lot = created.printOrder.lotCodes[0];
    expect(created.printOrder.synced).toBe(false);
    expect((await store().batchCodePool.list({ status: "RESERVED" })).length).toBe(poolBefore - 1); // no refill offline
    await markPrinted(ids.operator, created.printOrder.id);
    expect(await verifyLot(ids.qc, lot)).toMatchObject({ ok: true });

    // invisible to others
    expect(await lookup(ids.hq, lot)).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
    expect((await publicLookup(lot)).status.label).toBe("Unregistered code");
    // cannot dispatch
    expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "INV-009", code: lot })).toMatchObject({ ok: false, code: "UNSYNCED" });
    await expect(dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-009", codes: [lot] })).rejects.toThrow(/Nothing dispatched/);
    // sync requires online
    await expect(sync(ids.operator, {})).rejects.toThrow(/offline/);
    await setDeviceOffline(ids.operator, device.id, { offline: false });
    const s = await sync(ids.operator, {});
    expect(s.synced.lots).toBe(1);
    expect((await store().movements.list({ type: "SYNC" }))).toHaveLength(1);
    expect(await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-009", codes: [lot] })).toMatchObject({ ok: true });
  });

  it("9. reprint a sticker → same code, logged with reason", async () => {
    const code = `${lots[2]}43`;
    await expect(reprint(ids.operator, { code, reason: " " })).rejects.toThrow(/reason/);
    const r = await reprint(ids.operator, { code, reason: "Sticker torn while pasting" });
    expect(r.reprint).toMatchObject({ code, reason: "Sticker torn while pasting", itemKind: "PACK" });
    const sheet = await stickerForReprint(ids.operator, code);
    expect(sheet.stickers).toEqual([{ kind: "PACK", code, header: "PACK 3 of 6 | 4 CANS" }]);
    expect((await store().movements.list({ type: "REPRINTED" }))[0]).toMatchObject({ itemCode: code, note: "Sticker torn while pasting" });
    // no new codes were created
    expect((await store().lots.list()).length).toBe(5);
  });

  it("extra: quarantine on failed verification, void, dashboard", async () => {
    const created = await createPrintOrder(ids.operator, { batches: [{ flavour: "OR", mfgDate: today, expiryDate: expiry, cases: 2, trays: 0 }] });
    if (created.preview) throw new Error("expected order");
    await markPrinted(ids.operator, created.printOrder.id);
    const [a, b] = created.printOrder.lotCodes;
    const bad = await verify(ids.qc, { action: "confirm", lotCode: a, packCodes: [`${a}61`, `${a}62`] });
    expect(bad).toMatchObject({ ok: false, code: "QUARANTINED" });
    expect((await store().lots.findOne({ lotCode: a }))?.quarantineReason).toMatch(/expected 4 packs/);
    expect(await voidLot(ids.operator, { lotCode: b, reason: "misprint" })).toMatchObject({ ok: true });
    await expect(voidLot(ids.operator, { lotCode: lots[1] })).rejects.toThrow(/Only unpasted/);

    const d = await dashboard(ids.hq);
    expect(d.lotCounts.RECALLED).toBe(1);
    expect(d.lotCounts.QUARANTINED).toBe(1);
    expect(d.lotCounts.VOID).toBe(1);
    const inTransit = (await store().lots.list({ status: "IN_TRANSIT" })).map((l) => l.lotCode);
    expect(inTransit.length).toBeGreaterThan(0);
    expect(d.inTransit.map((t) => t.code)).toEqual(expect.arrayContaining(inTransit));
    expect(d.stock.find((s) => s.partner.startsWith("Outlet-1"))?.loosePacks).toBe(1);
  });
});
