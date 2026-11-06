// Continuing an existing batch: lots carry on from the batch's stored counter across days, operators,
// devices and restarts; never overlap; never exceed 1869F; retried requests never allocate twice.
// Runs on the JSON file store and on PostgreSQL (embedded), like every tests/unit file.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatLotNumber, LOT_NUMBER_MAX, parseCode } from "@/lib/core/codes";
import type { Batch, Device, Lot, User } from "@/lib/core/types";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { reprint, voidLot } from "@/lib/services/operator";
import { codesForOrder, continueBatch, continueMaxLots, createPrintOrder, listContinuableBatches, listPrintOrders, markPrinted, stickersForOrder } from "@/lib/services/printOrders";
import { listBatches, publicLookup } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const isJson = storeKind() === "json";
const store = () => getStore();
const key = () => crypto.randomUUID();
let dir: string;
let operator: string;
let operator2: string;
let qc: string;
let mf: string;
let device: Device;
let device2: Device;
let otherDevice: Device;

/** A fresh batch of the plant, made by the normal new-batch flow (1 case). */
async function newBatch(): Promise<Batch> {
  const r = await createPrintOrder(operator, { batches: [{ flavour: "OR", mfgDate: "2026-10-01", expiryDate: "2027-10-01", cases: 1, trays: 0 }] });
  if (r.preview) throw new Error("expected an order");
  return (await store().batches.findOne({ code: r.printOrder.batchCodes[0] }))!;
}
const batchOf = async (code: string) => (await store().batches.findOne({ code }))!;
const cont = (user: string, batchCode: string, cases: number, trays: number, extra: Record<string, unknown> = {}) =>
  continueBatch(user, { batchCode, cases, trays, idempotencyKey: key(), ...extra });
async function created(p: ReturnType<typeof continueBatch>) {
  const r = await p;
  if (r.preview) throw new Error("expected an order");
  return r;
}
const counts = async (batchCode: string) => ({
  nextLot: (await batchOf(batchCode)).nextLot,
  lots: (await store().lots.list({ batchCode })).length,
  orders: (await store().printOrders.list()).length,
  movements: (await store().movements.list()).length,
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-continue-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  if (!isJson) process.env.PGLITE_DIR = path.join(dir, "pg"); // on disk, so a restart can be tested
  await store().reset(buildSampleSeed());
  const op = (await store().users.list({ role: "OPERATOR" }))[0];
  operator = op.id;
  mf = op.partnerId!;
  qc = (await store().users.list({ role: "QC" }))[0].id;
  // A second operator sign-in at the same plant, a second line PC, and another partner's device.
  const second: User = { ...op, id: "MF9999-OP", name: "Second operator" };
  await store().users.create(second);
  operator2 = second.id;
  device = (await store().devices.list({ manufacturerId: mf }))[0];
  device2 = await store().devices.create({ id: crypto.randomUUID(), manufacturerId: mf, name: "Line-2 PC", offline: false, lastSyncAt: null });
  const other = (await store().partners.list()).find((p) => p.id !== mf)!;
  otherDevice = await store().devices.create({ id: crypto.randomUUID(), manufacturerId: other.id, name: "Other PC", offline: false, lastSyncAt: null });
}, 120_000);

afterAll(async () => {
  await closeStores();
  delete process.env.VELZA_DB_PATH;
  delete process.env.PGLITE_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("continuation from the stored counter", () => {
  it("continues day after day from nextLot, reusing the batch code, flavour and dates", async () => {
    const b = await newBatch(); // lot 00001
    const before = await batchOf(b.code);
    const day2 = await created(cont(operator, b.code, 3, 2));
    expect([day2.firstLotHex, day2.lastLotHex, day2.totalLots, day2.replayed]).toEqual(["00002", "00006", 5, false]);
    expect(day2.counter).toMatchObject({ state: "AVAILABLE", lastLotHex: "00006", nextLotHex: "00007", lotsAllocated: 6 });
    // another operator, another day
    const day3 = await created(cont(operator2, b.code, 0, 4));
    expect([day3.firstLotHex, day3.lastLotHex]).toEqual(["00007", "0000A"]);

    const lots = await store().lots.list({ printOrderId: day2.printOrder.id });
    expect(lots.map((l) => l.lotCode).sort()).toEqual(day2.printOrder.lotCodes.slice().sort());
    for (const l of lots) {
      const parsed = parseCode(l.lotCode);
      expect(parsed.ok && parsed.value).toMatchObject({ kind: "LOT", country: before.country, batch: b.code, flavour: "OR" });
      expect(l.flavour).toBe("OR");
    }
    // cases first, then trays, as in a new batch
    expect(lots.sort((a, c) => a.lotNumber - c.lotNumber).map((l) => l.lotType)).toEqual(["CASE", "CASE", "CASE", "TRAY", "TRAY"]);

    // only next_lot moved on the batch row
    const after = await batchOf(b.code);
    expect({ ...after, nextLot: 0 }).toEqual({ ...before, nextLot: 0 });
    expect(after.nextLot).toBe(11);
  });

  it("store counter: 10,000 lots → next 02711; another 10,000 → next 04E21", async () => {
    const b = await newBatch();
    await store().batches.update(b.id, { nextLot: 1 }); // a counter-only batch: start from 00001
    expect(formatLotNumber(await store().nextLotNumber(b.code, 10_000))).toBe("00001");
    expect(formatLotNumber((await batchOf(b.code)).nextLot)).toBe("02711");
    expect(formatLotNumber(await store().nextLotNumber(b.code, 10_000))).toBe("02711");
    expect(formatLotNumber((await batchOf(b.code)).nextLot)).toBe("04E21");
  });

  it.skipIf(isJson)(
    "PostgreSQL: two 10,000-lot continuation orders: 00002–02711, then 02712–04E21",
    async () => {
      const b = await newBatch(); // 00001
      const first = await created(cont(operator, b.code, 10_000, 0));
      expect([first.firstLotHex, first.lastLotHex, first.counter.nextLotHex]).toEqual(["00002", "02711", "02712"]);
      const second = await created(cont(operator2, b.code, 5_000, 5_000));
      expect([second.firstLotHex, second.lastLotHex, second.counter.nextLotHex]).toEqual(["02712", "04E21", "04E22"]);
      expect((await store().lots.list({ batchCode: b.code })).length).toBe(20_001);
      expect((await store().packs.list({ lotCode: second.printOrder.lotCodes.slice(-1) })).map((p) => p.packCode.slice(15))).toEqual(["41", "42", "43", "44", "45", "46"]);
    },
    600_000,
  );

  it.runIf(isJson)("JSON: 1,000 lots per order is allowed; 1,001 is refused with the JSON explanation", async () => {
    const b = await newBatch();
    expect((await created(cont(operator, b.code, 1_000, 0))).lastLotHex).toBe("003E9");
    await expect(cont(operator, b.code, 1_001, 0)).rejects.toMatchObject({ code: "TOO_MANY_LOTS", message: expect.stringMatching(/JSON file store/) });
  }, 120_000);

  it("caps one order at 10,000 lots (1,000 on JSON)", async () => {
    expect(continueMaxLots()).toBe(isJson ? 1_000 : 10_000);
    const b = await newBatch();
    const before = await counts(b.code);
    await expect(cont(operator, b.code, 10_001, 0)).rejects.toMatchObject({ status: 400, code: "TOO_MANY_LOTS" });
    await expect(cont(operator, b.code, 0, 0)).rejects.toMatchObject({ status: 400, code: "INVALID_QUANTITY" });
    await expect(cont(operator, b.code, -1, 2)).rejects.toThrow();
    await expect(cont(operator, b.code, 1.5, 0)).rejects.toThrow();
    expect(await counts(b.code)).toEqual(before);
  });
});

describe("capacity and exhaustion", () => {
  it("allocates the last lot 1869F, then the batch is exhausted; a replay still answers", async () => {
    const b = await newBatch();
    await store().batches.update(b.id, { nextLot: LOT_NUMBER_MAX - 1 }); // 1869E and 1869F left
    await expect(cont(operator, b.code, 3, 0)).rejects.toMatchObject({ status: 409, code: "INSUFFICIENT_CAPACITY" });
    const k = key();
    const last = await created(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 1, idempotencyKey: k }));
    expect([last.firstLotHex, last.lastLotHex]).toEqual(["1869E", "1869F"]);
    expect(last.counter).toEqual({ state: "EXHAUSTED", lotsAllocated: 99_999, lastLotHex: "1869F", nextLotHex: null, remaining: 0 });
    expect((await batchOf(b.code)).nextLot).toBe(0x186a0);

    const before = await counts(b.code);
    await expect(cont(operator, b.code, 1, 0)).rejects.toMatchObject({ status: 409, code: "BATCH_EXHAUSTED" });
    // the same request, retried after the batch filled up, gets its order back
    const again = await created(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 1, idempotencyKey: k }));
    expect([again.replayed, again.printOrder.id, again.firstLotHex]).toEqual([true, k, "1869E"]);
    expect(await counts(b.code)).toEqual(before);

    const listed = (await listContinuableBatches(operator)).batches.find((x) => x.batchCode === b.code)!;
    expect(listed).toMatchObject({ status: "EXHAUSTED", continuable: false, counter: { nextLotHex: null, remaining: 0 } });
    expect((await listBatches(operator)).find((x) => x.code === b.code)).toMatchObject({ displayStatus: "EXHAUSTED", status: "ACTIVE" });
  });

  it("an invalid stored counter is reported, never used or repaired", async () => {
    const b = await newBatch();
    await store().batches.update(b.id, { nextLot: 0 });
    await expect(cont(operator, b.code, 1, 0)).rejects.toMatchObject({ status: 409, code: "BATCH_COUNTER_INVALID" });
    expect((await batchOf(b.code)).nextLot).toBe(0);
    expect((await listContinuableBatches(operator)).batches.find((x) => x.batchCode === b.code)).toMatchObject({ status: "COUNTER_INVALID", continuable: false });
  });
});

describe("server-side blocks", () => {
  it("recalled and unsynced batches cannot be continued", async () => {
    const recalled = await newBatch();
    await store().batches.update(recalled.id, { status: "RECALLED" });
    await expect(cont(operator, recalled.code, 1, 0)).rejects.toMatchObject({ status: 409, code: "BATCH_RECALLED" });
    const unsynced = await newBatch();
    await store().batches.update(unsynced.id, { synced: false });
    await expect(cont(operator, unsynced.code, 1, 0)).rejects.toMatchObject({ status: 409, code: "BATCH_NOT_SYNCED" });
    expect((await batchOf(recalled.code)).nextLot).toBe(2);
    expect((await batchOf(unsynced.code)).nextLot).toBe(2);
  });

  it("an offline device cannot continue; the same key works once it is online", async () => {
    const b = await newBatch();
    const k = key();
    await store().devices.update(device.id, { offline: true });
    try {
      const before = await counts(b.code);
      await expect(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: k })).rejects.toMatchObject({ status: 409, code: "DEVICE_OFFLINE" });
      expect(await counts(b.code)).toEqual(before);
      expect(await store().printOrders.get(k)).toBeNull();
    } finally {
      await store().devices.update(device.id, { offline: false });
    }
    const r = await created(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: k }));
    expect([r.replayed, r.firstLotHex]).toEqual([false, "00002"]);
  });

  it("another manufacturer's batch looks like no batch; another manufacturer's device is refused", async () => {
    const b = await newBatch();
    const foreign = { ...b, id: crypto.randomUUID(), code: "ZZ9ZZ9", manufacturerId: otherDevice.manufacturerId, deviceId: otherDevice.id };
    await store().batches.create(foreign);
    await expect(cont(operator, foreign.code, 1, 0)).rejects.toMatchObject({ status: 404 });
    await expect(cont(operator, "NONE00", 1, 0)).rejects.toMatchObject({ status: 404 });
    await expect(cont(operator, b.code, 1, 0, { deviceId: otherDevice.id })).rejects.toMatchObject({ code: "NO_DEVICE" });
    expect((await listContinuableBatches(operator)).batches.map((x) => x.batchCode)).not.toContain(foreign.code);
  });

  it("only the plant operator may continue", async () => {
    const b = await newBatch();
    await expect(cont(qc, b.code, 1, 0)).rejects.toMatchObject({ status: 403 });
    await expect(cont(null as unknown as string, b.code, 1, 0)).rejects.toMatchObject({ status: 401 });
    await expect(listContinuableBatches(qc)).rejects.toMatchObject({ status: 403 });
  });

  it("a continuation order needs a request key", async () => {
    const b = await newBatch();
    await expect(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0 })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: "not-a-uuid" })).rejects.toThrow();
  });
});

describe("devices", () => {
  it("another online PC of the same plant continues; the order and lots record it, the batch keeps its own", async () => {
    const b = await newBatch();
    const r = await created(cont(operator2, b.code, 2, 0, { deviceId: device2.id }));
    expect(r.printOrder.deviceId).toBe(device2.id);
    expect((await store().lots.list({ printOrderId: r.printOrder.id })).every((l) => l.deviceId === device2.id)).toBe(true);
    expect((await store().movements.list({ itemCode: r.printOrder.lotCodes })).every((m) => m.deviceId === device2.id && m.type === "GENERATED")).toBe(true);
    const after = await batchOf(b.code);
    expect([after.deviceId, after.printOrderId, after.createdBy, after.createdAt]).toEqual([b.deviceId, b.printOrderId, b.createdBy, b.createdAt]);
  });

  it("offline new-batch orders still work (unchanged offline flow)", async () => {
    await store().devices.update(device.id, { offline: true });
    try {
      const r = await createPrintOrder(operator, { batches: [{ flavour: "GA", mfgDate: "2026-10-01", expiryDate: "2027-10-01", cases: 1, trays: 0 }] });
      expect(!r.preview && r.printOrder.synced).toBe(false);
    } finally {
      await store().devices.update(device.id, { offline: false });
    }
  });
});

describe("preview", () => {
  it("is read-only and only an expectation: the created order's range is authoritative", async () => {
    const b = await newBatch();
    const before = await counts(b.code);
    const p = await continueBatch(operator, { batchCode: b.code, cases: 2, trays: 1, preview: true });
    if (!p.preview) throw new Error("expected a preview");
    expect(p).toMatchObject({ ok: true, problem: null, expectedFirstLotHex: "00002", expectedLastLotHex: "00004", totalLots: 3, stickerCount: 17, remainingAfter: 99_995 });
    expect(await counts(b.code)).toEqual(before);

    // another operator takes 2 lots between preview and confirm
    await created(cont(operator2, b.code, 2, 0));
    const r = await created(cont(operator, b.code, 2, 1));
    expect([r.firstLotHex, r.lastLotHex]).toEqual(["00004", "00006"]);
  });

  it("reports problems instead of failing, and still never allocates", async () => {
    const b = await newBatch();
    await store().batches.update(b.id, { nextLot: LOT_NUMBER_MAX });
    const p = await continueBatch(operator, { batchCode: b.code, cases: 2, trays: 0, preview: true });
    expect(p).toMatchObject({ preview: true, ok: false, problem: { code: "INSUFFICIENT_CAPACITY" }, expectedFirstLotHex: null });
    expect((await batchOf(b.code)).nextLot).toBe(LOT_NUMBER_MAX);
  });
});

describe("idempotency", () => {
  it("the same key twice in a row: one order, one range", async () => {
    const b = await newBatch();
    const k = key();
    const body = { batchCode: b.code, cases: 2, trays: 1, idempotencyKey: k };
    const first = await created(continueBatch(operator, body));
    const after = await counts(b.code);
    const second = await created(continueBatch(operator, body));
    expect([first.replayed, second.replayed]).toEqual([false, true]);
    expect(second.printOrder).toEqual(first.printOrder);
    expect([second.firstLotHex, second.lastLotHex]).toEqual([first.firstLotHex, first.lastLotHex]);
    expect(await counts(b.code)).toEqual(after);
    // replay works for the plant's other operator too, from the same PC
    expect((await created(continueBatch(operator2, body))).replayed).toBe(true);
  });

  it("the same key in parallel: one order, one range", async () => {
    const b = await newBatch();
    const body = { batchCode: b.code, cases: 3, trays: 0, idempotencyKey: key() };
    const results = await Promise.all([1, 2, 3].map(() => created(continueBatch(operator, body))));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.printOrder.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.firstLotHex))).toEqual(new Set(["00002"]));
    expect((await batchOf(b.code)).nextLot).toBe(5);
    expect((await store().lots.list({ batchCode: b.code })).length).toBe(4);
  });

  it("the same key with a different batch, quantity or device is a conflict", async () => {
    const b = await newBatch();
    const other = await newBatch();
    const k = key();
    await created(continueBatch(operator, { batchCode: b.code, cases: 2, trays: 1, idempotencyKey: k }));
    const before = await counts(b.code);
    for (const changed of [
      { batchCode: b.code, cases: 1, trays: 2 },
      { batchCode: b.code, cases: 3, trays: 0 },
      { batchCode: b.code, cases: 2, trays: 2 },
      { batchCode: other.code, cases: 2, trays: 1 },
      { batchCode: b.code, cases: 2, trays: 1, deviceId: device2.id },
    ]) {
      await expect(continueBatch(operator, { ...changed, idempotencyKey: k })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
    }
    expect(await counts(b.code)).toEqual(before);
    expect((await batchOf(other.code)).nextLot).toBe(2);
  });

  // PGlite and JSON run transactions one at a time, so PostgreSQL's concurrent-insert errors are
  // injected here to exercise the recovery paths a real multi-connection server can take.
  it("PostgreSQL unique violation on the order key (concurrent same-key commit) → replay of the committed order", async () => {
    const b = await newBatch();
    const body = { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: key() };
    const first = await created(continueBatch(operator, body));
    const spy = vi.spyOn(store(), "transaction").mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "print_orders_pkey" }));
    try {
      const r = await created(continueBatch(operator, body));
      expect([r.replayed, r.printOrder.id]).toEqual([true, first.printOrder.id]);
    } finally {
      spy.mockRestore();
    }
  });

  it("other unique violations and exhausted serialization retries map to clear 409s", async () => {
    const b = await newBatch();
    const spy = vi
      .spyOn(store(), "transaction")
      .mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "codes_pkey" }))
      .mockRejectedValueOnce(Object.assign(new Error("could not serialize"), { code: "40001" }));
    try {
      await expect(cont(operator, b.code, 1, 0)).rejects.toMatchObject({ status: 409, code: "DUPLICATE_ALLOCATION" });
      await expect(cont(operator, b.code, 1, 0)).rejects.toMatchObject({ status: 409, code: "ALLOCATION_BUSY" });
    } finally {
      spy.mockRestore();
    }
    expect((await batchOf(b.code)).nextLot).toBe(2);
  });

  it("a key used by another manufacturer's order is a conflict that reveals nothing", async () => {
    const b = await newBatch();
    const k = key();
    await store().printOrders.create({
      id: k,
      createdAt: new Date().toISOString(),
      createdBy: "someone",
      deviceId: otherDevice.id,
      manufacturerId: otherDevice.manufacturerId,
      batchCodes: [b.code],
      lotCodes: [],
      stickerCount: 0,
      status: "CREATED",
      printedAt: null,
      synced: true,
    });
    const err = await continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: k }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toMatch(new RegExp(`${otherDevice.manufacturerId}|${otherDevice.id}|someone`));
  });
});

describe("concurrency", () => {
  it("parallel continuations of one batch get adjacent ranges with no overlap or duplicate", async () => {
    const b = await newBatch();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => created(cont(i % 2 ? operator2 : operator, b.code, 2, 1))));
    const numbers = results.flatMap((r) => r.printOrder.lotCodes.map((c) => parseInt(c.slice(10, 15), 16))).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, i) => i + 2));
    expect((await batchOf(b.code)).nextLot).toBe(20);
    const all = await store().lots.list({ batchCode: b.code });
    expect(new Set(all.map((l) => l.lotCode)).size).toBe(all.length);
    const packs = await store().packs.list({ lotCode: all.map((l) => l.lotCode) });
    expect(new Set(packs.map((p) => p.packCode)).size).toBe(packs.length);
  });

  it("parallel requests that together exceed capacity: the winners fit, the rest are refused, nothing past 1869F", async () => {
    const b = await newBatch();
    await store().batches.update(b.id, { nextLot: LOT_NUMBER_MAX - 4 }); // 5 left
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => cont(operator, b.code, 2, 0)));
    const ok = settled.filter((s) => s.status === "fulfilled");
    expect(ok).toHaveLength(2);
    for (const s of settled) if (s.status === "rejected") expect(s.reason).toMatchObject({ code: "INSUFFICIENT_CAPACITY" });
    expect((await batchOf(b.code)).nextLot).toBe(LOT_NUMBER_MAX);
  });
});

describe("rollback", () => {
  it("a failure after the counter moved rolls everything back; the same key then succeeds", async () => {
    const b = await newBatch();
    const lot = (await store().lots.list({ batchCode: b.code }))[0];
    // a stray row holding the next lot code makes the allocation fail after nextLotNumber ran
    const strayCode = `${lot.lotCode.slice(0, 10)}00002`;
    const stray: Lot = { ...lot, id: strayCode, lotCode: strayCode, lotNumber: 2, printOrderId: "stray" };
    await store().lots.create(stray);
    const k = key();
    const before = await counts(b.code);
    await expect(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: k })).rejects.toMatchObject({ status: 409, code: "DUPLICATE_ALLOCATION" });
    expect(await counts(b.code)).toEqual(before);
    expect(await store().printOrders.get(k)).toBeNull();

    await store().lots.delete(stray.id);
    const r = await created(continueBatch(operator, { batchCode: b.code, cases: 1, trays: 0, idempotencyKey: k }));
    expect([r.replayed, r.firstLotHex]).toEqual([false, "00002"]);
  });
});

describe("existing workflows on continued lots", () => {
  it("print, QC, void, reprint, codes view, order list and public lookup all work", async () => {
    const b = await newBatch();
    const firstOrderId = b.printOrderId;
    const r = await created(cont(operator2, b.code, 2, 1));
    const id = r.printOrder.id;

    const sheet = await stickersForOrder(operator, id);
    expect(sheet.stickers).toHaveLength(r.stickerCount);
    const codes = await codesForOrder(operator, id);
    expect(codes.totals).toMatchObject({ stickers: 17, cases: 2, trays: 1, packs: 14, unsynced: 0 });
    expect(codes.codes.every((c) => c.mfgDate === b.mfgDate && c.expiryDate === b.expiryDate && c.generatedBy === operator2)).toBe(true);
    expect(codes.codes.filter((c) => c.codeType === "PACK").map((c) => c.code.slice(15))).toEqual(["61", "62", "63", "64", "61", "62", "63", "64", "41", "42", "43", "44", "45", "46"]);

    const orders = await listPrintOrders(operator);
    expect(orders.find((o) => o.id === id)!.batches).toEqual([{ code: b.code, flavour: "OR", synced: true, cases: 2, trays: 1 }]);
    expect(orders.find((o) => o.id === firstOrderId)!.batches).toEqual([{ code: b.code, flavour: "OR", synced: true, cases: 1, trays: 0 }]);
    const firstCodes = await codesForOrder(operator, firstOrderId);
    expect(firstCodes.totals).toMatchObject({ stickers: 5, cases: 1, trays: 0 });

    expect(await markPrinted(operator, id)).toMatchObject({ lotsPrinted: 3 });
    const [lotA, lotB, lotC] = r.printOrder.lotCodes;
    const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((x, y) => x.seq - y.seq).map((p) => p.packCode);
    await verify(qc, { action: "scanLot", code: lotA });
    expect(await verify(qc, { action: "confirm", lotCode: lotA, packCodes: await packsOf(lotA) })).toMatchObject({ ok: true });
    expect((await store().lots.findOne({ lotCode: lotA }))!.status).toBe("PACKED");

    expect(await voidLot(operator, { lotCode: lotB, reason: "Misprint" })).toMatchObject({ ok: true });
    const pack = (await packsOf(lotC))[0];
    expect(await reprint(operator, { code: pack, reason: "Smudged" })).toMatchObject({ ok: true });

    expect(await publicLookup(lotA)).toMatchObject({ registered: true, code: lotA, batchCode: b.code, mfgDate: b.mfgDate, expiryDate: b.expiryDate, status: { tone: "ok" } });
  });
});

describe("one batch, one flavour", () => {
  it("continued lots keep the batch's flavour; another flavour is refused without allocating", async () => {
    const b = await newBatch(); // OR lot 00001
    const before = await counts(b.code);
    for (const flavour of ["GA", "ZZ"]) {
      await expect(cont(operator, b.code, 1, 0, { flavour })).rejects.toMatchObject({ status: 400, code: "FLAVOUR_CHANGE_NOT_ALLOWED" });
      await expect(continueBatch(operator, { batchCode: b.code, flavour, cases: 1, trays: 0, preview: true })).rejects.toMatchObject({ code: "FLAVOUR_CHANGE_NOT_ALLOWED" });
    }
    expect(await counts(b.code)).toEqual(before);

    // The batch's own flavour (sent or not) is fine.
    const same = await created(cont(operator, b.code, 1, 0, { flavour: "OR" }));
    const plain = await created(cont(operator, b.code, 0, 1));
    expect([...same.printOrder.lotCodes, ...plain.printOrder.lotCodes].map((c) => c.slice(8, 10))).toEqual(["OR", "OR"]);
    expect((await batchOf(b.code)).flavour).toBe("OR");
  });
});

describe("persistence", () => {
  it("after a restart the counter continues and a stored key still replays", async () => {
    const b = await newBatch();
    const k = key();
    const first = await created(continueBatch(operator, { batchCode: b.code, cases: 2, trays: 0, idempotencyKey: k }));
    await closeStores(); // the next getStore() opens the file / database again
    expect((await batchOf(b.code)).nextLot).toBe(4);
    const replayed = await created(continueBatch(operator, { batchCode: b.code, cases: 2, trays: 0, idempotencyKey: k }));
    expect([replayed.replayed, replayed.printOrder.id, replayed.firstLotHex]).toEqual([true, k, first.firstLotHex]);
    const next = await created(cont(operator2, b.code, 1, 0, { deviceId: device2.id }));
    expect(next.firstLotHex).toBe("00004");
  }, 120_000);
});
