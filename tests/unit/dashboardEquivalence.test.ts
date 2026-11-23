// The HQ dashboard reads the live stock summary and targeted rows instead of every lot and pack. Its output must be
// IDENTICAL to the implementation it replaced, which is copied below verbatim as `referenceDashboard` (with the
// private helpers it used). A scenario through the services builds the datasets step by step — empty network,
// unprinted / unverified / quarantined / void lots, unsynced device lots, sealed stock, containers held at Customs and
// on the road, opened lots and loose packs at an SS, a DB and Retailers, damaged lots and packs (sealed and opened),
// recalled sealed, opened and in-transit lots, returns — and after every step both must be deep-equal.
// Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ALERT_ACTION_MOVEMENT_TYPES,
  applyAlertState,
  computeAlerts,
  computeCloneAlerts,
  computePublicSummaryAlerts,
  formatAge,
  ageMs,
  notReceivedThresholdMs,
  type Alert,
  type ComputeAlertsInput,
  type InTransitUnit,
} from "@/lib/core/alerts";
import { ITEM_STATUSES, PARTNER_TYPE_LABELS, type ItemStatus, type Lot, type Movement, type Pack, type Role, type Scan, type Settings } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { isVisible, loadActor, partnerName, requireAction } from "@/lib/services/common";
import { clearContainer, createContainer, dispatchContainer, loadContainer } from "@/lib/services/containers";
import { damagedCounts, damagedUnits, reportDamaged } from "@/lib/services/damage";
import { damagePhotoUrls } from "@/lib/services/damagePhotos";
import { dispatch, openLot, receive } from "@/lib/services/movement";
import { setDeviceOffline, voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { inspectReturn, takeBack } from "@/lib/services/returns";
import { attributedTo, dashboard, pendingCounts, recall, recalledCounts, stockCounts, updateAlert } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { photoOf } from "../fixtures/damagePhoto";
import { buildSampleSeed } from "../fixtures/sampleNetwork";
import { shipToCustoms } from "../fixtures/shipToCustoms";

// ---------------------------------------------------------------- reference: dashboard() as it was before
// Copied verbatim from src/lib/services/trace.ts (helpers it used that are private there are copied too).

const uniqueIds = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))];

async function names(tx: StoreTx, only?: { partners: (string | null | undefined)[]; users: (string | null | undefined)[]; devices: (string | null | undefined)[] }) {
  const [partners, users, devices, flavours] = await Promise.all([
    tx.partners.list(only && { id: uniqueIds(only.partners) }),
    tx.users.list(only && { id: uniqueIds(only.users) }),
    tx.devices.list(only && { id: uniqueIds(only.devices) }),
    tx.flavours.list(),
  ]);
  return {
    partners,
    partner: (id: string | null | undefined) => partnerName(partners, id),
    user: (id: string | null | undefined) => (id ? users.find((u) => u.id === id)?.name ?? id : null),
    device: (id: string | null | undefined) => (id ? devices.find((d) => d.id === id)?.name ?? id : null),
    flavour: (code: string) => flavours.find((f) => f.code === code)?.name ?? code,
  };
}

async function visibleItems(tx: StoreTx) {
  const lots = (await tx.lots.list()).filter((l) => isVisible(l, null));
  const lotByCode = new Map(lots.map((l) => [l.lotCode, l]));
  const packs = (await tx.packs.list()).filter((p) => lotByCode.has(p.lotCode));
  return { lots, packs, lotByCode };
}

function inTransitUnits(lots: Lot[], packs: Pack[], lotByCode: Map<string, Lot>): InTransitUnit[] {
  const units: InTransitUnit[] = [];
  for (const l of lots) {
    if (l.status === "IN_TRANSIT" && l.dispatchedAt) units.push({ kind: "LOT", code: l.lotCode, fromId: l.locationId, toId: l.inTransitToId!, dispatchedAt: l.dispatchedAt });
  }
  for (const p of packs) {
    if (p.status === "IN_TRANSIT" && p.dispatchedAt && lotByCode.get(p.lotCode)?.status === "OPENED") {
      units.push({ kind: "PACK", code: p.packCode, fromId: p.locationId, toId: p.inTransitToId!, dispatchedAt: p.dispatchedAt });
    }
  }
  return units;
}

const visibleDamage = (damaged: Movement[], lotByCode: Map<string, Lot>) => damaged.filter((m) => lotByCode.has(m.itemCode.slice(0, 15)));

type AlertSources = Omit<ComputeAlertsInput, "now" | "settings"> & { settings: Settings; publicOkScans: Scan[] };

async function namedAlerts(tx: StoreTx, input: AlertSources) {
  const now = new Date();
  const publicScans = [...input.scans.filter((s) => s.context === "PUBLIC_LOOKUP"), ...input.publicOkScans];
  const list: Alert[] = [...computeAlerts({ ...input, now }), ...computeCloneAlerts(publicScans, input.settings, now), ...computePublicSummaryAlerts(publicScans, now)].sort(
    (a, b) => b.at.localeCompare(a.at),
  );
  const actions = await tx.movements.list({ type: ALERT_ACTION_MOVEMENT_TYPES, itemKind: "ALERT" });
  const n = await names(tx, { partners: list.map((a) => a.partnerId), users: [...list.map((a) => a.userId), ...actions.map((m) => m.userId)], devices: [] });
  const reportId = (a: { id: string; type: string }) => (a.type === "DAMAGED" && a.id.startsWith("DM-") ? a.id.slice(3) : null);
  const photos = await damagePhotoUrls(list.flatMap((a) => reportId(a) ?? []));
  return applyAlertState(list, actions).map((a) => ({
    ...a,
    partner: n.partner(a.partnerId),
    user: n.user(a.userId),
    stateByName: n.user(a.stateBy),
    history: a.history.map((h) => ({ ...h, user: n.user(h.userId) })),
    photoUrls: (reportId(a) && photos.get(reportId(a)!)) || [],
  }));
}

const alertScans = (store: StoreTx) => Promise.all([store.scans.list({ ok: false }), store.scans.list({ context: "PUBLIC_LOOKUP", ok: true })]);

async function referenceDashboard(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const { lots, packs, lotByCode } = await visibleItems(store);
  const [settings, damageReports, [failedScans, publicOkScans]] = await Promise.all([store.getSettings(), store.movements.list({ type: "DAMAGED" }), alertScans(store)]);
  const n = await names(store);
  const now = new Date();
  const damaged = damagedUnits(lots, packs, damageReports);

  const countBy = (rows: { status: ItemStatus }[]) => {
    const counts = new Map<ItemStatus, number>();
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return Object.fromEntries(ITEM_STATUSES.filter((s) => counts.has(s)).map((s) => [s, counts.get(s)!])) as Record<string, number>;
  };

  const lotsAt = Map.groupBy(lots, (l) => l.locationId);
  const packsAt = Map.groupBy(packs, (p) => p.locationId);
  const damagedAt = Map.groupBy(damaged, (u) => u.partnerId);
  const recalledLotsAt = Map.groupBy(
    lots.filter((l) => l.status === "RECALLED"),
    attributedTo,
  );
  const recalledPacksAt = Map.groupBy(
    packs.filter((p) => p.status === "RECALLED"),
    attributedTo,
  );
  const stock = n.partners
    .map((p) => {
      const c = stockCounts(p.id, lotsAt.get(p.id) ?? [], packsAt.get(p.id) ?? [], lotByCode);
      const d = damagedCounts(damagedAt.get(p.id) ?? []);
      const r = recalledCounts(p.id, recalledLotsAt.get(p.id) ?? [], recalledPacksAt.get(p.id) ?? [], lotByCode);
      return { partnerId: p.id, partner: p.name, tier: p.type, tierLabel: PARTNER_TYPE_LABELS[p.type], ...c, damaged: d, recalled: r, ...pendingCounts(p.id, lotsAt.get(p.id) ?? []) };
    })
    .filter((s) => s.cases || s.trays || s.loosePacks || s.damaged.cases || s.damaged.trays || s.damaged.packs || s.recalled.cases || s.recalled.trays || s.recalled.packs || s.awaitingPrint || s.awaitingQc || s.quarantined);

  const threshold = notReceivedThresholdMs(settings);
  const units = inTransitUnits(lots, packs, lotByCode);
  const inTransit = units
    .map((u) => ({ ...u, from: n.partner(u.fromId), to: n.partner(u.toId), age: formatAge(ageMs(u.dispatchedAt, now)), overdue: ageMs(u.dispatchedAt, now) > threshold }))
    .sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));

  const allAlerts = await namedAlerts(store, { scans: failedScans, publicOkScans, inTransit: units, damageReports: visibleDamage(damageReports, lotByCode), settings });
  const openAlerts = allAlerts.filter((a) => a.state === "OPEN");
  const alertCounts = openAlerts.reduce<Record<string, number>>((acc, a) => ((acc[a.type] = (acc[a.type] ?? 0) + 1), acc), {});
  const unsyncedLots = (await store.lots.list({ synced: false })).length;

  return {
    lotCounts: countBy(lots),
    packCounts: countBy(packs),
    totals: { lots: lots.length, packs: packs.length, batches: (await store.batches.list({ synced: true })).length, unsyncedLots },
    stock,
    inTransit,
    alertCounts,
    recentAlerts: openAlerts.slice(0, 10),
    threshold: { ms: threshold, label: formatAge(threshold), demoMode: settings.demoMode },
  };
}

// ---------------------------------------------------------------- scenario

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
const lots: Record<string, string[]> = {};

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
async function partner(prefix: string) {
  return (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;
}
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
async function verifyLot(lotCode: string) {
  const packs = await packsOf(lotCode);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
  expect(await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs })).toMatchObject({ ok: true });
}
async function order(cases: number, trays: number, flavour = "OR") {
  const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour, mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays }] });
  if (created.preview) throw new Error("expected a created order");
  return created.printOrder;
}
const send = async (from: string, to: string, invoice: string, codes: string[]) =>
  expect(await dispatch(from, { action: "confirm", toPartnerId: to, invoice, codes })).toMatchObject({ ok: true });
const take = async (who: string, codes: string[]) => {
  for (const code of codes) expect(await receive(who, { code })).toMatchObject({ ok: true });
};
const byType = async (codes: string[]) => {
  const rows = await store().lots.list({ lotCode: codes });
  return { cases: rows.filter((l) => l.lotType === "CASE").map((l) => l.lotCode).sort(), trays: rows.filter((l) => l.lotType === "TRAY").map((l) => l.lotCode).sort() };
};

/** Both implementations at one frozen instant (ages and overdue flags depend on the clock): deep-equal. */
async function same() {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
  try {
    const expected = await referenceDashboard(ids.hq);
    const actual = await dashboard(ids.hq);
    expect(actual).toEqual(expected);
    // Same keys in the same order too (the screen renders the status counts in this order).
    expect(Object.keys(actual.lotCounts)).toEqual(Object.keys(expected.lotCounts));
    expect(Object.keys(actual.packCounts)).toEqual(Object.keys(expected.packCounts));
    return actual;
  } finally {
    vi.useRealTimers();
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-dash-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  ids.op = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.vw = await user("WAREHOUSE");
  ids.ss1 = await user("SS", "SS-1");
  ids.ss2 = await user("SS", "SS-2");
  ids.db1 = await user("DB", "DB-1");
  ids.rt1 = await user("RETAILER", "Retailer-1");
  ids.rt2 = await user("RETAILER", "Retailer-2");
  ids.rt4 = await user("RETAILER", "Retailer-4");
  ids.hq = await user("TRACE_OWNER");
  ids.VW = await partner("VW-1");
  ids.SS1 = await partner("SS-1");
  ids.SS2 = await partner("SS-2");
  ids.DB1 = await partner("DB-1");
  ids.RT1 = await partner("Retailer-1");
  ids.RT2 = await partner("Retailer-2");
  ids.RT4 = await partner("Retailer-4");
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

describe("dashboard() = the reference implementation, step by step", () => {
  it("0. the sample network with no activity", async () => {
    const d = await same();
    expect(d.stock).toEqual([]);
  });

  it("1. at the plant: unprinted, printed, packed, quarantined and void lots", async () => {
    const a = await order(4, 3); // A: verified stock for the chain
    await markPrinted(ids.op, a.id);
    lots.A = a.lotCodes;
    for (const code of a.lotCodes) await verifyLot(code);
    const b = await order(3, 0); // B: one packed, one quarantined, one void (printed, not verified)
    await markPrinted(ids.op, b.id);
    lots.B = b.lotCodes;
    await verifyLot(b.lotCodes[0]);
    expect(await verify(ids.qc, { action: "confirm", lotCode: b.lotCodes[1], packCodes: [`${b.lotCodes[1]}61`] })).toMatchObject({ code: "QUARANTINED" });
    expect(await voidLot(ids.op, { lotCode: b.lotCodes[2], reason: "misprint" })).toMatchObject({ ok: true });
    lots.C = (await order(1, 1, "GA")).lotCodes; // C: generated, never printed
    const pr = await order(1, 0, "NS"); // printed, awaiting QC
    await markPrinted(ids.op, pr.id);
    lots.P = pr.lotCodes;
    const d = await same();
    expect(d.stock.find((s) => s.tier === "MANUFACTURER")).toMatchObject({ awaitingPrint: 2, awaitingQc: 1, quarantined: 1 });
  });

  it("2. an offline device's lots (unsynced: only counted as unsynced, invisible elsewhere)", async () => {
    const device = (await store().devices.list())[0];
    await setDeviceOffline(ids.op, device.id, { offline: true });
    const off = await order(1, 1, "MN");
    await markPrinted(ids.op, off.id);
    lots.OFF = off.lotCodes;
    await verifyLot(off.lotCodes[0]);
    const d = await same();
    expect(d.totals.unsyncedLots).toBe(2);
  });

  it("3. containers: one cleared at Customs, one held there (AT_CUSTOMS), one still on the road", async () => {
    const { cases, trays } = await byType(lots.A);
    lots.cases = cases;
    lots.trays = trays;
    await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: [...cases.slice(0, 3), ...trays.slice(0, 2)], invoice: "INV-D1" });
    await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: [cases[3]], invoice: "INV-D2", clear: false });
    await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: [trays[2], lots.B[0]], invoice: "INV-D3", receive: false });
    const d = await same();
    expect(d.inTransit).toHaveLength(2);
  });

  it("4. onward: sealed stock at SS-1 and SS-2, a tray opened at DB-1 with packs to Retailers, a case opened at SS-1", async () => {
    const { cases, trays } = lots as { cases: string[]; trays: string[] };
    await send(ids.vw, ids.SS1, "INV-D4", [cases[0], cases[1], trays[0], trays[1]]);
    await take(ids.ss1, [cases[0], cases[1], trays[0], trays[1]]);
    await send(ids.vw, ids.SS2, "INV-D5", [cases[2]]); // on its way to SS-2
    await send(ids.ss1, ids.DB1, "INV-D6", [trays[0], cases[1]]);
    await take(ids.db1, [trays[0], cases[1]]);
    expect(await openLot(ids.db1, { lotCode: trays[0] })).toMatchObject({ ok: true });
    const t0 = await packsOf(trays[0]);
    await send(ids.db1, ids.RT1, "INV-D7", t0.slice(0, 2));
    await take(ids.rt1, t0.slice(0, 1)); // one received, one still on the way
    await send(ids.db1, ids.RT2, "INV-D8", t0.slice(2, 4));
    await take(ids.rt2, t0.slice(2, 4));
    expect(await openLot(ids.rt2, { lotCode: cases[1] })).toMatchObject({ ok: false, code: "NOT_AT_LOCATION" });
    await send(ids.db1, ids.RT2, "INV-D9", [cases[1]]);
    await take(ids.rt2, [cases[1]]);
    expect(await openLot(ids.rt2, { lotCode: cases[1] })).toMatchObject({ ok: true }); // opened at a Retailer
    expect(await openLot(ids.ss1, { lotCode: cases[0] })).toMatchObject({ ok: true });
    const c0 = await packsOf(cases[0]);
    await send(ids.ss1, ids.RT4, "INV-D10", c0.slice(0, 2));
    await take(ids.rt4, c0.slice(0, 2));
    const d = await same();
    expect(d.stock.find((s) => s.partnerId === ids.DB1)).toMatchObject({ trays: 1, openedTrays: 1, loosePacks: 2 });
    expect(d.stock.find((s) => s.partnerId === ids.RT2)).toMatchObject({ cases: 1, openedCases: 1, loosePacks: 6 });
  });

  it("5. damage: a sealed tray at SS-1, a loose pack at DB-1, an opened case reported whole at Retailer-2", async () => {
    const { cases, trays } = lots as { cases: string[]; trays: string[] };
    expect(await reportDamaged(ids.ss1, { code: trays[1], reason: "Crushed", ...photoOf(trays[1]) })).toMatchObject({ ok: true });
    const [, , , , t0p5] = await packsOf(trays[0]);
    expect(await reportDamaged(ids.db1, { code: t0p5, reason: "Leaking", ...photoOf(t0p5) })).toMatchObject({ ok: true });
    expect(await reportDamaged(ids.rt2, { code: cases[1], reason: "Water damage", ...photoOf(cases[1]) })).toMatchObject({ ok: true });
    const d = await same();
    expect(d.stock.find((s) => s.partnerId === ids.SS1)?.damaged).toEqual({ cases: 0, trays: 1, packs: 0 });
    expect(d.stock.find((s) => s.partnerId === ids.DB1)?.damaged).toEqual({ cases: 0, trays: 0, packs: 1 });
    expect(d.stock.find((s) => s.partnerId === ids.RT2)?.damaged).toEqual({ cases: 1, trays: 0, packs: 0 });
  });

  it("6. HQ acknowledges an alert; failed scans raise more", async () => {
    await receive(ids.rt1, { code: "91ZZZZZZOR00001" }); // unknown code
    await receive(ids.rt4, { code: lots.cases[2] }); // in transit to SS-2, not to Retailer-4
    const first = (await dashboard(ids.hq)).recentAlerts[0];
    await updateAlert(ids.hq, { alertId: first.id, action: "ACKNOWLEDGE", note: "checking" });
    await same();
  });

  it("7. recall: batch A (sealed, opened, damaged and in-transit units) and batch B", async () => {
    const batchA = lots.A[0].slice(2, 8);
    await recall(ids.hq, { batchCode: batchA, reason: "Seal defect" });
    const d = await same();
    expect(d.lotCounts.RECALLED).toBeGreaterThan(0);
    expect(d.stock.some((s) => s.recalled.cases || s.recalled.trays || s.recalled.packs)).toBe(true);
    await recall(ids.hq, { batchCode: lots.B[0].slice(2, 8), reason: "Second recall" });
    await same();
  });

  it("8. the offline device comes back and syncs: its lots become visible", async () => {
    const device = (await store().devices.list())[0];
    await setDeviceOffline(ids.op, device.id, { offline: false });
    const { sync } = await import("@/lib/services/operator");
    await sync(ids.op, {});
    const d = await same();
    expect(d.totals.unsyncedLots).toBe(0);
  });

  it("9. returns: packs taken back from a Retailer (opening its case), received and inspected at Customs", async () => {
    const fresh = await order(1, 0, "OR");
    await markPrinted(ids.op, fresh.id);
    const [c] = fresh.lotCodes;
    await verifyLot(c);
    await shipToCustoms({ operatorId: ids.op, customsUserId: ids.vw, customsId: ids.VW, lotCodes: [c], invoice: "INV-D11" });
    await send(ids.vw, ids.SS1, "INV-D12", [c]);
    await take(ids.ss1, [c]);
    await send(ids.ss1, ids.RT4, "INV-D13", [c]);
    await take(ids.rt4, [c]);
    const [p1, p2] = await packsOf(c);
    expect(await takeBack("VF0001", { code: p1, reason: "NOT_SELLING" })).toMatchObject({ ok: true }); // opens the case at Retailer-4
    expect(await takeBack("VF0001", { code: p2, reason: "DAMAGED" })).toMatchObject({ ok: true });
    await same();
    await receive(ids.vw, { code: p1 });
    await inspectReturn(ids.vw, { code: p1, decision: "BACK_TO_STOCK" });
    await same();
  });

  it("10. a container dispatched straight to the dashboard's in-transit list, then received", async () => {
    const more = await order(0, 2, "GA");
    await markPrinted(ids.op, more.id);
    for (const code of more.lotCodes) await verifyLot(code);
    const { container } = await createContainer(ids.op, { code: "DASH0000001" });
    for (const code of more.lotCodes) await loadContainer(ids.op, container.id, { code });
    await dispatchContainer(ids.op, container.id, { toPartnerId: ids.VW, invoice: "INV-D14" });
    await same();
    await receive(ids.vw, { code: "DASH0000001" });
    await clearContainer(ids.vw, container.id, {});
    await same();
  });
});
