// Print confirmation gates QC: a generated-but-unprinted lot is refused with an actionable message, a lot marked
// printed through the print view verifies, void/recalled stay refused, and "mark printed" is transactional and
// idempotent. Also: the dev click-to-scan list on Verify never presents an unprinted lot as a valid scan.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { demoCodes } from "@/lib/services/demo";
import { reprint, voidLot } from "@/lib/services/operator";
import { codesForOrder, createPrintOrder, listPrintOrders, markPrinted, stickersForOrder } from "@/lib/services/printOrders";
import { recall } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
const lotOf = async (lotCode: string) => (await store().lots.findOne({ lotCode }))!;
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq);

async function order(flavour: string, cases: number, trays = 0) {
  const r = await createPrintOrder(ids.operator, { batches: [{ flavour, mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays }] });
async function order(flavour: string, cases: number) {
  const r = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour, mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays: 0 }] });
  if (r.preview) throw new Error("expected an order");
  return r.printOrder;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-printconf-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role] of [["operator", "OPERATOR"], ["qc", "QC"], ["hq", "TRACE_OWNER"]] as [string, Role][]) {
    ids[k] = (await store().users.list({ role }))[0].id;
  }
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("print confirmation and QC verify", () => {
  it("a generated lot that was never marked printed stays NOT_PRINTED, with an actionable message", async () => {
    const o = await order("NS", 1);
    const lotCode = o.lotCodes[0];
    const r = await verify(ids.qc, { action: "scanLot", code: lotCode });
    expect(r).toMatchObject({ ok: false, code: "NOT_PRINTED" });
    expect(r.message).toContain(lotCode);
    expect(r.message).toMatch(/generated but not marked as printed/i);
    expect(r.message).toMatch(/operator/i);
    expect(r.message).toMatch(/Mark as printed/);
    expect(r.message).not.toMatch(/markPrinted|GENERATED|status|database/);
    expect((await lotOf(lotCode)).status).toBe("GENERATED");
    // Pack confirm/quarantine paths refuse too: nothing is changed.
    await expect(verify(ids.qc, { action: "quarantine", lotCode, reason: "test" })).rejects.toThrow(/cannot be quarantined/);
    expect((await lotOf(lotCode)).status).toBe("GENERATED");
  });

  it("only the operator's print confirmation changes anything; a refused call leaves no partial state", async () => {
    const o = await order("MN", 2);
    await expect(markPrinted(ids.qc, o.id)).rejects.toThrow();
    expect((await store().printOrders.get(o.id))!).toMatchObject({ status: "CREATED", printedAt: null });
    for (const c of o.lotCodes) {
      expect((await lotOf(c)).status).toBe("GENERATED");
      expect((await packsOf(c)).every((p) => p.status === "GENERATED")).toBe(true);
    }
    expect(await store().movements.list({ type: "PRINTED" })).toHaveLength(0);
  });

  it("marking printed is transactional and idempotent: lots, packs, order and movements change together, once", async () => {
    const o = await order("OR", 3);
    const first = await markPrinted(ids.operator, o.id);
    expect(first.lotsPrinted).toBe(3);
    expect(first.printOrder).toMatchObject({ status: "PRINTED" });
    const printedAt = first.printOrder.printedAt;
    expect(printedAt).toBeTruthy();
    for (const c of o.lotCodes) {
      expect((await lotOf(c)).status).toBe("PRINTED");
      expect((await packsOf(c)).every((p) => p.status === "PRINTED")).toBe(true);
    }
    const movementsBefore = (await store().movements.list({ type: "PRINTED" })).filter((m) => o.lotCodes.includes(m.itemCode));
    expect(movementsBefore).toHaveLength(3);

    const again = await markPrinted(ids.operator, o.id);
    expect(again.lotsPrinted).toBe(0);
    expect(again.printOrder.printedAt).toBe(printedAt);
    expect((await store().movements.list({ type: "PRINTED" })).filter((m) => o.lotCodes.includes(m.itemCode))).toHaveLength(3);
    expect(await store().printOrders.list()).toHaveLength(3); // NS, MN and this one: no duplicate order
  });

  it("a printed lot passes verification; packs resolve to the lot; no duplicate records", async () => {
    const [orderOR] = (await store().printOrders.list()).filter((p) => p.status === "PRINTED");
    const lotCode = orderOR.lotCodes[0];
    const lot = await lotOf(lotCode);
    const batch = await store().batches.findOne({ code: lot.batchCode });
    expect(batch).toMatchObject({ manufacturerId: lot.manufacturerId, printOrderId: orderOR.id });

    const start = await verify(ids.qc, { action: "scanLot", code: lotCode });
    expect(start).toMatchObject({ ok: true, lot: { lotCode, status: "PRINTED", batchCode: lot.batchCode } });
    const packs = (await packsOf(lotCode)).map((p) => p.packCode);
    expect(start.lot!.expectedPacks).toEqual(packs);
    for (const [i, code] of packs.entries()) {
      expect(await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) })).toMatchObject({ ok: true });
    }
    const lotsBefore = (await store().lots.list()).length;
    const packsBefore = (await store().packs.list()).length;
    expect(await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs })).toMatchObject({ ok: true });
    expect((await lotOf(lotCode)).status).toBe("PACKED");
    expect((await store().lots.list()).length).toBe(lotsBefore);
    expect((await store().packs.list()).length).toBe(packsBefore);
    expect((await store().movements.list({ type: "VERIFIED" })).filter((m) => m.itemCode === lotCode)).toHaveLength(1);
  });

  it("voided lots, recalled batches and unknown codes stay rejected", async () => {
    const [orderOR] = (await store().printOrders.list()).filter((p) => p.status === "PRINTED");
    const voided = orderOR.lotCodes[1];
    await voidLot(ids.operator, { lotCode: voided, reason: "Misprint" });
    expect(await verify(ids.qc, { action: "scanLot", code: voided })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });

    const recalled = orderOR.lotCodes[2];
    await recall(ids.hq, { batchCode: (await lotOf(recalled)).batchCode, reason: "Contamination" });
    expect((await lotOf(recalled)).status).toBe("RECALLED");
    expect(await verify(ids.qc, { action: "scanLot", code: recalled })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });

    expect(await verify(ids.qc, { action: "scanLot", code: "91ZZZZZZOR00001" })).toMatchObject({ ok: false, code: "UNKNOWN_CODE" });
  });

  it("only QC may verify", async () => {
    const [orderMN] = (await store().printOrders.list()).filter((p) => p.lotCodes.length === 2);
    await expect(verify(ids.operator, { action: "scanLot", code: orderMN.lotCodes[0] })).rejects.toThrow();
  });
});

describe("cases and trays are separate print runs", () => {
  it("the sheet lists a cases run and a trays run, each with its own stickers", async () => {
    const o = await order("OR", 2, 1);
    const sheet = await stickersForOrder(ids.operator, o.id);
    expect(sheet.runs).toEqual([
      { lotType: "CASE", lots: 2, stickers: 10, pending: 2 },
      { lotType: "TRAY", lots: 1, stickers: 7, pending: 1 },
    ]);
    expect(sheet.stickers.filter((s) => s.lotType === "CASE")).toHaveLength(10);
    expect(sheet.stickers.filter((s) => s.lotType === "TRAY")).toHaveLength(7);
    // a cases-only order has just the cases run
    expect((await stickersForOrder(ids.operator, (await order("OR", 1)).id)).runs.map((r) => r.lotType)).toEqual(["CASE"]);
  });

  it("each run is confirmed on its own; the order is PRINTED only when both are", async () => {
    const o = await order("GA", 1, 2);
    const [caseLot, ...trayLots] = o.lotCodes;
    const cases = await markPrinted(ids.operator, o.id, { lotType: "CASE" });
    expect(cases.lotsPrinted).toBe(1);
    expect(cases.printOrder).toMatchObject({ status: "CREATED", printedAt: null });
    expect((await lotOf(caseLot)).status).toBe("PRINTED");
    expect((await packsOf(caseLot)).every((p) => p.status === "PRINTED")).toBe(true);
    for (const t of trayLots) expect((await lotOf(t)).status).toBe("GENERATED");
    // QC can verify the printed cases while the trays are still being printed; the trays are refused.
    expect(await verify(ids.qc, { action: "scanLot", code: caseLot })).toMatchObject({ ok: true });
    expect(await verify(ids.qc, { action: "scanLot", code: trayLots[0] })).toMatchObject({ ok: false, code: "NOT_PRINTED" });
    expect((await stickersForOrder(ids.operator, o.id)).runs.map((r) => r.pending)).toEqual([0, 2]);

    // repeating the cases confirmation changes nothing
    expect(await markPrinted(ids.operator, o.id, { lotType: "CASE" })).toMatchObject({ lotsPrinted: 0, printOrder: { status: "CREATED" } });

    const trays = await markPrinted(ids.operator, o.id, { lotType: "TRAY" });
    expect(trays.lotsPrinted).toBe(2);
    expect(trays.printOrder).toMatchObject({ status: "PRINTED", printedAt: expect.any(String) });
    for (const t of trayLots) expect((await lotOf(t)).status).toBe("PRINTED");
    expect((await store().movements.list({ type: "PRINTED" })).filter((m) => o.lotCodes.includes(m.itemCode))).toHaveLength(3);
  });

  it("a run the order does not have, or a bad run name, is refused without changes", async () => {
    const o = await order("NS", 1);
    await expect(markPrinted(ids.operator, o.id, { lotType: "TRAY" })).rejects.toMatchObject({ code: "NOTHING_TO_PRINT" });
    await expect(markPrinted(ids.operator, o.id, { lotType: "PALLET" })).rejects.toThrow();
    expect((await lotOf(o.lotCodes[0])).status).toBe("GENERATED");
    // without a run, the whole order is confirmed as before
    expect(await markPrinted(ids.operator, o.id)).toMatchObject({ lotsPrinted: 1, printOrder: { status: "PRINTED" } });
  });
});

describe("dev click-to-scan list on Verify", () => {
  it("lists printed lots as scans and at most one unprinted lot, labelled as an expected rejection", async () => {
    const o = await order("GA", 1);
    await markPrinted(ids.operator, o.id);
    const lots = await store().lots.list();
    const statusOf = new Map(lots.map((l) => [l.lotCode, l.status]));
    const codes = await demoCodes(ids.qc, "verify");

    const printed = codes.filter((c) => statusOf.get(c.code) === "PRINTED");
    expect(printed.map((c) => c.code)).toContain(o.lotCodes[0]);
    for (const c of printed) expect(c.label).not.toMatch(/not printed/i);

    const unprinted = codes.filter((c) => statusOf.get(c.code) === "GENERATED");
    expect(unprinted.length).toBe(1); // NOT_PRINTED stays demonstrable, but is not offered as a valid scan
    expect(unprinted[0].label).toMatch(/not printed.*expect rejection/i);
    // Printed examples come first.
    expect(codes.findIndex((c) => statusOf.get(c.code) === "GENERATED")).toBeGreaterThan(codes.findIndex((c) => statusOf.get(c.code) === "PRINTED"));
    // No blocked or already-verified lots offered.
    for (const c of codes) expect(["PRINTED", "GENERATED"]).toContain(statusOf.get(c.code));
  });
});

/** Everything "mark printed" may touch for one order, to prove a path changed nothing. */
async function snapshot(orderId: string) {
  const o = (await store().printOrders.get(orderId))!;
  const lots = await Promise.all(o.lotCodes.map(lotOf));
  const packs = (await Promise.all(o.lotCodes.map(packsOf))).flat();
  return {
    order: { status: o.status, printedAt: o.printedAt },
    lots: lots.map((l) => [l.lotCode, l.status, l.updatedAt]),
    packs: packs.map((p) => [p.packCode, p.status, p.updatedAt]),
    // status-changing history only: serving a sheet for first-time printing is logged (PRINT_SHEET_SERVED) but changes nothing
    movements: (await store().movements.list()).filter((m) => m.type !== "PRINT_SHEET_SERVED").length,
    orders: (await store().printOrders.list()).length,
  };
}

describe("explicit print confirmation", () => {
  it("opening the print view, reading the codes / CSV data and listing orders change nothing (the sheet serving is logged)", async () => {
    const o = await order("OR", 2);
    const before = await snapshot(o.id);
    await stickersForOrder(ids.operator, o.id);
    await codesForOrder(ids.operator, o.id); // the CSV is built in the browser from this data
    await listPrintOrders(ids.operator);
    expect(await snapshot(o.id)).toEqual(before);
    expect(before.order).toEqual({ status: "CREATED", printedAt: null });
    const served = (await store().movements.list({ type: "PRINT_SHEET_SERVED" })).filter((m) => m.itemCode === o.id);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ itemKind: "PRINT_ORDER", userId: ids.operator, fromStatus: null, toStatus: null });
  });

  it("a confirmation that fails part-way leaves every record unchanged; a retry then succeeds once", async () => {
    const o = await order("OR", 3);
    const before = await snapshot(o.id);
    const s = store();
    const real = s.transaction.bind(s);
    // Fail on writing the PRINTED movements: every lot and pack was already updated inside the transaction.
    const spy = vi.spyOn(s, "transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
      real(async (tx) => {
        const failing = new Proxy(tx, {
          get(t, prop, r) {
            if (prop === "appendMovement" || prop === "appendMovements") {
              return async () => {
                throw new Error("simulated storage failure");
              };
            }
            const v = Reflect.get(t, prop, r);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
        return fn(failing);
      })) as typeof s.transaction);
    try {
      await expect(markPrinted(ids.operator, o.id)).rejects.toThrow(/simulated storage failure/);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot(o.id)).toEqual(before);

    expect(await markPrinted(ids.operator, o.id)).toMatchObject({ lotsPrinted: 3 });
    const after = await snapshot(o.id);
    expect(after.order.status).toBe("PRINTED");
    expect(after.movements).toBe(before.movements + 3);
  });

  it("an unknown order is refused; an order whose lots are all voided cannot be marked printed", async () => {
    await expect(markPrinted(ids.operator, "no-such-order")).rejects.toMatchObject({ status: 404 });

    const o = await order("NS", 1);
    await voidLot(ids.operator, { lotCode: o.lotCodes[0], reason: "Line stopped" });
    const before = await snapshot(o.id);
    await expect(markPrinted(ids.operator, o.id)).rejects.toMatchObject({ code: "NOTHING_TO_PRINT" });
    expect(await snapshot(o.id)).toEqual(before);
    expect((await lotOf(o.lotCodes[0])).status).toBe("VOID");
  });

  it("voided lots stay voided when the rest of their order is marked printed", async () => {
    const o = await order("MN", 2);
    await voidLot(ids.operator, { lotCode: o.lotCodes[0], reason: "Misprint" });
    expect(await markPrinted(ids.operator, o.id)).toMatchObject({ lotsPrinted: 1 });
    expect((await lotOf(o.lotCodes[0])).status).toBe("VOID");
    expect((await packsOf(o.lotCodes[0])).every((p) => p.status === "VOID")).toBe(true);
    expect((await lotOf(o.lotCodes[1])).status).toBe("PRINTED");
    expect(await verify(ids.qc, { action: "scanLot", code: o.lotCodes[0] })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
  });

  it("a printed order never returns to pending: reprint, void, QC and repeat confirmations keep it PRINTED", async () => {
    const o = await order("GA", 3);
    const { printOrder } = await markPrinted(ids.operator, o.id);
    const printedAt = printOrder.printedAt;
    const [a, b, c] = o.lotCodes;
    await reprint(ids.operator, { code: (await packsOf(a))[0].packCode, reason: "Torn" });
    await voidLot(ids.operator, { lotCode: b, reason: "Dropped" });
    const packs = (await packsOf(c)).map((p) => p.packCode);
    await verify(ids.qc, { action: "scanLot", code: c });
    expect(await verify(ids.qc, { action: "confirm", lotCode: c, packCodes: packs })).toMatchObject({ ok: true });
    for (let i = 0; i < 2; i++) expect(await markPrinted(ids.operator, o.id)).toMatchObject({ lotsPrinted: 0 });
    expect((await store().printOrders.get(o.id))!).toMatchObject({ status: "PRINTED", printedAt });
    expect([await lotOf(a), await lotOf(b), await lotOf(c)].map((l) => l.status)).toEqual(["PRINTED", "VOID", "PACKED"]);
    expect((await store().movements.list({ type: "PRINTED" })).filter((m) => o.lotCodes.includes(m.itemCode))).toHaveLength(3);
  });

  it("roles without print permission cannot confirm printing", async () => {
    const o = await order("OR", 1);
    const before = await snapshot(o.id);
    for (const id of [ids.qc, ids.hq]) await expect(markPrinted(id, o.id)).rejects.toMatchObject({ status: 403 });
    expect(await snapshot(o.id)).toEqual(before);
  });
});
