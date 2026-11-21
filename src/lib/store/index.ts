// Active store, one instance per process (kept on globalThis so every route bundle shares it):
//   STORE=json      (default) data/db.json, or VELZA_DB_PATH
//   STORE=postgres  PostgreSQL at DATABASE_URL (chosen automatically when it or DATABASE_URL_UNPOOLED is set);
//                   code allocation uses DATABASE_URL_UNPOOLED when that is set too (databaseUrls below)
//   STORE=pglite    embedded PostgreSQL in PGLITE_DIR (in memory when unset) — local trials and tests
// Business logic only sees the Store interface, so switching is configuration, not code.

import path from "node:path";
import { JsonStore, releaseJsonStoreLocks } from "./jsonStore";
import { firstRunSeed } from "./seedData";
import { createPgDriver, createPgliteDriver, describeDatabaseUrl } from "./sql/driver";
import { SqlStore } from "./sql/sqlStore";
import type { Store } from "./Store";

export type { Store, StoreTx, DbSnapshot } from "./Store";
export { ConcurrentWriteError, IntegrityError, NotFoundError, type TransactionOptions } from "./Store";
export { JsonStoreLockedError } from "./jsonStore";

export type StoreKind = "json" | "postgres" | "pglite";

const g = globalThis as unknown as { __velzaStores?: Map<string, Store> };

export function dbFilePath(): string {
  return process.env.VELZA_DB_PATH ?? path.join(process.cwd(), "data", "db.json");
}

/**
 * The direct PostgreSQL connection string: DATABASE_URL_UNPOOLED when set, else DATABASE_URL. Undefined when neither
 * is set (the JSON store). Only code allocation needs a direct connection; see databaseUrls for which URL each kind
 * of work uses.
 */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || undefined;
}

/** Connections per process for ordinary work. Vercel runs many small instances, so each keeps few. */
const DEFAULT_POOL_MAX = 10;
const DEFAULT_VERCEL_POOL_MAX = 3;
/** Connections per process for code allocation on the direct address (only when that address is separate). */
const DEFAULT_LOCK_POOL_MAX = 2;

export interface DatabaseUrls {
  /** Every query and transaction, except code allocation when `lock` differs. */
  query: string;
  /** Transactions with a lockKey (code allocation of print orders). Equal to `query` unless DATABASE_URL_UNPOOLED is set. */
  lock: string;
  /** Connections per process to `query` (PG_POOL_MAX; default 3 on Vercel, 10 elsewhere). */
  poolMax: number;
  /** Connections per process to `lock` when it is a separate address (PG_LOCK_POOL_MAX, default 2); unused otherwise. */
  lockPoolMax: number;
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * Which address each kind of work uses. On Vercel the Neon integration sets DATABASE_URL to Neon's pooled address
 * (PgBouncer in transaction mode) and DATABASE_URL_UNPOOLED to the direct one, for each preview's own database branch
 * too. Ordinary queries and transactions go through the pooler, so many function instances share few server
 * connections. Code allocation holds a session-level advisory lock taken before BEGIN (sql/driver.ts), which a
 * transaction-mode pooler can't keep (the lock, the transaction and the unlock could run on different server
 * connections), so those transactions alone use a second, small pool on the direct address.
 *
 * Without DATABASE_URL_UNPOOLED (Docker, Lightsail, a laptop) both are DATABASE_URL and share one pool, as before.
 * Undefined when no database is configured.
 */
export function databaseUrls(env: Record<string, string | undefined> = process.env): DatabaseUrls | undefined {
  const query = env.DATABASE_URL || env.DATABASE_URL_UNPOOLED;
  if (!query) return undefined;
  return {
    query,
    lock: env.DATABASE_URL_UNPOOLED || query,
    poolMax: positiveInt(env.PG_POOL_MAX, env.VERCEL ? DEFAULT_VERCEL_POOL_MAX : DEFAULT_POOL_MAX),
    lockPoolMax: positiveInt(env.PG_LOCK_POOL_MAX, DEFAULT_LOCK_POOL_MAX),
  };
}

export function storeKind(env: Record<string, string | undefined> = process.env): StoreKind {
  const kind = env.STORE || (databaseUrl(env) ? "postgres" : "json");
  if (kind !== "json" && kind !== "postgres" && kind !== "pglite") throw new Error(`Unsupported STORE "${kind}" (use json, postgres or pglite)`);
  // Vercel functions have a read-only disk and many short-lived copies: a JSON file there would be lost or split.
  if (kind === "json" && env.VERCEL) throw new Error("On Vercel connect a PostgreSQL database (DATABASE_URL_UNPOOLED or DATABASE_URL, docs/VERCEL.md); the JSON store needs a real disk");
  // Embedded PostgreSQL lives inside one process: every Vercel instance would get its own empty database, so data
  // written by one request would be missing from the next.
  if (kind === "pglite" && env.VERCEL) throw new Error("On Vercel connect a PostgreSQL database (DATABASE_URL_UNPOOLED or DATABASE_URL, docs/VERCEL.md); embedded PostgreSQL (STORE=pglite) keeps its data inside one instance");
  return kind;
}

/** Where the data lives, for log lines. Never includes a password. */
export function describeStore(): string {
  const kind = storeKind();
  if (kind === "postgres") {
    const urls = databaseUrls();
    if (!urls) return describeDatabaseUrl("");
    const main = describeDatabaseUrl(urls.query);
    return urls.lock === urls.query ? main : `${main} (code allocation: ${describeDatabaseUrl(urls.lock).replace(/^PostgreSQL /, "")})`;
  }
  if (kind === "pglite") return process.env.PGLITE_DIR ? `PostgreSQL (embedded) in ${process.env.PGLITE_DIR}` : "PostgreSQL (embedded, in memory)";
  return dbFilePath();
}

function storeKey(kind: StoreKind): string {
  if (kind === "postgres") {
    const urls = databaseUrls();
    return `postgres:${urls?.query ?? ""}|${urls?.lock ?? ""}`;
  }
  if (kind === "pglite") return `pglite:${process.env.PGLITE_DIR ?? ":memory:"}`;
  return `json:${dbFilePath()}`;
}

function openStore(kind: StoreKind): Store {
  if (kind === "postgres") {
    const urls = databaseUrls();
    if (!urls) throw new Error("STORE=postgres needs DATABASE_URL, e.g. postgres://user:password@host:5432/velza?sslmode=require");
    return new SqlStore(() => createPgDriver(urls.query, { max: urls.poolMax, lockUrl: urls.lock, lockMax: urls.lockPoolMax }), firstRunSeed);
  }
  if (kind === "pglite") {
    const dir = process.env.PGLITE_DIR || undefined;
    return new SqlStore(() => createPgliteDriver(dir), firstRunSeed);
  }
  const file = dbFilePath();
  return new JsonStore(file, () => firstRunSeed(file));
}

export function getStore(): Store {
  const kind = storeKind();
  const key = storeKey(kind);
  g.__velzaStores ??= new Map();
  let store = g.__velzaStores.get(key);
  if (!store) {
    store = openStore(kind);
    g.__velzaStores.set(key, store);
  }
  return store;
}

/** Close database connections (scripts call this so the process can exit). */
export async function closeStores(): Promise<void> {
  const stores = [...(g.__velzaStores?.values() ?? [])];
  g.__velzaStores?.clear();
  await Promise.all(stores.map((s) => (s instanceof SqlStore ? s.close() : undefined)));
  releaseJsonStoreLocks(); // a script or test file is done with its JSON files
}
