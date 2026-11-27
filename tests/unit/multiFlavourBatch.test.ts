// One batch code with several flavours (DH3493, first consignment): one batch row per flavour, each with its own
// lot counter and dates. Continuing names the flavour; a recall covers every flavour of the code.
// Runs on the JSON file store and on PostgreSQL (embedded), like every tests/unit file.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Batch, Device } from "@/lib/core/types";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { codesForOrder, continueBatch as continueBatchOn, createPrintOrder as createPrintOrderOn } from "@/lib/services/printOrders";
import { recall } from "@/lib/services/trace";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const isJson = storeKind() === "json";
const store = () => getStore();
let dir: string;
let operator: string;
let hq: string;
let device: Device;
let code: string;

const onPc = (body: object) => ({ deviceId: device.id, ...body });
const cont = (body: object) => continueBatchOn(operator, onPc({ idempotencyKey: crypto.randomUUID(), ...body }));
async function created(p: ReturnType<typeof continueBatchOn>) {
  const r = await p;
  if (r.preview) throw new Error("expected an order");
  return r;
}
const rowOf = async (flavour: string) => (await store().batches.findOne({ code, flavour }))!;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-multiflavour-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  if (!isJson) process.env.PGLITE_DIR = path.join(dir, "pg");
  await store().reset(buildSampleSeed());
  operator = (await store().users.list({ role: "OPERATOR" }))[0].id;
  hq = (await store().users.list({ role: "TRACE_OWNER" }))[0].id;
  const mf = (await store().users.get(operator))!.partnerId!;
  device = (await store().devices.list({ manufacturerId: mf }))[0];
  // An OR batch made the normal way (2 lots), then a GA row under the same code, as DH3493 was printed.
  const r = await createPrintOrderOn(operator, onPc({ idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-13", expiryDate: "2028-05-13", cases: 1, trays: 1 }] }));
  if (r.preview) throw new Error("expected an order");
  code = r.printOrder.batchCodes[0];
  const or: Batch = (await store().batches.findOne({ code }))!;
  await store().batches.create({ ...or, id: crypto.randomUUID(), flavour: "GA", mfgDate: "2026-11-01", expiryDate: "2028-05-01", nextLot: 1 });
}, 120_000);

afterAll(async () => {
  await closeStores();
  delete process.env.VELZA_DB_PATH;
  delete process.env.PGLITE_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a batch code with several flavours", () => {
  it("must name the flavour to continue", async () => {
    await expect(cont({ batchCode: code, cases: 1, trays: 0 })).rejects.toMatchObject({ code: "FLAVOUR_REQUIRED" });
    await expect(cont({ batchCode: code, flavour: "MN", cases: 1, trays: 0 })).rejects.toMatchObject({ code: "FLAVOUR_CHANGE_NOT_ALLOWED" });
  });

  it("continues each flavour from its own counter, with its own dates", async () => {
    const ga = await created(cont({ batchCode: code, flavour: "GA", cases: 2, trays: 0 }));
    expect(ga.firstLotHex).toBe("00001");
    expect(ga.lastLotHex).toBe("00002");
    const or = await created(cont({ batchCode: code, flavour: "OR", cases: 1, trays: 0 }));
    expect(or.firstLotHex).toBe("00003");
    expect((await rowOf("GA")).nextLot).toBe(3);
    expect((await rowOf("OR")).nextLot).toBe(4);
    const { codes } = await codesForOrder(operator, ga.printOrder.id);
    const lot = codes.find((x) => x.code.startsWith(`91${code}GA`))!;
    expect(lot).toMatchObject({ mfgDate: "2026-11-01", expiryDate: "2028-05-01" });
  });

  it("a recall covers every flavour of the code", async () => {
    await recall(hq, { batchCode: code, reason: "Multi-flavour recall test" });
    expect((await rowOf("OR")).status).toBe("RECALLED");
    expect((await rowOf("GA")).status).toBe("RECALLED");
    const lots = await store().lots.list({ batchCode: code });
    expect(lots.some((l) => l.flavour === "GA")).toBe(true);
    expect(lots.every((l) => l.status === "RECALLED" || l.status === "VOID")).toBe(true);
  });
});
