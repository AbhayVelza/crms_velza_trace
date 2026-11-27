// Storage contract. Business logic and UI depend only on this interface; it is implemented over a
// JSON file (jsonStore.ts) and over PostgreSQL (sql/sqlStore.ts).

import type {
  Batch,
  BatchCodePoolEntry,
  Container,
  ContainerStatus,
  Country,
  DamageReport,
  Device,
  Flavour,
  ItemStatus,
  Lot,
  LotType,
  Movement,
  Pack,
  Partner,
  PrintOrder,
  Reprint,
  Scan,
  Sequence,
  Session,
  Settings,
  User,
} from "@/lib/core/types";

export interface Row {
  id: string;
}

/**
 * Filter on top-level fields: a value means equality, an array means "any of these" (maps to a SQL
 * WHERE a = ? AND b = ANY(?)). An empty array matches nothing. Array-valued fields take equality only.
 */
export type Where<T> = { [K in keyof T]?: T[K] | (T[K] extends readonly unknown[] ? never : readonly T[K][]) };

export interface Repo<T extends Row> {
  get(id: string): Promise<T | null>;
  findOne(where: Where<T>): Promise<T | null>;
  list(where?: Where<T>): Promise<T[]>;
  /** Whether any row matches (PostgreSQL: EXISTS, stops at the first row). */
  exists(where: Where<T>): Promise<boolean>;
  create(row: T): Promise<T>;
  createMany(rows: T[]): Promise<void>;
  update(id: string, patch: Partial<Omit<T, "id">>): Promise<T>;
  /**
   * Apply one patch to every row matching `where`, in one statement (bulk status changes: mark printed, sync).
   * Returns the ids of the changed rows, in insertion order. `where` must name at least one field (an empty
   * filter is refused rather than updating the whole table); an empty "any of" list matches nothing.
   */
  updateWhere(where: Where<T>, patch: Partial<Omit<T, "id">>): Promise<string[]>;
  /** Hard delete. Callers check references first; ledger tables have no delete. */
  delete(id: string): Promise<void>;
}

/** Time bound of a ledger read: only rows recorded at or after `since` (an ISO time). */
export interface LedgerReadOptions {
  since?: string;
}

/** Ledger tables: rows are appended, never updated or deleted. */
export interface AppendOnlyRepo<T extends Row> {
  /** `opts.since` bounds the read in time (on PostgreSQL only the history months from then on are read). */
  list(where?: Where<T>, opts?: LedgerReadOptions): Promise<T[]>;
  /** Whether any row matches (PostgreSQL: EXISTS, stops at the first row). */
  exists(where: Where<T>): Promise<boolean>;
  append(row: T): Promise<T>;
}

export type NewMovement = Omit<Movement, "id" | "at"> & Partial<Pick<Movement, "at">>;
export type NewScan = Omit<Scan, "id" | "at"> & Partial<Pick<Scan, "at">>;

export interface StoreTx {
  countries: Repo<Country>;
  flavours: Repo<Flavour>;
  partners: Repo<Partner>;
  users: Repo<User>;
  devices: Repo<Device>;
  batchCodePool: Repo<BatchCodePoolEntry>;
  batches: Repo<Batch>;
  printOrders: Repo<PrintOrder>;
  containers: Repo<Container>;
  lots: Repo<Lot>;
  packs: Repo<Pack>;
  movements: AppendOnlyRepo<Movement>;
  scans: AppendOnlyRepo<Scan>;
  reprints: AppendOnlyRepo<Reprint>;
  /** Damage reports (schema v11): one per DAMAGED movement, appended in the same transaction under its id. */
  damageReports: AppendOnlyRepo<DamageReport>;
  sessions: Repo<Session>;

  appendMovement(m: NewMovement): Promise<Movement>;
  /** Append several movements at once (multi-row inserts on PostgreSQL), in the given order. */
  appendMovements(ms: NewMovement[]): Promise<Movement[]>;
  appendScan(s: NewScan): Promise<Scan>;
  /**
   * Atomically reserve `count` consecutive lot numbers for a batch.
   * Returns the first number and advances the batch's nextLot. Numbers are never reused.
   */
  nextLotNumber(batchCode: string, count: number): Promise<number>;
  /** Atomically issue the next number of a named ID sequence (1, 2, 3 …). Numbers are never reused. */
  nextSequence(name: string): Promise<number>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Omit<Settings, "id">>): Promise<Settings>;

  /** The newest `limit` scans, newest first (ties: oldest recorded first). Reads only those rows, never the whole ledger. */
  recentScans(limit: number): Promise<Scan[]>;
  /**
   * The container sent to `toId` with one of `statuses` that carried `lotCode`; the most recently dispatched one if
   * several did (never dispatched last). An indexed lookup, never every container.
   */
  latestContainerWithLot(toId: string, lotCode: string, statuses: readonly ContainerStatus[]): Promise<Container | null>;
  /**
   * Live unit counts per location, status, kind, lot type, flavour and sync flag, without reading every code. On
   * PostgreSQL these come from the stock_summary / stock_deltas tables kept by triggers on `codes` (schema v9); the
   * JSON store counts its rows. Keys with no units are left out.
   */
  stockSummary(): Promise<StockSummaryRow[]>;
  /**
   * Whether the ledger holds any movement or scan that took place at this partner (a movement's place: the sender of a
   * dispatch, otherwise where it ended up; a scan's: the scanning partner). PostgreSQL: one EXISTS on the indexed
   * code_history.location_id. Used before a partner is deleted (the ledger is permanent).
   */
  historyAtPartner(partnerId: string): Promise<boolean>;
}

/** One line of the live stock summary: how many lot or pack codes share these attributes right now. */
export interface StockSummaryRow {
  locationId: string;
  status: ItemStatus;
  kind: "LOT" | "PACK";
  lotType: LotType;
  flavour: string;
  synced: boolean;
  units: number;
}

export interface DbSnapshot {
  countries: Country[];
  flavours: Flavour[];
  partners: Partner[];
  users: User[];
  devices: Device[];
  batchCodePool: BatchCodePoolEntry[];
  batches: Batch[];
  printOrders: PrintOrder[];
  containers: Container[];
  lots: Lot[];
  packs: Pack[];
  movements: Movement[];
  scans: Scan[];
  reprints: Reprint[];
  /**
   * Damage reports (schema v11). Left out (data written before v11): made from the DAMAGED movements on reset, as the
   * v11 upgrade does. Reports whose code or partner is not in the data are dropped on reset.
   */
  damageReports?: DamageReport[];
  sessions: Session[];
  sequences: Sequence[];
  settings: Settings[];
}

export const COLLECTIONS = [
  "countries",
  "flavours",
  "partners",
  "users",
  "devices",
  "batchCodePool",
  "batches",
  "printOrders",
  "containers",
  "lots",
  "packs",
  "movements",
  "scans",
  "reprints",
  "damageReports",
  "sessions",
  "sequences",
  "settings",
] as const satisfies readonly (keyof DbSnapshot)[];

export interface TransactionOptions {
  /**
   * Transactions with the same key run one after another across every app process (PostgreSQL: a
   * session advisory lock taken before BEGIN, so the transaction's snapshot is fresh). Used for code
   * allocation so concurrent print orders wait instead of failing. The JSON file and PGlite stores
   * already run one transaction at a time and ignore it.
   */
  lockKey?: string;
}

export interface Store extends StoreTx {
  /** Run `fn` atomically: all writes commit together or none do. */
  transaction<R>(fn: (tx: StoreTx) => Promise<R>, opts?: TransactionOptions): Promise<R>;
  /** Replace all data (used by the seed script, the JSON → database import and the chain conversion). */
  reset(data: DbSnapshot): Promise<void>;
  /** Every row of every table (backups, clear-activity, the JSON → database import). */
  snapshot(): Promise<DbSnapshot>;
  /** Cheapest proof the storage answers (GET /api/health): `SELECT 1` on the database, or the data file read. Throws if not. */
  ping(): Promise<void>;
}

/**
 * A write the storage layer refuses because it would break code integrity, whatever the caller:
 * a batch's lot counter moving backwards, deleting / renaming a code a print order issued, or a pack left following
 * a case/tray that is opened.
 */
export class IntegrityError extends Error {
  constructor(
    /**
     * LOT_OPENED_CONFLICT: a pack would follow a case/tray that is opened (Option C; PostgreSQL error VZ003). Not the
     * scan result LOT_OPENED ("this lot is opened, scan its packs"), which is a rule answer, not a storage refusal.
     */
    public code: "COUNTER_BACKWARDS" | "ISSUED_CODE_PROTECTED" | "LOT_OPENED_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** The JSON file changed on disk since this process read it (another process or an editor wrote it). */
export class ConcurrentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentWriteError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
