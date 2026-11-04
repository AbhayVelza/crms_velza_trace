// A partner must not learn anything about codes that are not theirs: another manufacturer's code answers
// exactly like a code that was never generated, and a retailer is told "not in stock here" before any status
// of a lot held elsewhere. Internal records (scan log, alerts) keep the real reason.
// Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { createEntity, registerPartner } from "@/lib/services/admin";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { reprint, voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { alerts, recall } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const store = () => getStore();
const ids: Record<string, string> = {};
let lots: string[] = [];
const NEVER = "91ABCDEFOR00001"; // valid format, never generated

const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
const send = async (from: string, to: string, invoice: string, codes: string[]) => {
  for (const code of codes) await dispatch(from, { action: "check", toPartnerId: to, invoice, code });
  return dispatch(from, { action: "confirm", toPartnerId: to, invoice, codes });
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-disclosure-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role] of [["op", "OPERATOR"], ["qc", "QC"]] as [string, Role][]) ids[k] = (await store().users.list({ role }))[0].id;
  // A second plant with its own operator, QC and device.
  const r = await registerPartner("AD0001", {
    type: "MANUFACTURER", name: "Second Plant", place: "Zone 2", address: "Plot 2", city: "Nashik", contactPerson: "Plant Two",
    phone: "+91 90000 66601", password: "Second2026pass", qcPassword: "Second2026pass",
  });
  ids.op2 = `${r.partner.id}-OP`;
  ids.qc2 = `${r.partner.id}-QC`;
  await createEntity("AD0001", "devices", { manufacturerId: r.partner.id, name: "Plant Two PC" });

  // Plant 1: three cases, verified; case 1 → SS0001 → DB0001 → RT0001 (opened); case 2 → SS0001 → RT0004.
  const order = await createPrintOrder(ids.op, { batches: [{ flavour: "OR", mfgDate: "2026-10-01", expiryDate: "2027-10-01", cases: 3, trays: 0 }] });
  if (order.preview) throw new Error("expected an order");
  lots = order.printOrder.lotCodes;
  await markPrinted(ids.op, order.printOrder.id);
  for (const l of lots) {
    await verify(ids.qc, { action: "scanLot", code: l });
    await verify(ids.qc, { action: "confirm", lotCode: l, packCodes: await packsOf(l) });
  }
  await send(ids.op, "SS0001", "INV-D1", [lots[0], lots[1]]);
  await receive("SS0001", { code: lots[0] });
  await receive("SS0001", { code: lots[1] });
  await send("SS0001", "DB0001", "INV-D2", [lots[0]]);
  await receive("DB0001", { code: lots[0] });
  await send("DB0001", "RT0001", "INV-D3", [lots[0]]);
  await receive("RT0001", { code: lots[0] });
  expect(await openLot("RT0001", { lotCode: lots[0] })).toMatchObject({ ok: true });
  await send("SS0001", "RT0004", "INV-D4", [lots[1]]);
  await receive("RT0004", { code: lots[1] });
}, 120_000);
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("another manufacturer's codes look like codes that were never generated", () => {
  it("reprint: same refusal and message as an unknown code", async () => {
    const pack = (await packsOf(lots[2]))[0];
    const theirs = await reprint(ids.op2, { code: pack, reason: "x" }).catch((e) => e);
    const never = await reprint(ids.op2, { code: `${NEVER}61`, reason: "x" }).catch((e) => e);
    expect(theirs).toMatchObject({ status: 400, code: "UNKNOWN_CODE", message: `Unknown code ${pack}: never generated` });
    expect(never).toMatchObject({ status: 400, code: "UNKNOWN_CODE", message: `Unknown code ${NEVER}61: never generated` });
  });

  it("void: same refusal as an unknown lot", async () => {
    await expect(voidLot(ids.op2, { lotCode: lots[2], reason: "x" })).rejects.toMatchObject({ code: "UNKNOWN_CODE", message: `Unknown lot ${lots[2]}` });
    await expect(voidLot(ids.op2, { lotCode: NEVER, reason: "x" })).rejects.toMatchObject({ code: "UNKNOWN_CODE", message: `Unknown lot ${NEVER}` });
  });

  it("QC scan: the answer matches an unknown code; the scan log keeps the real reason (no counterfeit alert)", async () => {
    const theirs = await verify(ids.qc2, { action: "scanLot", code: lots[2] });
    const never = await verify(ids.qc2, { action: "scanLot", code: NEVER });
    expect(theirs).toEqual({ ok: false, code: "UNKNOWN_CODE", message: `Unknown code ${lots[2]}: never generated` });
    expect(never).toEqual({ ok: false, code: "UNKNOWN_CODE", message: `Unknown code ${NEVER}: never generated` });
    await expect(verify(ids.qc2, { action: "confirm", lotCode: lots[2], packCodes: [] })).rejects.toMatchObject({ code: "UNKNOWN_CODE", message: `Unknown code ${lots[2]}: never generated` });
    const logged = (await store().scans.list({ code: lots[2] })).filter((s) => s.userId === ids.qc2);
    expect(logged.map((s) => s.result)).toContain("NOT_AT_LOCATION");
    const unknownAlerts = (await alerts("HQ0001")).filter((a) => a.type === "UNKNOWN_CODE" && a.code === lots[2]);
    expect(unknownAlerts).toHaveLength(0);
  });

  it("the owning plant still gets the normal answers", async () => {
    expect(await verify(ids.qc, { action: "scanLot", code: lots[2] })).toMatchObject({ ok: false, code: "WRONG_STATUS" }); // already PACKED
    await expect(reprint(ids.op, { code: (await packsOf(lots[2]))[0], reason: "Smudged" })).resolves.toMatchObject({ ok: true });
  });
});

describe("opening a lot: location before status", () => {
  it("a retailer is told 'not in stock here' about another retailer's opened lot", async () => {
    expect(await openLot("RT0002", { lotCode: lots[0] })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION", message: expect.not.stringContaining("opened") });
    expect(await openLot("RT0004", { lotCode: lots[0] })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
  });

  it("the retailer holding it is still told it is already opened", async () => {
    expect(await openLot("RT0001", { lotCode: lots[0] })).toMatchObject({ ok: false, code: "WRONG_STATUS", message: expect.stringContaining("already opened") });
  });

  it("a different retailer's unopened lot, an unknown code, and a non-retailer", async () => {
    expect(await openLot("RT0001", { lotCode: lots[1] })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    expect(await openLot("RT0001", { lotCode: NEVER })).toMatchObject({ ok: false, code: "UNKNOWN_CODE" });
    await expect(openLot("SS0001", { lotCode: lots[1] })).rejects.toMatchObject({ status: 403 });
  });

  it("a recalled lot is still reported as blocked wherever it is scanned (recall alert kept)", async () => {
    const batch = (await store().lots.findOne({ lotCode: lots[1] }))!.batchCode;
    await recall("HQ0001", { batchCode: batch, reason: "test recall" });
    expect(await openLot("RT0001", { lotCode: lots[1] })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
    expect(await openLot("RT0004", { lotCode: lots[1] })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
  });
});
