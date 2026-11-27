// Store implementation over a single JSON file (data/db.json). SINGLE-PROCESS trial storage only:
// - one process owns the file: `<file>.lock` (pid, host, token) is created exclusively on first use and
//   removed when the process exits; a second process gets JsonStoreLockedError instead of data;
// - inside the process, writes are serialized by one mutex per file (shared by every JsonStore instance);
// - each transaction works on a draft copy and is persisted with write-temp-then-rename, and is refused
//   (ConcurrentWriteError, nothing written) if the file changed on disk since it was read.
// Two processes sharing one file used to hand out the same lot codes (audit, 4 Nov 2026); production
// must use PostgreSQL.

import { closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOT_NUMBER_MAX } from "@/lib/core/codes";
import { DEFAULT_SETTINGS, type Batch, type ContainerStatus, type Lot, type Movement, type Pack, type Settings } from "@/lib/core/types";
import { conversionNeeded } from "./convertChain";
import { damageReportsFor, effectivePack, isPackStateField, LOT_OPENED_MESSAGE, lotIsOpened, packPatchToStore, toStoredPack, type StoredPack } from "./packState";
import {
  COLLECTIONS,
  ConcurrentWriteError,
  IntegrityError,
  NotFoundError,
  type AppendOnlyRepo,
  type DbSnapshot,
  type LedgerReadOptions,
  type NewMovement,
  type NewScan,
  type Repo,
  type Row,
  type StockSummaryRow,
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

// ---------------------------------------------------------------- process ownership of the file

/** Another live process owns this JSON file. */
export class JsonStoreLockedError extends Error {
  constructor(
    public file: string,
    public holder: { pid?: number; host?: string; startedAt?: string } | null,
  ) {
    super(
      `${file} is in use by another process${holder?.pid ? ` (pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ""}, since ${holder.startedAt ?? "?"})` : ""}. ` +
        `The JSON file store is single-process: stop the other server or script first (use PostgreSQL to run several app processes). ` +
        `If no such process exists, delete ${file}.lock.`,
    );
    this.name = "JsonStoreLockedError";
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  token: string;
}

interface FileOwner {
  mutex: Mutex;
  lockPath: string;
  token: string;
}

const g = globalThis as unknown as { __velzaJsonOwners?: Map<string, FileOwner>; __velzaJsonExitHook?: boolean };

function ownerKey(file: string): string {
  const abs = path.resolve(file);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function readLock(lockPath: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
    return typeof info?.pid === "number" && typeof info.token === "string" ? info : null;
  } catch {
    return null;
  }
}

function releaseAll() {
  for (const owner of g.__velzaJsonOwners?.values() ?? []) {
    try {
      if (readLock(owner.lockPath)?.token === owner.token) unlinkSync(owner.lockPath);
    } catch {
      // already gone
    }
  }
  g.__velzaJsonOwners?.clear();
}

/** Release this process's JSON file locks (scripts and tests call it via closeStores; exit does it too). */
export function releaseJsonStoreLocks(): void {
  releaseAll();
}

/**
 * Take (or reuse) this process's ownership of `file`. A lock left by a process that no longer exists on
 * this host is taken over; a live holder, or a holder on another host, is refused.
 */
function acquireOwner(file: string): FileOwner {
  g.__velzaJsonOwners ??= new Map();
  const key = ownerKey(file);
  const existing = g.__velzaJsonOwners.get(key);
  if (existing) return existing;

  const lockPath = `${path.resolve(file)}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), token: crypto.randomUUID() };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // fails if the file exists: exactly one creator wins
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      const owner: FileOwner = { mutex: new Mutex(), lockPath, token: info.token };
      g.__velzaJsonOwners.set(key, owner);
      if (!g.__velzaJsonExitHook) {
        g.__velzaJsonExitHook = true;
        process.on("exit", releaseAll);
      }
      return owner;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readLock(lockPath);
    if (!holder) {
      // Being written right now, or garbage: give a writer a moment, then treat it as stale.
      if (attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
    } else if (holder.host !== info.host || (holder.pid !== process.pid && pidAlive(holder.pid))) {
      throw new JsonStoreLockedError(file, holder);
    }
    // Stale (dead process, or an earlier module instance of this same process): move it aside
    // atomically, check it is still the lock we judged stale, then try to create ours again.
    const aside = `${lockPath}.stale-${info.token}`;
    try {
      renameSync(lockPath, aside);
    } catch {
      continue; // someone else moved it first
    }
    const moved = readLock(aside);
    if (holder && moved?.token !== holder.token) {
      // We moved a fresh lock another process had just created: put it back and give up.
      try {
        renameSync(aside, lockPath);
      } catch {
        // its owner will notice on write (ConcurrentWriteError) at worst
      }
      throw new JsonStoreLockedError(file, moved);
    }
    try {
      unlinkSync(aside);
    } catch {
      // ignore
    }
  }
  throw new JsonStoreLockedError(file, readLock(lockPath));
}

/** A row test for `where`, built once per call (an "any of" array becomes a Set, not a scan per row). */
function matcher<T extends object>(where?: Where<T>): (row: T) => boolean {
  const tests = Object.entries(where ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]): ((row: Record<string, unknown>) => boolean) => {
      if (!Array.isArray(v)) return (row) => row[k] === v;
      const any = new Set<unknown>(v);
      return (row) => any.has(row[k]);
    });
  return (row) => tests.every((t) => t(row as Record<string, unknown>));
}

/**
 * Packs as this file stores them (Option C, as the database does): no state while a pack follows its sealed lot. A pack
 * row that says so (followsLot) is stored that way; a row without state already follows. A file or snapshot written
 * before Option C (no pack without state, no flags) has its packs decided by the v11 upgrade's rule (`infer`): a pack of
 * a sealed lot with the lot's state follows it.
 */
function storePacks(db: DbSnapshot, infer: boolean): void {
  const lotByCode = new Map(db.lots.map((l) => [l.lotCode, l]));
  db.packs = db.packs.map((p) => {
    if (p.followsLot !== undefined || (infer && p.status !== null)) return toStoredPack(p, lotByCode.get(p.lotCode));
    const stored = { ...p };
    delete stored.followsLot;
    return stored;
  }) as unknown as Pack[];
}

/** A file written before Option C: it has packs, none of them without a state of its own. */
const beforeOptionC = (db: DbSnapshot) => db.packs.length > 0 && !db.packs.some((p) => p.status === null || p.followsLot !== undefined);

/** Where a movement took place, as PostgreSQL stores it (code_history.location_id): the sender while dispatching. */
const movementPlace = (m: Pick<Movement, "type" | "fromId" | "toId">) => (m.type === "DISPATCHED" ? m.fromId : (m.toId ?? m.fromId));

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

/**
 * Repos bound to an in-memory snapshot. Reads return copies so callers can't mutate state by accident. `openedLots`
 * collects the lots this transaction opened or left packs following, checked before it is saved (as PostgreSQL's
 * deferred VZ003 check does at commit).
 */
function makeTx(db: DbSnapshot, openedLots: Set<string> = new Set()): StoreTx {
  const repo = <T extends Row>(name: keyof DbSnapshot): Repo<T> => {
    const rows = () => db[name] as unknown as T[];
    return {
      async get(id) {
        const r = rows().find((x) => x.id === id);
        return r ? clone(r) : null;
      },
      async findOne(where) {
        const r = rows().find(matcher(where));
        return r ? clone(r) : null;
      },
      async list(where) {
        return rows()
          .filter(matcher(where))
          .map(clone);
      },
      async exists(where) {
        return rows().some(matcher(where));
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
      async updateWhere(where, patch) {
        if (!Object.values(where ?? {}).some((v) => v !== undefined)) throw new Error(`${name}: updateWhere needs a filter`);
        const test = matcher(where);
        const p = clone(patch) as Record<string, unknown>;
        delete p.id;
        const list = rows();
        const ids: string[] = [];
        // One pass over the table, patched in place (no lookup per row).
        for (let i = 0; i < list.length; i++) {
          if (!test(list[i])) continue;
          list[i] = { ...list[i], ...p, id: list[i].id };
          ids.push(list[i].id);
        }
        return ids;
      },
      async delete(id) {
        const list = rows();
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) throw new NotFoundError(`${name} ${id}`);
        list.splice(i, 1);
      },
    };
  };
  const ledger = <T extends Row>(name: keyof DbSnapshot): AppendOnlyRepo<T> => {
    const r = repo<T>(name);
    /** A ledger row's time: `at` (history), `reportedAt` (damage reports). */
    const timeOf = (x: T) => String((x as { at?: string; reportedAt?: string }).at ?? (x as { reportedAt?: string }).reportedAt ?? "");
    return {
      async list(where, opts?: LedgerReadOptions) {
        const rows = await r.list(where);
        const since = opts?.since;
        return since ? rows.filter((x) => timeOf(x) >= since) : rows;
      },
      exists: r.exists,
      append: r.create,
    };
  };

  // Integrity guards, the same as the PostgreSQL triggers (schema v3): a batch's lot counter never
  // moves backwards, and a code issued by a print order is never deleted.
  const issued = (printOrderId: string) => db.printOrders.some((o) => o.id === printOrderId);
  const batches = repo<Batch>("batches");
  const guardedBatches: Repo<Batch> = {
    ...batches,
    async update(id, patch) {
      const current = db.batches.find((b) => b.id === id);
      if (current && patch.nextLot !== undefined && typeof current.nextLot === "number" && !(Number(patch.nextLot) >= current.nextLot)) {
        throw new IntegrityError("COUNTER_BACKWARDS", `Batch ${current.code}: the lot counter cannot move backwards (${current.nextLot} → ${patch.nextLot})`);
      }
      return batches.update(id, patch);
    },
    async updateWhere(where, patch) {
      if (patch.nextLot !== undefined) {
        const test = matcher(where);
        const back = db.batches.find((b) => test(b) && typeof b.nextLot === "number" && !(Number(patch.nextLot) >= b.nextLot));
        if (back) throw new IntegrityError("COUNTER_BACKWARDS", `Batch ${back.code}: the lot counter cannot move backwards (${back.nextLot} → ${patch.nextLot})`);
      }
      return batches.updateWhere(where, patch);
    },
  };
  // Lots by code, for reading packs through their lot (Option C). Built on first use, dropped on every lot write.
  let lotIndex: Map<string, Lot> | null = null;
  const lotOf = (code: string) => (lotIndex ??= new Map(db.lots.map((l) => [l.lotCode, l]))).get(code);
  const lots = repo<Lot>("lots");
  /** After a lot write: forget the index, and remember lots now opened (their packs must all have a state by commit). */
  const lotsWritten = <R>(result: R, written: (Lot | null | undefined)[]) => {
    lotIndex = null;
    for (const l of written) if (l && lotIsOpened(l)) openedLots.add(l.lotCode);
    return result;
  };
  const guardedLots: Repo<Lot> = {
    ...lots,
    async create(row) {
      return lotsWritten(await lots.create(row), [row]);
    },
    async createMany(rows) {
      return lotsWritten(await lots.createMany(rows), rows);
    },
    async update(id, patch) {
      const updated = await lots.update(id, patch);
      return lotsWritten(updated, [updated]);
    },
    async updateWhere(where, patch) {
      const ids = await lots.updateWhere(where, patch);
      return lotsWritten(
        ids,
        ids.map((id) => db.lots.find((l) => l.id === id)),
      );
    },
    async delete(id) {
      const lot = db.lots.find((l) => l.id === id);
      if (lot && issued(lot.printOrderId)) throw new IntegrityError("ISSUED_CODE_PROTECTED", `Code ${lot.lotCode} was issued by print order ${lot.printOrderId} and cannot be deleted`);
      return lotsWritten(await lots.delete(id), []);
    },
  };

  // Packs (Option C): stored without state while they follow their sealed lot, read with the lot's state.
  const stored = () => db.packs as unknown as StoredPack[];
  const read = (p: StoredPack) => effectivePack(p, lotOf(p.lotCode));
  /** A filter split into the fields every pack row stores and those that depend on its lot (state, followsLot). */
  const packFilter = (where: Where<Pack> | undefined) => {
    const own: Record<string, unknown> = {};
    const eff: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(where ?? {})) (isPackStateField(k) || k === "followsLot" ? eff : own)[k] = v;
    const ownTest = matcher(own as Where<StoredPack>);
    const effTest = matcher(eff as Where<Pack>);
    return (p: StoredPack): Pack | null => {
      if (!ownTest(p)) return null;
      const r = read(p);
      return effTest(r) ? r : null;
    };
  };
  /** A pack stored without state under an opened lot: refused at once (PostgreSQL: VZ003 on insert). */
  const refuseUnderOpened = (p: StoredPack) => {
    const lot = p.status === null ? lotOf(p.lotCode) : undefined;
    if (lot && lotIsOpened(lot)) throw new IntegrityError("LOT_OPENED_CONFLICT", LOT_OPENED_MESSAGE(p.lotCode));
  };
  const writePack = (i: number, patch: Partial<Omit<Pack, "id">>) => {
    const list = stored();
    const current = list[i];
    list[i] = { ...current, ...clone(packPatchToStore(current, lotOf(current.lotCode), patch)), id: current.id };
    if (list[i].status === null) openedLots.add(list[i].lotCode); // checked before saving, as PostgreSQL does at commit
    return list[i];
  };
  const guardedPacks: Repo<Pack> = {
    async get(id) {
      const p = stored().find((x) => x.id === id);
      return p ? read(p) : null;
    },
    async findOne(where) {
      const test = packFilter(where);
      for (const p of stored()) {
        const r = test(p);
        if (r) return r;
      }
      return null;
    },
    async list(where) {
      const test = packFilter(where);
      const out: Pack[] = [];
      for (const p of stored()) {
        const r = test(p);
        if (r) out.push(r);
      }
      return out;
    },
    async exists(where) {
      return (await guardedPacks.findOne(where)) !== null;
    },
    async create(row) {
      await guardedPacks.createMany([row]);
      return clone(row);
    },
    async createMany(newRows) {
      const ids = new Set(stored().map((x) => x.id));
      const rows = newRows.map((r) => {
        if (ids.has(r.id)) throw new Error(`packs: duplicate id ${r.id}`);
        ids.add(r.id);
        const s = toStoredPack(clone(r), lotOf(r.lotCode));
        refuseUnderOpened(s);
        return s;
      });
      stored().push(...rows);
    },
    async update(id, patch) {
      const i = stored().findIndex((x) => x.id === id);
      if (i < 0) throw new NotFoundError(`packs ${id}`);
      return read(writePack(i, patch));
    },
    async updateWhere(where, patch) {
      if (!Object.values(where ?? {}).some((v) => v !== undefined)) throw new Error("packs: updateWhere needs a filter");
      const test = packFilter(where);
      const ids: string[] = [];
      const list = stored();
      for (let i = 0; i < list.length; i++) {
        if (!test(list[i])) continue;
        ids.push(writePack(i, patch).id);
      }
      return ids;
    },
    async delete(id) {
      const list = stored();
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) throw new NotFoundError(`packs ${id}`);
      const pack = list[i];
      const lot = lotOf(pack.lotCode);
      if (lot && issued(lot.printOrderId)) throw new IntegrityError("ISSUED_CODE_PROTECTED", `Code ${pack.packCode} was issued by print order ${lot.printOrderId} and cannot be deleted`);
      list.splice(i, 1);
    },
  };

  const movementRows = repo<Movement>("movements");

  const tx: StoreTx = {
    countries: repo("countries"),
    flavours: repo("flavours"),
    partners: repo("partners"),
    users: repo("users"),
    devices: repo("devices"),
    batchCodePool: repo("batchCodePool"),
    batches: guardedBatches,
    printOrders: repo("printOrders"),
    containers: repo("containers"),
    lots: guardedLots,
    packs: guardedPacks,
    movements: ledger("movements"),
    scans: ledger("scans"),
    reprints: ledger("reprints"),
    damageReports: ledger("damageReports"),
    sessions: repo("sessions"),

    async appendMovement(m: NewMovement) {
      return tx.movements.append({ ...m, id: crypto.randomUUID(), at: m.at ?? new Date().toISOString() });
    },
    async appendMovements(ms: NewMovement[]) {
      const now = new Date().toISOString();
      const rows: Movement[] = ms.map((m) => ({ ...m, id: crypto.randomUUID(), at: m.at ?? now }));
      await movementRows.createMany(rows);
      return rows.map(clone);
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
    async nextSequence(name) {
      let row = db.sequences.find((x) => x.id === name);
      if (!row) db.sequences.push((row = { id: name, value: 0 }));
      row.value += 1;
      return row.value;
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

    async recentScans(limit) {
      // Newest first; equal times keep the order they were recorded in (as PostgreSQL's history_id does).
      const rows = db.scans.map((s, i) => ({ s, i })).sort((a, b) => b.s.at.localeCompare(a.s.at) || a.i - b.i);
      return rows.slice(0, Math.max(0, limit)).map((r) => clone(r.s));
    },
    async latestContainerWithLot(toId, lotCode, statuses) {
      const sent = db.containers.filter((c) => c.toId === toId && statuses.includes(c.status) && c.lotCodes.includes(lotCode));
      const latest = sent.map((c, i) => ({ c, i })).sort((a, b) => (b.c.dispatchedAt ?? "").localeCompare(a.c.dispatchedAt ?? "") || a.i - b.i)[0];
      return latest ? clone(latest.c) : null;
    },
    async stockSummary() {
      // The development store is small: count its rows. A pack carries its lot's sync flag (as on PostgreSQL).
      const lotByCode = new Map(db.lots.map((l) => [l.lotCode, l]));
      const counts = new Map<string, StockSummaryRow>();
      const add = (row: Omit<StockSummaryRow, "units">) => {
        const key = [row.locationId, row.status, row.kind, row.lotType, row.flavour, row.synced].join("|");
        const hit = counts.get(key);
        if (hit) hit.units += 1;
        else counts.set(key, { ...row, units: 1 });
      };
      for (const l of db.lots) add({ locationId: l.locationId, status: l.status, kind: "LOT", lotType: l.lotType, flavour: l.flavour, synced: l.synced });
      // Every pack once, by its effective state (decision Q7): a following pack under its lot's state, a pack with a
      // state of its own (also inside a sealed lot: damaged, recalled ...) under that state only.
      for (const p of stored()) {
        const lot = lotByCode.get(p.lotCode);
        const e = effectivePack(p, lot);
        add({ locationId: e.locationId, status: e.status, kind: "PACK", lotType: p.packSize === 6 ? "CASE" : "TRAY", flavour: p.packCode.slice(8, 10), synced: lot?.synced ?? true });
      }
      return [...counts.values()];
    },
    async historyAtPartner(partnerId) {
      return db.movements.some((m) => movementPlace(m) === partnerId) || db.scans.some((s) => s.partnerId === partnerId);
    },
  };
  return tx;
}

export class JsonStore implements Store {
  private cache: DbSnapshot | null = null;
  private cacheMtime = -1;
  private cacheSize = -1;
  private owner: FileOwner | null = null;

  /** This process's ownership of the file, taken on first use (JsonStoreLockedError if another process has it). */
  private get mutex(): Mutex {
    this.owner ??= acquireOwner(this.filePath);
    return this.owner.mutex;
  }

  constructor(
    private readonly filePath: string,
    private readonly initialData: () => DbSnapshot,
  ) {}

  /** Set when the file holds data from before the chain change; the app refuses it until it is converted. */
  private notConverted: string | null = null;

  /** `locked` = caller already holds the mutex. `check` = refuse unconverted data (snapshot() reads it as it is). */
  private async readDb(locked = false, check = true): Promise<DbSnapshot> {
    void this.mutex; // ownership first: never read a file another process is writing
    let mtime: number;
    let size: number;
    try {
      const st = await fs.stat(this.filePath);
      mtime = st.mtimeMs;
      size = st.size;
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
      return this.readDb(locked, check);
    }
    if (!this.cache || mtime !== this.cacheMtime || size !== this.cacheSize) {
      const db = normalize(JSON.parse(await fs.readFile(this.filePath, "utf8")));
      storePacks(db, beforeOptionC(db));
      this.cache = db;
      this.cacheMtime = mtime;
      this.cacheSize = size;
      this.notConverted = conversionNeeded(this.cache);
    }
    if (check && this.notConverted) {
      throw new Error(`${this.filePath} holds data from before the current chain. Run "npm run db:convert-chain" first:\n${this.notConverted}`);
    }
    return this.cache;
  }

  private async writeDb(data: DbSnapshot) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1), "utf8");
    await renameWithRetry(tmp, this.filePath);
    this.cache = data;
    const st = await fs.stat(this.filePath);
    this.cacheMtime = st.mtimeMs;
    this.cacheSize = st.size;
    this.notConverted = null; // written by the app, a seed, an import or the conversion itself
  }

  /** Refuse to write if the file on disk is no longer the version this transaction read. */
  private async assertUnchanged(mtime: number, size: number) {
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      st = await fs.stat(this.filePath);
    } catch {
      st = null;
    }
    if (!st || st.mtimeMs !== mtime || st.size !== size) {
      this.cache = null; // re-read on the next request
      throw new ConcurrentWriteError(`${this.filePath} was changed by another process during this request — nothing was saved. Try again.`);
    }
  }

  /** `opts.lockKey` is not needed here: one process owns the file and its transactions already run one at a time. */
  transaction<R>(fn: (tx: StoreTx) => Promise<R>): Promise<R> {
    return this.mutex.run(async () => {
      const draft = clone(await this.readDb(true));
      const [mtime, size] = [this.cacheMtime, this.cacheSize];
      const openedLots = new Set<string>();
      const result = await fn(makeTx(draft, openedLots));
      // Option C, as PostgreSQL checks at commit (VZ003): an opened case/tray has no pack still following it.
      for (const code of openedLots) {
        const lot = draft.lots.find((l) => l.lotCode === code);
        if (lot && lotIsOpened(lot) && draft.packs.some((p) => p.lotCode === code && p.status === null)) throw new IntegrityError("LOT_OPENED_CONFLICT", LOT_OPENED_MESSAGE(code));
      }
      await this.assertUnchanged(mtime, size);
      await this.writeDb(draft);
      return result;
    });
  }

  async reset(data: DbSnapshot): Promise<void> {
    const db = normalize(clone(data));
    db.damageReports = damageReportsFor({ ...db, damageReports: data.damageReports });
    storePacks(db, true);
    // As PostgreSQL refuses it on load (VZ003): no pack may follow a case/tray that is opened. Nothing is written.
    const opened = new Set(db.lots.filter(lotIsOpened).map((l) => l.lotCode));
    const bad = db.packs.find((p) => p.status === null && opened.has(p.lotCode));
    if (bad) throw new IntegrityError("LOT_OPENED_CONFLICT", LOT_OPENED_MESSAGE(bad.lotCode));
    await this.mutex.run(() => this.writeDb(db));
  }

  async ping(): Promise<void> {
    await this.readDb();
    await fs.access(this.filePath, fsConstants.R_OK);
  }

  /** Packs as the app reads them: effective state, with followsLot (a reset of this snapshot stores them the same way). */
  async snapshot(): Promise<DbSnapshot> {
    const db = clone(await this.readDb(false, false));
    const lotByCode = new Map(db.lots.map((l) => [l.lotCode, l]));
    db.packs = (db.packs as unknown as StoredPack[]).map((p) => effectivePack(p, lotByCode.get(p.lotCode)));
    return db;
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
      exists: async (where) => (await read()).exists(where),
      create: write((r, row: T) => r.create(row)),
      createMany: write((r, rows: T[]) => r.createMany(rows)),
      update: write((r, id: string, patch: Partial<Omit<T, "id">>) => r.update(id, patch)),
      updateWhere: write((r, where: Where<T>, patch: Partial<Omit<T, "id">>) => r.updateWhere(where, patch)),
      delete: write((r, id: string) => r.delete(id)),
    };
  }

  private ledger<T extends Row>(name: "movements" | "scans" | "reprints" | "damageReports"): AppendOnlyRepo<T> {
    const read = async () => makeTx(await this.readDb())[name] as unknown as AppendOnlyRepo<T>;
    return {
      list: async (where, opts) => (await read()).list(where, opts),
      exists: async (where) => (await read()).exists(where),
      append: (row) => this.transaction((tx) => (tx[name] as unknown as AppendOnlyRepo<T>).append(row)),
    };
  }

  appendMovements(ms: NewMovement[]) {
    return this.transaction((tx) => tx.appendMovements(ms));
  }

  countries = this.repo<DbSnapshot["countries"][number]>("countries");
  flavours = this.repo<DbSnapshot["flavours"][number]>("flavours");
  partners = this.repo<DbSnapshot["partners"][number]>("partners");
  users = this.repo<DbSnapshot["users"][number]>("users");
  devices = this.repo<DbSnapshot["devices"][number]>("devices");
  batchCodePool = this.repo<DbSnapshot["batchCodePool"][number]>("batchCodePool");
  batches = this.repo<DbSnapshot["batches"][number]>("batches");
  printOrders = this.repo<DbSnapshot["printOrders"][number]>("printOrders");
  containers = this.repo<DbSnapshot["containers"][number]>("containers");
  lots = this.repo<DbSnapshot["lots"][number]>("lots");
  packs = this.repo<DbSnapshot["packs"][number]>("packs");
  movements = this.ledger<DbSnapshot["movements"][number]>("movements");
  scans = this.ledger<DbSnapshot["scans"][number]>("scans");
  reprints = this.ledger<DbSnapshot["reprints"][number]>("reprints");
  damageReports = this.ledger<NonNullable<DbSnapshot["damageReports"]>[number]>("damageReports");
  sessions = this.repo<DbSnapshot["sessions"][number]>("sessions");

  appendMovement(m: NewMovement) {
    return this.transaction((tx) => tx.appendMovement(m));
  }
  appendScan(s: NewScan) {
    return this.transaction((tx) => tx.appendScan(s));
  }
  nextLotNumber(batchCode: string, count: number) {
    return this.transaction((tx) => tx.nextLotNumber(batchCode, count));
  }
  nextSequence(name: string) {
    return this.transaction((tx) => tx.nextSequence(name));
  }
  async getSettings() {
    return makeTx(await this.readDb()).getSettings();
  }
  async recentScans(limit: number) {
    return makeTx(await this.readDb()).recentScans(limit);
  }
  async latestContainerWithLot(toId: string, lotCode: string, statuses: readonly ContainerStatus[]) {
    return makeTx(await this.readDb()).latestContainerWithLot(toId, lotCode, statuses);
  }
  async stockSummary() {
    return makeTx(await this.readDb()).stockSummary();
  }
  async historyAtPartner(partnerId: string) {
    return makeTx(await this.readDb()).historyAtPartner(partnerId);
  }
  updateSettings(patch: Partial<Omit<Settings, "id">>) {
    return this.transaction((tx) => tx.updateSettings(patch));
  }
}
