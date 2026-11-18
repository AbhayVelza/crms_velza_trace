// Active store, one instance per process (kept on globalThis so every route bundle shares it):
//   STORE=json      (default) data/db.json, or VELZA_DB_PATH
//   STORE=postgres  PostgreSQL at DATABASE_URL_UNPOOLED or DATABASE_URL (chosen automatically when either is set)
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
 * The PostgreSQL connection string. DATABASE_URL_UNPOOLED wins when set: on Vercel the Neon integration sets
 * DATABASE_URL to Neon's pooled address (PgBouncer in transaction mode) and DATABASE_URL_UNPOOLED to the direct
 * one, for each preview's own database branch too. The app needs the direct one: code allocation holds a
 * session-level advisory lock across a transaction (sql/driver.ts), and a transaction-mode pooler may run the
 * lock, the transaction and the unlock on different server connections, leaving the lock held.
 */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || undefined;
}

export function storeKind(): StoreKind {
  const kind = process.env.STORE || (databaseUrl() ? "postgres" : "json");
  if (kind !== "json" && kind !== "postgres" && kind !== "pglite") throw new Error(`Unsupported STORE "${kind}" (use json, postgres or pglite)`);
  // Vercel functions have a read-only disk and many short-lived copies: a JSON file there would be lost or split.
  if (kind === "json" && process.env.VERCEL) throw new Error("On Vercel connect a PostgreSQL database (DATABASE_URL_UNPOOLED or DATABASE_URL, docs/VERCEL.md); the JSON store needs a real disk");
  return kind;
}

/** Where the data lives, for log lines. Never includes a password. */
export function describeStore(): string {
  const kind = storeKind();
  if (kind === "postgres") return describeDatabaseUrl(databaseUrl() ?? "");
  if (kind === "pglite") return process.env.PGLITE_DIR ? `PostgreSQL (embedded) in ${process.env.PGLITE_DIR}` : "PostgreSQL (embedded, in memory)";
  return dbFilePath();
}

function storeKey(kind: StoreKind): string {
  if (kind === "postgres") return `postgres:${databaseUrl() ?? ""}`;
  if (kind === "pglite") return `pglite:${process.env.PGLITE_DIR ?? ":memory:"}`;
  return `json:${dbFilePath()}`;
}

function openStore(kind: StoreKind): Store {
  if (kind === "postgres") {
    const url = databaseUrl();
    if (!url) throw new Error("STORE=postgres needs DATABASE_URL, e.g. postgres://user:password@host:5432/velza?sslmode=require");
    return new SqlStore(() => createPgDriver(url), firstRunSeed);
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
