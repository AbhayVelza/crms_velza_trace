// Supervisor/QC verification: scan lot, scan each pack, confirm → PACKED or QUARANTINED.

import { z } from "zod";
import { buildPackCodes } from "@/lib/core/codes";
import { canStartVerification, checkVerifyPackScan, evaluateVerification } from "@/lib/core/rules";
import type { Lot } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, loadActor, logScan, manufacturerDevice, nowIso, requireAction, requirePartner, setLotState, type Actor } from "./common";

export const verifySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scanLot"), code: z.string() }),
  z.object({ action: z.literal("scanPack"), lotCode: z.string(), code: z.string(), scanned: z.array(z.string()).max(10) }),
  z.object({ action: z.literal("confirm"), lotCode: z.string(), packCodes: z.array(z.string()).max(10) }),
  z.object({ action: z.literal("quarantine"), lotCode: z.string(), reason: z.string(), packCodes: z.array(z.string()).max(10).optional() }),
]);

export type VerifyRequest = z.infer<typeof verifySchema>;

function lotView(lot: Lot) {
  return {
    lotCode: lot.lotCode,
    lotType: lot.lotType,
    flavour: lot.flavour,
    status: lot.status,
    batchCode: lot.batchCode,
    synced: lot.synced,
    expectedPacks: buildPackCodes(lot.lotCode, lot.lotType),
  };
}

async function loadLotForQc(tx: StoreTx, actor: Actor, lotCode: string) {
  const found = await findItem(tx, lotCode, actor.partner?.id ?? null);
  if (!found.ok) return found;
  if (found.item.kind !== "LOT") {
    return { ok: false as const, code: "INVALID_CODE" as const, message: `${lotCode} is a pack code — scan the lot sticker first` };
  }
  if (found.item.lot.manufacturerId !== actor.partner?.id) {
    return { ok: false as const, code: "NOT_AT_LOCATION" as const, message: `Lot ${lotCode} belongs to another manufacturer` };
  }
  return { ok: true as const, lot: found.item.lot };
}

export async function verify(userId: string | null, body: unknown) {
  const req = verifySchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "verify");
    const manufacturer = requirePartner(actor);
    const device = await manufacturerDevice(tx, manufacturer.id);
    const scan = (code: string, ok: boolean, result: string, message: string) =>
      logScan(tx, { context: "VERIFY", code, actor, ok, result, message, deviceId: device.id });

    if (req.action === "scanLot") {
      const r = await loadLotForQc(tx, actor, req.code);
      if (!r.ok) {
        await scan(req.code, false, r.code, r.message);
        return { ok: false, code: r.code, message: r.message };
      }
      const start = canStartVerification(r.lot);
      if (!start.ok) {
        await scan(req.code, false, start.code, start.message);
        return { ok: false, code: start.code, message: start.message, lot: lotView(r.lot) };
      }
      await scan(req.code, true, "OK", `Lot ${req.code} ready: scan ${lotView(r.lot).expectedPacks.length} packs`);
      return { ok: true, message: `Scan the ${lotView(r.lot).expectedPacks.length} pack stickers`, lot: lotView(r.lot) };
    }

    const r = await loadLotForQc(tx, actor, req.lotCode);
    if (!r.ok) throw badRequest(r.code, r.message);
    const lot = r.lot;

    if (req.action === "scanPack") {
      const check = checkVerifyPackScan(lot, req.code, req.scanned);
      const message = check.ok ? `${req.code} OK` : check.message;
      await scan(req.code, check.ok, check.ok ? "OK" : check.code, message);
      return check.ok ? { ok: true, message } : { ok: false, code: check.code, message };
    }

    const at = nowIso();
    const move = (type: "VERIFIED" | "QUARANTINED", toStatus: Lot["status"], note: string | null) =>
      tx.appendMovement({
        type,
        itemKind: "LOT",
        itemCode: lot.lotCode,
        fromId: lot.locationId,
        toId: lot.locationId,
        fromStatus: lot.status,
        toStatus,
        userId: actor.user.id,
        deviceId: device.id,
        invoice: null,
        note,
      });

    if (req.action === "quarantine") {
      if (!req.reason.trim()) throw badRequest("REASON_REQUIRED", "A reason is required to quarantine");
      if (lot.status !== "PRINTED" && lot.status !== "PACKED") {
        throw badRequest("WRONG_STATUS", `Lot ${lot.lotCode} is ${lot.status} and cannot be quarantined here`);
      }
      await setLotState(tx, lot, { status: "QUARANTINED", quarantineReason: req.reason.trim() }, at);
      await move("QUARANTINED", "QUARANTINED", req.reason.trim());
      return { ok: false, code: "QUARANTINED", message: `Lot ${lot.lotCode} quarantined: ${req.reason.trim()}`, lot: lotView({ ...lot, status: "QUARANTINED" }) };
    }

    // confirm
    const result = evaluateVerification(lot, req.packCodes);
    if (result.pass) {
      await setLotState(tx, lot, { status: "PACKED", quarantineReason: null }, at);
      await move("VERIFIED", "PACKED", `${req.packCodes.length} packs verified`);
      return { ok: true, message: `Lot ${lot.lotCode} verified → PACKED`, lot: lotView({ ...lot, status: "PACKED" }) };
    }
    if (lot.status !== "PRINTED") return { ok: false, code: "WRONG_STATUS", message: result.reason, lot: lotView(lot) };
    await setLotState(tx, lot, { status: "QUARANTINED", quarantineReason: result.reason }, at);
    await move("QUARANTINED", "QUARANTINED", result.reason);
    return { ok: false, code: "QUARANTINED", message: `Verification failed, lot quarantined: ${result.reason}`, lot: lotView({ ...lot, status: "QUARANTINED" }) };
  });
}
