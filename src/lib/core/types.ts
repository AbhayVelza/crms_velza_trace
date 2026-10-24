// Domain types shared by core rules, the store and the UI.
// IDs are string UUIDs and timestamps are ISO strings so rows map 1:1 to future DB tables.

export const PARTNER_TYPES = ["MANUFACTURER", "SS", "DB", "SUPPLIER", "OUTLET"] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const PARTNER_TYPE_LABELS: Record<PartnerType, string> = {
  MANUFACTURER: "Manufacturer",
  SS: "Super Stockist",
  DB: "Distributor",
  SUPPLIER: "Supplier",
  OUTLET: "Outlet",
};

export const ROLES = ["ADMIN", "OPERATOR", "QC", "SS", "DB", "SUPPLIER", "OUTLET", "TRACE_OWNER"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Velza Admin",
  OPERATOR: "Manufacturer Operator",
  QC: "Supervisor/QC",
  SS: "Super Stockist",
  DB: "Distributor",
  SUPPLIER: "Supplier",
  OUTLET: "Outlet",
  TRACE_OWNER: "Traceability Owner",
};

/** Partner type a user of this role belongs to (null = Velza HQ, no partner). */
export const ROLE_PARTNER_TYPE: Record<Role, PartnerType | null> = {
  ADMIN: null,
  OPERATOR: "MANUFACTURER",
  QC: "MANUFACTURER",
  SS: "SS",
  DB: "DB",
  SUPPLIER: "SUPPLIER",
  OUTLET: "OUTLET",
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
  "AT_SS",
  "AT_DB",
  "AT_SUPPLIER",
  "AT_OUTLET",
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

export interface Partner {
  id: string;
  type: PartnerType;
  name: string;
  city: string;
  active: boolean;
}

export interface User {
  id: string;
  name: string;
  role: Role;
  partnerId: string | null;
  active: boolean;
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

export interface PrintOrder {
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
  "SYNC",
  "POOL_ISSUED",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Append-only ledger row. Never updated or deleted. */
export interface Movement {
  id: string;
  at: string;
  type: MovementType;
  itemKind: ItemKind | "BATCH" | "DEVICE" | "PRINT_ORDER";
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

export const SCAN_CONTEXTS = ["VERIFY", "DISPATCH", "RECEIVE", "OPEN_LOT", "LOOKUP", "PUBLIC_LOOKUP"] as const;
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
};
