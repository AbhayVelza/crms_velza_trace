// Public QR page and security hardening, on the JSON file store and on PostgreSQL (embedded):
//   - the consumer check (verify.ts publicCheck): unreleased stock is not "Genuine", VOID looks unregistered,
//     non-genuine scans are logged ok:false with public result codes, junk input is never logged, repeat checks
//     from one client are logged once;
//   - QC verification takes a full QR link and refuses over-long input;
//   - the demo-codes helper only lists a screen's codes to a role allowed on that screen.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeCloneAlerts, computePublicSummaryAlerts } from "@/lib/core/alerts";
import { ALERT_RESULT_CODES } from "@/lib/core/rules";
import type { Role } from "@/lib/core/types";
import { MAX_SCAN_INPUT } from "@/lib/scan/normalize";
import { getStore } from "@/lib/store";
import { reportDamaged } from "@/lib/services/damage";
import { demoCodes } from "@/lib/services/demo";
import { voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { publicLookup } from "@/lib/services/trace";
import { publicCheck, resetPublicRepeatMemory, verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";
import { photoOf } from "../fixtures/damagePhoto";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();

async function user(role: Role) {
  return (await store().users.list({ role }))[0].id;
}

async function printLots(cases: number, print = true) {
  const created = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-10-26", expiryDate: "2027-07-26", cases, trays: 0 }] });
  if (created.preview) throw new Error("expected order");
  if (print) await markPrinted(ids.operator, created.printOrder.id);
  return created.printOrder.lotCodes as string[];
}

async function qcPass(lotCode: string) {
  const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
}

const publicScans = async (code: string) => (await store().scans.list({ context: "PUBLIC_LOOKUP" })).filter((s) => s.code === code);
const allScans = async () => (await store().scans.list()).length;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-public-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role] of [
    ["operator", "OPERATOR"],
    ["qc", "QC"],
    ["ss", "SS"],
    ["db", "DB"],
    ["rt", "RETAILER"],
    ["hq", "TRACE_OWNER"],
  ] as [string, Role][]) {
    ids[k] = await user(role);
  }
});
beforeEach(() => resetPublicRepeatMemory());
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("public consumer check (REF-12, void details, damaged ok, junk input)", () => {
  it("a printed lot that has not passed QC is 'Not yet released', not genuine, and logged ok:false", async () => {
    const [lot] = await printLots(1);
    const r = await publicCheck(lot);
    expect(r.status).toEqual({ label: "Not yet released", tone: "warn" });
    const [row] = await publicScans(lot);
    expect(row).toMatchObject({ ok: false, result: "PUBLIC_UNRELEASED", userId: null, partnerId: null, deviceId: null });
    expect(ALERT_RESULT_CODES as readonly string[]).not.toContain(row.result);
    // HQ's route (trace.ts publicLookup) gives the same label through the shared publicStatus rule.
    expect((await publicLookup(lot)).status.label).toBe("Not yet released");
  });

  it("QC-passed stock is genuine and logged ok", async () => {
    const [lot] = await printLots(1);
    await qcPass(lot);
    const r = await publicCheck(`https://velza.example/t/${lot.toLowerCase()}`);
    expect(r).toMatchObject({ code: lot, registered: true, status: { label: "Genuine Velza product", tone: "ok" }, packType: "CASE" });
    expect(r.flavour).toBeTruthy();
    expect((await publicScans(lot)).at(-1)).toMatchObject({ ok: true, result: "OK" });
  });

  it("a damaged lot is 'Not for sale' and its consumer scan is logged ok:false (not OK)", async () => {
    const [lot] = await printLots(1);
    await qcPass(lot);
    await reportDamaged(ids.operator, { code: lot, reason: "Crushed in the plant", ...photoOf(lot) });
    const r = await publicCheck(lot);
    expect(r.status).toEqual({ label: "Not for sale — do not consume", tone: "danger" });
    expect((await publicScans(lot)).at(-1)).toMatchObject({ context: "PUBLIC_LOOKUP", ok: false, result: "PUBLIC_BLOCKED", message: `Public scan of DAMAGED code ${lot}` });
  });

  it("a VOID code looks exactly like an unknown one: no flavour, batch, dates or pack type", async () => {
    const [lot] = await printLots(1);
    await voidLot(ids.operator, { lotCode: lot, reason: "Misprint" });
    const r = await publicCheck(lot);
    const unknown = await publicCheck("91ZZZZZZOR00001");
    expect(r).toEqual({ ...unknown, code: lot });
    expect(Object.keys(r).sort()).toEqual(["code", "product", "registered", "status"]);
    expect(r.status.label).toBe("Unregistered code");
    expect((await publicScans(lot)).at(-1)).toMatchObject({ ok: false, result: "PUBLIC_BLOCKED" });
  });

  it("a well-formed unknown code is logged as PUBLIC_UNKNOWN; many of them make one HQ summary alert", async () => {
    for (let i = 0; i < 30; i++) await publicCheck(`91ZZZZZZOR${String(i + 100).padStart(5, "0")}`);
    const rows = await store().scans.list({ context: "PUBLIC_LOOKUP" });
    expect(rows.filter((s) => s.result === "PUBLIC_UNKNOWN").length).toBeGreaterThanOrEqual(30);
    expect(rows.some((s) => s.result === "UNKNOWN_CODE")).toBe(false);
    const summary = computePublicSummaryAlerts(rows, new Date()).filter((a) => a.type === "PUBLIC_UNKNOWN");
    expect(summary).toHaveLength(1);
  });

  it("garbage, broken links and over-long input are answered 'Unregistered code' and write no scan row", async () => {
    const before = await allScans();
    for (const junk of ["hello", "%E0%A4%A", "A".repeat(10_000), "https://evil.example/t/<script>", "", "91ABC"]) {
      const r = await publicCheck(junk);
      expect(r).toMatchObject({ registered: false, status: { label: "Unregistered code" } });
      expect(r.code.length).toBeLessThanOrEqual(MAX_SCAN_INPUT);
    }
    for (let i = 0; i < 1000; i++) await publicCheck(`garbage-${i}`);
    expect(await allScans()).toBe(before);
  });

  it("one client re-opening the page is logged once per window; different clients each count (clone alert)", async () => {
    const [lot] = await printLots(1);
    await qcPass(lot);
    for (let i = 0; i < 7; i++) await publicCheck(lot, { clientKey: "203.0.113.9" });
    expect(await publicScans(lot)).toHaveLength(1);
    for (let i = 0; i < 7; i++) await publicCheck(lot, { clientKey: `198.51.100.${i}` });
    const rows = await publicScans(lot);
    expect(rows).toHaveLength(8);
    const clone = computeCloneAlerts(await store().scans.list({ context: "PUBLIC_LOOKUP" }), await store().getSettings(), new Date()).filter((a) => a.code === lot);
    expect(clone).toHaveLength(1);
    expect(clone[0]).toMatchObject({ type: "SUSPECT_CLONE", partnerId: null, userId: null });
    expect(clone[0].message).not.toMatch(/198\.51|203\.0/);
  });

  it("the live QR route's service (trace.ts publicLookup) uses the same rules: refreshes logged once, junk not logged", async () => {
    // /api/lookup/<code>?view=public calls publicLookup(code, { clientKey: clientIp(req.headers) }).
    const [lot] = await printLots(1);
    await qcPass(lot);
    for (let i = 0; i < 5; i++) {
      expect(await publicLookup(lot, { clientKey: "203.0.113.44" })).toMatchObject({ registered: true, status: { label: "Genuine Velza product" } });
    }
    expect(await publicScans(lot)).toHaveLength(1);
    const before = await allScans();
    expect(await publicLookup("not-a-velza-code", { clientKey: "203.0.113.44" })).toMatchObject({ registered: false });
    expect(await allScans()).toBe(before);
  });

  it("the provisional clone settings are in the defaults", async () => {
    expect(await store().getSettings()).toMatchObject({ publicCloneScanThreshold: 5, publicCloneWindowHours: 24 });
  });
});

describe("QC verification input (LOW-scan-normalize-maxlen)", () => {
  it("scanLot accepts a full QR link (or lower case) and refuses over-long input", async () => {
    const [lot] = await printLots(1);
    expect(await verify(ids.qc, { action: "scanLot", code: `https://velza.example/t/${lot}\r\n` })).toMatchObject({ ok: true });
    expect(await verify(ids.qc, { action: "scanLot", code: lot.toLowerCase() })).toMatchObject({ ok: true });
    await expect(verify(ids.qc, { action: "scanLot", code: "A".repeat(MAX_SCAN_INPUT + 1) })).rejects.toThrow();
    const longest = Math.max(...(await store().scans.list({ context: "VERIFY" })).map((s) => s.code.length));
    expect(longest).toBeLessThanOrEqual(MAX_SCAN_INPUT);
  });
});

describe("demo-codes helper (LOW-demo-codes-any-role)", () => {
  it("a role only gets the codes of screens it may use", async () => {
    await expect(demoCodes(ids.rt, "search")).rejects.toMatchObject({ status: 403 });
    await expect(demoCodes(ids.rt, "verify")).rejects.toMatchObject({ status: 403 });
    await expect(demoCodes(ids.ss, "reprint")).rejects.toMatchObject({ status: 403 });
    await expect(demoCodes(ids.hq, "receive")).rejects.toMatchObject({ status: 403 });
    await expect(demoCodes(ids.rt, "open")).resolves.toBeInstanceOf(Array);
    await expect(demoCodes(ids.rt, "receive")).resolves.toBeInstanceOf(Array);
    await expect(demoCodes(ids.qc, "verify")).resolves.toBeInstanceOf(Array);
    await expect(demoCodes(ids.hq, "search")).resolves.toBeInstanceOf(Array);
    await expect(demoCodes(ids.operator, "void")).resolves.toBeInstanceOf(Array);
  });
});
