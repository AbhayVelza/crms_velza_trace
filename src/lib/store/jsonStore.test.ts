import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Batch } from "@/lib/core/types";
import { JsonStore } from "./jsonStore";
import { buildBaseSeed } from "./seedData";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-store-"));
  file = path.join(dir, "db.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const batch = (code: string): Batch => ({
  id: crypto.randomUUID(),
  code,
  country: "91",
  flavour: "OR",
  mfgDate: "2026-10-01",
  expiryDate: "2027-04-01",
  manufacturerId: "m",
  deviceId: "d",
  nextLot: 1,
  status: "ACTIVE",
  synced: true,
  printOrderId: "p",
  createdAt: new Date().toISOString(),
  createdBy: "u",
  recalledAt: null,
  recallReason: null,
});

describe("JsonStore", () => {
  it("creates the file from the base seed on first use", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    const partners = await store.partners.list();
    expect(partners).toHaveLength(10);
    expect(JSON.parse(await fs.readFile(file, "utf8")).partners).toHaveLength(10);
    expect(await store.batchCodePool.list({ status: "RESERVED" })).toHaveLength(10);
  });

  it("rolls back a failed transaction", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    await expect(
      store.transaction(async (tx) => {
        await tx.batches.create(batch("AAA111"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.batches.list()).toHaveLength(0);
  });

  it("nextLotNumber allocates atomically with no overlap under concurrency", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    await store.batches.create(batch("AAA111"));
    const firsts = await Promise.all(Array.from({ length: 20 }, () => store.nextLotNumber("AAA111", 3)));
    const numbers = firsts.flatMap((f) => [f, f + 1, f + 2]);
    expect(new Set(numbers).size).toBe(60);
    expect(Math.min(...numbers)).toBe(1);
    expect((await store.batches.findOne({ code: "AAA111" }))?.nextLot).toBe(61);
  });

  it("refuses to allocate past 1869F", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    await store.batches.create({ ...batch("AAA111"), nextLot: 0x1869f });
    expect(await store.nextLotNumber("AAA111", 1)).toBe(0x1869f);
    await expect(store.nextLotNumber("AAA111", 1)).rejects.toThrow(/1869F/);
  });

  it("returns copies, so callers can't mutate state without update()", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    const [p] = await store.partners.list();
    p.name = "changed";
    expect((await store.partners.get(p.id))?.name).not.toBe("changed");
  });

  it("picks up external changes (e.g. npm run seed while the server runs)", async () => {
    const a = new JsonStore(file, () => buildBaseSeed());
    await a.partners.list();
    const b = new JsonStore(file, () => buildBaseSeed());
    await new Promise((r) => setTimeout(r, 20));
    await b.batches.create(batch("BBB222"));
    expect((await a.batches.list()).map((x) => x.code)).toEqual(["BBB222"]);
  });

  it("settings fall back to defaults and can be updated", async () => {
    const store = new JsonStore(file, () => ({ ...buildBaseSeed(), settings: [] }));
    expect((await store.getSettings()).notReceivedThresholdDays).toBe(3);
    await store.updateSettings({ demoMode: true });
    expect((await store.getSettings()).demoMode).toBe(true);
  });

  it("leaves no temp files behind", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.batches.create(batch(`C0000${i}`))));
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
