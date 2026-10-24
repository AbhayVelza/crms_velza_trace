// Batch code pools: Velza issues random batch codes to each device in advance,
// so a device can create batches while offline.

import { generateBatchCode } from "@/lib/core/codes";
import type { BatchCodePoolEntry, Device } from "@/lib/core/types";
import type { StoreTx } from "@/lib/store";
import { badRequest, nowIso } from "./common";

async function allKnownCodes(tx: StoreTx): Promise<Set<string>> {
  const [pool, batches] = await Promise.all([tx.batchCodePool.list(), tx.batches.list()]);
  return new Set([...pool.map((p) => p.code), ...batches.map((b) => b.code)]);
}

export async function issueCodes(
  tx: StoreTx,
  device: Device,
  count: number,
  userId: string | null,
): Promise<BatchCodePoolEntry[]> {
  if (device.offline) throw badRequest("DEVICE_OFFLINE", `${device.name} is offline — pool refill is blocked until it is back online`);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw badRequest("BAD_COUNT", "Issue between 1 and 100 codes");
  const taken = await allKnownCodes(tx);
  const at = nowIso();
  const rows: BatchCodePoolEntry[] = [];
  for (let i = 0; i < count; i++) {
    const code = generateBatchCode(taken);
    taken.add(code);
    rows.push({ id: crypto.randomUUID(), code, deviceId: device.id, status: "RESERVED", issuedAt: at, usedAt: null });
  }
  await tx.batchCodePool.createMany(rows);
  await tx.appendMovement({
    type: "POOL_ISSUED",
    itemKind: "DEVICE",
    itemCode: device.id,
    fromId: null,
    toId: null,
    fromStatus: null,
    toStatus: null,
    userId,
    deviceId: device.id,
    invoice: null,
    note: `Issued ${count} batch codes to ${device.name}: ${rows.map((r) => r.code).join(", ")}`,
  });
  return rows;
}

export async function reservedCodes(tx: StoreTx, deviceId: string): Promise<BatchCodePoolEntry[]> {
  const rows = await tx.batchCodePool.list({ deviceId, status: "RESERVED" });
  return rows.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

/** Top up to a fresh issue when fewer than `poolRefillBelow` RESERVED codes remain and the device is online. */
export async function autoRefill(tx: StoreTx, deviceId: string): Promise<BatchCodePoolEntry[]> {
  const device = await tx.devices.get(deviceId);
  if (!device || device.offline) return [];
  const settings = await tx.getSettings();
  const remaining = (await reservedCodes(tx, deviceId)).length;
  if (remaining >= settings.poolRefillBelow) return [];
  return issueCodes(tx, device, settings.poolIssueSize, null);
}
