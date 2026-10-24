// Store implementation over a single JSON file (data/db.json).
// Writes are serialized by an in-process mutex; each transaction works on a draft copy
// and is persisted with write-temp-then-rename so the file is never half written.

import { promises as fs } from "node:fs";
import path from "node:path";
import { LOT_NUMBER_MAX } from "@/lib/core/codes";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/core/types";
import {
  COLLECTIONS,
  NotFoundError,
  type AppendOnlyRepo,
  type DbSnapshot,
  type NewMovement,
  type NewScan,
  type Repo,
  type Row,
  type Store,
  type StoreTx,
  type Where,
} from "./Store";

const SETTINGS_ID = "default";

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const clone = <T>(v: T): T => structuredClone(v);

function matches<T extends object>(row: T, where?: Where<T>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => v === undefined || (row as Record<string, unknown>)[k] === v);
}

function emptyDb(): DbSnapshot {
  return Object.fromEntries(COLLECTIONS.map((c) => [c, []])) as unknown as DbSnapshot;
}

function normalize(raw: Partial<DbSnapshot>): DbSnapshot {
  const db = emptyDb();
  for (const c of COLLECTIONS) {
    if (Array.isArray(raw[c])) (db as unknown as Record<string, unknown[]>)[c] = raw[c] as unknown[];
  }
  return db;
}

async function renameWithRetry(from: string, to: string) {
  // Windows can briefly lock the target (antivirus, indexer); retry a few times.
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 10 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
}

/** Repos bound to an in-memory snapshot. Reads return copies so callers can't mutate state by accident. */
function makeTx(db: DbSnapshot): StoreTx {
  const repo = <T extends Row>(name: keyof DbSnapshot): Repo<T> => {
    const rows = () => db[name] as unknown as T[];
    return {
      async get(id) {
        const r = rows().find((x) => x.id === id);
        return r ? clone(r) : null;
      },
      async findOne(where) {
        const r = rows().find((x) => matches(x, where));
        return r ? clone(r) : null;
      },
      async list(where) {
        return rows()
          .filter((x) => matches(x, where))
          .map(clone);
      },
      async create(row) {
        if (rows().some((x) => x.id === row.id)) throw new Error(`${name}: duplicate id ${row.id}`);
        rows().push(clone(row));
        return clone(row);
      },
      async createMany(newRows) {
        const ids = new Set(rows().map((x) => x.id));
        for (const r of newRows) {
          if (ids.has(r.id)) throw new Error(`${name}: duplicate id ${r.id}`);
          ids.add(r.id);
        }
        rows().push(...newRows.map(clone));
      },
      async update(id, patch) {
        const list = rows();
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) throw new NotFoundError(`${name} ${id}`);
        list[i] = { ...list[i], ...clone(patch), id };
        return clone(list[i]);
      },
    };
  };
  const ledger = <T extends Row>(name: keyof DbSnapshot): AppendOnlyRepo<T> => {
    const r = repo<T>(name);
    return { list: r.list, append: r.create };
  };

  const tx: StoreTx = {
    countries: repo("countries"),
    flavours: repo("flavours"),
    partners: repo("partners"),
    users: repo("users"),
    devices: repo("devices"),
    batchCodePool: repo("batchCodePool"),
    batches: repo("batches"),
    printOrders: repo("printOrders"),
    lots: repo("lots"),
    packs: repo("packs"),
    movements: ledger("movements"),
    scans: ledger("scans"),
    reprints: ledger("reprints"),

    async appendMovement(m: NewMovement) {
      return tx.movements.append({ ...m, id: crypto.randomUUID(), at: m.at ?? new Date().toISOString() });
    },
    async appendScan(s: NewScan) {
      return tx.scans.append({ ...s, id: crypto.randomUUID(), at: s.at ?? new Date().toISOString() });
    },
    async nextLotNumber(batchCode, count) {
      if (!Number.isInteger(count) || count < 1) throw new RangeError(`count must be ≥ 1 (got ${count})`);
      const batch = db.batches.find((b) => b.code === batchCode);
      if (!batch) throw new NotFoundError(`Batch ${batchCode}`);
      const first = batch.nextLot;
      if (first + count - 1 > LOT_NUMBER_MAX) {
        throw new RangeError(`Batch ${batchCode} has no room for ${count} more lots (max 1869F)`);
      }
      batch.nextLot = first + count;
      return first;
    },
    async getSettings() {
      const row = db.settings.find((s) => s.id === SETTINGS_ID);
      return clone({ ...DEFAULT_SETTINGS, ...row, id: SETTINGS_ID }) as Settings;
    },
    async updateSettings(patch) {
      const current = await tx.getSettings();
      const next = { ...current, ...clone(patch), id: SETTINGS_ID };
      const i = db.settings.findIndex((s) => s.id === SETTINGS_ID);
      if (i < 0) db.settings.push(next);
      else db.settings[i] = next;
      return clone(next);
    },
  };
  return tx;
}

export class JsonStore implements Store {
  private cache: DbSnapshot | null = null;
  private cacheMtime = -1;
  private readonly mutex = new Mutex();

  constructor(
    private readonly filePath: string,
    private readonly initialData: () => DbSnapshot,
  ) {}

  /** `locked` = caller already holds the mutex. */
  private async readDb(locked = false): Promise<DbSnapshot> {
    let mtime: number;
    try {
      mtime = (await fs.stat(this.filePath)).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // First run without `npm run seed`: create the base seed so the app works.
      const create = async () => {
        try {
          await fs.stat(this.filePath);
        } catch {
          await this.writeDb(this.initialData());
        }
      };
      await (locked ? create() : this.mutex.run(create));
      return this.readDb(locked);
    }
    if (this.cache && mtime === this.cacheMtime) return this.cache;
    const data = normalize(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    this.cache = data;
    this.cacheMtime = mtime;
    return data;
  }

  private async writeDb(data: DbSnapshot) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1), "utf8");
    await renameWithRetry(tmp, this.filePath);
    this.cache = data;
    this.cacheMtime = (await fs.stat(this.filePath)).mtimeMs;
  }

  transaction<R>(fn: (tx: StoreTx) => Promise<R>): Promise<R> {
    return this.mutex.run(async () => {
      const draft = clone(await this.readDb(true));
      const result = await fn(makeTx(draft));
      await this.writeDb(draft);
      return result;
    });
  }

  async reset(data: DbSnapshot): Promise<void> {
    await this.mutex.run(() => this.writeDb(normalize(clone(data))));
  }

  // Reads use the latest committed snapshot; writes run as single-step transactions.
  private repo<T extends Row>(name: keyof StoreTx & keyof DbSnapshot): Repo<T> {
    const read = async () => makeTx(await this.readDb())[name] as unknown as Repo<T>;
    const write = <A extends unknown[], R>(op: (r: Repo<T>, ...a: A) => Promise<R>) =>
      (...a: A) => this.transaction((tx) => op(tx[name] as unknown as Repo<T>, ...a));
    return {
      get: async (id) => (await read()).get(id),
      findOne: async (where) => (await read()).findOne(where),
      list: async (where) => (await read()).list(where),
      create: write((r, row: T) => r.create(row)),
      createMany: write((r, rows: T[]) => r.createMany(rows)),
      update: write((r, id: string, patch: Partial<Omit<T, "id">>) => r.update(id, patch)),
    };
  }

  private ledger<T extends Row>(name: "movements" | "scans" | "reprints"): AppendOnlyRepo<T> {
    const r = this.repo<T>(name);
    return { list: r.list, append: r.create };
  }

  countries = this.repo<DbSnapshot["countries"][number]>("countries");
  flavours = this.repo<DbSnapshot["flavours"][number]>("flavours");
  partners = this.repo<DbSnapshot["partners"][number]>("partners");
  users = this.repo<DbSnapshot["users"][number]>("users");
  devices = this.repo<DbSnapshot["devices"][number]>("devices");
  batchCodePool = this.repo<DbSnapshot["batchCodePool"][number]>("batchCodePool");
  batches = this.repo<DbSnapshot["batches"][number]>("batches");
  printOrders = this.repo<DbSnapshot["printOrders"][number]>("printOrders");
  lots = this.repo<DbSnapshot["lots"][number]>("lots");
  packs = this.repo<DbSnapshot["packs"][number]>("packs");
  movements = this.ledger<DbSnapshot["movements"][number]>("movements");
  scans = this.ledger<DbSnapshot["scans"][number]>("scans");
  reprints = this.ledger<DbSnapshot["reprints"][number]>("reprints");

  appendMovement(m: NewMovement) {
    return this.transaction((tx) => tx.appendMovement(m));
  }
  appendScan(s: NewScan) {
    return this.transaction((tx) => tx.appendScan(s));
  }
  nextLotNumber(batchCode: string, count: number) {
    return this.transaction((tx) => tx.nextLotNumber(batchCode, count));
  }
  async getSettings() {
    return makeTx(await this.readDb()).getSettings();
  }
  updateSettings(patch: Partial<Omit<Settings, "id">>) {
    return this.transaction((tx) => tx.updateSettings(patch));
  }
}
