// Chain movements: dispatch (scan OUT), receive (scan IN), open lot.

import { z } from "zod";
import { canDispatch, canOpenLot, canReceive, checkDispatchHeader, dispatchPatch, isAssignedDestination, NEXT_TIER, receivePatch, type RuleResult } from "@/lib/core/rules";
import type { Partner } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, loadActor, logScan, manufacturerDevice, nowIso, requireAction, requirePartner, setLotState, type Actor, type FoundItem } from "./common";

export const dispatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check"), toPartnerId: z.string().nullable(), invoice: z.string(), code: z.string(), listed: z.array(z.string()).max(500).optional() }),
  z.object({ action: z.literal("confirm"), toPartnerId: z.string(), invoice: z.string(), codes: z.array(z.string()).min(1).max(500) }),
]);
export const receiveSchema = z.object({ code: z.string() });
export const openLotSchema = z.object({ lotCode: z.string() });

async function deviceIdFor(tx: StoreTx, partner: Partner): Promise<string | null> {
  return partner.type === "MANUFACTURER" ? (await manufacturerDevice(tx, partner.id)).id : null;
}

export async function destinations(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "dispatch");
  const sender = requirePartner(actor);
  const next = NEXT_TIER[sender.type];
  const partners = next ? await store.partners.list({ type: next, active: true }) : [];
  return { sender, nextTier: next, destinations: partners.filter((p) => isAssignedDestination(sender, p)) };
}

/** Super Stockist: its assigned distributors with what is at / on the way to each. */
export async function myDistributors(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "territory");
  const ss = requirePartner(actor);
  const [distributors, lots, packs] = await Promise.all([store.partners.list({ type: "DB", parentId: ss.id }), store.lots.list(), store.packs.list()]);
  const opened = new Set(lots.filter((l) => l.status === "OPENED").map((l) => l.lotCode));
  return {
    superStockist: ss,
    distributors: distributors
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        ...d,
        lotsInStock: lots.filter((l) => l.locationId === d.id && l.status === "AT_DB").length,
        loosePacksInStock: packs.filter((p) => opened.has(p.lotCode) && p.locationId === d.id && p.status === "AT_DB").length,
        lotsOnTheWayFromMe: lots.filter((l) => l.status === "IN_TRANSIT" && l.locationId === ss.id && l.inTransitToId === d.id).length,
      })),
  };
}

async function checkOne(tx: StoreTx, actor: Actor, sender: Partner, receiver: Partner | null, invoice: string, code: string) {
  const found = await findItem(tx, code, sender.id);
  if (!found.ok) return { result: found as RuleResult, item: null };
  const { item } = found;
  return { result: canDispatch({ item: item.movable, parentLotStatus: item.parentLotStatus, sender, receiver, invoice }), item };
}

function describe(item: FoundItem) {
  return item.kind === "LOT" ? `${item.lot.lotType} lot` : `Pack ${item.pack?.seq} of lot ${item.lot.lotCode}`;
}

export async function dispatch(userId: string | null, body: unknown) {
  const req = dispatchSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "dispatch");
    const sender = requirePartner(actor);
    const receiver = req.toPartnerId ? await tx.partners.get(req.toPartnerId) : null;
    const deviceId = await deviceIdFor(tx, sender);

    if (req.action === "check") {
      let result: RuleResult;
      let item: FoundItem | null = null;
      if (req.listed?.includes(req.code)) result = { ok: false, code: "DUPLICATE_SCAN", message: `${req.code} is already in the list` };
      else ({ result, item } = await checkOne(tx, actor, sender, receiver, req.invoice, req.code));
      const message = result.ok ? `${req.code} added (${describe(item!)})` : result.message;
      await logScan(tx, { context: "DISPATCH", code: req.code, actor, ok: result.ok, result: result.ok ? "OK" : result.code, message, deviceId });
      return result.ok ? { ok: true, message, kind: item!.kind } : { ok: false, code: result.code, message };
    }

    const header = checkDispatchHeader(sender, receiver, req.invoice);
    if (!header.ok) throw badRequest(header.code, header.message);
    const unique = [...new Set(req.codes)];
    const checks = await Promise.all(unique.map(async (code) => ({ code, ...(await checkOne(tx, actor, sender, receiver, req.invoice, code)) })));
    const failed = checks.filter((c) => !c.result.ok);
    if (failed.length) {
      throw badRequest(
        "DISPATCH_REJECTED",
        `Nothing dispatched: ${failed.length} code(s) not allowed`,
        failed.map((f) => ({ code: f.code, reason: f.result.ok ? "" : f.result.message })),
      );
    }
    const at = nowIso();
    const invoice = req.invoice.trim();
    for (const { item } of checks) {
      const patch = dispatchPatch(receiver!.id, at);
      if (item!.kind === "LOT") await setLotState(tx, item!.lot, patch, at);
      else await tx.packs.update(item!.pack!.id, { ...patch, updatedAt: at });
      await tx.appendMovement({
        type: "DISPATCHED",
        itemKind: item!.kind,
        itemCode: item!.movable.code,
        fromId: sender.id,
        toId: receiver!.id,
        fromStatus: item!.movable.status,
        toStatus: "IN_TRANSIT",
        userId: actor.user.id,
        deviceId,
        invoice,
        note: null,
      });
    }
    return { ok: true, message: `Dispatched ${checks.length} item(s) to ${receiver!.name} on ${invoice}`, count: checks.length };
  });
}

export async function receive(userId: string | null, body: unknown) {
  const { code } = receiveSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "receive");
    const receiver = requirePartner(actor);
    const found = await findItem(tx, code, receiver.id);
    let result: RuleResult = found.ok ? canReceive({ item: found.item.movable, parentLotStatus: found.item.parentLotStatus, receiver }) : found;
    if (!result.ok) {
      await logScan(tx, { context: "RECEIVE", code, actor, ok: false, result: result.code, message: result.message });
      return { ok: false, code: result.code, message: result.message };
    }
    const item = (found as { item: FoundItem }).item;
    const at = nowIso();
    const patch = receivePatch(receiver);
    const fromId = item.movable.locationId;
    if (item.kind === "LOT") await setLotState(tx, item.lot, patch, at);
    else await tx.packs.update(item.pack!.id, { ...patch, updatedAt: at });
    const dispatchMove = (await tx.movements.list({ itemCode: item.movable.code, type: "DISPATCHED" })).sort((a, b) => b.at.localeCompare(a.at))[0];
    await tx.appendMovement({
      type: "RECEIVED",
      itemKind: item.kind,
      itemCode: item.movable.code,
      fromId,
      toId: receiver.id,
      fromStatus: "IN_TRANSIT",
      toStatus: patch.status,
      userId: actor.user.id,
      deviceId: null,
      invoice: dispatchMove?.invoice ?? null,
      note: null,
    });
    result = { ok: true };
    const message = `${code} received → ${patch.status} (${describe(item)})`;
    await logScan(tx, { context: "RECEIVE", code, actor, ok: true, result: "OK", message });
    return { ok: result.ok, message, status: patch.status };
  });
}

export async function openLot(userId: string | null, body: unknown) {
  const { lotCode } = openLotSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "openLot");
    const partner = requirePartner(actor);
    const found = await findItem(tx, lotCode, partner.id);
    let result: RuleResult;
    if (!found.ok) result = found;
    else if (found.item.kind !== "LOT") result = { ok: false, code: "INVALID_CODE", message: `${lotCode} is a pack code — scan the lot sticker` };
    else result = canOpenLot(found.item.movable, partner);
    if (!result.ok) {
      await logScan(tx, { context: "OPEN_LOT", code: lotCode, actor, ok: false, result: result.code, message: result.message });
      return { ok: false, code: result.code, message: result.message };
    }
    const lot = (found as { item: FoundItem }).item.lot;
    const at = nowIso();
    await setLotState(tx, lot, { status: "OPENED" }, at);
    await tx.appendMovement({
      type: "OPENED",
      itemKind: "LOT",
      itemCode: lot.lotCode,
      fromId: partner.id,
      toId: partner.id,
      fromStatus: lot.status,
      toStatus: "OPENED",
      userId: actor.user.id,
      deviceId: null,
      invoice: null,
      note: "Packs are now individually movable",
    });
    const message = `Lot ${lot.lotCode} opened — its ${lot.lotType === "CASE" ? 4 : 6} packs can now move individually`;
    await logScan(tx, { context: "OPEN_LOT", code: lotCode, actor, ok: true, result: "OK", message });
    const packs = await tx.packs.list({ lotCode: lot.lotCode });
    return { ok: true, message, packs: packs.map((p) => ({ packCode: p.packCode, status: p.status })) };
  });
}
