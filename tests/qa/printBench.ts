// Print-order benchmark on the service layer, against a throw-away store (never data/db.json or a real database):
//   STORE=json   npx tsx tests/qa/printBench.ts [--sizes 100,1000,5000] [--label before]
//   STORE=pglite npx tsx tests/qa/printBench.ts [--sizes 100,1000,5000]
// For each size N (N cases = N lots, 4N packs): preview time and response bytes, create time (service), and
// mark-as-printed time. An order the service refuses (lot cap) is built straight in the store, so
// mark-as-printed is still measured at that size.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const SIZES = arg("sizes", "100,1000,5000").split(",").map(Number);
const LABEL = arg("label", "run");
async function main() {
const kind = process.env.STORE;
if (kind !== "json" && kind !== "pglite") throw new Error("Set STORE=json or STORE=pglite (a throw-away store only)");
delete process.env.DATABASE_URL;
delete process.env.PGLITE_DIR; // PGlite in memory
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-printbench-"));
process.env.VELZA_DB_PATH = path.join(dir, "db.json");

const { getStore, closeStores } = await import("@/lib/store");
const { createPrintOrder, markPrinted } = await import("@/lib/services/printOrders");
const { allocateLots, stickerCount } = await import("@/lib/core/codes");
const { buildSampleSeed } = await import("../fixtures/sampleNetwork");

const ms = (t0: number) => Math.round(performance.now() - t0);
const batchInput = (n: number) => [{ flavour: "OR", mfgDate: new Date().toISOString().slice(0, 10), expiryDate: "2099-01-01".replace("2099", String(new Date().getUTCFullYear() + 1)), cases: n, trays: 0 }];

/** The same rows createPrintOrder writes, straight into the store (for sizes the service refuses). */
async function buildDirect(n: number, operatorId: string): Promise<string> {
  const store = getStore();
  const id = crypto.randomUUID();
  await store.transaction(async (tx) => {
    const [device] = await tx.devices.list();
    const [pool] = await tx.batchCodePool.list({ deviceId: device.id, status: "RESERVED" });
    await tx.batchCodePool.update(pool.id, { status: "USED", usedAt: new Date().toISOString() });
    const at = new Date().toISOString();
    const b = batchInput(n)[0];
    await tx.batches.create({ id: crypto.randomUUID(), code: pool.code, country: "91", flavour: b.flavour, mfgDate: b.mfgDate, expiryDate: b.expiryDate, manufacturerId: device.manufacturerId, deviceId: device.id, nextLot: n + 1, status: "ACTIVE", synced: true, printOrderId: id, createdAt: at, createdBy: operatorId, recalledAt: null, recallReason: null });
    const { lots } = allocateLots({ code: pool.code, country: "91", flavour: b.flavour, nextLot: 1 }, n, 0);
    await tx.lots.createMany(lots.map((l) => ({ id: l.lotCode, lotCode: l.lotCode, batchCode: pool.code, flavour: b.flavour, lotType: l.lotType, packSize: l.packSize, lotNumber: l.lotNumber, status: "GENERATED" as const, locationId: device.manufacturerId, inTransitToId: null, dispatchedAt: null, printOrderId: id, manufacturerId: device.manufacturerId, deviceId: device.id, synced: true, quarantineReason: null, statusBeforeRecall: null, createdAt: at, updatedAt: at })));
    await tx.packs.createMany(lots.flatMap((l) => l.packCodes.map((packCode, i) => ({ id: packCode, packCode, lotCode: l.lotCode, seq: i + 1, packSize: l.packSize, status: "GENERATED" as const, locationId: device.manufacturerId, inTransitToId: null, dispatchedAt: null, statusBeforeRecall: null, createdAt: at, updatedAt: at }))));
    await tx.printOrders.create({ id, createdAt: at, createdBy: operatorId, deviceId: device.id, manufacturerId: device.manufacturerId, batchCodes: [pool.code], lotCodes: lots.map((l) => l.lotCode), stickerCount: stickerCount(n, 0), status: "CREATED", printedAt: null, synced: true, kind: "NEW_BATCH", requestFingerprint: null });
  });
  return id;
}

const rows: Record<string, unknown>[] = [];
try {
  for (const n of SIZES) {
    const store = getStore();
    await store.reset(buildSampleSeed());
    const operator = (await store.users.list({ role: "OPERATOR" }))[0].id;

    let t0 = performance.now();
    const preview = await createPrintOrder(operator, { preview: true, batches: batchInput(n) });
    const previewMs = ms(t0);
    const previewBytes = JSON.stringify(preview).length;

    let createMs: number | string;
    let orderId: string;
    t0 = performance.now();
    try {
      const r = await createPrintOrder(operator, { idempotencyKey: crypto.randomUUID(), batches: batchInput(n) });
      createMs = ms(t0);
      if (r.preview) throw new Error("expected an order");
      orderId = r.printOrder.id;
    } catch (e) {
      createMs = `refused (${(e as { code?: string }).code ?? (e as Error).message})`;
      orderId = await buildDirect(n, operator);
    }

    t0 = performance.now();
    const marked = await markPrinted(operator, orderId);
    const markMs = ms(t0);
    const printedMovements = (await store.movements.list({ type: "PRINTED" })).length;
    const packsPrinted = (await store.packs.list({ status: "PRINTED" })).length;
    rows.push({ store: kind, label: LABEL, lots: n, previewMs, previewBytes, createMs, markPrintedMs: markMs, lotsPrinted: marked.lotsPrinted, printedMovements, packsPrinted });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
} finally {
  await closeStores();
  await fs.rm(dir, { recursive: true, force: true });
}
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
