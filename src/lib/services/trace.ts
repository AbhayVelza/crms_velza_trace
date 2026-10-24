// HQ traceability: search + timeline, public lookup, dashboard, alerts, stock, batch report, recall.

import { z } from "zod";
import { computeAlerts, formatAge, ageMs, notReceivedThresholdMs, type InTransitUnit } from "@/lib/core/alerts";
import { extractScannedCode } from "@/lib/core/codes";
import { publicStatus, recallPatch } from "@/lib/core/rules";
import { ITEM_STATUSES, PARTNER_TYPE_LABELS, type ItemStatus, type Lot, type Movement, type Pack, type Partner } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, isVisible, loadActor, logScan, notFound, nowIso, partnerName, requireAction, requirePartner } from "./common";

export const recallSchema = z.object({ batchCode: z.string(), reason: z.string() });

async function names(tx: StoreTx) {
  const [partners, users, devices, flavours] = await Promise.all([tx.partners.list(), tx.users.list(), tx.devices.list(), tx.flavours.list()]);
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
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "search");
    const found = await findItem(tx, code, actor.partner?.id ?? null);
    if (!found.ok) {
      await logScan(tx, { context: "LOOKUP", code, actor, ok: false, result: found.code, message: found.message });
      return { found: false as const, code, result: found.code, message: found.message };
    }
    const { item } = found;
    const n = await names(tx);
    const batch = await tx.batches.findOne({ code: item.lot.batchCode });
    const codes = item.kind === "LOT" ? [item.lot.lotCode] : [item.lot.lotCode, item.pack!.packCode];
    const movements = (await tx.movements.list()).filter((m) => codes.includes(m.itemCode) || (m.itemKind === "BATCH" && m.itemCode === item.lot.batchCode));
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
    const packs = await tx.packs.list({ lotCode: item.lot.lotCode });
    await logScan(tx, { context: "LOOKUP", code, actor, ok: true, result: "OK", message: `${item.kind} ${current.status}` });
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
      reprints: (await tx.reprints.list()).filter((r) => codes.includes(r.code)).map((r) => ({ ...r, userName: n.user(r.userId) })),
    };
  });
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

export async function alerts(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const { lots, packs, lotByCode } = await visibleItems(store);
  const [scans, settings] = await Promise.all([store.scans.list(), store.getSettings()]);
  const n = await names(store);
  return computeAlerts({ scans, inTransit: inTransitUnits(lots, packs, lotByCode), settings, now: new Date() }).map((a) => ({
    ...a,
    partner: n.partner(a.partnerId),
    user: n.user(a.userId),
  }));
}

export async function dashboard(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const { lots, packs, lotByCode } = await visibleItems(store);
  const settings = await store.getSettings();
  const n = await names(store);
  const now = new Date();

  const countBy = (rows: { status: ItemStatus }[]) =>
    Object.fromEntries(ITEM_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, c]) => c)) as Record<string, number>;

  const loosePacks = packs.filter((p) => lotByCode.get(p.lotCode)?.status === "OPENED");
  const stock = n.partners
    .map((p) => {
      const atLots = lots.filter((l) => l.locationId === p.id && l.status !== "IN_TRANSIT" && l.status !== "VOID" && l.status !== "OPENED");
      const atPacks = loosePacks.filter((pk) => pk.locationId === p.id && pk.status !== "IN_TRANSIT");
      return { partnerId: p.id, partner: p.name, tier: p.type, tierLabel: PARTNER_TYPE_LABELS[p.type], lots: atLots.length, cases: atLots.filter((l) => l.lotType === "CASE").length, trays: atLots.filter((l) => l.lotType === "TRAY").length, loosePacks: atPacks.length };
    })
    .filter((s) => s.lots || s.loosePacks);

  const threshold = notReceivedThresholdMs(settings);
  const inTransit = inTransitUnits(lots, packs, lotByCode)
    .map((u) => ({ ...u, from: n.partner(u.fromId), to: n.partner(u.toId), age: formatAge(ageMs(u.dispatchedAt, now)), overdue: ageMs(u.dispatchedAt, now) > threshold }))
    .sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));

  const allAlerts = await alerts(userId);
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
  const lots = (await store.lots.list()).filter((l) => isVisible(l, partner.id));
  const lotByCode = new Map(lots.map((l) => [l.lotCode, l]));
  const packs = (await store.packs.list()).filter((p) => lotByCode.get(p.lotCode)?.status === "OPENED");
  const view = (l: Lot) => ({ code: l.lotCode, kind: "LOT" as const, lotType: l.lotType, flavour: n.flavour(l.flavour), batchCode: l.batchCode, status: l.status, synced: l.synced, from: n.partner(l.locationId), to: n.partner(l.inTransitToId), dispatchedAt: l.dispatchedAt });
  const packView = (p: Pack) => {
    const l = lotByCode.get(p.lotCode)!;
    return { code: p.packCode, kind: "PACK" as const, lotType: l.lotType, flavour: n.flavour(l.flavour), batchCode: l.batchCode, status: p.status, synced: l.synced, from: n.partner(p.locationId), to: n.partner(p.inTransitToId), dispatchedAt: p.dispatchedAt };
  };
  return {
    partner,
    inStock: [
      ...lots.filter((l) => l.locationId === partner.id && l.status !== "IN_TRANSIT").map(view),
      ...packs.filter((p) => p.locationId === partner.id && p.status !== "IN_TRANSIT").map(packView),
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
  const n = await names(store);
  const [batches, lots, reprints] = await Promise.all([store.batches.list(), store.lots.list(), store.reprints.list()]);
  return batches
    .filter((b) => (isHq ? b.synced : b.manufacturerId === actor.partner!.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((b) => {
      const bl = lots.filter((l) => l.batchCode === b.code);
      return {
        ...b,
        flavourName: n.flavour(b.flavour),
        manufacturer: n.partner(b.manufacturerId),
        lots: bl.length,
        statusCounts: bl.reduce<Record<string, number>>((acc, l) => ((acc[l.status] = (acc[l.status] ?? 0) + 1), acc), {}),
        reprints: reprints.filter((r) => r.code.slice(2, 8) === b.code).length,
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
  const movements = (await store.movements.list()).filter((m) => lotCodes.has(m.itemCode));
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
  const packs = await store.packs.list();
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
