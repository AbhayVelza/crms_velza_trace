// Product details for a scanned case, tray or pack, for every level of the chain (plant, Velza Warehouse, Super
// Stockist, Distributor, Retailer): what it is (flavour, batch, manufacture and expiry date, pack n of m) and the
// partners it came through to reach you — at a Retailer, the Super Stockist and Distributor it came from.
//
// Disclosure (same rules as the scan screens): a partner sees a code only if it is at, on its way to, or has passed
// through its location; the plant sees its own codes. Anything else answers like an unknown code. The supply chain
// stops at the viewer: where the stock went after leaving you is never shown. Scans are logged as LOOKUP (no alerts).

import { PARTNER_TYPE_LABELS, type ItemStatus, type Movement, type PartnerType } from "@/lib/core/types";
import { MAX_SCAN_INPUT, normalizeScannedCode } from "@/lib/scan/normalize";
import { getStore } from "@/lib/store";
import { PACKS_PER_LOT } from "@/lib/core/codes";
import { AT_STATUS } from "@/lib/core/rules";
import { findItem, loadActor, logScan, partnerName, requireAction, requirePartner, type Actor } from "./common";

const MAX_LOGGED_CODE = 64;
const cleanCode = (raw: string) => normalizeScannedCode(String(raw ?? "").slice(0, MAX_SCAN_INPUT)).slice(0, MAX_LOGGED_CODE);

const DAY_MS = 86_400_000;

export interface SupplyStep {
  partnerId: string;
  name: string;
  tier: PartnerType;
  tierLabel: string;
  /** When it arrived there (null for the plant, and for the viewer while it is still on its way). */
  receivedAt: string | null;
  /** Invoice / challan it was dispatched to this partner on (null for the plant). */
  invoice: string | null;
  /** The viewer's own step. */
  you: boolean;
  /** Still on its way to the viewer (not received yet). */
  onTheWay: boolean;
  /** Full view (HQ, Admin, field staff): this step is a take-back to the Velza Warehouse, not a delivery. */
  returned?: boolean;
}

/** Full view only (Velza HQ, Admin, field staff): who holds it now, and whether field staff can take it back. */
export interface FullView {
  holder: string;
  holderTier: string | null;
  /** "In transit: A → B" while on the road; otherwise the holder. */
  location: string;
  /** Field staff: it is in stock at an SS, Distributor or Retailer (a whole unopened case / tray, or a pack). */
  canTakeBack: boolean;
  /** Take-backs of this code: who, from where, why, when, and what the warehouse decided. */
  returns: { at: string; from: string | null; reason: string | null; by: string | null; decision: string | null }[];
}

export type DetailsResult =
  | { found: false; code: string; result: string; message: string }
  | {
      found: true;
      code: string;
      kind: "LOT" | "PACK";
      lotType: "CASE" | "TRAY";
      lotCode: string;
      flavour: string;
      batchCode: string;
      mfgDate: string | null;
      expiryDate: string | null;
      /** Whole days until the expiry date (negative once expired); null without a date. */
      daysToExpiry: number | null;
      expired: boolean;
      /** Cans in each pack (4 or 6). */
      packSize: number;
      /** Packs in the case (4) or tray (6). */
      packsInLot: number;
      /** "Pack 3 of 6" for a pack; null for a case or tray. */
      packLabel: string | null;
      manufacturer: string;
      /** Shown only while the item is here or on its way to / from the viewer; otherwise null. */
      status: ItemStatus | null;
      /** "Here", "On its way to you", "On its way from you to <partner>", or "Passed through you". */
      position: string;
      /** Plant first, the viewer last. */
      supplyChain: SupplyStep[];
      /** The partners of each tier it came through on its way to the viewer (the Retailer's "from which SS & DB"). */
      cameFrom: { warehouse: string | null; superStockist: string | null; distributor: string | null };
      recalled: boolean;
      /** Velza HQ, Admin and field staff only. */
      full?: FullView;
    };

/** Velza staff who see every code and its full chain (never cut at the viewer). */
const FULL_VIEW_ROLES = ["TRACE_OWNER", "ADMIN", "VELZA_FIELD"] as const;

/** Whole days from today (UTC) to a yyyy-mm-dd date. */
export function daysUntil(date: string | null, now = new Date()): number | null {
  if (!date) return null;
  const end = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - today) / DAY_MS);
}

export async function productDetails(userId: string | null, rawCode: string): Promise<DetailsResult> {
  const code = cleanCode(rawCode);
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "details");

  const notHere = async (result: string, message: string, logged = message) => {
    await logScan(store, { context: "LOOKUP", code, actor, ok: false, result, message: logged });
    return { found: false as const, code, result, message };
  };

  if ((FULL_VIEW_ROLES as readonly string[]).includes(actor.role)) return fullDetails(store, actor, code, notHere);
  const me = requirePartner(actor);
  const found = await findItem(store, code, me.id);
  if (!found.ok) return notHere(found.code, found.message);
  const { item } = found;
  const current = item.kind === "LOT" ? item.lot : item.pack!;
  const codes = item.kind === "LOT" ? [item.lot.lotCode] : [item.lot.lotCode, item.pack!.packCode];
  const moves = (await store.movements.list({ itemCode: codes })).filter((m) => m.type === "DISPATCHED" || m.type === "RECEIVED").sort((a, b) => a.at.localeCompare(b.at));

  // May this partner see it? The plant: its own codes. Everyone else: here, on its way to them, or passed through them.
  const touchesMe = (m: Movement) => m.toId === me.id || m.fromId === me.id;
  const allowed =
    me.type === "MANUFACTURER"
      ? item.lot.manufacturerId === me.id
      : current.locationId === me.id || current.inTransitToId === me.id || moves.some(touchesMe);
  if (!allowed) {
    // Answer exactly like an unknown code (never say where it is or what state it is in); the log keeps the reason.
    return notHere("UNKNOWN_CODE", `Unknown code ${code}: it has not been at your location`, `${code}: not at, to or through ${me.id}`);
  }

  const batch = await store.batches.findOne({ code: item.lot.batchCode });
  const flavour = (await store.flavours.findOne({ code: item.lot.flavour }))?.name ?? item.lot.flavour;
  const partners = await store.partners.list();
  const partnerOf = (id: string) => partners.find((p) => p.id === id);

  // The chain: the plant, then every partner it was received at (in order), up to the viewer's first arrival.
  const steps: SupplyStep[] = [];
  const plant = partnerOf(item.lot.manufacturerId);
  const step = (id: string, receivedAt: string | null, invoice: string | null, onTheWay = false): SupplyStep => {
    const p = partnerOf(id);
    const tier = p?.type ?? "MANUFACTURER";
    return { partnerId: id, name: partnerName(partners, id) ?? id, tier, tierLabel: PARTNER_TYPE_LABELS[tier], receivedAt, invoice, you: id === me.id, onTheWay };
  };
  steps.push(step(item.lot.manufacturerId, null, null));
  const lastDispatchTo = (to: string, before: string) =>
    [...moves].reverse().find((m) => m.type === "DISPATCHED" && m.toId === to && m.at <= before)?.invoice ?? null;
  for (const m of moves) {
    if (steps.some((s) => s.you)) break; // never past the viewer
    if (m.type !== "RECEIVED" || !m.toId) continue;
    if (steps[steps.length - 1]?.partnerId === m.toId) continue; // a pack and its lot received together
    steps.push(step(m.toId, m.at, m.invoice ?? lastDispatchTo(m.toId, m.at)));
  }
  // Still on its way to the viewer (also when recalled on the way): the viewer is the last, pending step.
  if (!steps.some((s) => s.you) && current.inTransitToId === me.id) steps.push(step(me.id, null, lastDispatchTo(me.id, "9999"), true));

  const upstream = steps.filter((s) => !s.you);
  const lastOf = (tier: PartnerType) => [...upstream].reverse().find((s) => s.tier === tier)?.name ?? null;

  const here = current.locationId === me.id && current.status !== "IN_TRANSIT";
  const toMe = current.status === "IN_TRANSIT" && current.inTransitToId === me.id;
  const fromMe = current.status === "IN_TRANSIT" && current.locationId === me.id;
  const recalledToMe = current.status === "RECALLED" && current.inTransitToId === me.id;
  const visibleStatus = here || toMe || fromMe || recalledToMe;
  const position = toMe
    ? "On its way to you"
    : fromMe
      ? `On its way from you to ${partnerName(partners, current.inTransitToId) ?? "—"}`
      : recalledToMe
        ? "Recalled on its way to you"
        : here
          ? "Here"
          : "Passed through you";

  const days = daysUntil(batch?.expiryDate ?? null);
  const message = `${item.kind} ${visibleStatus ? current.status : "seen"}`;
  await logScan(store, { context: "LOOKUP", code, actor, ok: true, result: "OK", message });

  return {
    found: true,
    code,
    kind: item.kind,
    lotType: item.lot.lotType,
    lotCode: item.lot.lotCode,
    flavour,
    batchCode: item.lot.batchCode,
    mfgDate: batch?.mfgDate ?? null,
    expiryDate: batch?.expiryDate ?? null,
    daysToExpiry: days,
    expired: days !== null && days < 0,
    packSize: item.lot.packSize,
    packsInLot: PACKS_PER_LOT[item.lot.lotType],
    packLabel: item.kind === "PACK" ? `Pack ${item.pack!.seq} of ${PACKS_PER_LOT[item.lot.lotType]} (${item.lot.packSize} cans)` : null,
    manufacturer: plant ? (partnerName(partners, plant.id) ?? plant.name) : item.lot.manufacturerId,
    status: visibleStatus ? current.status : null,
    position,
    supplyChain: steps,
    cameFrom: { warehouse: lastOf("WAREHOUSE"), superStockist: lastOf("SS"), distributor: lastOf("DB") },
    recalled: current.status === "RECALLED" || batch?.status === "RECALLED",
  };
}

type NotHere = (result: string, message: string, logged?: string) => Promise<DetailsResult>;

/**
 * Velza HQ, Admin and field staff: any synced code, the FULL chain (plant → Velza Warehouse → SS → DB → Retailer, each
 * step with partner, date and time, invoice; take-backs to the warehouse included), the current holder and status.
 */
async function fullDetails(store: ReturnType<typeof getStore>, actor: Actor, code: string, notHere: NotHere): Promise<DetailsResult> {
  const found = await findItem(store, code, null);
  if (!found.ok) return notHere(found.code, found.message);
  const { item } = found;
  const current = item.kind === "LOT" ? item.lot : item.pack!;
  const codes = item.kind === "LOT" ? [item.lot.lotCode] : [item.lot.lotCode, item.pack!.packCode];
  const all = (await store.movements.list({ itemCode: codes })).sort((a, b) => a.at.localeCompare(b.at));
  const moves = all.filter((m) => m.type === "DISPATCHED" || m.type === "RECEIVED" || m.type === "RETURN_PICKUP");
  const [batch, flavourRow, partners, users] = await Promise.all([
    store.batches.findOne({ code: item.lot.batchCode }),
    store.flavours.findOne({ code: item.lot.flavour }),
    store.partners.list(),
    store.users.list(),
  ]);
  const partnerOf = (id: string | null) => partners.find((p) => p.id === id);
  const step = (id: string, receivedAt: string | null, invoice: string | null, onTheWay = false, returned = false): SupplyStep => {
    const tier = partnerOf(id)?.type ?? "MANUFACTURER";
    return { partnerId: id, name: partnerName(partners, id) ?? id, tier, tierLabel: PARTNER_TYPE_LABELS[tier], receivedAt, invoice, you: false, onTheWay, returned };
  };
  const invoiceFor = (to: string, before: string) => [...moves].reverse().find((m) => m.type === "DISPATCHED" && m.toId === to && m.at <= before)?.invoice ?? null;

  const steps: SupplyStep[] = [step(item.lot.manufacturerId, null, null)];
  for (const m of moves) {
    if (m.type !== "RECEIVED" || !m.toId) continue;
    const returned = m.fromStatus === "RETURN_IN_TRANSIT";
    const last = steps[steps.length - 1];
    if (last?.partnerId === m.toId && !returned && !last.returned) continue; // a pack and its lot received together
    steps.push(step(m.toId, m.at, returned ? null : (m.invoice ?? invoiceFor(m.toId, m.at)), false, returned));
  }
  if ((current.status === "IN_TRANSIT" || current.status === "RETURN_IN_TRANSIT" || current.status === "RECALLED") && current.inTransitToId) {
    steps.push(step(current.inTransitToId, null, current.status === "RETURN_IN_TRANSIT" ? null : invoiceFor(current.inTransitToId, "9999"), true, current.status === "RETURN_IN_TRANSIT"));
  }

  const holder = partnerOf(current.locationId);
  const onRoad = !!current.inTransitToId && (current.status === "IN_TRANSIT" || current.status === "RETURN_IN_TRANSIT");
  const location = onRoad ? `${current.status === "RETURN_IN_TRANSIT" ? "Being taken back" : "In transit"}: ${holder?.name ?? current.locationId} → ${partnerName(partners, current.inTransitToId)}` : (holder?.name ?? current.locationId);
  const inStockAtPartner = !!holder && ["SS", "DB", "RETAILER"].includes(holder.type) && current.status === AT_STATUS[holder.type];
  const canTakeBack = actor.role === "VELZA_FIELD" && inStockAtPartner && !(item.kind === "LOT" && item.lot.status === "OPENED");

  const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? id) : null);
  const pickups = all.filter((m) => m.type === "RETURN_PICKUP" && m.itemCode === item.movable.code);
  const decisions = all.filter((m) => (m.type === "RETURN_RESTOCKED" || m.type === "RETURN_WRITTEN_OFF") && m.itemCode === item.movable.code);
  const returns = pickups.map((p) => {
    const d = decisions.find((x) => x.at >= p.at);
    return {
      at: p.at,
      from: partnerName(partners, p.fromId),
      reason: p.note,
      by: userName(p.userId),
      decision: d ? (d.type === "RETURN_RESTOCKED" ? "Back to stock" : `Written off (${d.toStatus})`) : null,
    };
  });

  const lastOf = (tier: PartnerType) => [...steps].reverse().find((s) => s.tier === tier && !s.returned)?.name ?? null;
  const days = daysUntil(batch?.expiryDate ?? null);
  await logScan(store, { context: "LOOKUP", code, actor, ok: true, result: "OK", message: `${item.kind} ${current.status}` });
  return {
    found: true,
    code,
    kind: item.kind,
    lotType: item.lot.lotType,
    lotCode: item.lot.lotCode,
    flavour: flavourRow?.name ?? item.lot.flavour,
    batchCode: item.lot.batchCode,
    mfgDate: batch?.mfgDate ?? null,
    expiryDate: batch?.expiryDate ?? null,
    daysToExpiry: days,
    expired: days !== null && days < 0,
    packSize: item.lot.packSize,
    packsInLot: PACKS_PER_LOT[item.lot.lotType],
    packLabel: item.kind === "PACK" ? `Pack ${item.pack!.seq} of ${PACKS_PER_LOT[item.lot.lotType]} (${item.lot.packSize} cans)` : null,
    manufacturer: partnerName(partners, item.lot.manufacturerId) ?? item.lot.manufacturerId,
    status: current.status,
    position: location,
    supplyChain: steps,
    cameFrom: { warehouse: lastOf("WAREHOUSE"), superStockist: lastOf("SS"), distributor: lastOf("DB") },
    recalled: current.status === "RECALLED" || batch?.status === "RECALLED",
    full: { holder: holder?.name ?? current.locationId, holderTier: holder ? PARTNER_TYPE_LABELS[holder.type] : null, location, canTakeBack, returns },
  };
}
