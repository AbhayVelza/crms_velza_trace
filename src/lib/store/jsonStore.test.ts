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

// File-specific behaviour. Everything else a store must do is in store.contract.test.ts.

describe("JsonStore", () => {
  it("creates the file from the clean base seed on first use", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    expect((await store.users.list()).map((u) => u.id)).toEqual(["AD0001", "HQ0001"]);
    expect(JSON.parse(await fs.readFile(file, "utf8")).flavours).toHaveLength(4);
    expect(await store.partners.list()).toEqual([]);
    expect(await store.batchCodePool.list()).toEqual([]);
  });

  it("picks up external changes (e.g. npm run seed while the server runs)", async () => {
    const a = new JsonStore(file, () => buildBaseSeed());
    await a.users.list();
    const b = new JsonStore(file, () => buildBaseSeed());
    await new Promise((r) => setTimeout(r, 20));
    await b.batches.create(batch("BBB222"));
    expect((await a.batches.list()).map((x) => x.code)).toEqual(["BBB222"]);
  });

  it("refuses data from before the chain change until it is converted, but snapshot() still reads it", async () => {
    const old = buildBaseSeed();
    const outlet = { id: "OT0001", type: "OUTLET", name: "Shop", city: "Pune", parentId: null, active: true };
    await fs.writeFile(file, JSON.stringify({ ...old, partners: [outlet] }), "utf8");
    const store = new JsonStore(file, () => buildBaseSeed());
    await expect(store.partners.list()).rejects.toThrow(/Run "npm run db:convert-chain" first:\n[^]*Outlet Shop \(OT0001\) → Retailer RT0001/);
    await expect(store.transaction(async (tx) => tx.users.list())).rejects.toThrow(/db:convert-chain/);
    expect((await store.snapshot()).partners).toEqual([outlet]);
    const { convertChain } = await import("./convertChain");
    await store.reset(convertChain(await store.snapshot()).data);
    expect((await store.partners.list()).map((p) => [p.id, p.type])).toEqual([["RT0001", "RETAILER"]]);
  });

  it("leaves no temp files behind", async () => {
    const store = new JsonStore(file, () => buildBaseSeed());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.batches.create(batch(`C0000${i}`))));
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
