// Manufacturer operator actions: reprint, void, device online/offline, sync.

import { z } from "zod";
import { canReprint, canVoid } from "@/lib/core/rules";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, loadActor, manufacturerDevice, notFound, nowIso, requireAction, requirePartner, setLotState } from "./common";
import { autoRefill, reservedCodes } from "./pool";

export const reprintSchema = z.object({ code: z.string(), reason: z.string() });
export const voidSchema = z.object({ lotCode: z.string(), reason: z.string().optional() });
export const deviceSchema = z.object({ offline: z.boolean() });
export const syncSchema = z.object({ deviceId: z.string().optional() });

export async function reprint(userId: string | null, body: unknown) {
  const { code, reason } = reprintSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "reprint");
    const manufacturer = requirePartner(actor);
    const found = await findItem(tx, code, manufacturer.id);
    if (!found.ok || found.item.lot.manufacturerId !== manufacturer.id) throw badRequest("UNKNOWN_CODE", found.ok ? `${code} belongs to another manufacturer` : found.message);
    const check = canReprint(found.item.movable, reason);
    if (!check.ok) throw badRequest(check.code, check.message);
    const device = await manufacturerDevice(tx, manufacturer.id);
    const at = nowIso();
    const row = await tx.reprints.append({ id: crypto.randomUUID(), at, code, itemKind: found.item.kind, reason: reason.trim(), userId: actor.user.id, deviceId: device.id });
    await tx.appendMovement({
      type: "REPRINTED",
      itemKind: found.item.kind,
      itemCode: code,
      fromId: null,
      toId: null,
      fromStatus: found.item.movable.status,
      toStatus: found.item.movable.status,
      userId: actor.user.id,
      deviceId: device.id,
      invoice: null,
      note: reason.trim(),
    });
    return { ok: true, message: `Reprint of ${code} logged (same code)`, reprint: row };
  });
}

export async function listReprints(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "reprint");
  const [rows, users] = await Promise.all([store.reprints.list(), store.users.list()]);
  const lots = await store.lots.list({ manufacturerId: actor.partner?.id ?? "" });
  const own = new Set(lots.map((l) => l.lotCode));
  return rows
    .filter((r) => own.has(r.code.slice(0, 15)))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => ({ ...r, userName: users.find((u) => u.id === r.userId)?.name ?? r.userId }));
}

export async function voidLot(userId: string | null, body: unknown) {
  const { lotCode, reason } = voidSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "void");
    const manufacturer = requirePartner(actor);
    const lot = await tx.lots.findOne({ lotCode });
    if (!lot || lot.manufacturerId !== manufacturer.id) throw badRequest("UNKNOWN_CODE", `Unknown lot ${lotCode}`);
    const check = canVoid(lot);
    if (!check.ok) throw badRequest(check.code, check.message);
    const device = await manufacturerDevice(tx, manufacturer.id);
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
      note: reason?.trim() || null,
    });
    return { ok: true, message: `Lot ${lotCode} voided; lot number ${lot.lotNumber.toString(16).toUpperCase().padStart(5, "0")} will never be reused` };
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
    const device = await manufacturerDevice(tx, manufacturer.id, deviceId);
    if (device.offline) throw badRequest("DEVICE_OFFLINE", `${device.name} is offline — switch it Online, then Sync`);
    const at = nowIso();
    const counts = await unsyncedCounts(tx, device.id);
    for (const b of await tx.batches.list({ deviceId: device.id, synced: false })) await tx.batches.update(b.id, { synced: true });
    for (const l of await tx.lots.list({ deviceId: device.id, synced: false })) await tx.lots.update(l.id, { synced: true, updatedAt: at });
    for (const o of await tx.printOrders.list({ deviceId: device.id, synced: false })) await tx.printOrders.update(o.id, { synced: true });
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
