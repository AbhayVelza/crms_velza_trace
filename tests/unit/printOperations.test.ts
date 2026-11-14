// Plant print operations (4 Nov 2026, traceability flow completion):
//   - "Mark as printed" writes in bulk: a 5,000-lot order is confirmed quickly, once, with one PRINTED movement per lot;
//   - the print order preview / create responses carry ranges and counts, never every generated code;
//   - a new print order is capped (10,000 lots on PostgreSQL, 1,000 on the JSON file) and refused whole above it;
//   - manufacture dates in the future and implausible shelf lives are refused;
//   - a void needs a reason;
//   - a plant with several PCs must say which PC does the work ("This PC"); nothing is booked on the first PC by default.
// Runs on the JSON file store and on PostgreSQL (embedded), like every tests/unit file.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateLots, stickerCount } from "@/lib/core/codes";
import type { Device, PrintOrder } from "@/lib/core/types";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { reprint, sync, voidLot } from "@/lib/services/operator";
import { issueCodes } from "@/lib/services/pool";
import { continueMaxLots, createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const isJson = storeKind() === "json";
const store = () => getStore();
let dir: string;
let operator: string;
let mf: string;
let pc1: Device;

const today = new Date().toISOString().slice(0, 10);
const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4, 8)}01`;
const batch = (cases: number, trays = 0, over: Record<string, unknown> = {}) => ({ flavour: "OR", mfgDate: today, expiryDate: nextYear, cases, trays, ...over });

async function order(cases: number, extra: Record<string, unknown> = {}): Promise<PrintOrder> {
  const r = await createPrintOrder(operator, { idempotencyKey: crypto.randomUUID(), batches: [batch(cases)], ...extra });
  if (r.preview) throw new Error("expected an order");
  return r.printOrder;
}

/** What a refused request must leave untouched. */
const counts = async () => ({
  reservedPool: (await store().batchCodePool.list({ status: "RESERVED" })).length,
  batches: (await store().batches.list()).length,
  orders: (await store().printOrders.list()).length,
  lots: (await store().lots.list()).length,
  packs: (await store().packs.list()).length,
  movements: (await store().movements.list()).length,
});

/** A big order written straight into the store, as createPrintOrder writes it (beyond the JSON store's order cap). */
async function bigOrder(n: number): Promise<PrintOrder> {
  const id = crypto.randomUUID();
  let order!: PrintOrder;
  await store().transaction(async (tx) => {
    const [pool] = await tx.batchCodePool.list({ deviceId: pc1.id, status: "RESERVED" });
    await tx.batchCodePool.update(pool.id, { status: "USED", usedAt: new Date().toISOString() });
    const at = new Date().toISOString();
    const b = batch(n);
    await tx.batches.create({ id: crypto.randomUUID(), code: pool.code, country: "91", flavour: b.flavour, mfgDate: b.mfgDate, expiryDate: b.expiryDate, manufacturerId: mf, deviceId: pc1.id, nextLot: n + 1, status: "ACTIVE", synced: true, printOrderId: id, createdAt: at, createdBy: operator, recalledAt: null, recallReason: null });
    const { lots } = allocateLots({ code: pool.code, country: "91", flavour: b.flavour, nextLot: 1 }, n, 0);
    await tx.lots.createMany(lots.map((l) => ({ id: l.lotCode, lotCode: l.lotCode, batchCode: pool.code, flavour: b.flavour, lotType: l.lotType, packSize: l.packSize, lotNumber: l.lotNumber, status: "GENERATED" as const, locationId: mf, inTransitToId: null, dispatchedAt: null, printOrderId: id, manufacturerId: mf, deviceId: pc1.id, synced: true, quarantineReason: null, statusBeforeRecall: null, createdAt: at, updatedAt: at })));
    await tx.packs.createMany(lots.flatMap((l) => l.packCodes.map((packCode, i) => ({ id: packCode, packCode, lotCode: l.lotCode, seq: i + 1, packSize: l.packSize, status: "GENERATED" as const, locationId: mf, inTransitToId: null, dispatchedAt: null, statusBeforeRecall: null, createdAt: at, updatedAt: at }))));
    order = { id, createdAt: at, createdBy: operator, deviceId: pc1.id, manufacturerId: mf, batchCodes: [pool.code], lotCodes: lots.map((l) => l.lotCode), stickerCount: stickerCount(n, 0), status: "CREATED", printedAt: null, synced: true, kind: "NEW_BATCH", requestFingerprint: null };
    await tx.printOrders.create(order);
  });
  return order;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-printops-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  const op = (await store().users.list({ role: "OPERATOR" }))[0];
  operator = op.id;
  mf = op.partnerId!;
  [pc1] = await store().devices.list({ manufacturerId: mf });
}, 120_000);

afterAll(async () => {
  await closeStores();
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("mark as printed at volume", () => {
  it("confirms a 5,000-lot order in bulk: every lot and pack PRINTED, one movement per lot, once", async () => {
    const small = await order(2); // another order of the plant, left alone
    const big = await bigOrder(5000);
    const before = (await store().movements.list()).length;

    const t0 = performance.now();
    const r = await markPrinted(operator, big.id);
    const ms = performance.now() - t0;
    // Before the bulk writes: 13 s on the JSON file and 115 s on PostgreSQL (embedded) for 5,000 lots.
    expect(ms).toBeLessThan(isJson ? 8_000 : 30_000);

    expect(r).toMatchObject({ lotsPrinted: 5000, printOrder: { status: "PRINTED" } });
    expect(await store().lots.list({ printOrderId: big.id, status: "GENERATED" })).toEqual([]);
    expect((await store().lots.list({ printOrderId: big.id, status: "PRINTED" })).length).toBe(5000);
    expect((await store().packs.list({ lotCode: big.lotCodes, status: "PRINTED" })).length).toBe(20_000);
    const printed = (await store().movements.list({ type: "PRINTED" })).filter((m) => m.itemKind === "LOT" && big.lotCodes.includes(m.itemCode));
    expect(printed).toHaveLength(5000);
    expect(printed.map((m) => m.itemCode)).toEqual(big.lotCodes); // in lot order
    expect(printed[0]).toMatchObject({ fromStatus: "GENERATED", toStatus: "PRINTED", fromId: mf, toId: mf, userId: operator, deviceId: pc1.id, note: null });
    expect((await store().movements.list()).length).toBe(before + 5000);

    // The other order is untouched; repeating changes nothing.
    expect((await store().lots.list({ printOrderId: small.id })).every((l) => l.status === "GENERATED")).toBe(true);
    expect((await store().packs.list({ lotCode: small.lotCodes })).every((p) => p.status === "GENERATED")).toBe(true);
    expect(await markPrinted(operator, big.id)).toMatchObject({ lotsPrinted: 0, printOrder: { printedAt: r.printOrder.printedAt } });
    expect((await store().movements.list()).length).toBe(before + 5000);
  }, 180_000);
});

describe("print order preview and create responses", () => {
  it("a preview carries ranges and counts, never every code", async () => {
    const r = await createPrintOrder(operator, { preview: true, batches: [batch(900, 100)] });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/"lots"|"packCodes"/);
    expect(text.length).toBeLessThan(10_000);
    if (!r.preview) throw new Error("expected a preview");
    expect(r.plan).toMatchObject({ ok: true, totalLots: 1000, totalStickers: 900 * 5 + 100 * 7 });
    expect(r.plan.batches[0]).toMatchObject({ lotCount: 1000, caseRange: ["00001", "00384"], trayRange: ["00385", "003E8"], lotRange: ["00001", "003E8"] });
    expect(r.plan.batches[0].firstLotCode).toMatch(/^91[A-Z0-9]{6}OR00001$/);
    expect(r.maxLotsPerOrder).toBe(continueMaxLots());
  });

  it("a 99,999-lot preview stays small and says it is over the cap", async () => {
    const r = await createPrintOrder(operator, { preview: true, batches: [batch(99_999)] });
    expect(JSON.stringify(r).length).toBeLessThan(10_000);
    if (!r.preview) throw new Error("expected a preview");
    expect(r.plan).toMatchObject({ ok: false, totalLots: 99_999, totalStickers: 499_995 });
    expect(r.plan.batches[0].lotRange).toEqual(["00001", "1869F"]);
    expect(r.plan.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^At most .* lots per print order/)]);
  });

  it("a created order's response has the summary, not the codes", async () => {
    const r = await createPrintOrder(operator, { idempotencyKey: crypto.randomUUID(), batches: [batch(3, 1)] });
    if (r.preview || !r.plan) throw new Error("expected an order with its plan");
    expect(JSON.stringify(r.plan)).not.toMatch(/"lots"|"packCodes"/);
    expect(r.plan).toMatchObject({ ok: true, totalLots: 4 });
    expect(r.printOrder.lotCodes).toHaveLength(4);
  });
});

describe("lot cap on new print orders", () => {
  it(`refuses one lot over the cap (${isJson ? "1,000 on the JSON file" : "10,000 on PostgreSQL"}) whole, allocating nothing`, async () => {
    const max = continueMaxLots();
    expect(max).toBe(isJson ? 1_000 : 10_000);
    const before = await counts();
    const err = await createPrintOrder(operator, { idempotencyKey: crypto.randomUUID(), batches: [batch(max - 10), batch(11)] }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "INVALID_ORDER" });
    expect(err.message).toMatch(new RegExp(`At most ${max.toLocaleString("en-IN")} lots per print order.*requested ${(max + 1).toLocaleString("en-IN")}`));
    if (isJson) expect(err.message).toMatch(/JSON file store/);
    expect(await counts()).toEqual(before);
  });

  it.skipIf(!isJson)("JSON file: exactly 1,000 lots in one order is allowed", async () => {
    const o = await order(1000);
    expect(o.lotCodes).toHaveLength(1000);
  }, 60_000);

  it("refuses a manufacture date in the future and a mistyped expiry year, allocating nothing", async () => {
    const before = await counts();
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await expect(order(1, { batches: [batch(1, 0, { mfgDate: future, expiryDate: nextYear.replace(/^\d{4}/, (y) => String(Number(y) + 1)) })] })).rejects.toMatchObject({
      code: "INVALID_ORDER",
      message: expect.stringMatching(/manufacture date .* is in the future/),
    });
    await expect(order(1, { batches: [batch(1, 0, { expiryDate: `${Number(today.slice(0, 4)) + 80}-01-01` })] })).rejects.toMatchObject({
      code: "INVALID_ORDER",
      message: expect.stringMatching(/more than 5 years after manufacture/),
    });
    expect(await counts()).toEqual(before);
  });
});

describe("voiding needs a reason", () => {
  it("a blank reason is refused and changes nothing; the reason is kept on the VOIDED movement", async () => {
    const o = await order(1);
    const lotCode = o.lotCodes[0];
    for (const reason of [undefined, "", "   "]) {
      await expect(voidLot(operator, { lotCode, reason })).rejects.toMatchObject({ status: 400, code: "REASON_REQUIRED" });
    }
    expect((await store().lots.findOne({ lotCode }))!.status).toBe("GENERATED");
    expect(await store().movements.list({ type: "VOIDED", itemCode: lotCode })).toEqual([]);
    await voidLot(operator, { lotCode, reason: "  Misprint on line 1 " });
    expect((await store().lots.findOne({ lotCode }))!.status).toBe("VOID");
    expect(await store().movements.list({ type: "VOIDED", itemCode: lotCode })).toEqual([expect.objectContaining({ note: "Misprint on line 1", deviceId: pc1.id })]);
  });
});

describe("a plant with two PCs: work is recorded on the PC that does it", () => {
  let pc2: Device;
  let foreign: Device;
  beforeAll(async () => {
    pc2 = await store().devices.create({ id: crypto.randomUUID(), manufacturerId: mf, name: "Pune Line-2 PC", offline: false, lastSyncAt: null });
    await store().transaction((tx) => issueCodes(tx, pc2, 5, null));
    const other = (await store().partners.list()).find((p) => p.id !== mf)!;
    foreign = await store().devices.create({ id: crypto.randomUUID(), manufacturerId: other.id, name: "Elsewhere PC", offline: false, lastSyncAt: null });
  });

  it("without a PC the order is refused (409 DEVICE_REQUIRED), never booked on the first PC", async () => {
    const before = await counts();
    await expect(createPrintOrder(operator, { preview: true, batches: [batch(1)] })).rejects.toMatchObject({ status: 409, code: "DEVICE_REQUIRED" });
    await expect(order(1)).rejects.toMatchObject({ status: 409, code: "DEVICE_REQUIRED", message: expect.stringMatching(/This PC/) });
    await expect(order(1, { deviceId: foreign.id })).rejects.toMatchObject({ status: 400, code: "NO_DEVICE" });
    await expect(order(1, { deviceId: "no-such-pc" })).rejects.toMatchObject({ code: "NO_DEVICE" });
    expect(await counts()).toEqual(before);
  });

  it("an order from PC 2 uses PC 2's pool and carries PC 2 on the batch, order, lots and movements", async () => {
    const pool1 = (await store().batchCodePool.list({ deviceId: pc1.id, status: "RESERVED" })).map((p) => p.code);
    const pool2 = (await store().batchCodePool.list({ deviceId: pc2.id, status: "RESERVED" })).map((p) => p.code);
    const o = await order(2, { deviceId: pc2.id });
    expect(o.deviceId).toBe(pc2.id);
    expect(pool2).toContain(o.batchCodes[0]);
    expect((await store().batchCodePool.list({ deviceId: pc1.id, status: "RESERVED" })).map((p) => p.code)).toEqual(pool1);
    expect((await store().batches.findOne({ code: o.batchCodes[0] }))!.deviceId).toBe(pc2.id);
    expect((await store().lots.list({ printOrderId: o.id })).every((l) => l.deviceId === pc2.id)).toBe(true);
    const generated = (await store().movements.list({ type: "GENERATED" })).filter((m) => o.lotCodes.includes(m.itemCode));
    expect(generated.map((m) => m.deviceId)).toEqual([pc2.id, pc2.id]);
  });

  it("mark as printed, reprint and void name their PC; without one they are refused", async () => {
    const o = await order(3, { deviceId: pc2.id });
    // Confirmed from PC 1: the PRINTED movements keep the order's PC and say where it was confirmed.
    await markPrinted(operator, o.id, { deviceId: pc1.id });
    const printed = (await store().movements.list({ type: "PRINTED" })).filter((m) => o.lotCodes.includes(m.itemCode));
    expect(printed.map((m) => [m.deviceId, m.note])).toEqual(o.lotCodes.map(() => [pc2.id, `Confirmed on ${pc1.name}`]));
    await expect(markPrinted(operator, o.id, { deviceId: foreign.id })).rejects.toMatchObject({ code: "NO_DEVICE" });

    const pack = (await store().packs.list({ lotCode: o.lotCodes[0] }))[0].packCode;
    await expect(reprint(operator, { code: pack, reason: "Torn" })).rejects.toMatchObject({ status: 409, code: "DEVICE_REQUIRED" });
    const r = await reprint(operator, { code: pack.toLowerCase(), reason: "Torn", deviceId: pc2.id });
    expect(r.reprint).toMatchObject({ code: pack, deviceId: pc2.id });
    expect((await store().movements.list({ type: "REPRINTED", itemCode: pack })).map((m) => m.deviceId)).toEqual([pc2.id]);

    await expect(voidLot(operator, { lotCode: o.lotCodes[1], reason: "Smudged" })).rejects.toMatchObject({ status: 409, code: "DEVICE_REQUIRED" });
    expect((await store().lots.findOne({ lotCode: o.lotCodes[1] }))!.status).toBe("PRINTED");
    await voidLot(operator, { lotCode: o.lotCodes[1], reason: "Smudged", deviceId: pc1.id });
    expect((await store().movements.list({ type: "VOIDED", itemCode: o.lotCodes[1] })).map((m) => m.deviceId)).toEqual([pc1.id]);
  });

  it("sync names its PC and marks that PC's offline work synced in bulk", async () => {
    await store().devices.update(pc2.id, { offline: true });
    const o = await order(2, { deviceId: pc2.id });
    expect(o.synced).toBe(false);
    await store().devices.update(pc2.id, { offline: false });
    await expect(sync(operator, {})).rejects.toMatchObject({ status: 409, code: "DEVICE_REQUIRED" });
    const r = await sync(operator, { deviceId: pc2.id });
    expect(r.synced).toMatchObject({ batches: 1, lots: 2, printOrders: 1 });
    expect((await store().printOrders.get(o.id))!.synced).toBe(true);
    expect((await store().lots.list({ printOrderId: o.id })).every((l) => l.synced)).toBe(true);
    expect((await store().batches.findOne({ code: o.batchCodes[0] }))!.synced).toBe(true);
    expect(await store().lots.list({ deviceId: pc2.id, synced: false })).toEqual([]);
  });
});
