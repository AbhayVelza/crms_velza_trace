// Active store, chosen by env STORE (default "json"). One instance per process,
// kept on globalThis so every route bundle shares the same mutex and cache.

import path from "node:path";
import { JsonStore } from "./jsonStore";
import { buildBaseSeed } from "./seedData";
import type { Store } from "./Store";

export type { Store, StoreTx, DbSnapshot } from "./Store";
export { NotFoundError } from "./Store";

const g = globalThis as unknown as { __velzaStores?: Map<string, Store> };

export function dbFilePath(): string {
  return process.env.VELZA_DB_PATH ?? path.join(process.cwd(), "data", "db.json");
}

export function getStore(): Store {
  const kind = process.env.STORE ?? "json";
  if (kind !== "json") throw new Error(`Unsupported STORE "${kind}" (only "json" is implemented)`);
  const file = dbFilePath();
  g.__velzaStores ??= new Map();
  let store = g.__velzaStores.get(file);
  if (!store) {
    store = new JsonStore(file, () => buildBaseSeed());
    g.__velzaStores.set(file, store);
  }
  return store;
}
