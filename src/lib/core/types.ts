// Domain types shared by core rules, the store and the UI.
// Partners and users are keyed by their readable IDs (DB0001, MF0001-OP), lots and packs by their
// printed code, everything else by a UUID. Timestamps are ISO strings.

export const PARTNER_TYPES = ["MANUFACTURER", "WAREHOUSE", "SS", "DB", "RETAILER"] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const PARTNER_TYPE_LABELS: Record<PartnerType, string> = {
  MANUFACTURER: "Manufacturer",
  WAREHOUSE: "Velza Warehouse",
  SS: "Super Stockist",
  DB: "Distributor",
  RETAILER: "Retailer",
};

export const ROLES = ["ADMIN", "OPERATOR", "QC", "WAREHOUSE", "SS", "DB", "RETAILER", "TRACE_OWNER"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Velza Admin",
  OPERATOR: "Manufacturer Operator",
  QC: "Supervisor/QC",
  WAREHOUSE: "Velza Warehouse",
  SS: "Super Stockist",
  DB: "Distributor",
  RETAILER: "Retailer",
  TRACE_OWNER: "Velza HQ",
};

/** Velza staff (no partner) belong to this organisation. */
export const VELZA_ORG_NAME = "Velza Global India";

/** Partner type a user of this role belongs to (null = Velza HQ, no partner). */
export const ROLE_PARTNER_TYPE: Record<Role, PartnerType | null> = {
  ADMIN: null,
  OPERATOR: "MANUFACTURER",
  QC: "MANUFACTURER",
  WAREHOUSE: "WAREHOUSE",
  SS: "SS",
  DB: "DB",
  RETAILER: "RETAILER",
  TRACE_OWNER: null,
};

export const LOT_TYPES = ["CASE", "TRAY"] as const;
export type LotType = (typeof LOT_TYPES)[number];
export type PackSize = 4 | 6;

export const MAIN_STATUSES = [
  "GENERATED",
  "PRINTED",
  "PACKED",
  "IN_TRANSIT",
  "AT_WAREHOUSE",
  "AT_SS",
  "AT_DB",
  "AT_RETAILER",
  "OPENED",
] as const;
export const EXCEPTION_STATUSES = ["QUARANTINED", "VOID", "DAMAGED", "RETURNED", "RECALLED"] as const;
export const ITEM_STATUSES = [...MAIN_STATUSES, ...EXCEPTION_STATUSES] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type ItemKind = "LOT" | "PACK";

export interface Country {
  id: string;
  code: string; // 2 digits, e.g. "91"
  name: string;
  active: boolean;
}

export interface Flavour {
  id: string;
  code: string; // 2 letters, e.g. "OR"
  name: string; // e.g. "Original"
  active: boolean;
}

/** A site in the chain, registered by Velza Admin. `id` is its partner ID, e.g. "DB0001". */
export interface Partner {
  id: string;
  type: PartnerType;
  name: string;
  /** Locality, e.g. "FC Road". */
  place: string;
  address: string;
  city: string;
  /** Indian state or union territory (one Super Stockist per state). */
  state: string;
  pincode: string;
  contactPerson: string;
  phone: string;
  email: string;
  /** The partner it is assigned to: DB → its SS, Retailer → its DB or (for a few retailers) its SS directly. */
  parentId: string | null;
  active: boolean;
  /**
   * Self sign-up approval. Absent / null = approved (every partner the Admin registered, and every Retailer).
   * PENDING = a Super Stockist or Distributor that signed itself up and waits for Velza Admin; REJECTED = turned
   * down. A pending or rejected partner is also inactive, so it cannot sign in, receive stock or be dispatched to.
   */
  approval?: PartnerApproval | null;
  createdAt: string;
  createdBy: string | null;
}

export type PartnerApproval = "PENDING" | "REJECTED";

/** A sign-in. `id` is the sign-in ID: the partner ID (DB0001), MF0001-OP / MF0001-QC, or AD0001 / HQ0001. */
export interface User {
  id: string;
  name: string;
  role: Role;
  partnerId: string | null;
  active: boolean;
  /** scrypt hash; null = no password set, cannot sign in. */
  passwordHash: string | null;
  passwordChangedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** User as sent to the browser: never includes the password hash. */
export type PublicUser = Omit<User, "passwordHash"> & { hasPassword: boolean };

/** Signed-in session. `id` is the SHA-256 of the cookie token, so a leaked database can't be replayed. */
export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** Last number issued by one ID sequence ("DB", "MF", "AD" …). */
export interface Sequence {
  id: string;
  value: number;
}

export interface Device {
  id: string;
  manufacturerId: string;
  name: string;
  offline: boolean;
  lastSyncAt: string | null;
}

export type PoolCodeStatus = "RESERVED" | "USED" | "RETURNED";

export interface BatchCodePoolEntry {
  id: string;
  code: string;
  deviceId: string;
  status: PoolCodeStatus;
  issuedAt: string;
  usedAt: string | null;
}

export type BatchStatus = "ACTIVE" | "RECALLED";

export interface Batch {
  id: string;
  code: string;
  country: string;
  flavour: string;
  mfgDate: string; // YYYY-MM-DD
  expiryDate: string; // YYYY-MM-DD
  manufacturerId: string;
  deviceId: string;
  nextLot: number; // next unallocated lot number (decimal)
  status: BatchStatus;
  synced: boolean;
  printOrderId: string;
  createdAt: string;
  createdBy: string;
  recalledAt: string | null;
  recallReason: string | null;
}

export type PrintOrderStatus = "CREATED" | "PRINTED";

/** NEW_BATCH = creates its batches; CONTINUATION = adds lots to an existing batch. Absent on orders made before 4 Nov 2026. */
export type PrintOrderKind = "NEW_BATCH" | "CONTINUATION";

export interface PrintOrder {
  /** The client's idempotency key (a UUID) for orders made since 4 Nov 2026. */
  id: string;
  createdAt: string;
  createdBy: string;
  deviceId: string;
  manufacturerId: string;
  batchCodes: string[];
  lotCodes: string[];
  stickerCount: number;
  status: PrintOrderStatus;
  printedAt: string | null;
  synced: boolean;
  kind?: PrintOrderKind | null;
  /** SHA-256 of the canonical request; a replay of the same key must match it exactly. */
  requestFingerprint?: string | null;
}

/** Cases and trays one shipping container holds at most. */
export const CONTAINER_CAPACITY = 2860;

export const CONTAINER_STATUSES = ["LOADING", "IN_TRANSIT", "RECEIVED"] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

/**
 * One trip of a shipping container from the manufacturer to the Velza Warehouse. `code` is the container's own
 * number (e.g. MSCU1234567), entered at the plant; a container is reused for many trips, so a number is unique
 * only among containers still loading or on the road. The operator scans cases and trays in (LOADING), dispatches
 * the container to a warehouse (IN_TRANSIT: every lot in it is dispatched), and the warehouse receives everything
 * still on the way in it with one scan of the container number (RECEIVED).
 */
export interface Container {
  id: string;
  code: string;
  manufacturerId: string;
  status: ContainerStatus;
  /** Lot (case/tray) codes loaded, in scan order. */
  lotCodes: string[];
  toId: string | null;
  invoice: string | null;
  createdAt: string;
  createdBy: string;
  dispatchedAt: string | null;
  dispatchedBy: string | null;
  receivedAt: string | null;
  receivedBy: string | null;
}

export interface Lot {
  id: string;
  lotCode: string;
  batchCode: string;
  flavour: string;
  lotType: LotType;
  packSize: PackSize;
  lotNumber: number;
  status: ItemStatus;
  locationId: string; // partner holding it (sender while IN_TRANSIT)
  inTransitToId: string | null;
  dispatchedAt: string | null;
  printOrderId: string;
  manufacturerId: string;
  deviceId: string;
  synced: boolean;
  quarantineReason: string | null;
  statusBeforeRecall: ItemStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface Pack {
  id: string;
  packCode: string;
  lotCode: string;
  seq: number;
  packSize: PackSize;
  status: ItemStatus;
  locationId: string;
  inTransitToId: string | null;
  dispatchedAt: string | null;
  statusBeforeRecall: ItemStatus | null;
  createdAt: string;
  updatedAt: string;
}

export const MOVEMENT_TYPES = [
  "GENERATED",
  "PRINTED",
  "VERIFIED",
  "QUARANTINED",
  "DISPATCHED",
  "RECEIVED",
  "OPENED",
  "REPRINTED",
  "VOIDED",
  "RECALLED",
  "DAMAGED",
  "SYNC",
  "POOL_ISSUED",
  /** A print-order sticker sheet was handed to a browser for first-time printing (one per request). */
  "PRINT_SHEET_SERVED",
  /** A logged reprint authorization was used to serve its sticker (once; the row id makes reuse impossible). */
  "REPRINT_SERVED",
  /** HQ acted on a computed alert (itemKind "ALERT", itemCode = the alert id, note = HQ's note). See core/alerts.ts. */
  "ALERT_ACKNOWLEDGED",
  "ALERT_CLOSED",
  "ALERT_REOPENED",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Append-only ledger row. Never updated or deleted. */
export interface Movement {
  id: string;
  at: string;
  type: MovementType;
  itemKind: ItemKind | "BATCH" | "DEVICE" | "PRINT_ORDER" | "ALERT";
  itemCode: string;
  fromId: string | null;
  toId: string | null;
  fromStatus: ItemStatus | null;
  toStatus: ItemStatus | null;
  userId: string | null;
  deviceId: string | null;
  invoice: string | null;
  note: string | null;
}

export const SCAN_CONTEXTS = ["VERIFY", "DISPATCH", "RECEIVE", "OPEN_LOT", "DAMAGE", "LOOKUP", "PUBLIC_LOOKUP", "CONTAINER"] as const;
export type ScanContext = (typeof SCAN_CONTEXTS)[number];

/** Scan audit row: every scan, success or failure. */
export interface Scan {
  id: string;
  at: string;
  context: ScanContext;
  code: string;
  ok: boolean;
  result: string; // "OK" or a RejectCode
  message: string;
  userId: string | null;
  partnerId: string | null;
  deviceId: string | null;
}

export interface Reprint {
  id: string;
  at: string;
  code: string;
  itemKind: ItemKind;
  reason: string;
  userId: string;
  deviceId: string | null;
  /** The print order that originally allocated the code (absent on reprints logged before 4 Nov 2026). */
  printOrderId?: string | null;
}

export interface StickerSize {
  widthMm: number;
  heightMm: number;
}

export interface Settings {
  id: string;
  notReceivedThresholdDays: number;
  demoMode: boolean; // when true the NOT_RECEIVED threshold is in minutes
  demoThresholdMinutes: number;
  lotSticker: StickerSize;
  packSticker: StickerSize;
  publicBaseUrl: string;
  poolIssueSize: number;
  poolRefillBelow: number;
  defaultCountry: string;
  /** PROVISIONAL — needs Velza business approval. Public-page scans of one code within the window that raise a SUSPECT_CLONE alert. */
  publicCloneScanThreshold?: number;
  /** PROVISIONAL — needs Velza business approval. Sliding window (hours) for publicCloneScanThreshold. */
  publicCloneWindowHours?: number;
}

export const DEFAULT_SETTINGS: Omit<Settings, "id"> = {
  notReceivedThresholdDays: 3,
  demoMode: false,
  demoThresholdMinutes: 5,
  lotSticker: { widthMm: 100, heightMm: 50 },
  packSticker: { widthMm: 75, heightMm: 25 },
  publicBaseUrl: "http://localhost:3000",
  poolIssueSize: 10,
  poolRefillBelow: 3,
  defaultCountry: "91",
  publicCloneScanThreshold: 5, // PROVISIONAL — needs Velza business approval
  publicCloneWindowHours: 24, // PROVISIONAL — needs Velza business approval
};
