// Shared service helpers: errors, actor resolution, item lookup with sync visibility.

import { parseCode, type ParsedCode } from "@/lib/core/codes";
import { can, type Action } from "@/lib/core/permissions";
import type { MovableItem, RejectCode } from "@/lib/core/rules";
import type { Device, Lot, Pack, Partner, PublicUser, Role, ScanContext, User } from "@/lib/core/types";
import type { StoreTx } from "@/lib/store";

export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ServiceError(400, code, message, details);
export const notFound = (message: string) => new ServiceError(404, "NOT_FOUND", message);
export const forbidden = (message: string) => new ServiceError(403, "FORBIDDEN", message);

export interface Actor {
  user: User;
  role: Role;
  partner: Partner | null;
}

export const notSignedIn = (message = "Please sign in") => new ServiceError(401, "NOT_SIGNED_IN", message);

/** The signed-in user. Re-checked on every request, so disabling a sign-in or its partner takes effect at once. */
export async function loadActor(tx: StoreTx, userId: string | null | undefined): Promise<Actor> {
  if (!userId) throw notSignedIn();
  const user = await tx.users.get(userId);
  if (!user || !user.active) throw notSignedIn("Your sign-in is no longer active — contact Velza Admin");
  const partner = user.partnerId ? await tx.partners.get(user.partnerId) : null;
  if (partner && !partner.active) throw notSignedIn(`${partner.name} is inactive — contact Velza Admin`);
  return { user, role: user.role, partner };
}

export function requireAction(actor: Actor, action: Action) {
  if (!can(actor.role, action)) throw forbidden(`${actor.user.name} (${actor.role}) is not allowed to ${action}`);
}

export function requirePartner(actor: Actor): Partner {
  if (!actor.partner) throw forbidden(`${actor.user.name} is not linked to a partner`);
  return actor.partner;
}

export async function manufacturerDevice(tx: StoreTx, manufacturerId: string, deviceId?: string | null): Promise<Device> {
  const devices = await tx.devices.list({ manufacturerId });
  const device = deviceId ? devices.find((d) => d.id === deviceId) : devices[0];
  if (!device) throw badRequest("NO_DEVICE", "No device registered for this manufacturer");
  return device;
}

/**
 * The plant PC a print operation (print order, continuation, reprint, void, sync, print confirmation) runs on.
 * The screen sends the PC chosen as "This PC" in the device bar; the server checks it belongs to the operator's
 * manufacturer. Without one, a plant with a single PC uses it; a plant with several is refused (409
 * DEVICE_REQUIRED) instead of silently booking the work, its pool codes and its sync state on the first PC.
 */
export async function printDevice(tx: StoreTx, manufacturerId: string, deviceId?: string | null): Promise<Device> {
  const devices = await tx.devices.list({ manufacturerId });
  if (deviceId) {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) throw badRequest("NO_DEVICE", "This PC is not registered for your plant — choose This PC again in the device bar");
    return device;
  }
  if (!devices.length) throw badRequest("NO_DEVICE", "No device registered for this manufacturer");
  if (devices.length > 1) {
    throw new ServiceError(409, "DEVICE_REQUIRED", `Your plant has ${devices.length} PCs — choose This PC in the device bar first, so the work is recorded on the right PC`);
  }
  return devices[0];
}

export async function parseOptions(tx: StoreTx) {
  const [countries, flavours] = await Promise.all([tx.countries.list({ active: true }), tx.flavours.list()]);
  return { countries: countries.map((c) => c.code), flavours: flavours.map((f) => f.code) };
}

export function isVisible(lot: Pick<Lot, "synced" | "manufacturerId">, viewerPartnerId: string | null): boolean {
  return lot.synced || viewerPartnerId === lot.manufacturerId;
}

export interface FoundItem {
  parsed: ParsedCode;
  kind: "LOT" | "PACK";
  lot: Lot;
  pack: Pack | null;
  movable: MovableItem;
  parentLotStatus: Lot["status"] | null;
}

export type FindResult = { ok: true; item: FoundItem } | { ok: false; code: RejectCode; message: string };

/**
 * Resolve a scanned code to its lot/pack. Codes never generated, malformed, or
 * not yet synced (for anyone outside the owning manufacturer) are UNKNOWN_CODE.
 */
/**
 * What a code that does not exist looks like. Codes of another manufacturer get exactly the same answer, so a
 * partner cannot learn that someone else's code exists (or its status) by trying it.
 */
export const unknownCodeMessage = (code: string) => `Unknown code ${code}: never generated`;

export async function findItem(tx: StoreTx, code: string, viewerPartnerId: string | null): Promise<FindResult> {
  const parsed = parseCode(code, await parseOptions(tx));
  if (!parsed.ok) return { ok: false, code: "UNKNOWN_CODE", message: `Unknown code ${code || "(empty)"}: ${parsed.error.message}` };
  const p = parsed.value;
  const lot = await tx.lots.findOne({ lotCode: p.lotCode });
  if (!lot) return { ok: false, code: "UNKNOWN_CODE", message: unknownCodeMessage(code) };
  if (!isVisible(lot, viewerPartnerId)) {
    return { ok: false, code: "UNKNOWN_CODE", message: `Unknown code ${code}: not synced yet` };
  }
  if (p.kind === "LOT") {
    return {
      ok: true,
      item: {
        parsed: p,
        kind: "LOT",
        lot,
        pack: null,
        parentLotStatus: null,
        movable: { kind: "LOT", code: lot.lotCode, status: lot.status, locationId: lot.locationId, inTransitToId: lot.inTransitToId, synced: lot.synced },
      },
    };
  }
  const pack = await tx.packs.findOne({ packCode: code });
  if (!pack) return { ok: false, code: "UNKNOWN_CODE", message: unknownCodeMessage(code) };
  return {
    ok: true,
    item: {
      parsed: p,
      kind: "PACK",
      lot,
      pack,
      parentLotStatus: lot.status,
      movable: { kind: "PACK", code: pack.packCode, status: pack.status, locationId: pack.locationId, inTransitToId: pack.inTransitToId, synced: lot.synced },
    },
  };
}

export async function logScan(
  tx: StoreTx,
  args: { context: ScanContext; code: string; actor: Actor | null; ok: boolean; result: string; message: string; deviceId?: string | null },
) {
  return tx.appendScan({
    context: args.context,
    code: args.code,
    ok: args.ok,
    result: args.result,
    message: args.message,
    userId: args.actor?.user.id ?? null,
    partnerId: args.actor?.partner?.id ?? null,
    deviceId: args.deviceId ?? null,
  });
}

export const nowIso = () => new Date().toISOString();

/**
 * Apply a status change to a lot (Option C, schema v11). The packs of a sealed case/tray follow it: only the lot row
 * is written, and its following packs read the new state through it. Opening it (status OPENED) first gives each
 * following pack the lot's state as it is now, in the same transaction, so from then on they move one by one. A pack
 * that already has a state of its own (damaged or recalled on its own inside a sealed lot) keeps it.
 */
export async function setLotState(tx: StoreTx, lot: Lot, patch: Partial<Lot>, at: string) {
  if (patch.status === "OPENED") await tx.packs.updateWhere({ lotCode: lot.lotCode, followsLot: true }, { followsLot: false, updatedAt: at });
  return tx.lots.update(lot.id, { ...patch, updatedAt: at });
}

/** Strip the password hash before a user row leaves the server. */
export function publicUser({ passwordHash, ...u }: User): PublicUser {
  return { ...u, hasPassword: !!passwordHash };
}

export function partnerName(partners: Partner[], id: string | null | undefined): string | null {
  if (!id) return null;
  return partners.find((p) => p.id === id)?.name ?? id;
}
