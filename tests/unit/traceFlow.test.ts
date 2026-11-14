// HQ traceability flow completion (4 Nov): recalled / unverified stock kept out of sellable stock (REF-06),
// damage kept through a recall (REF-07), alert acknowledge / close / paging (REF-11), HQ search and repeated scans
// not flooding alerts, recall checks, opened lots with nothing left, and a lot's timeline with its packs' events.
// Runs on a disposable JSON file store and on embedded PostgreSQL (PGlite).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertWorthyScan, applyAlertState, collapseAlerts, computeAlerts, scanThrottle, type Alert } from "@/lib/core/alerts";
import { recallPatch } from "@/lib/core/rules";
import type { Role, Scan } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { listDamaged, reportDamaged } from "@/lib/services/damage";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { alertPage, alerts, batchReport, dashboard, lookup, myStock, publicLookup, recall, recallReport, updateAlert } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { photoOf } from "../fixtures/damagePhoto";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
const partner = async (prefix: string) => (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;

async function order(cases: number) {
  const created = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-10-26", expiryDate: "2027-07-26", cases, trays: 0 }] });
  if (created.preview) throw new Error("expected order");
  return created.printOrder;
}
async function qcPass(lotCode: string) {
  const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
  await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
}
/** The plant ships only to the Velza Warehouse; the warehouse sends the stock on to SS-1 (in transit to it). */
async function toSS1(codes: string[], invoice: string) {
  await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.VW, invoice: `${invoice}-VW`, codes });
  for (const code of codes) await receive(ids.vw, { code });
  await dispatch(ids.vw, { action: "confirm", toPartnerId: ids.SS1, invoice, codes });
}
async function printAndVerify(cases: number) {
  const o = await order(cases);
  await markPrinted(ids.operator, o.id);
  for (const lotCode of o.lotCodes) await qcPass(lotCode);
  return o.lotCodes;
}
const batchOf = (lotCode: string) => lotCode.slice(2, 8);
const row = async (partnerId: string) => (await dashboard(ids.hq)).stock.find((s) => s.partnerId === partnerId);
const codesOf = (items: { code: string }[]) => items.map((i) => i.code);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-traceflow-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  process.env.VELZA_UPLOAD_DIR = path.join(dir, "uploads");
  await store().reset(buildSampleSeed());
  for (const [k, role, tag] of [
    ["admin", "ADMIN"],
    ["operator", "OPERATOR"],
    ["qc", "QC"],
    ["vw", "WAREHOUSE"],
    ["ss1", "SS", "SS-1"],
    ["rt1", "RETAILER", "Retailer-1"],
    ["rt4", "RETAILER", "Retailer-4"],
    ["hq", "TRACE_OWNER"],
  ] as [string, Role, string?][]) {
    ids[k] = await user(role, tag);
  }
  ids.VW = await partner("VW-1");
  ids.SS1 = await partner("SS-1");
  ids.RT4 = await partner("Retailer-4");
  ids.MF = (await store().users.get(ids.operator))!.partnerId!;
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  delete process.env.VELZA_UPLOAD_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("plant stock: only QC-passed lots are finished stock (LOW-unverified-plant-stock)", () => {
  it("generated and printed lots are awaiting QC, not cases; a QC pass makes one a case", async () => {
    const before = { cases: (await row(ids.MF))?.cases ?? 0, mine: (await myStock(ids.operator)).counts.cases };
    const o = await order(2);
    expect(await row(ids.MF)).toMatchObject({ cases: before.cases, awaitingQc: 2 });
    await markPrinted(ids.operator, o.id);
    expect(await row(ids.MF)).toMatchObject({ cases: before.cases, awaitingQc: 2 });
    expect((await myStock(ids.operator)).inStock.map((s) => s.code)).not.toContain(o.lotCodes[0]);
    await qcPass(o.lotCodes[0]);
    expect(await row(ids.MF)).toMatchObject({ cases: before.cases + 1, awaitingQc: 1 });
    const mine = await myStock(ids.operator);
    expect(mine.counts.cases).toBe(before.mine + 1);
    expect(mine.pending).toEqual({ awaitingQc: 1, quarantined: 0 });
    expect(codesOf(mine.inStock)).toContain(o.lotCodes[0]);
    expect(codesOf(mine.inStock)).not.toContain(o.lotCodes[1]);
    await qcPass(o.lotCodes[1]); // leave the plant clean for the next checks
  });
});

describe("an opened case with no packs left (LOW-opened-empty-listed) and its timeline (NEW-timeline-pack-events)", () => {
  let lot = "";
  it("is not listed in My stock once every pack is reported damaged", async () => {
    [lot] = await printAndVerify(1);
    await toSS1([lot], "INV-D1");
    await receive(ids.ss1, { code: lot });
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.RT4, invoice: "INV-D2", codes: [lot] });
    await receive(ids.rt4, { code: lot });
    await openLot(ids.rt4, { lotCode: lot });
    expect((await myStock(ids.rt4)).counts).toMatchObject({ cases: 1, openedCases: 1, loosePacks: 4 });
    for (const seq of [1, 2, 3, 4]) expect(await reportDamaged(ids.rt4, { code: `${lot}6${seq}`, reason: "Leaking", ...photoOf(`${lot}6${seq}`) })).toMatchObject({ ok: true });
    const mine = await myStock(ids.rt4);
    expect(codesOf(mine.inStock).filter((c) => c.startsWith(lot))).toEqual([]);
    expect(mine.counts).toMatchObject({ cases: 0, openedCases: 0, loosePacks: 0 });
  });

  it("HQ's lot timeline shows the single-pack damage reports of its packs", async () => {
    const t = await lookup(ids.hq, lot);
    if (!t.found) throw new Error("not found");
    const damaged = t.timeline.filter((e) => e.event === "DAMAGED");
    expect(damaged.map((e) => [e.itemCode, e.itemKind])).toEqual([1, 2, 3, 4].map((s) => [`${lot}6${s}`, "PACK"]));
    expect(t.timeline.map((e) => e.at)).toEqual([...t.timeline.map((e) => e.at)].sort());
  });
});

describe("recall while in transit (REF-06)", () => {
  let lots: string[] = [];
  it("a lot recalled on its way to the SS is recalled stock at the SS, not stock or outgoing at the plant", async () => {
    lots = await printAndVerify(2);
    await toSS1([lots[0]], "INV-A1");
    const before = { mf: (await row(ids.MF))!.cases, ss: (await row(ids.SS1))?.cases ?? 0 };
    await recall(ids.hq, { batchCode: batchOf(lots[0]), reason: "Seal failure", confirm: true });

    const ss = await myStock(ids.ss1);
    expect(codesOf(ss.recalled)).toEqual([lots[0]]);
    expect(ss.recalled[0]).toMatchObject({ status: "RECALLED", statusBeforeRecall: "IN_TRANSIT" });
    expect(ss.recalledCounts).toEqual({ cases: 1, trays: 0, packs: 0 });
    expect(codesOf(ss.incoming)).not.toContain(lots[0]);
    expect(codesOf(ss.inStock)).not.toContain(lots[0]);

    const mf = await myStock(ids.operator);
    for (const list of [mf.inStock, mf.outgoing]) expect(codesOf(list)).not.toEqual(expect.arrayContaining([lots[0]]));
    expect(codesOf(mf.inStock)).not.toContain(lots[1]);
    expect(codesOf(mf.recalled)).toEqual([lots[1]]); // recalled at the plant: do not ship

    expect(await row(ids.SS1)).toMatchObject({ cases: before.ss, recalled: { cases: 1, trays: 0, packs: 0 } });
    expect(await row(ids.MF)).toMatchObject({ cases: before.mf - 1, recalled: { cases: 1, trays: 0, packs: 0 } });
    const t = await lookup(ids.hq, lots[0]);
    expect(t).toMatchObject({ found: true, status: "RECALLED", location: expect.stringMatching(/^Recalled in transit: .*→ SS-1/) });
    expect((await dashboard(ids.hq)).inTransit.map((u) => u.code)).not.toContain(lots[0]);
  });
});

describe("recall after damage and after opening (REF-06, REF-07)", () => {
  let lots: string[] = [];
  let damagedBefore: Record<string, unknown> = {};
  it("set up: SS reports a sealed case damaged, a retailer opens a case and reports one pack", async () => {
    lots = await printAndVerify(3);
    await toSS1(lots, "INV-B1");
    for (const code of lots) await receive(ids.ss1, { code });
    expect(await reportDamaged(ids.ss1, { code: lots[0], reason: "Crushed", ...photoOf(lots[0]) })).toMatchObject({ ok: true });
    await dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.RT4, invoice: "INV-B2", codes: [lots[1]] });
    await receive(ids.rt4, { code: lots[1] });
    await openLot(ids.rt4, { lotCode: lots[1] });
    expect(await reportDamaged(ids.rt4, { code: `${lots[1]}62`, reason: "Leaking", ...photoOf(`${lots[1]}62`) })).toMatchObject({ ok: true });
    expect((await myStock(ids.rt4)).counts).toMatchObject({ cases: 1, loosePacks: 3 });
    const d = await dashboard(ids.hq);
    damagedBefore = Object.fromEntries(d.stock.map((s) => [s.partnerId, s.damaged]));
  });

  it("after the recall the damaged units stay in Damaged and in the dashboard's damaged counts", async () => {
    await recall(ids.hq, { batchCode: batchOf(lots[0]), reason: "Contamination risk" });
    expect((await listDamaged(ids.ss1)).items.find((i) => i.code === lots[0])).toMatchObject({ kind: "LOT", recalled: true, reason: "Crushed" });
    expect((await listDamaged(ids.rt4)).items.find((i) => i.code === `${lots[1]}62`)).toMatchObject({ kind: "PACK", recalled: true, reason: "Leaking" });
    const d = await dashboard(ids.hq);
    for (const pid of [ids.SS1, ids.RT4]) expect(d.stock.find((s) => s.partnerId === pid)?.damaged).toEqual(damagedBefore[pid]);
  });

  it("the opened case's remaining packs are recalled packs, not loose stock; damaged ones are not double-counted", async () => {
    const rt = await myStock(ids.rt4);
    expect(rt.counts).toMatchObject({ cases: 0, openedCases: 0, loosePacks: 0 });
    expect(codesOf(rt.inStock).filter((c) => c.startsWith(lots[1]))).toEqual([]);
    expect(codesOf(rt.recalled).sort()).toEqual([1, 3, 4].map((s) => `${lots[1]}6${s}`));
    expect(rt.recalledCounts).toEqual({ cases: 0, trays: 0, packs: 3 });
    expect((await row(ids.RT4))?.recalled).toEqual({ cases: 0, trays: 0, packs: 3 });

    const ss = await myStock(ids.ss1);
    expect(codesOf(ss.inStock)).not.toEqual(expect.arrayContaining([lots[0]]));
    expect(codesOf(ss.inStock)).not.toContain(lots[2]);
    expect(codesOf(ss.recalled)).toContain(lots[2]);
    expect(codesOf(ss.recalled)).not.toContain(lots[0]); // damaged: listed under Damaged only
  });

  it("a consumer scan of a damaged code is not logged as a genuine scan", async () => {
    await publicLookup(lots[0]);
    const [scan] = (await store().scans.list({ context: "PUBLIC_LOOKUP", code: lots[0] })).slice(-1);
    expect(scan).toMatchObject({ ok: false });
    expect(scan.result).not.toBe("OK");
  });
});

describe("recall checks (LOW-recall-*, NEW-recall-input-limits)", () => {
  let lots: string[] = [];
  it("void lots are not counted as recallable; the recall marks only the others", async () => {
    const o = await order(3);
    lots = o.lotCodes;
    await markPrinted(ids.operator, o.id);
    await voidLot(ids.operator, { lotCode: lots[2], reason: "Misprint" });
    await qcPass(lots[0]);
    await qcPass(lots[1]);
    const r = await batchReport(ids.hq, batchOf(lots[0]));
    expect(r.summary).toMatchObject({ lots: 3, void: 1, recallable: 2 });
  });

  it("no recall report for a batch that is not recalled", async () => {
    await expect(recallReport(ids.hq, batchOf(lots[0]))).rejects.toMatchObject({ status: 400, code: "NOT_RECALLED" });
  });

  it("only HQ may recall; the reason is required and bounded", async () => {
    const batchCode = batchOf(lots[0]);
    for (const who of ["rt1", "ss1", "admin", "operator"]) await expect(recall(ids[who], { batchCode, reason: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(recall(ids.hq, { batchCode, reason: "x".repeat(10_000) })).rejects.toThrow();
    await expect(recall(ids.hq, { batchCode: "Z".repeat(5_000), reason: "x" })).rejects.toThrow();
    await expect(recall(ids.hq, { batchCode, reason: "  " })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect((await store().batches.findOne({ code: batchCode }))?.status).toBe("ACTIVE");
  });

  it("the recall marks 2 lots and the report is then served", async () => {
    const r = await recall(ids.hq, { batchCode: batchOf(lots[0]), reason: "Label error", confirm: true });
    expect(r.items.filter((i) => i.status === "RECALLED")).toHaveLength(2);
    expect(r.items.find((i) => i.code === lots[2])).toMatchObject({ status: "VOID", statusBeforeRecall: null });
    await expect(recallReport(ids.hq, batchOf(lots[0]))).resolves.toMatchObject({ batch: { status: "RECALLED" } });
  });

  it("a voided code's public answer carries no product details", async () => {
    const pub = await publicLookup(lots[2]);
    expect(pub).toMatchObject({ registered: false, status: { label: "Unregistered code" } });
    expect(pub).not.toHaveProperty("flavour");
    expect(pub).not.toHaveProperty("batchCode");
    expect(pub).not.toHaveProperty("expiryDate");
  });

  it("a recall never overwrites RETURNED or VOID", () => {
    expect(recallPatch("RETURNED")).toBeNull();
    expect(recallPatch("VOID")).toBeNull();
    expect(recallPatch("AT_SS")).toEqual({ status: "RECALLED", statusBeforeRecall: "AT_SS" });
  });
});

describe("HQ search does not raise alerts (LOW-hq-search-alerts)", () => {
  it("a mistyped HQ search is audited without an alert; a failed receive still alerts", async () => {
    const bogus = "91ZZZZZZXX99991";
    expect(await lookup(ids.hq, bogus)).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
    expect(await store().scans.list({ context: "LOOKUP", code: bogus })).toHaveLength(1);
    expect((await alerts(ids.hq)).filter((a) => a.code === bogus)).toEqual([]);
    const field = "91ZZZZZZXX99992";
    expect(await receive(ids.ss1, { code: field })).toMatchObject({ ok: false, code: "UNKNOWN_CODE" });
    expect((await alerts(ids.hq)).filter((a) => a.code === field).map((a) => a.type)).toEqual(["UNKNOWN_CODE"]);
  });
});

describe("acknowledge, close and page alerts (REF-11)", () => {
  let lot = "";
  let alertId = "";
  it("only HQ may act on an alert (403 before anything is looked up)", async () => {
    [lot] = await printAndVerify(1);
    await toSS1([lot], "INV-G1");
    expect(await receive(ids.rt1, { code: lot })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    alertId = (await alerts(ids.hq)).find((a) => a.type === "WRONG_RECEIVER" && a.code === lot)!.id;
    for (const who of ["ss1", "admin", "rt1", "operator"]) {
      await expect(updateAlert(ids[who], { alertId, action: "ACKNOWLEDGE" })).rejects.toMatchObject({ status: 403 });
      await expect(alertPage(ids[who], {})).rejects.toMatchObject({ status: 403 });
    }
    await expect(updateAlert(null, { alertId, action: "ACKNOWLEDGE" })).rejects.toMatchObject({ status: 401 });
  });

  it("an acknowledged alert leaves the open list and the dashboard counts, and keeps who / when", async () => {
    const before = (await dashboard(ids.hq)).alertCounts.WRONG_RECEIVER ?? 0;
    const acked = await updateAlert(ids.hq, { alertId, action: "ACKNOWLEDGE", note: "Called the retailer" });
    expect(acked).toMatchObject({ id: alertId, state: "ACKNOWLEDGED", stateByName: expect.any(String), stateNote: "Called the retailer" });
    const open = await alertPage(ids.hq, { state: "OPEN", limit: 200 });
    expect(open.items.map((a) => a.id)).not.toContain(alertId);
    const d = await dashboard(ids.hq);
    expect(d.alertCounts.WRONG_RECEIVER ?? 0).toBe(before - 1);
    expect(d.recentAlerts.map((a) => a.id)).not.toContain(alertId);
    const all = await alertPage(ids.hq, { state: "ALL", limit: 200 });
    expect(all.items.find((a) => a.id === alertId)).toMatchObject({ state: "ACKNOWLEDGED", stateAt: expect.any(String) });
    expect((await alertPage(ids.hq, { state: "ACKNOWLEDGED" })).items.map((a) => a.id)).toEqual([alertId]);
  });

  it("close, reopen and wrong transitions; the full history is kept in the ledger", async () => {
    await expect(updateAlert(ids.hq, { alertId, action: "ACKNOWLEDGE" })).rejects.toMatchObject({ status: 400, code: "WRONG_STATE" });
    expect(await updateAlert(ids.hq, { alertId, action: "CLOSE" })).toMatchObject({ state: "CLOSED" });
    await expect(updateAlert(ids.hq, { alertId, action: "CLOSE" })).rejects.toMatchObject({ code: "WRONG_STATE" });
    const reopened = await updateAlert(ids.hq, { alertId, action: "REOPEN" });
    expect(reopened?.state).toBe("OPEN");
    expect(reopened?.history.map((h) => h.state)).toEqual(["ACKNOWLEDGED", "CLOSED", "OPEN"]);
    expect((await store().movements.list({ itemKind: "ALERT", itemCode: alertId })).map((m) => m.type)).toEqual(["ALERT_ACKNOWLEDGED", "ALERT_CLOSED", "ALERT_REOPENED"]);
    await expect(updateAlert(ids.hq, { alertId: "SC-nope", action: "CLOSE" })).rejects.toMatchObject({ status: 404 });
    await expect(updateAlert(ids.hq, { alertId, action: "DELETE" })).rejects.toThrow();
    await expect(updateAlert(ids.hq, { alertId, action: "CLOSE", note: "n".repeat(301) })).rejects.toThrow();
    // Alert actions never show in an item's trace.
    const t = await lookup(ids.hq, lot);
    if (!t.found) throw new Error("not found");
    expect(t.timeline.map((e) => e.event)).not.toContain("ALERT_ACKNOWLEDGED");
  });

  it("pages: limit and offset over the open alerts, with counts per state and type", async () => {
    const all = await alertPage(ids.hq, { state: "OPEN", limit: 200 });
    expect(all.total).toBeGreaterThanOrEqual(5);
    const page = await alertPage(ids.hq, { state: "OPEN", limit: 2, offset: 1 });
    expect(page).toMatchObject({ total: all.total, limit: 2, offset: 1 });
    expect(page.items.map((a) => a.id)).toEqual(all.items.slice(1, 3).map((a) => a.id));
    expect(page.counts.byState.ALL).toBe((await alerts(ids.hq)).length);
    const damaged = await alertPage(ids.hq, { state: "OPEN", type: "DAMAGED", limit: "200" });
    expect(damaged.items.every((a) => a.type === "DAMAGED")).toBe(true);
    expect(damaged.total).toBe(page.counts.byType.DAMAGED);
    await expect(alertPage(ids.hq, { limit: 500 })).rejects.toThrow();
    await expect(alertPage(ids.hq, { state: "SOMETHING" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- pure alert rules

const scan = (over: Partial<Scan>): Scan => ({ id: crypto.randomUUID(), at: "2026-11-04T10:00:00.000Z", context: "RECEIVE", code: "91AAAAAAOR00001", ok: false, result: "WRONG_RECEIVER", message: "m", userId: "RT0001", partnerId: "RT0001", deviceId: null, ...over });
const settings = { demoMode: false, demoThresholdMinutes: 5, notReceivedThresholdDays: 3 };

describe("alert rules (pure)", () => {
  it("HQ's own searches never alert; field scans do", () => {
    expect(alertWorthyScan(scan({ context: "LOOKUP", result: "UNKNOWN_CODE" }))).toBe(false);
    expect(alertWorthyScan(scan({ context: "RECEIVE", result: "UNKNOWN_CODE" }))).toBe(true);
    expect(alertWorthyScan(scan({ context: "RECEIVE", ok: true, result: "OK" }))).toBe(false);
  });

  it("7 failed receives of one code by one partner in one window are one alert with count 7", () => {
    const scans = Array.from({ length: 7 }, (_, i) => scan({ at: `2026-11-04T10:0${i}:00.000Z` }));
    const list = computeAlerts({ scans, inTransit: [], settings, now: new Date("2026-11-04T12:00:00Z") });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: `SC-${scans[0].id}`, count: 7, firstAt: scans[0].at, lastAt: scans[6].at, at: scans[6].at });
  });

  it("scans in another window, of another code or by another partner stay separate", () => {
    const scans = [scan({}), scan({ at: "2026-11-04T11:30:00.000Z" }), scan({ code: "91AAAAAAOR00002" }), scan({ partnerId: "RT0002" }), scan({ context: "DISPATCH" })];
    const list = collapseAlerts(
      scans.map((s): Alert => ({ id: `SC-${s.id}`, type: "WRONG_RECEIVER", at: s.at, code: s.code, message: "m", partnerId: s.partnerId, userId: s.userId })),
      scans,
    );
    expect(list).toHaveLength(5);
    expect(list.every((a) => a.count === undefined)).toBe(true);
  });

  it("NOT_RECEIVED ids are per dispatch: acknowledging one does not hide a later re-dispatch", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const unit = (dispatchedAt: string) => ({ kind: "LOT" as const, code: "91AAAAAAOR00001", fromId: "MF0001", toId: "SS0001", dispatchedAt });
    const first = computeAlerts({ scans: [], inTransit: [unit("2026-11-01T00:00:00.000Z")], settings, now });
    const second = computeAlerts({ scans: [], inTransit: [unit("2026-11-10T00:00:00.000Z")], settings, now });
    expect(first[0].id).not.toBe(second[0].id);
    const ack = [{ at: "2026-11-05T00:00:00.000Z", type: "ALERT_ACKNOWLEDGED" as const, itemCode: first[0].id, userId: "HQ0001", note: null }];
    expect(applyAlertState(first, ack)[0].state).toBe("ACKNOWLEDGED");
    expect(applyAlertState(second, ack)[0].state).toBe("OPEN");
  });

  it("an acknowledged group that gets a newer occurrence is open again", () => {
    const a: Alert = { id: "SC-1", type: "WRONG_RECEIVER", at: "2026-11-04T10:30:00.000Z", code: "c", message: "m", partnerId: null, userId: null, count: 3, lastAt: "2026-11-04T10:30:00.000Z" };
    const ack = { at: "2026-11-04T10:10:00.000Z", type: "ALERT_ACKNOWLEDGED" as const, itemCode: "SC-1", userId: "HQ0001", note: null };
    expect(applyAlertState([a], [ack])[0]).toMatchObject({ state: "OPEN", history: [{ state: "ACKNOWLEDGED" }] });
    expect(applyAlertState([{ ...a, lastAt: "2026-11-04T10:05:00.000Z" }], [ack])[0].state).toBe("ACKNOWLEDGED");
  });

  it("scanThrottle records up to max per window and counts the rest as suppressed", () => {
    const now = new Date("2026-11-04T10:10:00Z");
    const recent = Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-04T10:0${i % 10}:00.000Z` }));
    expect(scanThrottle(recent.slice(0, 3), now, { windowMs: 3_600_000, max: 10 })).toEqual({ record: true, suppressed: 0 });
    expect(scanThrottle(recent, now, { windowMs: 3_600_000, max: 10 })).toEqual({ record: false, suppressed: 2 });
    expect(scanThrottle([{ at: "2026-11-04T08:00:00.000Z" }], now, { windowMs: 3_600_000, max: 1 })).toEqual({ record: true, suppressed: 0 });
  });
});
