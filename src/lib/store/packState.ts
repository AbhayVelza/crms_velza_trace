// Option C (schema v11): a pack of a sealed case/tray stores no state of its own and follows its lot. Shared by the
// JSON store and the PostgreSQL store, so both decide the same way which packs follow.
//
// The five state fields of a pack: all of them are the lot's while the pack follows it (stored as null), all of them
// its own once it has a state of its own (its lot was opened, or it was damaged / recalled on its own).

import type { DamageReport, Lot, Movement, Pack, Partner, User } from "@/lib/core/types";

export const PACK_STATE_FIELDS = ["status", "locationId", "inTransitToId", "dispatchedAt", "statusBeforeRecall"] as const;
export type PackStateField = (typeof PACK_STATE_FIELDS)[number];
export type PackState = Pick<Pack, PackStateField>;

/** A pack as stored: state fields null while it follows its lot. */
export type StoredPack = Omit<Pack, PackStateField | "followsLot"> & { [K in PackStateField]: Pack[K] | null };

const STATE_SET = new Set<string>(PACK_STATE_FIELDS);
export const isPackStateField = (field: string): field is PackStateField => STATE_SET.has(field);

/** A lot whose packs move one by one: opened, or recalled after it was opened (the schema's LOT_OPENED). */
export function lotIsOpened(lot: Pick<Lot, "status" | "statusBeforeRecall">): boolean {
  return lot.status === "OPENED" || (lot.status === "RECALLED" && lot.statusBeforeRecall === "OPENED");
}

/** The lot's state, as its following packs read it. */
export function lotState(lot: PackState): PackState {
  return { status: lot.status, locationId: lot.locationId, inTransitToId: lot.inTransitToId, dispatchedAt: lot.dispatchedAt, statusBeforeRecall: lot.statusBeforeRecall };
}

const sameState = (a: PackState, b: PackState) => PACK_STATE_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));

/**
 * Whether a pack written without an explicit `followsLot` follows its lot: its lot exists, is sealed, and the pack's
 * state equals the lot's. The same rule as the v10 → v11 upgrade, so seed data, old JSON files and snapshots taken
 * before Option C load the way an upgraded database looks.
 */
export function infersFollow(pack: PackState, lot: (PackState & Pick<Lot, "statusBeforeRecall">) | undefined | null): boolean {
  return !!lot && !lotIsOpened(lot) && sameState(pack, lot);
}

/**
 * A pack's own state always has a status and a place (the database: codes_pack_state_all_or_nothing). Clearing them
 * would make it follow its lot by accident, so a write of status or locationId null is refused on both stores; the
 * way to make a pack follow its lot is `followsLot: true`. (inTransitToId, dispatchedAt and statusBeforeRecall may
 * be null in an own state: a received pack has none.)
 */
export function assertOwnStateValues(patch: Partial<Record<PackStateField, unknown>>): void {
  for (const f of ["status", "locationId"] as const) {
    if (Object.hasOwn(patch, f) && patch[f] === null) {
      throw new Error(`packs: ${f} can't be set to null (a pack's own state has a status and a place) — write followsLot: true to make a pack follow its lot`);
    }
  }
}

/** What a written pack stores: null state when it follows (explicitly, or inferred), its own state otherwise. */
export function toStoredPack(pack: Pack, lot: Lot | undefined | null): StoredPack {
  const { followsLot, ...rest } = pack;
  const follows = followsLot ?? (pack.status === null || infersFollow(pack, lot));
  if (!follows) {
    assertOwnStateValues(rest);
    return rest;
  }
  return { ...rest, status: null, locationId: null, inTransitToId: null, dispatchedAt: null, statusBeforeRecall: null };
}

/** The pack as the app reads it: the lot's state while it follows (followsLot true), its own otherwise. */
export function effectivePack(stored: StoredPack, lot: Lot | undefined | null): Pack {
  if (stored.status !== null) return { ...(stored as Omit<Pack, "followsLot">), followsLot: false };
  // A following pack whose lot is missing (never in committed data: codes.lot_code is a foreign key).
  const state = lot ? lotState(lot) : { status: stored.status, locationId: stored.locationId, inTransitToId: null, dispatchedAt: null, statusBeforeRecall: null };
  return { ...(stored as Omit<Pack, "followsLot">), ...(state as PackState), followsLot: true };
}

/**
 * The patch a pack update stores. Writing any state field (or `followsLot: false`) gives a following pack a state of
 * its own: the fields the patch leaves out are copied from its lot first, so the pack keeps the lot's place. Writing
 * `followsLot: true` clears its state (it follows its lot again). A patch without state fields leaves following alone.
 */
export function packPatchToStore(current: StoredPack, lot: Lot | undefined | null, patch: Partial<Omit<Pack, "id">>): Partial<StoredPack> {
  const { followsLot, ...rest } = patch;
  assertOwnStateValues(rest);
  const touchesState = Object.keys(rest).some((k) => isPackStateField(k) && (rest as Record<string, unknown>)[k] !== undefined);
  if (followsLot === true) {
    if (touchesState) throw new Error(`Pack ${current.packCode}: a pack that follows its lot takes no state of its own`);
    return { ...rest, status: null, locationId: null, inTransitToId: null, dispatchedAt: null, statusBeforeRecall: null };
  }
  if (!touchesState && followsLot !== false) return rest;
  if (current.status !== null) return rest; // already has a state of its own
  const base = lot ? lotState(lot) : ({} as PackState);
  const own: Partial<StoredPack> = { ...base };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (own as Record<string, unknown>)[k] = v;
  return own;
}

/** The error both stores give for a pack that would follow an opened lot (PostgreSQL: VZ003). */
export const LOT_OPENED_MESSAGE = (lotCode: string) =>
  `Case/tray ${lotCode} is opened: its packs move one by one and each needs a state of its own. Nothing was saved — please try again.`;

// ---------------------------------------------------------------- damage reports

const PACKS_IN = { CASE: 4, TRAY: 6 } as const;

/**
 * Damage reports made from DAMAGED movements, for data written before the app kept them (old JSON files, seed data,
 * snapshots taken before v11): the same rules as the v11 upgrade. A report needs a code and a reporting partner that
 * exist; a pack counts 1, an opened lot the packs of it damaged at the reporter (at least 1), a sealed case 4, a tray 6.
 */
export function damageReportsFromMovements(data: { movements: Movement[]; lots: Lot[]; packs: Pack[]; partners: Partner[]; users: User[] }): DamageReport[] {
  const lotByCode = new Map(data.lots.map((l) => [l.lotCode, l]));
  const packCodes = new Set(data.packs.map((p) => p.packCode));
  const partners = new Set(data.partners.map((p) => p.id));
  const users = new Set(data.users.map((u) => u.id));
  const out: DamageReport[] = [];
  for (const m of data.movements) {
    if (m.type !== "DAMAGED" || !m.fromId || !partners.has(m.fromId)) continue;
    const lot = lotByCode.get(m.itemCode);
    const isPack = !lot && packCodes.has(m.itemCode);
    if (!lot && !isPack) continue;
    const packsAffected = isPack
      ? 1
      : m.fromStatus === "OPENED"
        ? Math.max(1, data.packs.filter((p) => p.lotCode === m.itemCode && p.status === "DAMAGED" && p.locationId === m.fromId).length)
        : PACKS_IN[lot!.lotType];
    out.push({
      id: m.id,
      code: m.itemCode,
      itemKind: (m.itemKind === "LOT" || m.itemKind === "PACK" ? m.itemKind : isPack ? "PACK" : "LOT"),
      partnerId: m.fromId,
      reason: m.note?.trim() || "(no reason recorded)",
      packsAffected,
      reportedBy: m.userId && users.has(m.userId) ? m.userId : null,
      reportedAt: m.at,
    });
  }
  return out;
}

/** Damage reports a reset keeps: those whose code and partner are in the data (the database's foreign keys). */
export function damageReportsFor(data: { damageReports?: DamageReport[]; movements: Movement[]; lots: Lot[]; packs: Pack[]; partners: Partner[]; users: User[] }): DamageReport[] {
  if (!data.damageReports) return damageReportsFromMovements(data);
  const codes = new Set([...data.lots.map((l) => l.lotCode), ...data.packs.map((p) => p.packCode)]);
  const partners = new Set(data.partners.map((p) => p.id));
  const users = new Set(data.users.map((u) => u.id));
  return data.damageReports
    .filter((r) => codes.has(r.code) && partners.has(r.partnerId))
    .map((r) => ({ ...r, reportedBy: r.reportedBy && users.has(r.reportedBy) ? r.reportedBy : null }));
}
