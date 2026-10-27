// Status and movement rules. Pure: callers load the data, these functions decide.

import { buildPackCodes, PACKS_PER_LOT } from "./codes";
import { PARTNER_TYPES, type ItemKind, type ItemStatus, type LotType, type Partner, type PartnerType } from "./types";

/**
 * Distribution line: Manufacturer → Super Stockist → Distributor → Retailer. A few retailers are supplied
 * by their Super Stockist directly (Manufacturer → Super Stockist → Retailer). Retailers are the last tier.
 */
export const DESTINATION_TYPES: Record<PartnerType, PartnerType[]> = {
  MANUFACTURER: ["SS"],
  SS: ["DB", "RETAILER"],
  DB: ["RETAILER"],
  RETAILER: [],
};

/** Status of an item sitting at a partner of this tier. */
export const AT_STATUS: Record<PartnerType, ItemStatus> = {
  MANUFACTURER: "PACKED",
  SS: "AT_SS",
  DB: "AT_DB",
  RETAILER: "AT_RETAILER",
};

/** Scanning one of these raises a BLOCKED_CODE alert. */
export const BLOCKED_STATUSES: ItemStatus[] = ["RECALLED", "QUARANTINED", "VOID"];
/** Exception statuses: the item cannot move. */
export const STOPPED_STATUSES: ItemStatus[] = ["RECALLED", "QUARANTINED", "VOID", "DAMAGED", "RETURNED"];

export const ALERT_RESULT_CODES = ["WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE"] as const;

export type RejectCode =
  | "INVALID_CODE"
  | "UNKNOWN_CODE"
  | "WRONG_RECEIVER"
  | "DUPLICATE_RECEIPT"
  | "BLOCKED_CODE"
  | "UNSYNCED"
  | "NOT_AT_LOCATION"
  | "WRONG_STATUS"
  | "WRONG_DESTINATION"
  | "INVOICE_REQUIRED"
  | "LOT_SEALED"
  | "LOT_OPENED"
  | "WRONG_LOT"
  | "DUPLICATE_SCAN"
  | "NOT_PRINTED"
  | "INCOMPLETE"
  | "REASON_REQUIRED"
  | "NOT_ALLOWED";

export type RuleResult = { ok: true } | { ok: false; code: RejectCode; message: string };

const OK: RuleResult = { ok: true };
const reject = (code: RejectCode, message: string): RuleResult => ({ ok: false, code, message });

/** Minimal view of a lot or pack that movement rules need. */
export interface MovableItem {
  kind: ItemKind;
  code: string;
  status: ItemStatus;
  locationId: string;
  inTransitToId: string | null;
  synced: boolean;
}

export function isBlocked(status: ItemStatus): boolean {
  return BLOCKED_STATUSES.includes(status);
}

function blockedResult(item: MovableItem): RuleResult | null {
  if (isBlocked(item.status)) return reject("BLOCKED_CODE", `${item.code} is ${item.status} and must not move`);
  if (STOPPED_STATUSES.includes(item.status)) return reject("WRONG_STATUS", `${item.code} is ${item.status}`);
  return null;
}

/** A pack moves on its own only after its lot is OPENED; a lot stops moving once opened. */
function sealRule(item: MovableItem, parentLotStatus: ItemStatus | null): RuleResult | null {
  if (item.kind === "PACK" && parentLotStatus !== "OPENED") {
    return reject("LOT_SEALED", `Pack ${item.code} is inside a sealed lot — scan the lot code instead`);
  }
  if (item.kind === "LOT" && item.status === "OPENED") {
    return reject("LOT_OPENED", `Lot ${item.code} is opened — scan its packs individually`);
  }
  return null;
}

// ---------------------------------------------------------------- dispatch

export interface DispatchCheckInput {
  item: MovableItem;
  parentLotStatus: ItemStatus | null; // for packs: the lot's status
  sender: Partner;
  receiver: Partner | null;
  invoice: string;
}

/**
 * Assignment chain (partner.parentId): each Distributor is assigned to one Super Stockist; each Retailer to
 * one Distributor, or to its Super Stockist directly. Super Stockists are not assigned: the manufacturer may
 * supply any of them.
 */
export const ASSIGNED_TO: Partial<Record<PartnerType, PartnerType[]>> = { DB: ["SS"], RETAILER: ["DB", "SS"] };

export const ASSIGNED_PLURAL: Partial<Record<PartnerType, string>> = { DB: "distributors", RETAILER: "retailers" };

/** The tiers whose partners can be assigned to a partner of this type: SS → Distributors and Retailers, DB → Retailers. */
export function assignedTypesOf(type: PartnerType): PartnerType[] {
  return PARTNER_TYPES.filter((t) => ASSIGNED_TO[t]?.includes(type));
}

/** "distributors and retailers" for an SS, "retailers" for a DB, "" for tiers nobody is assigned to. */
export function assignedPluralOf(type: PartnerType): string {
  return assignedTypesOf(type)
    .map((t) => ASSIGNED_PLURAL[t])
    .join(" and ");
}

/** A sender may supply only the partners assigned to it (when the receiver's tier is assigned at all). */
export function isAssignedDestination(sender: Pick<Partner, "id" | "type">, receiver: Pick<Partner, "type" | "parentId">): boolean {
  if (ASSIGNED_TO[receiver.type]?.includes(sender.type)) return receiver.parentId === sender.id;
  return true;
}

/** Destination and invoice checks that do not depend on the item. */
export function checkDispatchHeader(sender: Partner, receiver: Partner | null, invoice: string): RuleResult {
  const allowed = DESTINATION_TYPES[sender.type];
  if (!allowed.length) return reject("NOT_ALLOWED", `${sender.name} is the last tier and cannot dispatch`);
  if (!receiver) return reject("WRONG_DESTINATION", "Choose a destination");
  if (!receiver.active) return reject("WRONG_DESTINATION", `${receiver.name} is inactive and can't receive stock`);
  if (!allowed.includes(receiver.type)) {
    return reject("WRONG_DESTINATION", `${sender.type} can only dispatch to ${allowed.join(" or ")}, not ${receiver.type}`);
  }
  if (!isAssignedDestination(sender, receiver)) {
    return reject("WRONG_DESTINATION", `${receiver.name} is not one of ${sender.name}'s assigned ${ASSIGNED_PLURAL[receiver.type]}`);
  }
  if (!invoice.trim()) return reject("INVOICE_REQUIRED", "Invoice/challan number is required");
  return OK;
}

export function canDispatch({ item, parentLotStatus, sender, receiver, invoice }: DispatchCheckInput): RuleResult {
  const header = checkDispatchHeader(sender, receiver, invoice);
  if (!header.ok) return header;
  if (!item.synced) return reject("UNSYNCED", `${item.code} is not synced yet — sync the device before dispatch`);
  const blocked = blockedResult(item);
  if (blocked) return blocked;
  const seal = sealRule(item, parentLotStatus);
  if (seal) return seal;
  if (item.status === "IN_TRANSIT") return reject("WRONG_STATUS", `${item.code} is already in transit`);
  if (item.locationId !== sender.id) return reject("NOT_AT_LOCATION", `${item.code} is not at ${sender.name}`);
  const expected = AT_STATUS[sender.type];
  if (item.status !== expected) {
    const hint = item.status === "PRINTED" || item.status === "GENERATED" ? " — verify it first" : "";
    return reject("WRONG_STATUS", `${item.code} is ${item.status}, must be ${expected}${hint}`);
  }
  return OK;
}

export function dispatchPatch(receiverId: string, at: string) {
  return { status: "IN_TRANSIT" as ItemStatus, inTransitToId: receiverId, dispatchedAt: at };
}

// ---------------------------------------------------------------- receive

export interface ReceiveCheckInput {
  item: MovableItem;
  parentLotStatus: ItemStatus | null;
  receiver: Partner;
}

export function canReceive({ item, parentLotStatus, receiver }: ReceiveCheckInput): RuleResult {
  const blocked = blockedResult(item);
  if (blocked) return blocked;
  if (item.kind === "PACK" && parentLotStatus !== "OPENED") {
    return reject("LOT_SEALED", `Pack ${item.code} is inside a sealed lot — scan the lot code instead`);
  }
  if (item.status === "IN_TRANSIT" && item.inTransitToId === receiver.id) return OK;
  if (item.status !== "IN_TRANSIT" && item.locationId === receiver.id) {
    return reject("DUPLICATE_RECEIPT", `${item.code} was already received at ${receiver.name}`);
  }
  return reject("WRONG_RECEIVER", `${item.code} is not in transit to ${receiver.name}`);
}

export function receivePatch(receiver: Partner) {
  return { status: AT_STATUS[receiver.type], locationId: receiver.id, inTransitToId: null, dispatchedAt: null };
}

// ---------------------------------------------------------------- verify

export interface VerifiableLot {
  lotCode: string;
  lotType: LotType;
  status: ItemStatus;
}

export function canStartVerification(lot: VerifiableLot): RuleResult {
  if (isBlocked(lot.status)) return reject("BLOCKED_CODE", `Lot ${lot.lotCode} is ${lot.status}`);
  if (lot.status === "GENERATED") return reject("NOT_PRINTED", `Lot ${lot.lotCode} has not been printed yet`);
  if (lot.status !== "PRINTED") return reject("WRONG_STATUS", `Lot ${lot.lotCode} is ${lot.status}, already verified`);
  return OK;
}

/** Live check for one pack scan during verification. */
export function checkVerifyPackScan(lot: VerifiableLot, packCode: string, alreadyScanned: string[]): RuleResult {
  const expected = buildPackCodes(lot.lotCode, lot.lotType);
  if (!expected.includes(packCode)) {
    return reject("WRONG_LOT", `${packCode} does not belong to lot ${lot.lotCode}`);
  }
  if (alreadyScanned.includes(packCode)) return reject("DUPLICATE_SCAN", `${packCode} was already scanned`);
  return OK;
}

/** Final pass/fail. Pass → PACKED, fail → QUARANTINED with the returned reason. */
export function evaluateVerification(lot: VerifiableLot, packCodes: string[]): { pass: true } | { pass: false; reason: string } {
  const start = canStartVerification(lot);
  if (!start.ok) return { pass: false, reason: start.message };
  const expected = buildPackCodes(lot.lotCode, lot.lotType);
  const problems: string[] = [];
  const need = PACKS_PER_LOT[lot.lotType];
  if (packCodes.length !== need) problems.push(`expected ${need} packs, scanned ${packCodes.length}`);
  const foreign = packCodes.filter((c) => !expected.includes(c));
  if (foreign.length) problems.push(`not from this lot: ${foreign.join(", ")}`);
  const dupes = packCodes.filter((c, i) => packCodes.indexOf(c) !== i);
  if (dupes.length) problems.push(`duplicates: ${[...new Set(dupes)].join(", ")}`);
  const missing = expected.filter((c) => !packCodes.includes(c));
  if (missing.length) problems.push(`missing: ${missing.join(", ")}`);
  return problems.length ? { pass: false, reason: problems.join("; ") } : { pass: true };
}

// ---------------------------------------------------------------- open, void, reprint, recall

export function canOpenLot(lot: MovableItem, actor: Partner): RuleResult {
  if (actor.type !== "RETAILER") {
    return reject("NOT_ALLOWED", "Only a Retailer can open a lot");
  }
  const blocked = blockedResult(lot);
  if (blocked) return blocked;
  if (lot.status === "OPENED") return reject("WRONG_STATUS", `Lot ${lot.code} is already opened`);
  if (lot.locationId !== actor.id || lot.status !== AT_STATUS[actor.type]) {
    return reject("NOT_AT_LOCATION", `Lot ${lot.code} is not in stock at ${actor.name}`);
  }
  return OK;
}

// ---------------------------------------------------------------- damaged

export interface DamageCheckInput {
  item: MovableItem;
  parentLotStatus: ItemStatus | null; // for packs: the lot's status
  partner: Partner;
  reason: string;
  packsHere?: number; // for an opened lot: its packs still in stock at the partner
}

/**
 * Any partner holding stock reports damaged units; they stop moving for good and leave its stock.
 * A case or tray is reported whole by its lot code, sealed or opened (then: its packs still here);
 * single packs only after the lot is opened.
 */
export function canReportDamaged({ item, parentLotStatus, partner, reason, packsHere = 0 }: DamageCheckInput): RuleResult {
  if (!reason.trim()) return reject("REASON_REQUIRED", "Say what is damaged (e.g. crushed, leaking)");
  if (item.status === "DAMAGED") return reject("WRONG_STATUS", `${item.code} is already reported damaged`);
  const blocked = blockedResult(item);
  if (blocked) return blocked;
  if (item.kind === "PACK" && parentLotStatus !== "OPENED") {
    const open = partner.type === "RETAILER" ? ", or open the lot first" : "";
    return reject("LOT_SEALED", `Pack ${item.code} is inside a sealed case or tray — report the whole lot by its lot code${open}`);
  }
  if (item.kind === "LOT" && item.status === "OPENED") {
    // Opened or not, a case/tray is reported whole: the packs of it still in stock here.
    if (item.locationId !== partner.id) {
      const hint = packsHere ? ` — report its ${packsHere} pack(s) here one by one` : "";
      return reject("NOT_AT_LOCATION", `${item.code} was opened before it reached ${partner.name}${hint}`);
    }
    if (!packsHere) return reject("NOT_AT_LOCATION", `None of the packs of ${item.code} are in stock at ${partner.name} any more`);
    return OK;
  }
  if (item.status === "IN_TRANSIT") {
    const hint = item.inTransitToId === partner.id ? " — receive it first, then report the damage" : "";
    return reject("NOT_AT_LOCATION", `${item.code} is in transit${hint}`);
  }
  if (item.locationId !== partner.id || item.status !== AT_STATUS[partner.type]) {
    const hint = item.status === "PRINTED" || item.status === "GENERATED" ? " — not packed yet: use Void lot or Reprint instead" : "";
    return reject("NOT_AT_LOCATION", `${item.code} is not in stock at ${partner.name}${hint}`);
  }
  return OK;
}

export const VOIDABLE_STATUSES: ItemStatus[] = ["GENERATED", "PRINTED", "QUARANTINED"];

export function canVoid(lot: { lotCode: string; status: ItemStatus }): RuleResult {
  if (lot.status === "VOID") return reject("WRONG_STATUS", `Lot ${lot.lotCode} is already VOID`);
  if (!VOIDABLE_STATUSES.includes(lot.status)) {
    return reject("WRONG_STATUS", `Only unpasted or misprinted lots can be voided; ${lot.lotCode} is ${lot.status}`);
  }
  return OK;
}

export const REPRINTABLE_STATUSES: ItemStatus[] = ["GENERATED", "PRINTED", "PACKED", "QUARANTINED"];

export function canReprint(item: { code: string; status: ItemStatus }, reason: string): RuleResult {
  if (!reason.trim()) return reject("REASON_REQUIRED", "A reason is required to reprint");
  if (!REPRINTABLE_STATUSES.includes(item.status)) {
    return reject("WRONG_STATUS", `${item.code} is ${item.status}; only stickers still at the manufacturer can be reprinted`);
  }
  return OK;
}

/**
 * A quarantined lot comes back only through a reprint: reprinting its lot or a pack sticker (with a reason)
 * sends the whole lot back to PRINTED, so QC must verify it again before it is PACKED. Voiding it ends it.
 */
export function lotStatusAfterReprint(lotStatus: ItemStatus): ItemStatus {
  return lotStatus === "QUARANTINED" ? "PRINTED" : lotStatus;
}

/** Recall moves every lot/pack of the batch to RECALLED, except VOID ones which never left the factory. */
export function recallPatch(status: ItemStatus): { status: ItemStatus; statusBeforeRecall: ItemStatus } | null {
  if (status === "VOID" || status === "RECALLED") return null;
  return { status: "RECALLED", statusBeforeRecall: status };
}

/** Packs mirror their lot's status until the lot is opened. */
export function packStatusForLot(lotStatus: ItemStatus, currentPackStatus: ItemStatus): ItemStatus {
  return lotStatus === "OPENED" ? currentPackStatus : lotStatus;
}

/** Customer-facing status line for the public lookup page. */
export function publicStatus(found: boolean, status: ItemStatus | null): { label: string; tone: "ok" | "danger" | "warn" } {
  if (!found || !status) return { label: "Unregistered code", tone: "warn" };
  if (status === "RECALLED") return { label: "Recalled — do not consume", tone: "danger" };
  if (status === "VOID") return { label: "Unregistered code", tone: "warn" };
  if (status === "QUARANTINED" || status === "DAMAGED") return { label: "Not for sale — do not consume", tone: "danger" };
  return { label: "Genuine Velza product", tone: "ok" };
}
