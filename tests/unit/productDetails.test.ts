// Product details at every level of the chain (plant, Velza Warehouse, SS, DB, Retailer): batch, manufacture and
// expiry date, pack n of m, and the partners a case / pack came through — at a Retailer, its SS and DB. A partner sees
// only codes that are at, on their way to, or have passed through it; the chain never goes past the viewer.
// Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { daysUntil, productDetails } from "@/lib/services/details";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
let lots: string[] = [];
let batchCode = "";

async function user(role: Role, prefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !prefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(prefix))!.id;
}
const partner = async (prefix: string) => (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
const send = async (from: string, to: string, invoice: string, codes: string[]) => {
  expect(await dispatch(from, { action: "confirm", toPartnerId: to, invoice, codes })).toMatchObject({ ok: true });
};
const take = async (who: string, codes: string[]) => {
  for (const code of codes) expect(await receive(who, { code })).toMatchObject({ ok: true });
};
const found = async (who: string, code: string) => {
  const r = await productDetails(who, code);
  if (!r.found) throw new Error(`${code} not found for ${who}: ${r.message}`);
  return r;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-details-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role, prefix] of [
    ["op", "OPERATOR"], ["qc", "QC"], ["vw", "WAREHOUSE"], ["ss1", "SS", "SS-1"], ["ss2", "SS", "SS-2"], ["db1", "DB", "DB-1"],
    ["rt1", "RETAILER", "Retailer-1"], ["rt2", "RETAILER", "Retailer-2"], ["rt4", "RETAILER", "Retailer-4"], ["hq", "TRACE_OWNER"], ["admin", "ADMIN"],
  ] as [string, Role, string?][]) ids[k] = await user(role, prefix);
  for (const [k, prefix] of [["VW", "VW-1"], ["SS1", "SS-1"], ["DB1", "DB-1"], ["RT1", "Retailer-1"], ["RT4", "Retailer-4"]]) ids[k] = await partner(prefix);

  // Three Original cases, made 1 Nov 2026, expiring 1 Aug 2027, QC-passed.
  const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 3, trays: 0 }] });
  if (created.preview) throw new Error("expected an order");
  await markPrinted(ids.op, created.printOrder.id);
  lots = created.printOrder.lotCodes;
  batchCode = (await store().lots.findOne({ lotCode: lots[0] }))!.batchCode;
  for (const lotCode of lots) {
    const packs = await packsOf(lotCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  // Plant → Velza Warehouse → SS-1; then case 0: SS-1 → DB-1 → Retailer-1 (opened); case 1: SS-1 → Retailer-4 directly.
  await send(ids.op, ids.VW, "INV-P1", [lots[0], lots[1]]);
  await take(ids.vw, [lots[0], lots[1]]);
  await send(ids.vw, ids.SS1, "INV-W1", [lots[0], lots[1]]);
  await take(ids.ss1, [lots[0], lots[1]]);
  await send(ids.ss1, ids.DB1, "INV-S1", [lots[0]]);
  await take(ids.db1, [lots[0]]);
  await send(ids.db1, ids.RT1, "INV-D1", [lots[0]]);
  await take(ids.rt1, [lots[0]]);
  await openLot(ids.rt1, { lotCode: lots[0] });
  await send(ids.ss1, ids.RT4, "INV-S2", [lots[1]]);
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("product details at the Retailer: Mfg date, Exp date, Batch No., from which SS and DB", () => {
  it("a pack of the opened case at Retailer-1: dates, batch, pack n of m, came from SS-1 and DB-1", async () => {
    const pack = (await packsOf(lots[0]))[2];
    const r = await found(ids.rt1, pack);
    expect(r).toMatchObject({
      kind: "PACK",
      lotType: "CASE",
      lotCode: lots[0],
      flavour: "Original",
      batchCode,
      mfgDate: "2026-11-01",
      expiryDate: "2027-08-01",
      packLabel: "Pack 3 of 6",
      position: "Here",
      cameFrom: { warehouse: expect.stringMatching(/^VW-1/), superStockist: expect.stringMatching(/^SS-1/), distributor: expect.stringMatching(/^DB-1/) },
    });
    expect(r.supplyChain.map((s) => s.tier)).toEqual(["MANUFACTURER", "WAREHOUSE", "SS", "DB", "RETAILER"]);
    expect(r.supplyChain.map((s) => s.invoice)).toEqual([null, "INV-P1", "INV-W1", "INV-S1", "INV-D1"]);
    expect(r.supplyChain.at(-1)).toMatchObject({ you: true, onTheWay: false });
  });

  it("the case itself at Retailer-1 (scanned as a case, not a pack)", async () => {
    expect(await found(ids.rt1, lots[0])).toMatchObject({ kind: "LOT", packLabel: null, status: "OPENED", cameFrom: { distributor: expect.stringMatching(/^DB-1/) } });
  });

  it("a case still on its way to Retailer-4, supplied by SS-1 directly: no Distributor", async () => {
    const r = await found(ids.rt4, lots[1]);
    expect(r).toMatchObject({ position: "On its way to you", status: "IN_TRANSIT", cameFrom: { superStockist: expect.stringMatching(/^SS-1/), distributor: null } });
    expect(r.supplyChain.at(-1)).toMatchObject({ tier: "RETAILER", you: true, onTheWay: true, invoice: "INV-S2" });
  });
});

describe("product details at every level", () => {
  it("the plant (operator and QC) sees its own codes with dates and batch; the chain is just the plant", async () => {
    for (const who of [ids.op, ids.qc]) {
      const r = await found(who, lots[2]);
      expect(r).toMatchObject({ batchCode, mfgDate: "2026-11-01", expiryDate: "2027-08-01", position: "Here", status: "PACKED" });
      expect(r.supplyChain).toHaveLength(1);
    }
  });

  it("the plant also sees a code it has shipped, but not where it went after the plant", async () => {
    const r = await found(ids.op, lots[0]);
    expect(r).toMatchObject({ position: "Passed through you", status: null });
    expect(r.supplyChain.map((s) => s.tier)).toEqual(["MANUFACTURER"]);
  });

  it("the warehouse, SS and DB see the chain up to themselves only, never further down", async () => {
    expect((await found(ids.vw, lots[0])).supplyChain.map((s) => s.tier)).toEqual(["MANUFACTURER", "WAREHOUSE"]);
    const ss = await found(ids.ss1, lots[0]);
    expect(ss.supplyChain.map((s) => s.tier)).toEqual(["MANUFACTURER", "WAREHOUSE", "SS"]);
    expect(ss).toMatchObject({ position: "Passed through you", status: null });
    expect(JSON.stringify(ss)).not.toMatch(/Retailer-1|DB-1/);
    const db = await found(ids.db1, lots[0]);
    expect(db.supplyChain.map((s) => s.tier)).toEqual(["MANUFACTURER", "WAREHOUSE", "SS", "DB"]);
    expect(JSON.stringify(db)).not.toMatch(/Retailer-1/);
  });

  it("an SS sees a case it dispatched while it is on its way to the next partner", async () => {
    expect(await found(ids.ss1, lots[1])).toMatchObject({ position: expect.stringMatching(/^On its way from you to Retailer-4/), status: "IN_TRANSIT" });
  });
});

describe("what a partner may not see", () => {
  it("a code that never came to this partner answers like an unknown code", async () => {
    for (const [who, code] of [[ids.rt2, lots[0]], [ids.rt2, (await packsOf(lots[0]))[0]], [ids.ss2, lots[1]], [ids.vw, lots[2]], [ids.rt1, lots[1]]]) {
      const r = await productDetails(who, code);
      expect(r).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
      expect(JSON.stringify(r)).not.toMatch(/IN_TRANSIT|OPENED|PACKED|SS-1|DB-1|2027/);
    }
  });

  it("an unknown code and junk input", async () => {
    expect(await productDetails(ids.rt1, "91ABCDEFOR00001")).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
    expect(await productDetails(ids.rt1, "hello")).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
  });

  it("HQ and Admin have their own screens; not signed in is refused", async () => {
    await expect(productDetails(ids.hq, lots[0])).rejects.toMatchObject({ status: 403 });
    await expect(productDetails(ids.admin, lots[0])).rejects.toMatchObject({ status: 403 });
    await expect(productDetails(null, lots[0])).rejects.toMatchObject({ status: 401 });
  });

  it("every details scan is in the scan audit as LOOKUP and raises no alert", async () => {
    const scans = (await store().scans.list()).filter((s) => s.context === "LOOKUP");
    expect(scans.some((s) => s.ok)).toBe(true);
    expect(scans.some((s) => !s.ok && s.result === "UNKNOWN_CODE")).toBe(true);
  });
});

describe("days to expiry", () => {
  it("counts whole calendar days", () => {
    const now = new Date("2026-11-13T18:30:00Z");
    expect(daysUntil("2026-11-14", now)).toBe(1);
    expect(daysUntil("2026-11-13", now)).toBe(0);
    expect(daysUntil("2026-11-10", now)).toBe(-3);
    expect(daysUntil(null, now)).toBeNull();
  });
});
