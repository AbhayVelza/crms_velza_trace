// Status and movement rules. Pure: callers load the data, these functions decide.

import { buildPackCodes, PACKS_PER_LOT } from "./codes";
import type { ItemKind, ItemStatus, LotType, Partner, PartnerType } from "./types";

export const NEXT_TIER: Record<PartnerType, PartnerType | null> = {
  MANUFACTURER: "SS",
  SS: "DB",
  DB: "SUPPLIER",
  SUPPLIER: "OUTLET",
  OUTLET: null,
};

/** Status of an item sitting at a partner of this tier. */
export const AT_STATUS: Record<PartnerType, ItemStatus> = {
  MANUFACTURER: "PACKED",
  SS: "AT_SS",
  DB: "AT_DB",
  SUPPLIER: "AT_SUPPLIER",
  OUTLET: "AT_OUTLET",
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

export function nextTierOf(type: PartnerType): PartnerType | null {
  return NEXT_TIER[type];
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
 * Territory rule: a Super Stockist supplies only the distributors assigned to it
 * (distributor.parentId). Other tiers may supply any partner of the next tier.
 */
export function isAssignedDestination(sender: Pick<Partner, "id" | "type">, receiver: Pick<Partner, "type" | "parentId">): boolean {
  if (sender.type === "SS" && receiver.type === "DB") return receiver.parentId === sender.id;
  return true;
}

/** Destination and invoice checks that do not depend on the item. */
export function checkDispatchHeader(sender: Partner, receiver: Partner | null, invoice: string): RuleResult {
  const next = NEXT_TIER[sender.type];
  if (!next) return reject("NOT_ALLOWED", `${sender.name} is the last tier and cannot dispatch`);
  if (!receiver) return reject("WRONG_DESTINATION", "Choose a destination");
  if (receiver.type !== next) {
    return reject("WRONG_DESTINATION", `${sender.type} can only dispatch to ${next}, not ${receiver.type}`);
  }
  if (!isAssignedDestination(sender, receiver)) {
    return reject("WRONG_DESTINATION", `${receiver.name} is not one of ${sender.name}'s assigned distributors`);
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
  if (actor.type !== "SUPPLIER" && actor.type !== "OUTLET") {
    return reject("NOT_ALLOWED", "Only a Supplier or Outlet can open a lot");
  }
  const blocked = blockedResult(lot);
  if (blocked) return blocked;
  if (lot.status === "OPENED") return reject("WRONG_STATUS", `Lot ${lot.code} is already opened`);
  if (lot.locationId !== actor.id || lot.status !== AT_STATUS[actor.type]) {
    return reject("NOT_AT_LOCATION", `Lot ${lot.code} is not in stock at ${actor.name}`);
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
