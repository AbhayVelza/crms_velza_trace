// Damaged stock at every stage: plant, Super Stockist, Distributor, Retailer (loose packs, opened cases), a Retailer
// supplied by its Super Stockist directly, and HQ being informed.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { listDamaged, reportDamaged } from "@/lib/services/damage";
import { dispatch, myPartners, openLot, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { alerts, dashboard, lookup, myStock, publicLookup } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
let lots: string[] = [];

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
const partner = async (prefix: string) => (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;

async function printAndVerify(cases: number) {
  const created = await createPrintOrder(ids.operator, { batches: [{ flavour: "OR", mfgDate: "2026-10-26", expiryDate: "2027-07-26", cases, trays: 0 }] });
  if (created.preview) throw new Error("expected order");
  await markPrinted(ids.operator, created.printOrder.id);
  for (const lotCode of created.printOrder.lotCodes) {
    const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  return created.printOrder.lotCodes;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-damage-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role, tag] of [
    ["operator", "OPERATOR"],
    ["qc", "QC"],
    ["ss1", "SS", "SS-1"],
    ["ss2", "SS", "SS-2"],
    ["db1", "DB", "DB-1"],
    ["rt1", "RETAILER", "Retailer-1"],
    ["rt4", "RETAILER", "Retailer-4"],
    ["hq", "TRACE_OWNER"],
  ] as [string, Role, string?][]) {
    ids[k] = await user(role, tag);
  }
  ids.SS1 = await partner("SS-1");
  ids.DB1 = await partner("DB-1");
  ids.RT1 = await partner("Retailer-1"); // DB-1's
  ids.RT4 = await partner("Retailer-4"); // SS-1's directly
  lots = await printAndVerify(4);
  await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-1", codes: [lots[0], lots[1]] });
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("report damaged", () => {
  it("in transit to me → receive first; then the SS reports a whole case", async () => {
    expect(await reportDamaged(ids.ss1, { code: lots[0], reason: "Crushed" })).toMatchObject({ ok: false, message: expect.stringMatching(/receive it first/) });
    await receive(ids.ss1, { code: lots[0] });
    await receive(ids.ss1, { code: lots[1] });

    expect(await reportDamaged(ids.ss1, { code: `${lots[0]}62`, reason: "Crushed" })).toMatchObject({ ok: false, code: "LOT_SEALED" });
    expect(await reportDamaged(ids.ss2, { code: lots[0], reason: "Crushed" })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    expect(await reportDamaged(ids.ss1, { code: lots[0], reason: " " })).toMatchObject({ ok: false, code: "REASON_REQUIRED" });

    const r = await reportDamaged(ids.ss1, { code: lots[0], reason: "Crushed in transit" });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/HQ informed/) });
    expect((await store().lots.findOne({ lotCode: lots[0] }))?.status).toBe("DAMAGED");
    expect((await store().packs.list({ lotCode: lots[0] })).every((p) => p.status === "DAMAGED")).toBe(true);
    expect(await reportDamaged(ids.ss1, { code: lots[0], reason: "again" })).toMatchObject({ ok: false, message: expect.stringMatching(/already reported/) });
  });

  it("the damaged case is in the SS's Damaged section only, and can't move", async () => {
    const section = await listDamaged(ids.ss1);
    expect(section.items).toEqual([expect.objectContaining({ code: lots[0], kind: "LOT", lotType: "CASE", reason: "Crushed in transit", reportedBy: expect.stringMatching(/Kiran/) })]);
    expect((await listDamaged(ids.ss2)).items).toEqual([]);
    expect((await myStock(ids.ss1)).inStock.map((s) => s.code)).toEqual([lots[1]]);
    expect(await dispatch(ids.ss1, { action: "check", toPartnerId: ids.DB1, invoice: "INV-2", code: lots[0] })).toMatchObject({ ok: false, code: "WRONG_STATUS" });
  });

  it("HQ is informed: alert, dashboard, timeline; the public page warns", async () => {
    const a = (await alerts(ids.hq)).find((x) => x.type === "DAMAGED");
    expect(a).toMatchObject({ code: lots[0], message: expect.stringMatching(/Crushed in transit/), partner: expect.stringMatching(/SS-1/) });
    const d = await dashboard(ids.hq);
    expect(d.lotCounts.DAMAGED).toBe(1);
    expect(d.alertCounts.DAMAGED).toBe(1);
    expect(d.stock.find((s) => s.partnerId === ids.SS1)).toMatchObject({ cases: 1, damaged: { cases: 1, trays: 0, packs: 0 } });
    const t = await lookup(ids.hq, lots[0]);
    if (!t.found) throw new Error("not found");
    expect(t.timeline.at(-1)).toMatchObject({ event: "DAMAGED", note: "Crushed in transit" });
    expect((await publicLookup(lots[0])).status.label).toBe("Not for sale — do not consume");
  });

  it("a Retailer opens a case and reports one pack; the other packs stay in stock", async () => {
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.DB1, invoice: "INV-2", codes: [lots[1]] });
    await receive(ids.db1, { code: lots[1] });
    // A Distributor ships sealed cases: it can't open one, so it reports damage by the whole case only.
    await expect(openLot(ids.db1, { lotCode: lots[1] })).rejects.toMatchObject({ status: 403 });
    expect(await reportDamaged(ids.db1, { code: `${lots[1]}63`, reason: "Leaking" })).toMatchObject({ ok: false, code: "LOT_SEALED", message: expect.not.stringMatching(/open the lot/) });
    await dispatch(ids.db1, { action: "confirm", toPartnerId: ids.RT1, invoice: "INV-3", codes: [lots[1]] });
    expect(await receive(ids.rt1, { code: lots[1] })).toMatchObject({ ok: true, status: "AT_RETAILER" });
    expect(await reportDamaged(ids.rt1, { code: `${lots[1]}63`, reason: "Leaking" })).toMatchObject({ ok: false, message: expect.stringMatching(/open the lot first/) });
    await openLot(ids.rt1, { lotCode: lots[1] });
    expect(await reportDamaged(ids.rt1, { code: `${lots[1]}63`, reason: "Leaking" })).toMatchObject({ ok: true });

    const section = await listDamaged(ids.rt1);
    expect(section.items.map((i) => [i.code, i.kind])).toEqual([[`${lots[1]}63`, "PACK"]]);
    expect(section.counts).toEqual({ cases: 0, trays: 0, packs: 1 });
    const stock = (await myStock(ids.rt1)).inStock.map((s) => s.code);
    expect(stock).toContain(`${lots[1]}61`);
    expect(stock).not.toContain(`${lots[1]}63`);

    // an opened case in good condition still counts as a case where it was opened
    const counts = { cases: 1, trays: 0, openedCases: 1, openedTrays: 0, loosePacks: 3 };
    expect((await myStock(ids.rt1)).counts).toEqual(counts);
    expect((await dashboard(ids.hq)).stock.find((s) => s.partnerId === ids.RT1)).toMatchObject(counts);
  });

  it("an opened case is still reported as a whole case: the packs of it left here", async () => {
    expect(await reportDamaged(ids.rt1, { code: lots[1], reason: "Crushed in storage" })).toMatchObject({ ok: true, message: expect.stringMatching(/Opened case .*3 packs left here/) });
    expect((await store().lots.findOne({ lotCode: lots[1] }))?.status).toBe("OPENED");
    const packs = Object.fromEntries((await store().packs.list({ lotCode: lots[1] })).map((p) => [p.seq, p.status]));
    expect(packs).toEqual({ 1: "DAMAGED", 2: "DAMAGED", 3: "DAMAGED", 4: "DAMAGED" });

    // one case, its earlier single damaged pack included
    const section = await listDamaged(ids.rt1);
    expect(section.counts).toEqual({ cases: 1, trays: 0, packs: 0 });
    expect(section.items).toEqual([expect.objectContaining({ code: lots[1], kind: "LOT", opened: true, packs: 4, reason: "Crushed in storage" })]);
    expect((await myStock(ids.rt1)).inStock).toEqual([]);
    expect((await myStock(ids.rt1)).counts).toMatchObject({ cases: 0, loosePacks: 0 });
    // DB-1's My retailers agrees with Retailer-1's own stock: the opened case is gone
    expect((await myPartners(ids.db1)).partners.find((p) => p.id === ids.RT1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 0 });
    expect((await dashboard(ids.hq)).stock.find((s) => s.partnerId === ids.RT1)?.damaged).toEqual({ cases: 1, trays: 0, packs: 0 });

    expect(await reportDamaged(ids.rt1, { code: lots[1], reason: "again" })).toMatchObject({ ok: false, message: expect.stringMatching(/None of the packs/) });
  });

  it("a Retailer supplied by its Super Stockist directly reports a sealed case", async () => {
    await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-4", codes: [lots[3]] });
    await receive(ids.ss1, { code: lots[3] });
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.RT4, invoice: "INV-5", codes: [lots[3]] });
    expect(await reportDamaged(ids.rt4, { code: lots[3], reason: "Wet" })).toMatchObject({ ok: false, message: expect.stringMatching(/receive it first/) });
    expect(await receive(ids.rt4, { code: lots[3] })).toMatchObject({ ok: true, status: "AT_RETAILER" });
    expect(await reportDamaged(ids.rt4, { code: lots[3], reason: "Wet" })).toMatchObject({ ok: true, message: expect.stringMatching(/Case .* and its packs reported damaged/) });
    expect((await listDamaged(ids.rt4)).items).toEqual([expect.objectContaining({ code: lots[3], kind: "LOT", opened: false, reason: "Wet" })]);
    expect((await listDamaged(ids.ss1)).items.map((i) => i.code)).toEqual([lots[0]]);
    expect((await dashboard(ids.hq)).stock.find((s) => s.partnerId === ids.RT4)?.damaged).toEqual({ cases: 1, trays: 0, packs: 0 });
  });

  it("the plant reports packed stock; QC and HQ can't report", async () => {
    expect(await reportDamaged(ids.operator, { code: lots[2], reason: "Dropped by forklift" })).toMatchObject({ ok: true });
    expect((await listDamaged(ids.operator)).items.map((i) => i.code)).toEqual([lots[2]]);
    await expect(reportDamaged(ids.qc, { code: lots[2], reason: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(listDamaged(ids.hq)).rejects.toMatchObject({ status: 403 });
    // every report is in the scan audit
    expect((await store().scans.list({ context: "DAMAGE" })).filter((s) => s.ok)).toHaveLength(5);
  });
});
