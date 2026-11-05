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
import { reportDamaged } from "@/lib/services/damage";
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

describe("chain scans take what the scanner sends (QR link, lower case, padding)", () => {
  let c1: string;
  const url = (code: string) => `https://velza.example/t/${code}`;
  beforeAll(async () => {
    [c1] = await order("OR", 1);
    await qcPass(c1);
  });

  it("dispatch check, confirm, receive and open accept the full QR link and a padded lower-case code; no false UNKNOWN_CODE", async () => {
    const head = { toPartnerId: ids.SS1, invoice: "INV-QR-1" };
    expect(await dispatch(ids.operator, { action: "check", ...head, code: url(c1), listed: [] })).toMatchObject({ ok: true, message: expect.stringContaining(c1) });
    // A raw code and its QR link are the same item in the list.
    expect(await dispatch(ids.operator, { action: "check", ...head, code: url(c1), listed: [c1] })).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" });
    expect(await dispatch(ids.operator, { action: "check", ...head, code: c1, listed: [url(c1)] })).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" });
    // Confirm with the code twice (raw + link) dispatches it once.
    expect(await dispatch(ids.operator, { action: "confirm", ...head, codes: [c1, url(c1)] })).toMatchObject({ ok: true, count: 1 });
    expect(await store().movements.list({ itemCode: c1, type: "DISPATCHED" })).toHaveLength(1);
    expect(await receive(ids.ss1, { code: ` ${c1.toLowerCase()}\r\n` })).toMatchObject({ ok: true, message: expect.stringContaining(c1) });
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.DB1, invoice: "INV-QR-2", codes: [url(c1)] });
    expect(await receive(ids.db1, { code: url(c1) })).toMatchObject({ ok: true });
    await dispatch(ids.db1, { action: "confirm", toPartnerId: ids.RT1, invoice: "INV-QR-3", codes: [c1] });
    expect(await receive(ids.rt1, { code: `\t${url(c1)}\n` })).toMatchObject({ ok: true });
    expect(await openLot(ids.rt1, { lotCode: url(c1) })).toMatchObject({ ok: true });
    expect(await statusOf(c1)).toBe("OPENED");
    // Audit rows carry the normalised code; nothing was logged as an unknown code.
    const all = await store().scans.list();
    expect(all.filter((s) => s.code.includes(c1.toLowerCase()) || s.code.includes(`/t/${c1}`))).toHaveLength(0);
    expect((await scans(c1)).every((s) => s.result !== "UNKNOWN_CODE")).toBe(true);
  });

  it("a 10,000-character code is a validation error and is not logged", async () => {
    const before = (await store().scans.list()).length;
    const junk = "9".repeat(10_000);
    await expect(receive(ids.ss1, { code: junk })).rejects.toMatchObject({ name: "ZodError" });
    await expect(openLot(ids.rt1, { lotCode: junk })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dispatch(ids.ss1, { action: "check", toPartnerId: ids.DB1, invoice: "X", code: junk })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.DB1, invoice: "X", codes: [junk] })).rejects.toMatchObject({ name: "ZodError" });
    expect((await store().scans.list()).length).toBe(before);
  });
});

describe("receive / dispatch: location before status (no status of stock held elsewhere)", () => {
  it("an SS receiving a plant-held VOID or QUARANTINED lot is told only that it is not addressed to it", async () => {
    const [v] = await order("MN", 1);
    await voidLot(ids.operator, { lotCode: v, reason: "Misprint" });
    const [q] = await order("NS", 1);
    await verify(ids.qc, { action: "scanLot", code: q });
    await verify(ids.qc, { action: "confirm", lotCode: q, packCodes: (await packsOf(q)).slice(0, 1) });
    expect(await statusOf(q)).toBe("QUARANTINED");
    for (const code of [v, q]) {
      const r = await receive(ids.ss1, { code });
      expect(r).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
      expect(r.message).not.toMatch(/VOID|QUARANTINED/);
      const d = await dispatch(ids.db1, { action: "check", toPartnerId: ids.RT1, invoice: "INV-LEAK", code });
      expect(d).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
      expect(d.message).not.toMatch(/VOID|QUARANTINED/);
    }
  });

  it("another partner's DAMAGED lot: NOT_AT_LOCATION / WRONG_RECEIVER; the holder is still told it is DAMAGED", async () => {
    const [d] = await order("OR", 1);
    await qcPass(d);
    await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-DMG", codes: [d] });
    await receive(ids.ss1, { code: d });
    expect(await reportDamaged(ids.ss1, { code: d, reason: "Crushed" })).toMatchObject({ ok: true });
    const check = await dispatch(ids.db1, { action: "check", toPartnerId: ids.RT1, invoice: "INV-LEAK", code: d });
    expect(check).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    expect(check.message).not.toMatch(/DAMAGED/);
    const rec = await receive(ids.db1, { code: d });
    expect(rec).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    expect(rec.message).not.toMatch(/DAMAGED/);
    expect(await dispatch(ids.ss1, { action: "check", toPartnerId: ids.DB1, invoice: "INV-LEAK", code: d })).toMatchObject({ ok: false, code: "WRONG_STATUS", message: expect.stringMatching(/DAMAGED/) });
    // A bad destination/invoice is still reported first, as before.
    expect(await dispatch(ids.db1, { action: "check", toPartnerId: ids.RT1, invoice: " ", code: d })).toMatchObject({ ok: false, code: "INVOICE_REQUIRED" });
  });

  it("a recall is still reported as BLOCKED_CODE wherever it is scanned", async () => {
    const [r] = await order("GA", 1);
    await recall(ids.hq, { batchCode: (await store().lots.findOne({ lotCode: r }))!.batchCode, reason: "Test recall" });
    expect(await receive(ids.ss1, { code: r })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
    expect(await dispatch(ids.db1, { action: "check", toPartnerId: ids.RT1, invoice: "INV-LEAK", code: r })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
  });
});

describe("dispatch confirm is all-or-nothing", () => {
  it("one refused code: nothing dispatched, the refused code is named", async () => {
    const [good] = await order("OR", 1);
    await qcPass(good);
    const [unverified] = await order("MN", 1);
    const err = await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-AON", codes: [good, unverified] }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "DISPATCH_REJECTED" });
    expect(err.details).toEqual([{ code: unverified, reason: expect.any(String) }]);
    expect(await statusOf(good)).toBe("PACKED");
    expect(await store().movements.list({ itemCode: good, type: "DISPATCHED" })).toHaveLength(0);
  });

  it("two confirms of the same lot at once: exactly one succeeds", async () => {
    const [lot] = await order("OR", 1);
    await qcPass(lot);
    const head = { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-RACE", codes: [lot] } as const;
    const results = await Promise.allSettled([dispatch(ids.operator, head), dispatch(ids.operator, head)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "DISPATCH_REJECTED" } });
    expect(await store().movements.list({ itemCode: lot, type: "DISPATCHED" })).toHaveLength(1);
  });
});

describe("retailer opens a lot", () => {
  let caseLot: string;
  let trayLot: string;
  let rt4: string;
  beforeAll(async () => {
    const [users, partners] = await Promise.all([store().users.list(), store().partners.list()]);
    const RT4 = partners.find((p) => p.name.startsWith("Retailer-4"))!.id;
    rt4 = users.find((u) => u.partnerId === RT4)!.id;
    const codes = await order("OR", 1, 1);
    for (const c of codes) await qcPass(c);
    const types = await Promise.all(codes.map(async (c) => [c, (await store().lots.findOne({ lotCode: c }))!.lotType] as const));
    caseLot = types.find(([, t]) => t === "CASE")![0];
    trayLot = types.find(([, t]) => t === "TRAY")![0];
    await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-OPEN-1", codes });
    for (const c of codes) await receive(ids.ss1, { code: c });
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: RT4, invoice: "INV-OPEN-2", codes });
  });

  it("a lot still in transit to the retailer cannot be opened; a pack code is refused", async () => {
    expect(await openLot(rt4, { lotCode: caseLot })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    for (const c of [caseLot, trayLot]) await receive(rt4, { code: c });
    expect(await openLot(rt4, { lotCode: (await packsOf(caseLot))[0] })).toMatchObject({ ok: false, code: "INVALID_CODE" });
    expect(await statusOf(caseLot)).toBe("AT_RETAILER");
  });

  it("a case opens into 4 packs and a tray into 6, all in the retailer's stock; the message does not promise onward movement", async () => {
    const c = await openLot(rt4, { lotCode: caseLot });
    expect(c).toMatchObject({ ok: true, message: expect.stringMatching(/4 packs/) });
    expect(c.message).not.toMatch(/move/i);
    expect(c.packs?.map((p) => p.status)).toEqual(Array(4).fill("AT_RETAILER"));
    const t = await openLot(rt4, { lotCode: trayLot });
    expect(t).toMatchObject({ ok: true, message: expect.stringMatching(/6 packs/) });
    expect(t.message).not.toMatch(/move/i);
    expect(t.packs?.map((p) => p.status)).toEqual(Array(6).fill("AT_RETAILER"));
    const [moved] = await store().movements.list({ itemCode: trayLot, type: "OPENED" });
    expect(moved.note).toBe("Opened into 6 loose packs");
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
