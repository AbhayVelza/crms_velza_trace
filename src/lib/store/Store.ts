// Storage contract. Business logic and UI depend only on this interface, so a real
// database can replace the JSON file by implementing it (one repo per table).

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
  Settings,
  User,
} from "@/lib/core/types";

export interface Row {
  id: string;
}

/** Equality filter on top-level fields (maps to a SQL WHERE a = ? AND b = ?). */
export type Where<T> = Partial<T>;

export interface Repo<T extends Row> {
  get(id: string): Promise<T | null>;
  findOne(where: Where<T>): Promise<T | null>;
  list(where?: Where<T>): Promise<T[]>;
  create(row: T): Promise<T>;
  createMany(rows: T[]): Promise<void>;
  update(id: string, patch: Partial<Omit<T, "id">>): Promise<T>;
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

  appendMovement(m: NewMovement): Promise<Movement>;
  appendScan(s: NewScan): Promise<Scan>;
  /**
   * Atomically reserve `count` consecutive lot numbers for a batch.
   * Returns the first number and advances the batch's nextLot. Numbers are never reused.
   */
  nextLotNumber(batchCode: string, count: number): Promise<number>;
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
  "settings",
] as const satisfies readonly (keyof DbSnapshot)[];

export interface Store extends StoreTx {
  /** Run `fn` atomically: all writes commit together or none do. */
  transaction<R>(fn: (tx: StoreTx) => Promise<R>): Promise<R>;
  /** Replace all data (used by the seed script). */
  reset(data: DbSnapshot): Promise<void>;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
