// Returns: Velza field staff take a case, tray or pack back from a partner (Super Stockist, Distributor or Retailer)
// to the Velza Warehouse; the warehouse receives it by scanning it (→ RETURNED) and then inspects it: back to stock
// (AT_WAREHOUSE, can be dispatched again) or write-off (DAMAGED or EXPIRED, never dispatched again).
//
// Ledger: RETURN_PICKUP (who, from where, reason, when) → RECEIVED (fromStatus RETURN_IN_TRANSIT) → RETURN_RESTOCKED
// or RETURN_WRITTEN_OFF. The Returns report on the HQ dashboard is read from these rows.

import { z } from "zod";
import { PACKS_PER_LOT } from "@/lib/core/codes";
import { AT_STATUS } from "@/lib/core/rules";
import { PARTNER_TYPE_LABELS, type ItemStatus, type Movement, type Partner } from "@/lib/core/types";
import { scannedCodeSchema } from "@/lib/scan/scannedCode";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, loadActor, nowIso, partnerName, requireAction, requirePartner, setLotState } from "./common";

export const RETURN_REASONS = ["NOT_SELLING", "NEAR_EXPIRY", "DAMAGED", "OTHER"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  NOT_SELLING: "Not selling",
  NEAR_EXPIRY: "Near expiry",
  DAMAGED: "Damaged",
  OTHER: "Other",
};

/** Partners stock can be taken back from (not the plant, not the warehouse itself). */
const TAKE_BACK_FROM = ["SS", "DB", "RETAILER"] as const;

export const takeBackSchema = z.object({
  code: scannedCodeSchema,
  reason: z.enum(RETURN_REASONS),
  note: z.string().trim().max(300).optional().default(""),
  /** The Velza Warehouse to send it to; optional while there is only one active warehouse. */
  warehouseId: z.string().max(20).optional(),
});

export const inspectSchema = z.object({
  code: scannedCodeSchema,
  decision: z.enum(["BACK_TO_STOCK", "WRITE_OFF"]),
  /** Write-off only: why it can never be sold. */
  writeOffAs: z.enum(["DAMAGED", "EXPIRED"]).optional(),
  note: z.string().trim().max(300).optional().default(""),
});

const reasonText = (reason: ReturnReason, note: string) => (note ? `${RETURN_REASON_LABELS[reason]}: ${note}` : RETURN_REASON_LABELS[reason]);

async function chooseWarehouse(tx: StoreTx, warehouseId: string | undefined): Promise<Partner> {
  const warehouses = (await tx.partners.list({ type: "WAREHOUSE" })).filter((p) => p.active);
  if (warehouseId) {
    const w = warehouses.find((p) => p.id === warehouseId);
    if (!w) throw badRequest("WRONG_DESTINATION", `${warehouseId} is not an active Velza Warehouse`);
    return w;
  }
  if (!warehouses.length) throw badRequest("WRONG_DESTINATION", "No active Velza Warehouse is registered to take stock back to");
  if (warehouses.length > 1) throw badRequest("WRONG_DESTINATION", "Choose the Velza Warehouse to send it to");
  return warehouses[0];
}

/**
 * Field staff "Take back": the item (a whole unopened case / tray, or a single pack) leaves the partner's stock and is
 * on its way to the Velza Warehouse (RETURN_IN_TRANSIT). A single pack taken from an unopened case or tray first opens
 * that case or tray at the partner (an OPENED movement), so its other packs stay in the partner's stock one by one.
 */
export async function takeBack(userId: string | null, body: unknown) {
  const req = takeBackSchema.parse(body);
  if (req.reason === "OTHER" && !req.note) throw badRequest("REASON_REQUIRED", "Write a note for the reason (Other)");
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "takeBack");
    const found = await findItem(tx, req.code, null);
    if (!found.ok) throw badRequest(found.code, found.message);
    const { item } = found;
    const current = item.movable;
    const holder = await tx.partners.get(current.locationId);
    if (!holder || !(TAKE_BACK_FROM as readonly string[]).includes(holder.type)) {
      throw badRequest("NOT_ALLOWED", `${req.code} is not at a Super Stockist, Distributor or Retailer (${current.status} at ${partnerName([holder].filter(Boolean) as Partner[], current.locationId) ?? current.locationId})`);
    }
    const inStock = AT_STATUS[holder.type];
    if (item.kind === "LOT" && current.status === "OPENED") {
      throw badRequest("LOT_OPENED", `${item.lot.lotType === "CASE" ? "Case" : "Tray"} ${req.code} is opened — take back its packs one by one`);
    }
    if (current.status !== inStock) {
      throw badRequest("WRONG_STATUS", `${req.code} is ${current.status}, not in stock at ${holder.name}: it can't be taken back`);
    }
    const warehouse = await chooseWarehouse(tx, req.warehouseId);
    const at = nowIso();
    const reason = reasonText(req.reason, req.note);

    // A pack from an unopened case / tray: open that case or tray at the partner first.
    let openedLot: string | null = null;
    if (item.kind === "PACK" && item.lot.status !== "OPENED") {
      if (item.lot.status !== inStock || item.lot.locationId !== holder.id) throw badRequest("WRONG_STATUS", `Its ${item.lot.lotType.toLowerCase()} ${item.lot.lotCode} is ${item.lot.status}`);
      await setLotState(tx, item.lot, { status: "OPENED" }, at);
      await tx.appendMovement({
        type: "OPENED",
        itemKind: "LOT",
        itemCode: item.lot.lotCode,
        fromId: holder.id,
        toId: holder.id,
        fromStatus: item.lot.status,
        toStatus: "OPENED",
        userId: actor.user.id,
        deviceId: null,
        invoice: null,
        note: `Opened by Velza field staff to take back pack ${req.code}`,
        at,
      });
      openedLot = item.lot.lotCode;
    }

    const patch = { status: "RETURN_IN_TRANSIT" as ItemStatus, inTransitToId: warehouse.id, dispatchedAt: at };
    if (item.kind === "LOT") await setLotState(tx, item.lot, patch, at);
    else await tx.packs.update(item.pack!.id, { ...patch, updatedAt: at });
    await tx.appendMovement({
      type: "RETURN_PICKUP",
      itemKind: item.kind,
      itemCode: current.code,
      fromId: holder.id,
      toId: warehouse.id,
      fromStatus: inStock,
      toStatus: "RETURN_IN_TRANSIT",
      userId: actor.user.id,
      deviceId: null,
      invoice: null,
      note: reason,
      at,
    });
    const what = item.kind === "PACK" ? "Pack" : item.lot.lotType === "CASE" ? "Case" : "Tray";
    return {
      ok: true as const,
      code: current.code,
      status: "RETURN_IN_TRANSIT" as const,
      openedLot,
      message: `${what} ${current.code} taken back from ${holder.name} (${reason}) — on its way to ${warehouse.name}${openedLot ? `; its ${item.lot.lotType.toLowerCase()} ${openedLot} was opened` : ""}`,
    };
  });
}

/** The warehouse's inspection of a RETURNED item at its location: back to stock, or write-off. */
export async function inspectReturn(userId: string | null, body: unknown) {
  const req = inspectSchema.parse(body);
  if (req.decision === "WRITE_OFF" && !req.writeOffAs) throw badRequest("REASON_REQUIRED", "Choose Damaged or Expired for the write-off");
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "returnInspect");
    const warehouse = requirePartner(actor);
    const found = await findItem(tx, req.code, warehouse.id);
    if (!found.ok) throw badRequest(found.code, found.message);
    const { item } = found;
    const current = item.movable;
    if (current.locationId !== warehouse.id || current.status !== "RETURNED") {
      throw badRequest("WRONG_STATUS", current.locationId === warehouse.id ? `${req.code} is ${current.status}, not a return waiting for inspection` : `${req.code} is not a return at ${warehouse.name}`);
    }
    const at = nowIso();
    const toStatus: ItemStatus = req.decision === "BACK_TO_STOCK" ? "AT_WAREHOUSE" : req.writeOffAs!;
    if (item.kind === "LOT") await setLotState(tx, item.lot, { status: toStatus }, at);
    else await tx.packs.update(item.pack!.id, { status: toStatus, updatedAt: at });
    await tx.appendMovement({
      type: req.decision === "BACK_TO_STOCK" ? "RETURN_RESTOCKED" : "RETURN_WRITTEN_OFF",
      itemKind: item.kind,
      itemCode: current.code,
      fromId: warehouse.id,
      toId: warehouse.id,
      fromStatus: "RETURNED",
      toStatus,
      userId: actor.user.id,
      deviceId: null,
      invoice: null,
      note: req.note || null,
      at,
    });
    const message =
      req.decision === "BACK_TO_STOCK"
        ? `${current.code} is back in stock at ${warehouse.name} (AT WAREHOUSE) and can be dispatched again`
        : `${current.code} written off as ${toStatus}: it can never be dispatched`;
    return { ok: true as const, code: current.code, status: toStatus, message };
  });
}

type ItemInfo = { item: string; flavour: string; batch: string; expiry: string | null };

async function itemInfo(tx: StoreTx, codes: string[]) {
  const lotCodes = [...new Set(codes.map((c) => c.slice(0, 15)))];
  const [lots, flavours, batches] = await Promise.all([tx.lots.list({ lotCode: lotCodes }), tx.flavours.list(), tx.batches.list()]);
  return (code: string): ItemInfo => {
    const lot = lots.find((l) => l.lotCode === code.slice(0, 15));
    const kind = code.length > 15 ? "Pack" : lot?.lotType === "TRAY" ? "Tray" : "Case";
    return {
      // Pack code = lot code + cans per pack (1 digit) + pack number (1 digit).
      item: lot && code.length > 15 ? `Pack ${code.slice(16)} of ${PACKS_PER_LOT[lot.lotType]}` : kind,
      flavour: flavours.find((f) => f.code === lot?.flavour)?.name ?? lot?.flavour ?? "—",
      batch: lot?.batchCode ?? "—",
      expiry: batches.find((b) => b.code === lot?.batchCode)?.expiryDate ?? null,
    };
  };
}

/** Returns at the signed-in warehouse that wait for their inspection (status RETURNED). */
export async function pendingReturns(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "returnInspect");
  const warehouse = requirePartner(actor);
  const [lots, packs] = await Promise.all([store.lots.list({ locationId: warehouse.id, status: "RETURNED" }), store.packs.list({ locationId: warehouse.id, status: "RETURNED" })]);
  // A returned whole case/tray: its packs mirror it; list the case / tray only.
  const codes = [...lots.map((l) => l.lotCode), ...packs.filter((p) => !lots.some((l) => l.lotCode === p.lotCode)).map((p) => p.packCode)];
  const pickups = await store.movements.list({ itemCode: codes, type: "RETURN_PICKUP" });
  const partners = await store.partners.list();
  const info = await itemInfo(store, codes);
  return {
    items: codes.map((code) => {
      const p = pickups.filter((m) => m.itemCode === code).sort((a, b) => b.at.localeCompare(a.at))[0];
      return { code, ...info(code), from: partnerName(partners, p?.fromId), reason: p?.note ?? null, pickedUpAt: p?.at ?? null };
    }),
  };
}

const DECISION_LABEL = (m: Movement | undefined, status: ItemStatus | null) => {
  if (m?.type === "RETURN_RESTOCKED") return "Back to stock";
  if (m?.type === "RETURN_WRITTEN_OFF") return `Written off (${m.toStatus})`;
  if (status === "RETURNED") return "Awaiting inspection";
  if (status === "RETURN_IN_TRANSIT") return "On its way to the warehouse";
  return "—";
};

/** HQ: every take-back, newest first, with what the warehouse decided. */
export async function returnsReport(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dashboard");
  const pickups = (await store.movements.list({ type: "RETURN_PICKUP" })).sort((a, b) => b.at.localeCompare(a.at));
  if (!pickups.length) return { rows: [] };
  const codes = [...new Set(pickups.map((m) => m.itemCode))];
  const [decisions, partners, users, lots, packs] = await Promise.all([
    store.movements.list({ itemCode: codes, type: ["RETURN_RESTOCKED", "RETURN_WRITTEN_OFF"] }),
    store.partners.list(),
    store.users.list(),
    store.lots.list({ lotCode: [...new Set(codes.map((c) => c.slice(0, 15)))] }),
    store.packs.list({ packCode: codes.filter((c) => c.length > 15) }),
  ]);
  const info = await itemInfo(store, codes);
  const statusOf = (code: string): ItemStatus | null =>
    code.length > 15 ? (packs.find((p) => p.packCode === code)?.status ?? null) : (lots.find((l) => l.lotCode === code)?.status ?? null);
  return {
    rows: pickups.map((m) => {
      const from = partners.find((p) => p.id === m.fromId);
      // This pickup's decision: the first inspection of the code after it (a code can be returned more than once).
      const next = pickups.filter((x) => x.itemCode === m.itemCode && x.at > m.at).sort((a, b) => a.at.localeCompare(b.at))[0];
      const decision = decisions.filter((d) => d.itemCode === m.itemCode && d.at >= m.at && (!next || d.at < next.at)).sort((a, b) => a.at.localeCompare(b.at))[0];
      return {
        id: m.id,
        code: m.itemCode,
        ...info(m.itemCode),
        returnedFrom: from?.name ?? m.fromId,
        returnedFromTier: from ? PARTNER_TYPE_LABELS[from.type] : null,
        reason: m.note,
        pickedUpBy: users.find((u) => u.id === m.userId)?.name ?? m.userId,
        pickedUpById: m.userId,
        date: m.at,
        decision: DECISION_LABEL(decision, next ? null : statusOf(m.itemCode)),
        decidedAt: decision?.at ?? null,
      };
    }),
  };
}

