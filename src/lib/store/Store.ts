// Storage contract. Business logic and UI depend only on this interface; it is implemented over a
// JSON file (jsonStore.ts) and over PostgreSQL (sql/sqlStore.ts).

import type {
  Batch,
  BatchCodePoolEntry,
  Country,
  Device,
  Flavour,
  Lot,
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
  create(row: T): Promise<T>;
  createMany(rows: T[]): Promise<void>;
  update(id: string, patch: Partial<Omit<T, "id">>): Promise<T>;
  /** Hard delete. Callers check references first; ledger tables have no delete. */
  delete(id: string): Promise<void>;
}

/** Ledger tables: rows are appended, never updated or deleted. */
export interface AppendOnlyRepo<T extends Row> {
  list(where?: Where<T>): Promise<T[]>;
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
  lots: Repo<Lot>;
  packs: Repo<Pack>;
  movements: AppendOnlyRepo<Movement>;
  scans: AppendOnlyRepo<Scan>;
  reprints: AppendOnlyRepo<Reprint>;
  sessions: Repo<Session>;

  appendMovement(m: NewMovement): Promise<Movement>;
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
  lots: Lot[];
  packs: Pack[];
  movements: Movement[];
  scans: Scan[];
  reprints: Reprint[];
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
  "lots",
  "packs",
  "movements",
  "scans",
  "reprints",
  "sessions",
  "sequences",
  "settings",
] as const satisfies readonly (keyof DbSnapshot)[];

export interface Store extends StoreTx {
  /** Run `fn` atomically: all writes commit together or none do. */
  transaction<R>(fn: (tx: StoreTx) => Promise<R>): Promise<R>;
  /** Replace all data (used by the seed script, the JSON → database import and the chain conversion). */
  reset(data: DbSnapshot): Promise<void>;
  /** Every row of every table (backups, clear-activity, the JSON → database import). */
  snapshot(): Promise<DbSnapshot>;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
