// Scanning through the real services (the same code the scan screens call): QC lot → packs, dispatch checks, receive,
// duplicates, refused codes and their audit records, the invoice on incoming items, and the role / partner matrix for
// every scan API. The checklist on the screens only reflects these answers.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/lib/core/permissions";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { myStock, recall } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
const statusOf = async (lotCode: string) => (await store().lots.findOne({ lotCode }))!.status;

async function order(flavour: string, cases: number, trays = 0, print = true) {
  const r = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour, mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays }] });
  if (r.preview) throw new Error("expected an order");
  if (print) await markPrinted(ids.operator, r.printOrder.id);
  return r.printOrder.lotCodes;
}
async function qcPass(lotCode: string) {
  const packs = await packsOf(lotCode);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
  return verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
}
const scans = async (code: string) => (await store().scans.list()).filter((s) => s.code === code);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-scan-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  const [users, partners] = await Promise.all([store().users.list(), store().partners.list()]);
  const user = (role: Role, prefix?: string) => users.find((u) => u.role === role && (!prefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(prefix)))!.id;
  Object.assign(ids, {
    admin: user("ADMIN"),
    hq: user("TRACE_OWNER"),
    operator: user("OPERATOR"),
    qc: user("QC"),
    ss1: user("SS", "SS-1"),
    ss2: user("SS", "SS-2"),
    db1: user("DB", "DB-1"),
    rt1: user("RETAILER", "Retailer-1"),
    rt2: user("RETAILER", "Retailer-2"),
    SS1: partners.find((p) => p.name.startsWith("SS-1"))!.id,
    DB1: partners.find((p) => p.name.startsWith("DB-1"))!.id,
    RT1: partners.find((p) => p.name.startsWith("Retailer-1"))!.id,
  });
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("QC: lot, then each pack", () => {
  it("lot accepted with its expected packs; correct packs accepted; another lot's pack, an unknown code and a repeat refused", async () => {
    const [a, b] = await order("OR", 1, 1);
    const start = await verify(ids.qc, { action: "scanLot", code: a });
    expect(start).toMatchObject({ ok: true, lot: { lotCode: a, expectedPacks: await packsOf(a) } });
    const [p1, p2] = await packsOf(a);
    expect(await verify(ids.qc, { action: "scanPack", lotCode: a, code: p1, scanned: [] })).toMatchObject({ ok: true });
    expect(await verify(ids.qc, { action: "scanPack", lotCode: a, code: p1, scanned: [p1] })).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" });
    expect(await verify(ids.qc, { action: "scanPack", lotCode: a, code: (await packsOf(b))[0], scanned: [p1] })).toMatchObject({ ok: false, code: "WRONG_LOT" });
    expect(await verify(ids.qc, { action: "scanPack", lotCode: a, code: "91ZZZZZZOR0000161", scanned: [p1] })).toMatchObject({ ok: false, code: "WRONG_LOT" });
    expect(await verify(ids.qc, { action: "scanLot", code: "91ZZZZZZOR00001" })).toMatchObject({ ok: false, code: "UNKNOWN_CODE" });
    // Scanning the lot is not verifying its packs: nothing changed yet.
    expect(await statusOf(a)).toBe("PRINTED");
    // A missing pack: Confirm with what was scanned → QUARANTINED (existing rule); every pack → PACKED.
    expect(await verify(ids.qc, { action: "confirm", lotCode: a, packCodes: [p1, p2] })).toMatchObject({ ok: false, code: "QUARANTINED" });
    expect(await statusOf(a)).toBe("QUARANTINED");
    expect(await qcPass(b)).toMatchObject({ ok: true });
    expect(await statusOf(b)).toBe("PACKED");
  });

  it("unprinted, voided and recalled lots are refused at the lot scan", async () => {
    const [unprinted] = await order("NS", 1, 0, false);
    expect(await verify(ids.qc, { action: "scanLot", code: unprinted })).toMatchObject({ ok: false, code: "NOT_PRINTED" });
    const [v] = await order("MN", 1);
    await voidLot(ids.operator, { lotCode: v, reason: "Misprint" });
    expect(await verify(ids.qc, { action: "scanLot", code: v })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
    const [r] = await order("GA", 1);
    await recall(ids.hq, { batchCode: (await store().lots.findOne({ lotCode: r }))!.batchCode, reason: "Test recall" });
    expect(await verify(ids.qc, { action: "scanLot", code: r })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
  });

  it("every QC scan, accepted or refused, is in the append-only scan audit with its result", async () => {
    const [lot] = await order("OR", 1);
    await verify(ids.qc, { action: "scanLot", code: lot });
    await verify(ids.qc, { action: "scanPack", lotCode: lot, code: "91YYYYYYMN0000162", scanned: [] });
    expect((await scans(lot)).map((s) => [s.context, s.ok, s.result])).toEqual([["VERIFY", true, "OK"]]);
    expect((await scans("91YYYYYYMN0000162")).map((s) => [s.context, s.ok, s.result])).toEqual([["VERIFY", false, "WRONG_LOT"]]);
  });
});

describe("dispatch and receive scans", () => {
  let lots: string[] = [];
  beforeAll(async () => {
    lots = await order("OR", 3);
    for (const l of lots) await qcPass(l);
  });

  it("dispatch check: eligible stock accepted, a repeat in the list refused, unverified stock refused, nothing moves before confirm", async () => {
    const [a] = lots;
    const head = { toPartnerId: ids.SS1, invoice: "INV-SCAN-1" };
    expect(await dispatch(ids.operator, { action: "check", ...head, code: a, listed: [] })).toMatchObject({ ok: true });
    expect(await dispatch(ids.operator, { action: "check", ...head, code: a, listed: [a] })).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" });
    const [printedOnly] = await order("MN", 1);
    expect(await dispatch(ids.operator, { action: "check", ...head, code: printedOnly, listed: [a] })).toMatchObject({ ok: false, code: "WRONG_STATUS" });
    expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: " ", code: a, listed: [] })).toMatchObject({ ok: false, code: "INVOICE_REQUIRED" });
    expect(await statusOf(a)).toBe("PACKED");
    expect((await scans(a)).filter((s) => s.context === "DISPATCH").map((s) => s.result)).toEqual(["OK", "DUPLICATE_SCAN", "INVOICE_REQUIRED"]);
  });

  it("incoming items carry the invoice they were dispatched on; wrong receiver and duplicate receipt refused; stock counts follow", async () => {
    const [a, b] = lots;
    await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-SCAN-2", codes: [a, b] });
    const incoming = (await myStock(ids.ss1)).incoming;
    expect(incoming.filter((i) => i.code === a || i.code === b).map((i) => [i.code, i.invoice])).toEqual([
      [a, "INV-SCAN-2"],
      [b, "INV-SCAN-2"],
    ]);
    expect(await receive(ids.ss2, { code: a })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    expect(await receive(ids.ss1, { code: a })).toMatchObject({ ok: true });
    expect(await receive(ids.ss1, { code: a })).toMatchObject({ ok: false, code: "DUPLICATE_RECEIPT" });
    const stock = await myStock(ids.ss1);
    expect(stock.inStock.map((i) => i.code)).toContain(a);
    expect(stock.incoming.map((i) => i.code)).toEqual([b]);
    expect((await store().movements.list({ itemCode: a, type: "RECEIVED" })).length).toBe(1);
    expect((await scans(a)).filter((s) => s.context === "RECEIVE").map((s) => [s.ok, s.result])).toEqual([
      [false, "WRONG_RECEIVER"],
      [true, "OK"],
      [false, "DUPLICATE_RECEIPT"],
    ]);
  });

  it("SS → DB → Retailer, retailer opens; another retailer cannot open it", async () => {
    const [a] = lots;
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.DB1, invoice: "INV-SCAN-3", codes: [a] });
    await receive(ids.db1, { code: a });
    await dispatch(ids.db1, { action: "confirm", toPartnerId: ids.RT1, invoice: "INV-SCAN-4", codes: [a] });
    await receive(ids.rt1, { code: a });
    expect(await openLot(ids.rt2, { lotCode: a })).toMatchObject({ ok: false });
    expect(await openLot(ids.rt1, { lotCode: a })).toMatchObject({ ok: true });
    expect(await statusOf(a)).toBe("OPENED");
  });
});

describe("who may scan where (server-side, every role and anonymous)", () => {
  const ROLES: [string, Role | null][] = [
    ["admin", "ADMIN"],
    ["hq", "TRACE_OWNER"],
    ["operator", "OPERATOR"],
    ["qc", "QC"],
    ["ss1", "SS"],
    ["db1", "DB"],
    ["rt1", "RETAILER"],
    ["anonymous", null],
  ];
  const CALLS = {
    verify: (u: string | null) => verify(u, { action: "scanLot", code: "91ZZZZZZOR00001" }),
    dispatch: (u: string | null) => dispatch(u, { action: "check", toPartnerId: null, invoice: "X", code: "91ZZZZZZOR00001" }),
    receive: (u: string | null) => receive(u, { code: "91ZZZZZZOR00001" }),
    openLot: (u: string | null) => openLot(u, { lotCode: "91ZZZZZZOR00001" }),
  } as const;

  for (const [who, role] of ROLES) {
    it(`${who}: allowed exactly where PERMISSIONS says, 401 when not signed in`, async () => {
      for (const [action, call] of Object.entries(CALLS) as [keyof typeof CALLS, (u: string | null) => Promise<unknown>][]) {
        const p = call(role ? ids[who] : null);
        if (!role) await expect(p, `${who} ${action}`).rejects.toMatchObject({ status: 401 });
        else if (PERMISSIONS[action].includes(role)) await expect(p, `${who} ${action}`).resolves.toMatchObject({ ok: false }); // allowed in, then the made-up code is refused
        else await expect(p, `${who} ${action}`).rejects.toMatchObject({ status: 403 });
      }
    });
  }
});
