// Active store, one instance per process (kept on globalThis so every route bundle shares it):
//   STORE=json      (default) data/db.json, or VELZA_DB_PATH
//   STORE=postgres  PostgreSQL at DATABASE_URL (chosen automatically when DATABASE_URL is set)
//   STORE=pglite    embedded PostgreSQL in PGLITE_DIR (in memory when unset) — local trials and tests
// Business logic only sees the Store interface, so switching is configuration, not code.

import path from "node:path";
import { JsonStore } from "./jsonStore";
import { firstRunSeed } from "./seedData";
import { createPgDriver, createPgliteDriver, describeDatabaseUrl } from "./sql/driver";
import { SqlStore } from "./sql/sqlStore";
import type { Store } from "./Store";

export type { Store, StoreTx, DbSnapshot } from "./Store";
export { NotFoundError } from "./Store";

export type StoreKind = "json" | "postgres" | "pglite";

const g = globalThis as unknown as { __velzaStores?: Map<string, Store> };

export function dbFilePath(): string {
  return process.env.VELZA_DB_PATH ?? path.join(process.cwd(), "data", "db.json");
}

export function storeKind(): StoreKind {
  const kind = process.env.STORE || (process.env.DATABASE_URL ? "postgres" : "json");
  if (kind !== "json" && kind !== "postgres" && kind !== "pglite") throw new Error(`Unsupported STORE "${kind}" (use json, postgres or pglite)`);
  return kind;
}

/** Where the data lives, for log lines. Never includes a password. */
export function describeStore(): string {
  const kind = storeKind();
  if (kind === "postgres") return describeDatabaseUrl(process.env.DATABASE_URL ?? "");
  if (kind === "pglite") return process.env.PGLITE_DIR ? `PostgreSQL (embedded) in ${process.env.PGLITE_DIR}` : "PostgreSQL (embedded, in memory)";
  return dbFilePath();
}

function storeKey(kind: StoreKind): string {
  if (kind === "postgres") return `postgres:${process.env.DATABASE_URL ?? ""}`;
  if (kind === "pglite") return `pglite:${process.env.PGLITE_DIR ?? ":memory:"}`;
  return `json:${dbFilePath()}`;
}

function openStore(kind: StoreKind): Store {
  if (kind === "postgres") {
    const url = process.env.DATABASE_URL;
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
}
