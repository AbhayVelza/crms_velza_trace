// A Super Stockist opens a tray of its own stock and sends loose packs both to its Distributor and to the Retailer it
// supplies directly; the Distributor sends one of those loose packs on to one of its own Retailers. My stock, My
// partners and the HQ dashboard are checked at every step. Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { dispatch, myPartners, openLot, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { dashboard, myStock } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";
import { shipToCustoms } from "../fixtures/shipToCustoms";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
/** C1: a case (4 packs); T1, T2: trays (6 packs). SS-1 holds all three; T1 is opened, C1 and T2 stay sealed. */
const lot: Record<"C1" | "T1" | "T2", string> = { C1: "", T1: "", T2: "" };
let packs: string[] = []; // T1's 6 packs: [0, 1] → DB-1, [2..5] → Retailer-4

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
async function partner(prefix: string) {
  return (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;
}
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
async function verifyLot(lotCode: string) {
  const codes = await packsOf(lotCode);
  expect(await verify(ids.qc, { action: "scanLot", code: lotCode })).toMatchObject({ ok: true });
  for (const [i, code] of codes.entries()) expect(await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: codes.slice(0, i) })).toMatchObject({ ok: true });
  expect(await verify(ids.qc, { action: "confirm", lotCode, packCodes: codes })).toMatchObject({ ok: true });
}
const send = async (from: string, to: string, invoice: string, codes: string[]) =>
  expect(await dispatch(from, { action: "confirm", toPartnerId: to, invoice, codes })).toMatchObject({ ok: true, count: codes.length });
const take = async (who: string, codes: string[]) => {
  for (const code of codes) expect(await receive(who, { code })).toMatchObject({ ok: true });
};
const check = (from: string, to: string, code: string) => dispatch(from, { action: "check", toPartnerId: to, invoice: "INV-CHECK", code });
const counts = async (who: string) => (await myStock(who)).counts;
const stock = (cases: number, trays: number, openedCases: number, openedTrays: number, loosePacks: number) => ({ cases, trays, openedCases, openedTrays, loosePacks });
const partnerRow = async (who: string, partnerId: string) => (await myPartners(who)).partners.find((p) => p.id === partnerId);
const hqRow = async (partnerId: string) => (await dashboard(ids.hq)).stock.find((s) => s.partnerId === partnerId);
/** The same five figures from My stock and from the partner's HQ dashboard row (a partner holding nothing has no row). */
async function expectStock(who: string, partnerId: string, expected: ReturnType<typeof stock>) {
  expect(await counts(who)).toEqual(expected);
  const row = await hqRow(partnerId);
  if (Object.values(expected).every((n) => n === 0) && row === undefined) return;
  expect(row).toMatchObject(expected);
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-ss-loose-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  ids.op = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.vw = await user("WAREHOUSE");
  ids.ss1 = await user("SS", "SS-1");
  ids.db1 = await user("DB", "DB-1");
  ids.rt1 = await user("RETAILER", "Retailer-1");
  ids.rt4 = await user("RETAILER", "Retailer-4");
  ids.hq = await user("TRACE_OWNER");
  ids.VW = await partner("VW-1");
  ids.SS1 = await partner("SS-1");
  ids.DB1 = await partner("DB-1"); // SS-1's Distributor
  ids.DB2 = await partner("DB-2"); // SS-2's Distributor
  ids.RT1 = await partner("Retailer-1"); // DB-1's
  ids.RT3 = await partner("Retailer-3"); // DB-2's
  ids.RT4 = await partner("Retailer-4"); // SS-1's directly

  const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 1, trays: 2 }] });
  if (created.preview) throw new Error("expected a created order");
  await markPrinted(ids.op, created.printOrder.id);
  const lots = await store().lots.list({ lotCode: created.printOrder.lotCodes });
  [lot.C1] = lots.filter((l) => l.lotType === "CASE").map((l) => l.lotCode);
  [lot.T1, lot.T2] = lots.filter((l) => l.lotType === "TRAY").map((l) => l.lotCode).sort();
  const all = [lot.C1, lot.T1, lot.T2];
  for (const code of all) await verifyLot(code);
  await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: all, invoice: "INV-SSL-0" });
  await send(ids.vw, ids.SS1, "INV-SSL-1", all);
  await take(ids.ss1, all);
  packs = await packsOf(lot.T1);
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a Super Stockist sends loose packs to its Distributor, which sends one on to its Retailer", () => {
  it("before: SS-1 holds a case and two trays, all sealed", async () => {
    await expectStock(ids.ss1, ids.SS1, stock(1, 2, 0, 0, 0));
    await expectStock(ids.db1, ids.DB1, stock(0, 0, 0, 0, 0));
  });

  it("1. SS-1 opens tray T1 in its own stock: 6 loose packs at SS-1, the tray counted while any is there", async () => {
    const r = await openLot(ids.ss1, { lotCode: lot.T1 });
    expect(r).toMatchObject({ ok: true });
    expect(r.packs).toHaveLength(6);
    expect(new Set(r.packs!.map((p) => p.status))).toEqual(new Set(["AT_SS"]));
    await expectStock(ids.ss1, ids.SS1, stock(1, 2, 0, 1, 6));
  });

  it("a pack of a still-sealed tray or case can't move alone; a loose pack can't go to another Super Stockist's Distributor", async () => {
    const [sealedTrayPack] = await packsOf(lot.T2);
    const [sealedCasePack] = await packsOf(lot.C1);
    expect(await check(ids.ss1, ids.DB1, sealedTrayPack)).toMatchObject({ ok: false, code: "LOT_SEALED" });
    expect(await check(ids.ss1, ids.RT4, sealedCasePack)).toMatchObject({ ok: false, code: "LOT_SEALED" });
    expect(await check(ids.ss1, ids.DB2, packs[0])).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // SS-2's Distributor
    expect(await check(ids.ss1, ids.RT3, packs[0])).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // DB-2's Retailer
    expect(await check(ids.ss1, ids.RT1, packs[0])).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // DB-1's Retailer
    expect(await check(ids.ss1, ids.DB1, packs[0])).toMatchObject({ ok: true, kind: "PACK" });
    expect(await check(ids.ss1, ids.RT4, packs[0])).toMatchObject({ ok: true, kind: "PACK" });
    // Nothing moved.
    await expectStock(ids.ss1, ids.SS1, stock(1, 2, 0, 1, 6));
  });

  it("2. SS-1 sends 2 packs to DB-1 and 4 to Retailer-4: on the way, no longer SS-1's stock", async () => {
    await send(ids.ss1, ids.DB1, "INV-SSL-DB1", packs.slice(0, 2));
    await send(ids.ss1, ids.RT4, "INV-SSL-RT4", packs.slice(2));
    // The opened tray has no pack left at SS-1: only the sealed case and tray count.
    await expectStock(ids.ss1, ids.SS1, stock(1, 1, 0, 0, 0));
    expect((await myStock(ids.ss1)).outgoing.filter((o) => o.kind === "PACK")).toHaveLength(6);
    expect(await partnerRow(ids.ss1, ids.DB1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 0, onTheWayFromMe: 2 });
    expect(await partnerRow(ids.ss1, ids.RT4)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 0, onTheWayFromMe: 4 });
    expect((await myStock(ids.db1)).incoming.map((i) => [i.code, i.kind, i.invoice])).toEqual(packs.slice(0, 2).map((c) => [c, "PACK", "INV-SSL-DB1"]));
    await expectStock(ids.db1, ids.DB1, stock(0, 0, 0, 0, 0));
    await expectStock(ids.rt4, ids.RT4, stock(0, 0, 0, 0, 0));
  });

  it("3. DB-1 and Retailer-4 receive their packs (each only its own)", async () => {
    expect(await receive(ids.db1, { code: packs[2] })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    await take(ids.db1, packs.slice(0, 2));
    await take(ids.rt4, packs.slice(2));
    for (const code of packs.slice(0, 2)) expect((await store().packs.findOne({ packCode: code }))!).toMatchObject({ status: "AT_DB", locationId: ids.DB1 });
    for (const code of packs.slice(2)) expect((await store().packs.findOne({ packCode: code }))!).toMatchObject({ status: "AT_RETAILER", locationId: ids.RT4 });
    await expectStock(ids.ss1, ids.SS1, stock(1, 1, 0, 0, 0));
    await expectStock(ids.db1, ids.DB1, stock(0, 0, 0, 0, 2));
    await expectStock(ids.rt4, ids.RT4, stock(0, 0, 0, 0, 4));
    expect(await partnerRow(ids.ss1, ids.DB1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 2, onTheWayFromMe: 0 });
    expect(await partnerRow(ids.ss1, ids.RT4)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 4, onTheWayFromMe: 0 });
    expect(await partnerRow(ids.db1, ids.RT1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 0, onTheWayFromMe: 0 });
  });

  it("4. DB-1 sends one loose pack on to its own Retailer-1, who receives it; never to someone else's Retailer", async () => {
    const [p, kept] = packs;
    expect(await check(ids.db1, ids.RT3, p)).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // DB-2's Retailer
    expect(await check(ids.db1, ids.RT4, p)).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // SS-1's direct Retailer
    expect(await check(ids.db1, ids.SS1, p)).toMatchObject({ ok: false, code: "WRONG_DESTINATION" }); // never back up the chain
    await send(ids.db1, ids.RT1, "INV-SSL-RT1", [p]);
    await expectStock(ids.db1, ids.DB1, stock(0, 0, 0, 0, 1));
    expect(await partnerRow(ids.db1, ids.RT1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 0, onTheWayFromMe: 1 });
    expect(await partnerRow(ids.ss1, ids.DB1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 1, onTheWayFromMe: 0 });

    await take(ids.rt1, [p]);
    expect((await store().packs.findOne({ packCode: p }))!).toMatchObject({ status: "AT_RETAILER", locationId: ids.RT1 });
    expect((await store().packs.findOne({ packCode: kept }))!).toMatchObject({ status: "AT_DB", locationId: ids.DB1 });
    await expectStock(ids.rt1, ids.RT1, stock(0, 0, 0, 0, 1));
    await expectStock(ids.db1, ids.DB1, stock(0, 0, 0, 0, 1));
    await expectStock(ids.ss1, ids.SS1, stock(1, 1, 0, 0, 0));
    await expectStock(ids.rt4, ids.RT4, stock(0, 0, 0, 0, 4));
    expect(await partnerRow(ids.db1, ids.RT1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 1, onTheWayFromMe: 0 });
    expect(await partnerRow(ids.ss1, ids.DB1)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 1, onTheWayFromMe: 0 });
    expect(await partnerRow(ids.ss1, ids.RT4)).toMatchObject({ lotsInStock: 0, loosePacksInStock: 4, onTheWayFromMe: 0 });
  });

  it("HQ dashboard status counts: the opened tray, the sealed lots, and the loose packs where they are", async () => {
    const d = await dashboard(ids.hq);
    expect(d.lotCounts).toMatchObject({ OPENED: 1, AT_SS: 2 });
    // T1: 1 pack at DB-1, 1 at Retailer-1, 4 at Retailer-4; C1 (4) and T2 (6) sealed at SS-1.
    expect(d.packCounts).toMatchObject({ AT_DB: 1, AT_RETAILER: 5, AT_SS: 10 });
  });
});
