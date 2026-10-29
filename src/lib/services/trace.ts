// HQ traceability: search + timeline, public lookup, dashboard, alerts, stock, batch report, recall.

import { z } from "zod";
import { computeAlerts, formatAge, ageMs, notReceivedThresholdMs, type ComputeAlertsInput, type InTransitUnit } from "@/lib/core/alerts";
import { extractScannedCode } from "@/lib/core/codes";
import { publicStatus, recallPatch } from "@/lib/core/rules";
import { ITEM_STATUSES, PARTNER_TYPE_LABELS, type ItemStatus, type Lot, type Movement, type Pack, type Partner } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { damagedCounts, damagedUnits } from "./damage";
import { badRequest, findItem, isVisible, loadActor, logScan, notFound, nowIso, partnerName, requireAction, requirePartner } from "./common";

export const recallSchema = z.object({ batchCode: z.string(), reason: z.string() });

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

function locationLabel(partners: Partner[], item: { status: ItemStatus; locationId: string; inTransitToId: string | null }) {
  const at = partnerName(partners, item.locationId);
  if (item.status === "IN_TRANSIT") return `In transit: ${at} → ${partnerName(partners, item.inTransitToId)}`;
  return at ?? "—";
}

// ---------------------------------------------------------------- search

export async function lookup(userId: string | null, rawCode: string) {
  const code = extractScannedCode(rawCode);
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
  // This item's history only (its lot, its pack, batch-wide events such as a recall), never the whole ledger.
  const [itemMoves, batchMoves, reprints, packs] = await Promise.all([
    store.movements.list({ itemCode: codes }),
    store.movements.list({ itemKind: "BATCH", itemCode: item.lot.batchCode }),
    store.reprints.list({ code: codes }),
    store.packs.list({ lotCode: item.lot.lotCode }),
  ]);
  const movements = [...itemMoves, ...batchMoves];
  const at = (x: { locationId: string | null; inTransitToId: string | null }) => [x.locationId, x.inTransitToId];
  const n = await names(store, {
    partners: [...movements.flatMap((m) => [m.fromId, m.toId]), ...at(item.lot), ...(item.pack ? at(item.pack) : []), ...packs.flatMap(at), batch?.manufacturerId],
    users: [...movements.map((m) => m.userId), ...reprints.map((r) => r.userId)],
    devices: movements.map((m) => m.deviceId),
  });
  const timeline = movements
    .sort((a, b) => a.at.localeCompare(b.at))
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
      flavour: n.flavour(batch.flavour),
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

/** Public QR page: safe fields only, no partners, invoices or history. Logged in the scan audit. */
export async function publicLookup(rawCode: string) {
  const code = extractScannedCode(rawCode);
  return getStore().transaction(async (tx) => {
    const found = await findItem(tx, code, null);
    if (!found.ok) {
      await logScan(tx, { context: "PUBLIC_LOOKUP", code, actor: null, ok: false, result: found.code, message: found.message });
      return { code, product: "Velza Beverage", registered: false, status: publicStatus(false, null) };
    }
    const { item } = found;
    const batch = await tx.batches.findOne({ code: item.lot.batchCode });
    const flavour = await tx.flavours.findOne({ code: item.lot.flavour });
    const status = item.kind === "LOT" ? item.lot.status : item.pack!.status;
    const label = publicStatus(true, status);
    const blocked = status === "RECALLED" || status === "QUARANTINED" || status === "VOID";
    await logScan(tx, {
      context: "PUBLIC_LOOKUP",
      code,
      actor: null,
      ok: !blocked,
      result: blocked ? "BLOCKED_CODE" : "OK",
      message: blocked ? `Public scan of ${status} code ${code}` : label.label,
    });
    return {
      code,
      product: "Velza Beverage",
      registered: status !== "VOID",
      flavour: flavour?.name ?? item.lot.flavour,
      batchCode: item.lot.batchCode,
      mfgDate: batch?.mfgDate ?? null,
      expiryDate: batch?.expiryDate ?? null,
      packType: item.kind === "LOT" ? item.lot.lotType : "PACK",
      status: label,
    };
  });
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

async function namedAlerts(tx: StoreTx, input: Omit<ComputeAlertsInput, "now">) {
  const list = computeAlerts({ ...input, now: new Date() });
  const n = await names(tx, { partners: list.map((a) => a.partnerId), users: list.map((a) => a.userId), devices: [] });
  return list.map((a) => ({ ...a, partner: n.partner(a.partnerId), user: n.user(a.userId) }));
}

export async function alerts(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  // Only what can raise an alert: units in transit, failed scans and damage reports — not every lot and pack.
  const [lots, packs, scans, settings, damaged] = await Promise.all([
    store.lots.list({ status: "IN_TRANSIT", synced: true }),
    store.packs.list({ status: "IN_TRANSIT" }),
    store.scans.list({ ok: false }),
    store.getSettings(),
    store.movements.list({ type: "DAMAGED" }),
  ]);
  // The visible lots those packs and damage reports belong to.
  const related = await store.lots.list({ lotCode: uniqueIds([...packs.map((p) => p.lotCode), ...damaged.map((m) => m.itemCode.slice(0, 15))]), synced: true });
  const lotByCode = new Map(related.map((l) => [l.lotCode, l]));
  return namedAlerts(store, { scans, inTransit: inTransitUnits(lots, packs, lotByCode), damageReports: visibleDamage(damaged, lotByCode), settings });
}

/**
 * Cases and trays held at a location, opened or not: an opened one counts where it was opened while any of
 * its packs is still in stock there. Loose packs are the packs of opened lots in stock there.
 */
export function stockCounts(partnerId: string, lots: Lot[], packs: Pack[], lotByCode: Map<string, Lot>) {
  const loose = packs.filter((pk) => pk.locationId === partnerId && lotByCode.get(pk.lotCode)?.status === "OPENED" && pk.status !== "IN_TRANSIT" && pk.status !== "DAMAGED");
  const withPacksHere = new Set(loose.map((pk) => pk.lotCode));
  const here = lots.filter((l) => l.locationId === partnerId);
  const sealed = here.filter((l) => !["IN_TRANSIT", "VOID", "OPENED", "DAMAGED"].includes(l.status));
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

export async function dashboard(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const { lots, packs, lotByCode } = await visibleItems(store);
  const [settings, damageReports, failedScans] = await Promise.all([store.getSettings(), store.movements.list({ type: "DAMAGED" }), store.scans.list({ ok: false })]);
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
  const stock = n.partners
    .map((p) => {
      // Cases and trays count whether they were opened or not, damaged ones too.
      const c = stockCounts(p.id, lotsAt.get(p.id) ?? [], packsAt.get(p.id) ?? [], lotByCode);
      const d = damagedCounts(damagedAt.get(p.id) ?? []);
      return { partnerId: p.id, partner: p.name, tier: p.type, tierLabel: PARTNER_TYPE_LABELS[p.type], ...c, damaged: d };
    })
    .filter((s) => s.cases || s.trays || s.loosePacks || s.damaged.cases || s.damaged.trays || s.damaged.packs);

  const threshold = notReceivedThresholdMs(settings);
  const units = inTransitUnits(lots, packs, lotByCode);
  const inTransit = units
    .map((u) => ({ ...u, from: n.partner(u.fromId), to: n.partner(u.toId), age: formatAge(ageMs(u.dispatchedAt, now)), overdue: ageMs(u.dispatchedAt, now) > threshold }))
    .sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));

  // The same alerts as GET /api/alerts, from the data already read here (not read a second time).
  const allAlerts = await namedAlerts(store, { scans: failedScans, inTransit: units, damageReports: visibleDamage(damageReports, lotByCode), settings });
  const alertCounts = allAlerts.reduce<Record<string, number>>((acc, a) => ((acc[a.type] = (acc[a.type] ?? 0) + 1), acc), {});
  const unsyncedLots = (await store.lots.list({ synced: false })).length;

  return {
    lotCounts: countBy(lots),
    packCounts: countBy(packs),
    totals: { lots: lots.length, packs: packs.length, batches: (await store.batches.list({ synced: true })).length, unsyncedLots },
    stock,
    inTransit,
    alertCounts,
    recentAlerts: allAlerts.slice(0, 10),
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
  const packs = once([...packsHere, ...packsIncoming]).filter((p) => lotByCode.get(p.lotCode)?.status === "OPENED");
  // An opened lot reported damaged here as a whole leaves stock with its packs.
  const reportedWhole = new Set(wholeReports.map((m) => m.itemCode));
  const view = (l: Lot) => ({ code: l.lotCode, kind: "LOT" as const, lotType: l.lotType, flavour: n.flavour(l.flavour), batchCode: l.batchCode, status: l.status, synced: l.synced, from: n.partner(l.locationId), to: n.partner(l.inTransitToId), dispatchedAt: l.dispatchedAt });
  const packView = (p: Pack) => {
    const l = lotByCode.get(p.lotCode)!;
    return { code: p.packCode, kind: "PACK" as const, lotType: l.lotType, flavour: n.flavour(l.flavour), batchCode: l.batchCode, status: p.status, synced: l.synced, from: n.partner(p.locationId), to: n.partner(p.inTransitToId), dispatchedAt: p.dispatchedAt };
  };
  return {
    partner,
    counts: stockCounts(partner.id, lots, packs, lotByCode),
    // Damaged units leave stock; they are listed in the Damaged section instead.
    inStock: [
      ...lots.filter((l) => l.locationId === partner.id && l.status !== "IN_TRANSIT" && l.status !== "DAMAGED" && !reportedWhole.has(l.lotCode)).map(view),
      ...packs.filter((p) => p.locationId === partner.id && p.status !== "IN_TRANSIT" && p.status !== "DAMAGED").map(packView),
    ],
    outgoing: [
      ...lots.filter((l) => l.locationId === partner.id && l.status === "IN_TRANSIT").map(view),
      ...packs.filter((p) => p.locationId === partner.id && p.status === "IN_TRANSIT").map(packView),
    ],
    incoming: [
      ...lots.filter((l) => l.inTransitToId === partner.id && l.status === "IN_TRANSIT").map(view),
      ...packs.filter((p) => p.inTransitToId === partner.id && p.status === "IN_TRANSIT").map(packView),
    ],
  };
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
        flavourName: n.flavour(b.flavour),
        manufacturer: n.partner(b.manufacturerId),
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
    batch: { ...batch, flavourName: n.flavour(batch.flavour), manufacturer: n.partner(batch.manufacturerId) },
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
    for (const lot of await tx.lots.list({ batchCode })) {
      const patch = recallPatch(lot.status);
      if (patch) {
        await tx.lots.update(lot.id, { ...patch, updatedAt: at });
        await tx.appendMovement({ type: "RECALLED", itemKind: "LOT", itemCode: lot.lotCode, fromId: lot.locationId, toId: lot.inTransitToId, fromStatus: lot.status, toStatus: "RECALLED", userId: actor.user.id, deviceId: null, invoice: null, note: reason.trim() });
      }
      for (const pack of await tx.packs.list({ lotCode: lot.lotCode })) {
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
