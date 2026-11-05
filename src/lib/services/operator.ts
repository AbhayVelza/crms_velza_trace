// Manufacturer operator actions: reprint, void, device online/offline, sync.

import { z } from "zod";
import { formatLotNumber } from "@/lib/core/codes";
import { canReprint, canVoid, lotStatusAfterReprint } from "@/lib/core/rules";
import { scannedCodeSchema } from "@/lib/scan/scannedCode";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, loadActor, notFound, nowIso, printDevice, requireAction, requirePartner, setLotState, unknownCodeMessage } from "./common";
import { autoRefill, reservedCodes } from "./pool";
import { reprintServedId } from "./printOrders";

// deviceId: the PC chosen as "This PC" in the device bar (required when the plant has several PCs).
export const reprintSchema = z.object({ code: scannedCodeSchema, reason: z.string().max(500), deviceId: z.string().optional() });
export const voidSchema = z.object({ lotCode: scannedCodeSchema, reason: z.string().max(500).optional(), deviceId: z.string().optional() });
export const deviceSchema = z.object({ offline: z.boolean() });
export const syncSchema = z.object({ deviceId: z.string().optional() });

export async function reprint(userId: string | null, body: unknown) {
  const { code, reason, deviceId } = reprintSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "reprint");
    const manufacturer = requirePartner(actor);
    const found = await findItem(tx, code, manufacturer.id);
    if (!found.ok || found.item.lot.manufacturerId !== manufacturer.id) throw badRequest("UNKNOWN_CODE", found.ok ? unknownCodeMessage(code) : found.message);
    const check = canReprint(found.item.movable, reason);
    if (!check.ok) throw badRequest(check.code, check.message);
    const device = await printDevice(tx, manufacturer.id, deviceId);
    const at = nowIso();
    const lot = found.item.lot;
    const lotStatus = lotStatusAfterReprint(lot.status);
    const backToQc = lotStatus !== lot.status;
    if (backToQc) await setLotState(tx, lot, { status: lotStatus, quarantineReason: null }, at);
    // The authorization to print this code once more: who, when, why, which device and the order that issued it.
    const row = await tx.reprints.append({
      id: crypto.randomUUID(),
      at,
      code,
      itemKind: found.item.kind,
      reason: reason.trim(),
      userId: actor.user.id,
      deviceId: device.id,
      printOrderId: lot.printOrderId,
    });
    await tx.appendMovement({
      type: "REPRINTED",
      itemKind: found.item.kind,
      itemCode: code,
      fromId: null,
      toId: null,
      fromStatus: found.item.movable.status,
      toStatus: backToQc ? lotStatus : found.item.movable.status,
      userId: actor.user.id,
      deviceId: device.id,
      invoice: null,
      note: reason.trim(),
    });
    const message = backToQc
      ? `Reprint of ${code} logged (same code). Lot ${lot.lotCode} is out of quarantine and back to PRINTED — QC must verify it again. Open its print view to print it once.`
      : `Reprint of ${code} logged (same code). Open its print view to print it once.`;
    return { ok: true, message, reprint: row };
  });
}

export async function listReprints(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "reprint");
  const [rows, users, served] = await Promise.all([store.reprints.list(), store.users.list(), store.movements.list({ type: "REPRINT_SERVED" })]);
  const lots = await store.lots.list({ manufacturerId: actor.partner?.id ?? "" });
  const own = new Set(lots.map((l) => l.lotCode));
  const servedAt = new Map(served.map((m) => [m.id, m.at]));
  return rows
    .filter((r) => own.has(r.code.slice(0, 15)))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => ({ ...r, userName: users.find((u) => u.id === r.userId)?.name ?? r.userId, servedAt: servedAt.get(reprintServedId(r.id)) ?? null }));
}

export async function voidLot(userId: string | null, body: unknown) {
  const { lotCode, reason, deviceId } = voidSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "void");
    const manufacturer = requirePartner(actor);
    const lot = await tx.lots.findOne({ lotCode });
    if (!lot || lot.manufacturerId !== manufacturer.id) throw badRequest("UNKNOWN_CODE", `Unknown lot ${lotCode}`);
    const check = canVoid(lot);
    if (!check.ok) throw badRequest(check.code, check.message);
    // A void can never be undone and its lot number is never reused, so the audit trail must say why.
    const why = reason?.trim() ?? "";
    if (!why) throw badRequest("REASON_REQUIRED", "Say why the lot is voided (for example: misprint, torn sticker, line stopped)");
    const device = await printDevice(tx, manufacturer.id, deviceId);
    const at = nowIso();
    await setLotState(tx, lot, { status: "VOID" }, at);
    await tx.appendMovement({
      type: "VOIDED",
      itemKind: "LOT",
      itemCode: lotCode,
      fromId: lot.locationId,
      toId: null,
      fromStatus: lot.status,
      toStatus: "VOID",
      userId: actor.user.id,
      deviceId: device.id,
      invoice: null,
      note: why,
    });
    return { ok: true, message: `Lot ${lotCode} voided; lot number ${formatLotNumber(lot.lotNumber)} will never be reused` };
  });
}

async function unsyncedCounts(tx: StoreTx, deviceId: string) {
  const [batches, lots, orders] = await Promise.all([
    tx.batches.list({ deviceId, synced: false }),
    tx.lots.list({ deviceId, synced: false }),
    tx.printOrders.list({ deviceId, synced: false }),
  ]);
  return { batches: batches.length, lots: lots.length, printOrders: orders.length };
}

export async function listDevices(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "device");
  const devices = actor.partner ? await store.devices.list({ manufacturerId: actor.partner.id }) : await store.devices.list();
  return Promise.all(
    devices.map(async (d) => ({
      ...d,
      unsynced: await unsyncedCounts(store, d.id),
      reservedCodes: (await reservedCodes(store, d.id)).length,
    })),
  );
}

export async function setDeviceOffline(userId: string | null, deviceId: string, body: unknown) {
  const { offline } = deviceSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "device");
    const device = await tx.devices.get(deviceId);
    if (!device || (actor.partner && device.manufacturerId !== actor.partner.id)) throw notFound(`Device ${deviceId}`);
    const updated = await tx.devices.update(deviceId, { offline });
    if (!offline) await autoRefill(tx, deviceId);
    return { ...updated, unsynced: await unsyncedCounts(tx, deviceId), reservedCodes: (await reservedCodes(tx, deviceId)).length };
  });
}

export async function sync(userId: string | null, body: unknown) {
  const { deviceId } = syncSchema.parse(body ?? {});
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "sync");
    const manufacturer = requirePartner(actor);
    const device = await printDevice(tx, manufacturer.id, deviceId);
    if (device.offline) throw badRequest("DEVICE_OFFLINE", `${device.name} is offline — switch it Online, then Sync`);
    const at = nowIso();
    const counts = await unsyncedCounts(tx, device.id);
    // One statement per table (the lots' packs follow their lot's sync flag), not one per row.
    await tx.batches.updateWhere({ deviceId: device.id, synced: false }, { synced: true });
    await tx.lots.updateWhere({ deviceId: device.id, synced: false }, { synced: true, updatedAt: at });
    await tx.printOrders.updateWhere({ deviceId: device.id, synced: false }, { synced: true });
    await tx.devices.update(device.id, { lastSyncAt: at });
    await tx.appendMovement({
      type: "SYNC",
      itemKind: "DEVICE",
      itemCode: device.id,
      fromId: manufacturer.id,
      toId: null,
      fromStatus: null,
      toStatus: null,
      userId: actor.user.id,
      deviceId: device.id,
      invoice: null,
      note: `Synced ${counts.batches} batch(es), ${counts.lots} lot(s), ${counts.printOrders} print order(s)`,
    });
    const refilled = await autoRefill(tx, device.id);
    return { ok: true, message: `Synced ${counts.batches} batch(es) and ${counts.lots} lot(s)`, synced: counts, refilled: refilled.length };
  });
}
