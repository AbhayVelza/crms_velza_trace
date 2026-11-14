// Supervisor/QC verification: scan lot, scan each pack, confirm → PACKED or QUARANTINED.

import { z } from "zod";
import { buildPackCodes } from "@/lib/core/codes";
import { canStartVerification, checkVerifyPackScan, evaluateVerification, publicScanOutcome, publicStatus } from "@/lib/core/rules";
import type { Lot } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { publicScanInput } from "@/lib/scan/normalize";
import { scannedCodeSchema } from "@/lib/scan/scannedCode";
import { badRequest, findItem, loadActor, logScan, manufacturerDevice, nowIso, requireAction, requirePartner, setLotState, unknownCodeMessage, type Actor } from "./common";

// Codes are bounded and normalised (QR link, lower case, scanner prefixes) before they reach the scan audit.
const code = scannedCodeSchema;
export const verifySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scanLot"), code }),
  z.object({ action: z.literal("scanPack"), lotCode: code, code, scanned: z.array(code).max(10) }),
  z.object({ action: z.literal("confirm"), lotCode: code, packCodes: z.array(code).max(10) }),
  z.object({ action: z.literal("quarantine"), lotCode: code, reason: z.string().max(500), packCodes: z.array(code).max(10).optional() }),
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
    // The scan log keeps the real reason (audit, alerts); the person sees the same answer as for an unknown code.
    return { ok: false as const, code: "NOT_AT_LOCATION" as const, message: `Lot ${lotCode} belongs to another manufacturer`, shown: { code: "UNKNOWN_CODE" as const, message: unknownCodeMessage(lotCode) } };
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
        const shown = "shown" in r ? r.shown : r;
        return { ok: false, code: shown.code, message: shown.message };
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
    if (!r.ok) {
      const shown = "shown" in r ? r.shown : r;
      throw badRequest(shown.code, shown.message);
    }
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

// ---------------------------------------------------------------- public QR page (consumer check)
// The rules for what a consumer sees when a QR sticker is scanned, and what the scan audit keeps. HQ's
// trace.ts publicLookup (route /api/lookup/<code>?view=public) delegates here.

export interface PublicCheckResult {
  code: string;
  product: string;
  registered: boolean;
  flavour?: string;
  batchCode?: string;
  mfgDate?: string | null;
  expiryDate?: string | null;
  packType?: string;
  status: { label: string; tone: "ok" | "danger" | "warn" };
}

const PRODUCT = "Velza Beverage";
/** An unknown, malformed or void code: nothing about any product, batch or date. */
const unregistered = (code: string): PublicCheckResult => ({ code, product: PRODUCT, registered: false, status: publicStatus(false, null) });

/**
 * One phone re-opening the same page (refresh, back button, a second camera frame) is logged once per window, so it
 * cannot inflate the clone count. In memory only, never persisted, and keyed by the caller's client key (an IP from
 * the route) plus the code: no consumer identity reaches the store.
 */
export const PUBLIC_REPEAT_WINDOW_MS = 10 * 60_000;
const recentPublic = new Map<string, number>();
const RECENT_MAX = 20_000;

function isRepeatPublicScan(clientKey: string | null | undefined, code: string, nowMs: number): boolean {
  if (!clientKey) return false;
  const key = `${clientKey}|${code}`;
  const last = recentPublic.get(key);
  if (last !== undefined && nowMs - last < PUBLIC_REPEAT_WINDOW_MS) return true;
  if (recentPublic.size >= RECENT_MAX) {
    for (const [k, t] of recentPublic) if (nowMs - t >= PUBLIC_REPEAT_WINDOW_MS) recentPublic.delete(k);
    if (recentPublic.size >= RECENT_MAX) recentPublic.clear();
  }
  recentPublic.set(key, nowMs);
  return false;
}

/** For tests: forget the repeat-scan memory. */
export function resetPublicRepeatMemory() {
  recentPublic.clear();
}

/**
 * Consumer check of a scanned code. Only QC-passed stock in the chain is "Genuine" (rules.ts publicStatus allowlist).
 * Input that cannot be a Velza code is answered "Unregistered code" and not logged. Every other check is logged with
 * a public result code (rules.ts publicScanOutcome) that never raises a per-scan HQ alert; HQ is told through the
 * aggregated public alerts (alerts.ts computeCloneAlerts / computePublicSummaryAlerts).
 */
export async function publicCheck(rawCode: string, opts: { clientKey?: string | null; now?: Date } = {}): Promise<PublicCheckResult> {
  const input = publicScanInput(rawCode);
  if (!input.loggable) return unregistered(input.code);
  const { code } = input;
  const repeat = isRepeatPublicScan(opts.clientKey, code, (opts.now ?? new Date()).getTime());
  return getStore().transaction(async (tx) => {
    const found = await findItem(tx, code, null);
    const status = found.ok ? (found.item.kind === "LOT" ? found.item.lot.status : found.item.pack!.status) : null;
    if (!repeat) {
      const outcome = publicScanOutcome(code, status);
      await logScan(tx, { context: "PUBLIC_LOOKUP", code, actor: null, ok: outcome.ok, result: outcome.result, message: outcome.message });
    }
    if (!found.ok || status === "VOID") return unregistered(code);
    const { item } = found;
    const [batch, flavour] = await Promise.all([tx.batches.findOne({ code: item.lot.batchCode }), tx.flavours.findOne({ code: item.lot.flavour })]);
    return {
      code,
      product: PRODUCT,
      registered: true,
      flavour: flavour?.name ?? item.lot.flavour,
      batchCode: item.lot.batchCode,
      mfgDate: batch?.mfgDate ?? null,
      expiryDate: batch?.expiryDate ?? null,
      packType: item.kind === "LOT" ? item.lot.lotType : "PACK",
      status: publicStatus(true, status),
    };
  });
}
