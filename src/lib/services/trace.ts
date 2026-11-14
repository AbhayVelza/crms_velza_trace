// HQ traceability: search + timeline, public lookup, dashboard, alerts, stock, batch report, recall.

import { z } from "zod";
import {
  ALERT_ACTION_MOVEMENT,
  ALERT_ACTION_MOVEMENT_TYPES,
  ALERT_ACTIONS,
  ALERT_STATES,
  ALERT_TYPES,
  applyAlertState,
  canApplyAlertAction,
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
import { batchCounter } from "@/lib/core/codes";
import { recallPatch } from "@/lib/core/rules";
import { ITEM_STATUSES, PARTNER_TYPE_LABELS, type ItemStatus, type Lot, type Movement, type Pack, type Partner, type Scan, type Settings } from "@/lib/core/types";
import { MAX_SCAN_INPUT, normalizeScannedCode } from "@/lib/scan/normalize";
import { getStore, type StoreTx } from "@/lib/store";
import { damagedCounts, damagedUnits, wasOpened } from "./damage";
import { damagePhotoUrls } from "./damagePhotos";
import { badRequest, findItem, isVisible, loadActor, logScan, notFound, nowIso, partnerName, requireAction, requirePartner } from "./common";
import { batchDisplayStatus } from "./printOrders";
import { publicCheck } from "./verify";

export const recallSchema = z.object({
  batchCode: z.string().max(20),
  reason: z.string().max(300),
  /** Sent by the HQ screen after its "This cannot be undone" step. Optional for API clients (see business_decisions). */
  confirm: z.boolean().optional(),
});

/** Longest input taken from a scanner / QR link / URL before it is cleaned (the scan screens' limit). */
const MAX_RAW_CODE = MAX_SCAN_INPUT;
/** Longest code written to the scan audit: real codes are 15 or 17 characters. */
const MAX_LOGGED_CODE = 64;
const cleanCode = (raw: string) => normalizeScannedCode(String(raw ?? "").slice(0, MAX_RAW_CODE)).slice(0, MAX_LOGGED_CODE);

/** Sellable stock: QC-passed at the plant (PACKED) and received down the chain. Everything else is not stock. */
export const SELLABLE_STATUSES: readonly ItemStatus[] = ["PACKED", "AT_WAREHOUSE", "AT_SS", "AT_DB", "AT_RETAILER"];
const sellable = (s: ItemStatus) => SELLABLE_STATUSES.includes(s);

type Placed = { status: ItemStatus; statusBeforeRecall: ItemStatus | null; locationId: string; inTransitToId: string | null };
/** Where a unit is held: one recalled while in transit belongs to its receiver (the sender no longer has it). */
export function attributedTo(x: Placed): string {
  return x.status === "RECALLED" && x.statusBeforeRecall === "IN_TRANSIT" && x.inTransitToId ? x.inTransitToId : x.locationId;
}

type Ids = (string | null | undefined)[];
const uniqueIds = (ids: Ids) => [...new Set(ids.filter((x): x is string => !!x))];

/** Display names. `only` reads just the partners, users and devices a response refers to (one query each). */
async function names(tx: StoreTx, only?: { partners: Ids; users: Ids; devices: Ids }) {
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

/** The batch's flavour first, then any other flavours its continued lots use: "Original, Green Apple". */
function flavoursLabel(batch: { flavour: string }, lots: { flavour: string }[], name: (code: string) => string) {
  return [...new Set([batch.flavour, ...lots.map((l) => l.flavour)])].map(name).join(", ");
}

function locationLabel(partners: Partner[], item: { status: ItemStatus; statusBeforeRecall?: ItemStatus | null; locationId: string; inTransitToId: string | null }) {
  const at = partnerName(partners, item.locationId);
  if (item.status === "IN_TRANSIT") return `In transit: ${at} → ${partnerName(partners, item.inTransitToId)}`;
  if (item.status === "RECALLED" && item.statusBeforeRecall === "IN_TRANSIT") return `Recalled in transit: ${at} → ${partnerName(partners, item.inTransitToId)}`;
  return at ?? "—";
}

// ---------------------------------------------------------------- search

/** Timeline order: by time; at the same instant batch events, then lot, then pack (insertion order after that). */
const KIND_ORDER: Record<string, number> = { BATCH: 0, LOT: 1, PACK: 2 };
export const timelineOrder = (a: Pick<Movement, "at" | "itemKind">, b: Pick<Movement, "at" | "itemKind">) =>
  a.at.localeCompare(b.at) || (KIND_ORDER[a.itemKind] ?? 9) - (KIND_ORDER[b.itemKind] ?? 9);

export async function lookup(userId: string | null, rawCode: string) {
  const code = cleanCode(rawCode);
  // Reads see the latest committed data; the audit scan is then appended on its own (one short transaction).
  // In one serializable transaction, concurrent lookups of a code each read the history the others append
  // their scan to, and PostgreSQL aborted them (serialization failures under load, DEF-002 re-test).
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "search");
  const found = await findItem(store, code, actor.partner?.id ?? null);
  if (!found.ok) {
    await logScan(store, { context: "LOOKUP", code, actor, ok: false, result: found.code, message: found.message });
    return { found: false as const, code, result: found.code, message: found.message };
  }
  const { item } = found;
  const batch = await store.batches.findOne({ code: item.lot.batchCode });
  const codes = item.kind === "LOT" ? [item.lot.lotCode] : [item.lot.lotCode, item.pack!.packCode];
  // An opened lot's own history includes what happened to its packs since (single-pack damage, pack moves).
  const packs = await store.packs.list({ lotCode: item.lot.lotCode });
  const packCodes = item.kind === "LOT" && wasOpened(item.lot) ? packs.map((p) => p.packCode) : [];
  // This item's history only (its lot, its pack, batch-wide events such as a recall), never the whole ledger.
  const [itemMoves, batchMoves, reprints] = await Promise.all([
    store.movements.list({ itemCode: [...codes, ...packCodes] }),
    store.movements.list({ itemKind: "BATCH", itemCode: item.lot.batchCode }),
    store.reprints.list({ code: codes }),
  ]);
  const movements = [...itemMoves.filter((m) => m.itemKind !== "ALERT"), ...batchMoves];
  const at = (x: { locationId: string | null; inTransitToId: string | null }) => [x.locationId, x.inTransitToId];
  const n = await names(store, {
    partners: [...movements.flatMap((m) => [m.fromId, m.toId]), ...at(item.lot), ...(item.pack ? at(item.pack) : []), ...packs.flatMap(at), batch?.manufacturerId],
    users: [...movements.map((m) => m.userId), ...reprints.map((r) => r.userId)],
    devices: movements.map((m) => m.deviceId),
  });
  const timeline = movements
    .sort(timelineOrder)
    .map((m: Movement) => ({
      at: m.at,
      event: m.type,
      itemCode: m.itemCode,
      itemKind: m.itemKind,
      from: n.partner(m.fromId),
      to: n.partner(m.toId),
      fromStatus: m.fromStatus,
      toStatus: m.toStatus,
      user: n.user(m.userId),
      device: n.device(m.deviceId),
      invoice: m.invoice,
      note: m.note,
    }));
  const current = item.kind === "LOT" ? item.lot : item.pack!;
  await logScan(store, { context: "LOOKUP", code, actor, ok: true, result: "OK", message: `${item.kind} ${current.status}` });
  return {
    found: true as const,
    code,
    kind: item.kind,
    status: current.status,
    location: locationLabel(n.partners, current),
    locationTier: n.partners.find((p) => p.id === current.locationId)?.type ?? null,
    quarantineReason: item.lot.quarantineReason,
    batch: batch && {
      code: batch.code,
      // The lot's own flavour: a continued batch may hold lots of several flavours.
      flavour: n.flavour(item.lot.flavour),
      mfgDate: batch.mfgDate,
      expiryDate: batch.expiryDate,
      status: batch.status,
      manufacturer: n.partner(batch.manufacturerId),
    },
    parent:
      item.kind === "PACK"
        ? { code: item.lot.lotCode, status: item.lot.status, lotType: item.lot.lotType, location: locationLabel(n.partners, item.lot) }
        : null,
    lot: { code: item.lot.lotCode, lotType: item.lot.lotType, packSize: item.lot.packSize },
    children:
      item.kind === "LOT"
        ? packs.sort((a, b) => a.seq - b.seq).map((p) => ({ code: p.packCode, seq: p.seq, status: p.status, location: locationLabel(n.partners, p) }))
        : [],
    timeline,
    reprints: reprints.map((r) => ({ ...r, userName: n.user(r.userId) })),
  };
}

/**
 * Public QR page: safe fields only, no partners, invoices or history. One implementation for the live route and
 * the tests: verify.ts publicCheck (junk input not logged, one log per client per repeat window, VOID shows nothing,
 * public result codes that never raise a per-scan HQ alert). `clientKey` is the caller's IP (route), never stored.
 */
export async function publicLookup(rawCode: string, opts: { clientKey?: string | null } = {}) {
  return publicCheck(rawCode, opts);
}

// ---------------------------------------------------------------- dashboard & alerts

async function visibleItems(tx: StoreTx) {
  const lots = (await tx.lots.list()).filter((l) => isVisible(l, null));
  const lotByCode = new Map(lots.map((l) => [l.lotCode, l]));
  const packs = (await tx.packs.list()).filter((p) => lotByCode.has(p.lotCode));
  return { lots, packs, lotByCode };
}

/** Units moving on their own: lots, and packs of opened lots. */
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

/** Only damage on synced (visible) lots; the code's first 15 characters are its lot code. */
const visibleDamage = (damaged: Movement[], lotByCode: Map<string, Lot>) => damaged.filter((m) => lotByCode.has(m.itemCode.slice(0, 15)));

type AlertSources = Omit<ComputeAlertsInput, "now" | "settings"> & {
  settings: Settings;
  /** Public-page scans that found a registered code (ok), for the copied-sticker check; failed ones are in `scans`. */
  publicOkScans: Scan[];
};

/**
 * Every alert, newest first, with its state (OPEN / ACKNOWLEDGED / CLOSED, from HQ's ALERT_* ledger rows) and names.
 * Field alerts (computeAlerts) plus the aggregated public-page alerts (copied stickers, unknown / blocked codes).
 */
async function namedAlerts(tx: StoreTx, input: AlertSources) {
  const now = new Date();
  const publicScans = [...input.scans.filter((s) => s.context === "PUBLIC_LOOKUP"), ...input.publicOkScans];
  const list: Alert[] = [...computeAlerts({ ...input, now }), ...computeCloneAlerts(publicScans, input.settings, now), ...computePublicSummaryAlerts(publicScans, now)].sort(
    (a, b) => b.at.localeCompare(a.at),
  );
  const actions = await tx.movements.list({ type: ALERT_ACTION_MOVEMENT_TYPES, itemKind: "ALERT" });
  const n = await names(tx, { partners: list.map((a) => a.partnerId), users: [...list.map((a) => a.userId), ...actions.map((m) => m.userId)], devices: [] });
  // A damage alert's id is "DM-<report id>"; its photos are served by /api/damaged/photo/<report id>.
  const reportId = (a: { id: string; type: string }) => (a.type === "DAMAGED" && a.id.startsWith("DM-") ? a.id.slice(3) : null);
  const photos = await damagePhotoUrls(list.flatMap((a) => reportId(a) ?? []));
  return applyAlertState(list, actions).map((a) => ({
    ...a,
    partner: n.partner(a.partnerId),
    user: n.user(a.userId),
    stateByName: n.user(a.stateBy),
    history: a.history.map((h) => ({ ...h, user: n.user(h.userId) })),
    // Damage alerts: the barcode photo first, then the extra photos of the damage.
    photoUrls: (reportId(a) && photos.get(reportId(a)!)) || [],
  }));
}

/** The scan rows alerts are computed from: failed scans, and successful public-page scans (copied-sticker check). */
const alertScans = (store: StoreTx) => Promise.all([store.scans.list({ ok: false }), store.scans.list({ context: "PUBLIC_LOOKUP", ok: true })]);

export async function alerts(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  // Only what can raise an alert: units in transit, failed scans and damage reports — not every lot and pack.
  const [lots, packs, [scans, publicOkScans], settings, damaged] = await Promise.all([
    store.lots.list({ status: "IN_TRANSIT", synced: true }),
    store.packs.list({ status: "IN_TRANSIT" }),
    alertScans(store),
    store.getSettings(),
    store.movements.list({ type: "DAMAGED" }),
  ]);
  // The visible lots those packs and damage reports belong to.
  const related = await store.lots.list({ lotCode: uniqueIds([...packs.map((p) => p.lotCode), ...damaged.map((m) => m.itemCode.slice(0, 15))]), synced: true });
  const lotByCode = new Map(related.map((l) => [l.lotCode, l]));
  return namedAlerts(store, { scans, publicOkScans, inTransit: inTransitUnits(lots, packs, lotByCode), damageReports: visibleDamage(damaged, lotByCode), settings });
}

export const alertQuerySchema = z.object({
  state: z.enum([...ALERT_STATES, "ALL"]).default("OPEN"),
  type: z.enum(ALERT_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** One page of alerts in a state (default OPEN), optionally of one type, with counts per state and per type. */
export async function alertPage(userId: string | null, query: unknown) {
  const store = getStore();
  requireAction(await loadActor(store, userId), "dashboard");
  const q = alertQuerySchema.parse(query);
  const all = await alerts(userId);
  const inState = all.filter((a) => q.state === "ALL" || a.state === q.state);
  const items = inState.filter((a) => !q.type || a.type === q.type);
  const tally = (rows: { type: string; state: string }[], key: "type" | "state") => rows.reduce<Record<string, number>>((acc, a) => ((acc[a[key]] = (acc[a[key]] ?? 0) + 1), acc), {});
  return {
    items: items.slice(q.offset, q.offset + q.limit),
    total: items.length,
    limit: q.limit,
    offset: q.offset,
    state: q.state,
    type: q.type ?? null,
    counts: { byState: { ...tally(all, "state"), ALL: all.length }, byType: tally(inState, "type") },
  };
}

export const alertActionSchema = z.object({
  alertId: z.string().trim().min(1).max(200),
  action: z.enum(ALERT_ACTIONS),
  note: z.string().max(300).optional(),
});

/**
 * HQ acknowledges, closes or reopens an alert. Alerts stay computed; the action is appended to the ledger
 * (never changed or deleted), so the history of who did what is kept. HQ only.
 */
export async function updateAlert(userId: string | null, body: unknown) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const { alertId, action, note } = alertActionSchema.parse(body);
  const current = (await alerts(userId)).find((a) => a.id === alertId);
  if (!current) throw notFound(`Alert ${alertId}`);
  if (!canApplyAlertAction(current.state, action)) throw badRequest("WRONG_STATE", `Alert ${alertId} is ${current.state.toLowerCase()}; it cannot be ${ALERT_ACTION_MOVEMENT[action].slice(6).toLowerCase()}`);
  await store.transaction((tx) =>
    tx.appendMovement({
      type: ALERT_ACTION_MOVEMENT[action],
      itemKind: "ALERT",
      itemCode: alertId,
      fromId: current.partnerId,
      toId: null,
      fromStatus: null,
      toStatus: null,
      userId: actor.user.id,
      deviceId: null,
      invoice: null,
      note: note?.trim() || null,
    }),
  );
  return (await alerts(userId)).find((a) => a.id === alertId) ?? null;
}

/**
 * Sellable cases and trays held at a location, opened or not: an opened one counts where it was opened while any
 * of its packs is still in stock there. Loose packs are the packs of opened lots in stock there. Only QC-passed
 * and received stock counts (SELLABLE_STATUSES): not recalled, quarantined, unverified, damaged or returned units.
 */
export function stockCounts(partnerId: string, lots: Lot[], packs: Pack[], lotByCode: Map<string, Lot>) {
  const loose = packs.filter((pk) => pk.locationId === partnerId && lotByCode.get(pk.lotCode)?.status === "OPENED" && sellable(pk.status));
  const withPacksHere = new Set(loose.map((pk) => pk.lotCode));
  const here = lots.filter((l) => l.locationId === partnerId);
  const sealed = here.filter((l) => sellable(l.status));
  const opened = here.filter((l) => l.status === "OPENED" && withPacksHere.has(l.lotCode));
  const count = (ls: Lot[], t: Lot["lotType"]) => ls.filter((l) => l.lotType === t).length;
  return {
    cases: count(sealed, "CASE") + count(opened, "CASE"),
    trays: count(sealed, "TRAY") + count(opened, "TRAY"),
    openedCases: count(opened, "CASE"),
    openedTrays: count(opened, "TRAY"),
    loosePacks: loose.length,
  };
}

/** A recalled lot held whole (not opened, not damaged: those are counted by their packs / in Damaged). */
const recalledWhole = (l: Lot) => l.status === "RECALLED" && l.statusBeforeRecall !== "OPENED" && l.statusBeforeRecall !== "DAMAGED";
/** A recalled pack of a lot recalled after it was opened (not one already damaged). */
const recalledLoose = (p: Pack, lotByCode: Map<string, Lot>) => {
  const lot = lotByCode.get(p.lotCode);
  return p.status === "RECALLED" && p.statusBeforeRecall !== "DAMAGED" && lot?.status === "RECALLED" && lot.statusBeforeRecall === "OPENED";
};

/**
 * Recalled stock held at a location (do not sell): whole cases / trays, and loose packs of opened ones. A unit
 * recalled while in transit is held by its receiver (attributedTo).
 */
export function recalledCounts(partnerId: string, lots: Lot[], packs: Pack[], lotByCode: Map<string, Lot>) {
  const whole = lots.filter((l) => recalledWhole(l) && attributedTo(l) === partnerId);
  return {
    cases: whole.filter((l) => l.lotType === "CASE").length,
    trays: whole.filter((l) => l.lotType === "TRAY").length,
    packs: packs.filter((p) => recalledLoose(p, lotByCode) && attributedTo(p) === partnerId).length,
  };
}

/**
 * At the plant, lots that are not finished stock yet: codes not printed yet (GENERATED), printed lots
 * awaiting QC (PRINTED), and quarantined lots. Kept apart so "awaiting QC" never counts unprinted codes.
 */
export function pendingCounts(partnerId: string, lots: Lot[]) {
  const here = lots.filter((l) => l.locationId === partnerId);
  return {
    awaitingPrint: here.filter((l) => l.status === "GENERATED").length,
    awaitingQc: here.filter((l) => l.status === "PRINTED").length,
    quarantined: here.filter((l) => l.status === "QUARANTINED").length,
  };
}

export async function dashboard(userId: string | null) {
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

  // Grouped by location once: scanning every lot and pack for each partner grew with partners × codes.
  const lotsAt = Map.groupBy(lots, (l) => l.locationId);
  const packsAt = Map.groupBy(packs, (p) => p.locationId);
  const damagedAt = Map.groupBy(damaged, (u) => u.partnerId);
  // Recalled units by who holds them: one recalled in transit is at its receiver.
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
      // Sellable cases and trays, opened or not; damaged, recalled and not-yet-released units are counted apart.
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

  // The same alerts as GET /api/alerts, from the data already read here (not read a second time). Open ones only:
  // acknowledged and closed alerts stay on the Alerts screen.
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

// ---------------------------------------------------------------- my stock

export async function myStock(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "stock");
  const partner = requirePartner(actor);
  const n = await names(store);
  // Only what is here or on its way here (indexed by location / destination), never every lot and pack.
  const [lotsHere, lotsIncoming, packsHere, packsIncoming, wholeReports] = await Promise.all([
    store.lots.list({ locationId: partner.id }),
    store.lots.list({ inTransitToId: partner.id }),
    store.packs.list({ locationId: partner.id }),
    store.packs.list({ inTransitToId: partner.id }),
    store.movements.list({ type: "DAMAGED", itemKind: "LOT", fromId: partner.id }),
  ]);
  const packLots = await store.lots.list({ lotCode: uniqueIds([...packsHere, ...packsIncoming].map((p) => p.lotCode)) });
  const visible = (ls: Lot[]) => ls.filter((l) => isVisible(l, partner.id));
  const lotByCode = new Map([...visible(packLots), ...visible(lotsHere), ...visible(lotsIncoming)].map((l) => [l.lotCode, l]));
  const once = <R extends { id: string }>(rows: R[]) => [...new Map(rows.map((r) => [r.id, r])).values()];
  const lots = once([...visible(lotsHere), ...visible(lotsIncoming)]);
  // Packs move on their own once their lot is opened (also when that lot was recalled after opening).
  const packs = once([...packsHere, ...packsIncoming]).filter((p) => wasOpened(lotByCode.get(p.lotCode)));
  // An opened lot reported damaged here as a whole leaves stock with its packs.
  const reportedWhole = new Set(wholeReports.map((m) => m.itemCode));
  const view = (l: Lot) => ({ code: l.lotCode, kind: "LOT" as const, lotType: l.lotType, flavour: n.flavour(l.flavour), batchCode: l.batchCode, status: l.status, statusBeforeRecall: l.statusBeforeRecall, synced: l.synced, from: n.partner(l.locationId), to: n.partner(l.inTransitToId), dispatchedAt: l.dispatchedAt });
  const packView = (p: Pack) => {
    const l = lotByCode.get(p.lotCode)!;
    return { code: p.packCode, kind: "PACK" as const, lotType: l.lotType, flavour: n.flavour(l.flavour), batchCode: l.batchCode, status: p.status, statusBeforeRecall: p.statusBeforeRecall, synced: l.synced, from: n.partner(p.locationId), to: n.partner(p.inTransitToId), dispatchedAt: p.dispatchedAt };
  };
  // Loose packs in stock here, and the opened lots that still have any (an opened lot with none left is not listed).
  const looseHere = packs.filter((p) => p.locationId === partner.id && lotByCode.get(p.lotCode)?.status === "OPENED" && sellable(p.status));
  const withPacksHere = new Set(looseHere.map((p) => p.lotCode));
  return {
    partner,
    counts: stockCounts(partner.id, lots, packs, lotByCode),
    // Damaged units leave stock (Damaged section); recalled ones are listed apart, not as stock; at the plant, lots
    // awaiting QC or quarantined are not finished stock (counted in `pending`).
    inStock: [
      ...lots
        .filter((l) => l.locationId === partner.id && !reportedWhole.has(l.lotCode) && (sellable(l.status) || (l.status === "OPENED" && withPacksHere.has(l.lotCode))))
        .map(view),
      ...looseHere.map(packView),
    ],
    outgoing: [
      ...lots.filter((l) => l.locationId === partner.id && l.status === "IN_TRANSIT").map(view),
      ...packs.filter((p) => p.locationId === partner.id && p.status === "IN_TRANSIT").map(packView),
    ],
    incoming: await withInvoices(store, [
      // Also stock Velza field staff took back, on its way to this warehouse (RETURN_IN_TRANSIT).
      ...lots.filter((l) => l.inTransitToId === partner.id && (l.status === "IN_TRANSIT" || l.status === "RETURN_IN_TRANSIT")).map(view),
      ...packs.filter((p) => p.inTransitToId === partner.id && (p.status === "IN_TRANSIT" || p.status === "RETURN_IN_TRANSIT")).map(packView),
    ]),
    /** Recalled — do not sell: held here, including units recalled while in transit to this location. */
    recalled: [
      ...lots.filter((l) => recalledWhole(l) && attributedTo(l) === partner.id).map(view),
      ...packs.filter((p) => recalledLoose(p, lotByCode) && attributedTo(p) === partner.id).map(packView),
    ],
    recalledCounts: recalledCounts(partner.id, lots, packs, lotByCode),
    pending: pendingCounts(partner.id, lots),
  };
}

/** Incoming items with the invoice/challan of the dispatch that sent them (one query for all of them). */
async function withInvoices<T extends { code: string }>(store: Pick<StoreTx, "movements">, items: T[]): Promise<(T & { invoice: string | null })[]> {
  if (!items.length) return [];
  const moves = await store.movements.list({ type: "DISPATCHED", itemCode: items.map((i) => i.code) });
  const latest = new Map<string, { at: string; invoice: string | null }>();
  for (const m of moves) {
    const seen = latest.get(m.itemCode);
    if (!seen || m.at > seen.at) latest.set(m.itemCode, { at: m.at, invoice: m.invoice });
  }
  // A take-back to the warehouse has no invoice (the last one belonged to the delivery before it).
  return items.map((i) => ({ ...i, invoice: (i as { status?: string }).status === "RETURN_IN_TRANSIT" ? null : (latest.get(i.code)?.invoice ?? null) }));
}

// ---------------------------------------------------------------- batches, recall

export async function listBatches(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  const isHq = actor.partner === null;
  if (isHq) requireAction(actor, "dashboard");
  const batches = await store.batches.list(isHq ? { synced: true } : { manufacturerId: actor.partner!.id });
  const [lots, reprints] = await Promise.all([store.lots.list({ batchCode: batches.map((b) => b.code) }), store.reprints.list()]);
  const n = await names(store, { partners: batches.map((b) => b.manufacturerId), users: [], devices: [] });
  // Grouped once: filtering every lot for each batch grew with batches × lots.
  const lotsOf = Map.groupBy(lots, (l) => l.batchCode);
  const reprintsOf = Map.groupBy(reprints, (r) => r.code.slice(2, 8));
  return batches
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((b) => {
      const bl = lotsOf.get(b.code) ?? [];
      return {
        ...b,
        flavourName: flavoursLabel(b, bl, n.flavour),
        manufacturer: n.partner(b.manufacturerId),
        counter: batchCounter(b),
        displayStatus: batchDisplayStatus(b),
        lots: bl.length,
        statusCounts: bl.reduce<Record<string, number>>((acc, l) => ((acc[l.status] = (acc[l.status] ?? 0) + 1), acc), {}),
        reprints: reprintsOf.get(b.code)?.length ?? 0,
      };
    });
}

export async function batchReport(userId: string | null, batchCode: string) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const batch = await store.batches.findOne({ code: batchCode });
  if (!batch || !batch.synced) throw notFound(`Batch ${batchCode}`);
  const n = await names(store);
  const lots = (await store.lots.list({ batchCode })).sort((a, b) => a.lotNumber - b.lotNumber);
  const lotCodes = new Set(lots.map((l) => l.lotCode));
  const movements = await store.movements.list({ itemCode: [...lotCodes] });
  const ever = (type: Movement["type"]) => new Set(movements.filter((m) => m.type === type).map((m) => m.itemCode)).size;
  const reprints = (await store.reprints.list()).filter((r) => lotCodes.has(r.code.slice(0, 15)));
  return {
    batch: { ...batch, flavourName: flavoursLabel(batch, lots, n.flavour), manufacturer: n.partner(batch.manufacturerId), counter: batchCounter(batch), displayStatus: batchDisplayStatus(batch) },
    summary: {
      lots: lots.length,
      cases: lots.filter((l) => l.lotType === "CASE").length,
      trays: lots.filter((l) => l.lotType === "TRAY").length,
      printed: ever("PRINTED"),
      packed: ever("VERIFIED"),
      quarantined: lots.filter((l) => l.status === "QUARANTINED" || l.statusBeforeRecall === "QUARANTINED").length,
      void: lots.filter((l) => l.status === "VOID").length,
      reprinted: reprints.length,
      recalled: lots.filter((l) => l.status === "RECALLED").length,
      /** Lots a recall would mark RECALLED now (void and already recalled ones are left as they are). */
      recallable: lots.filter((l) => recallPatch(l.status) !== null).length,
    },
    lots: lots.map((l) => ({ code: l.lotCode, lotType: l.lotType, status: l.status, location: locationLabel(n.partners, l), quarantineReason: l.quarantineReason })),
    reprints: reprints.map((r) => ({ ...r, userName: n.user(r.userId) })),
  };
}

export async function recall(userId: string | null, body: unknown) {
  const { batchCode, reason } = recallSchema.parse(body);
  await getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "recall");
    if (!reason.trim()) throw badRequest("REASON_REQUIRED", "A recall reason is required");
    const batch = await tx.batches.findOne({ code: batchCode });
    if (!batch || !batch.synced) throw notFound(`Batch ${batchCode}`);
    if (batch.status === "RECALLED") throw badRequest("ALREADY_RECALLED", `Batch ${batchCode} is already recalled`);
    const at = nowIso();
    const lots = await tx.lots.list({ batchCode });
    // Every pack of the batch in one read (not one query per lot).
    const packsOf = Map.groupBy(await tx.packs.list({ lotCode: lots.map((l) => l.lotCode) }), (p) => p.lotCode);
    for (const lot of lots) {
      const patch = recallPatch(lot.status);
      if (patch) {
        await tx.lots.update(lot.id, { ...patch, updatedAt: at });
        await tx.appendMovement({ type: "RECALLED", itemKind: "LOT", itemCode: lot.lotCode, fromId: lot.locationId, toId: lot.inTransitToId, fromStatus: lot.status, toStatus: "RECALLED", userId: actor.user.id, deviceId: null, invoice: null, note: reason.trim() });
      }
      for (const pack of packsOf.get(lot.lotCode) ?? []) {
        const pp = recallPatch(pack.status);
        if (pp) await tx.packs.update(pack.id, { ...pp, updatedAt: at });
      }
    }
    await tx.batches.update(batch.id, { status: "RECALLED", recalledAt: at, recallReason: reason.trim() });
    await tx.appendMovement({ type: "RECALLED", itemKind: "BATCH", itemCode: batchCode, fromId: null, toId: null, fromStatus: null, toStatus: "RECALLED", userId: actor.user.id, deviceId: null, invoice: null, note: reason.trim() });
  });
  return recallReport(userId, batchCode);
}

/** Last known location of every lot and pack of a recalled batch. */
export async function recallReport(userId: string | null, batchCode: string) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const batch = await store.batches.findOne({ code: batchCode });
  if (!batch || !batch.synced) throw notFound(`Batch ${batchCode}`);
  if (batch.status !== "RECALLED") throw badRequest("NOT_RECALLED", `Batch ${batchCode} is not recalled; there is no recall report`);
  const n = await names(store);
  const lots = (await store.lots.list({ batchCode })).sort((a, b) => a.lotNumber - b.lotNumber);
  // Packs are listed for lots that were opened when recalled; read only theirs.
  const packs = await store.packs.list({ lotCode: lots.filter((l) => l.statusBeforeRecall === "OPENED").map((l) => l.lotCode) });
  const where = (x: { statusBeforeRecall: ItemStatus | null; locationId: string; inTransitToId: string | null }) =>
    x.statusBeforeRecall === "IN_TRANSIT" ? `In transit: ${n.partner(x.locationId)} → ${n.partner(x.inTransitToId)}` : n.partner(x.locationId);
  return {
    batch: { code: batch.code, flavour: n.flavour(batch.flavour), status: batch.status, recalledAt: batch.recalledAt, recallReason: batch.recallReason },
    items: lots.map((l) => ({
      code: l.lotCode,
      kind: "LOT" as const,
      lotType: l.lotType,
      status: l.status,
      statusBeforeRecall: l.statusBeforeRecall,
      lastLocation: where(l),
      packs:
        l.statusBeforeRecall === "OPENED"
          ? packs
              .filter((p) => p.lotCode === l.lotCode)
              .sort((a, b) => a.seq - b.seq)
              .map((p) => ({ code: p.packCode, status: p.status, statusBeforeRecall: p.statusBeforeRecall, lastLocation: where(p) }))
          : [],
    })),
  };
}

export async function listScans(userId: string | null, limit = 300) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const n = await names(store);
  return (await store.scans.list())
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((s) => ({ ...s, user: n.user(s.userId), partner: n.partner(s.partnerId) }));
}
