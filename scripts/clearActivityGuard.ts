// Safety rules for `npm run clear-activity`, which deletes ALL activity (batches, print orders, lots, packs, movements,
// scans, reprints) and keeps the setup. Same pattern as the seed guard (src/lib/store/seedGuard.ts):
//   - prints the exact target first, and refuses an ambiguous target (two stores configured, a JSON file that is
//     missing, not .json, a backup, a folder or a link),
//   - never runs in a production environment,
//   - without --force only shows what would be removed and changes nothing,
//   - with --force first writes a timestamped backup it never overwrites, reads it back, and stops if that fails.

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DbSnapshot, Store } from "@/lib/store";

export class ClearActivityRefused extends Error {
  constructor(
    public code: "NOT_FORCED" | "PRODUCTION" | "BAD_TARGET" | "AMBIGUOUS_TARGET" | "BACKUP_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ClearActivityRefused";
  }
}

/** The collections clear-activity empties. Everything else (countries, flavours, partners, sign-ins, sessions,
 *  devices, batch code pool, ID sequences, settings) is kept exactly as it is. */
export const ACTIVITY_COLLECTIONS = ["batches", "printOrders", "lots", "packs", "movements", "scans", "reprints"] as const;
type ActivityCollection = (typeof ACTIVITY_COLLECTIONS)[number];

export function activityCounts(s: DbSnapshot): Record<string, number> {
  const counts = Object.fromEntries(ACTIVITY_COLLECTIONS.map((k) => [k, s[k].length])) as Record<ActivityCollection, number>;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/**
 * Store settings that make it unclear which data would be cleared. Returns the reason, or null when the target is clear.
 * (Mirrors src/lib/store/index.ts storeKind: STORE wins, else DATABASE_URL means PostgreSQL, else the JSON file.)
 */
export function ambiguousTarget(env: Record<string, string | undefined>): string | null {
  const store = env.STORE?.trim();
  if (!store && env.DATABASE_URL && env.VELZA_DB_PATH) {
    return "both DATABASE_URL and VELZA_DB_PATH are set and STORE is not: set STORE=postgres or STORE=json to say which one to clear";
  }
  if (store === "json" && env.DATABASE_URL) return "STORE=json but DATABASE_URL is also set: unset one of them";
  if ((store === "postgres" || store === "pglite") && env.VELZA_DB_PATH) return `STORE=${store} but VELZA_DB_PATH is also set: unset one of them`;
  return null;
}

/** A JSON target must be an existing plain .json file that is not a backup. A missing file is never created. */
export async function checkClearJsonTarget(file: string): Promise<void> {
  const resolved = path.resolve(file);
  const base = path.basename(resolved).toLowerCase();
  if (path.extname(base) !== ".json") throw new ClearActivityRefused("BAD_TARGET", `Refusing to clear ${resolved}: the JSON store file must end in .json`);
  if (base.includes("backup")) throw new ClearActivityRefused("BAD_TARGET", `Refusing to clear ${resolved}: that looks like a backup file`);
  const existing = await lstat(resolved).catch(() => null);
  if (!existing) throw new ClearActivityRefused("BAD_TARGET", `Refusing to clear ${resolved}: the file does not exist (nothing was created)`);
  if (!existing.isFile()) throw new ClearActivityRefused("BAD_TARGET", `Refusing to clear ${resolved}: it is not a plain file (folder or link)`);
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

/** Writes the backup without ever replacing a file, then reads it back. Returns its path. */
async function writeBackup(snapshot: DbSnapshot, dir: string, now: Date): Promise<string> {
  const file = path.join(dir, `db.backup-${stamp(now)}-before-clear-activity.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(snapshot, null, 1), { encoding: "utf8", flag: "wx" }); // wx: fail if it exists
    const back = JSON.parse(await readFile(file, "utf8")) as DbSnapshot;
    for (const k of ["partners", ...ACTIVITY_COLLECTIONS] as const) {
      if (back[k]?.length !== snapshot[k].length) throw new Error(`read-back mismatch in ${k}`);
    }
  } catch (e) {
    throw new ClearActivityRefused("BACKUP_FAILED", `Backup to ${file} failed (${(e as Error).message}); nothing was changed`);
  }
  return file;
}

export interface ClearActivityOptions {
  /** Opens the store. Called only after the target checks pass, so a missing JSON file is never created. */
  store: () => Store;
  /** Where the data lives, for the log (never includes a password). */
  description: string;
  /** JSON store file, or null for a database. */
  jsonFile: string | null;
  /** Folder for the backup. */
  backupDir: string;
  force: boolean;
  production: boolean;
  /** Environment to check for an ambiguous target (default: none). */
  env?: Record<string, string | undefined>;
  now?: Date;
  log?: (line: string) => void;
}

export interface ClearActivityResult {
  cleared: Record<string, number>;
  backup: string | null;
}

export async function runClearActivity(o: ClearActivityOptions): Promise<ClearActivityResult> {
  const log = o.log ?? console.log;
  log(`Clear-activity target: ${o.description}`);
  if (o.production) throw new ClearActivityRefused("PRODUCTION", "Refusing to clear activity in production (NODE_ENV=production). Nothing was changed.");
  const ambiguous = o.env ? ambiguousTarget(o.env) : null;
  if (ambiguous) throw new ClearActivityRefused("AMBIGUOUS_TARGET", `Refusing to clear activity: ${ambiguous}. Nothing was changed.`);
  if (o.jsonFile) await checkClearJsonTarget(o.jsonFile);

  const store = o.store();
  const data = await store.snapshot();
  const found = activityCounts(data);
  const describe = Object.entries(found).map(([k, n]) => `${n} ${k}`).join(", ");
  if (!describe) {
    log("There is no activity to clear. Nothing was changed.");
    return { cleared: {}, backup: null };
  }
  if (!o.force) {
    throw new ClearActivityRefused(
      "NOT_FORCED",
      `clear-activity would delete ${describe} from ${o.description}. Nothing was changed. To delete it run \`npm run clear-activity -- --force\` (a backup is written first).`,
    );
  }

  const backup = await writeBackup(data, o.backupDir, o.now ?? new Date());
  log(`Backup written: ${backup}`);
  await store.reset({ ...data, ...Object.fromEntries(ACTIVITY_COLLECTIONS.map((k) => [k, []])) });
  log(`Cleared ${describe} in ${o.description}`);
  log(
    `Kept ${data.partners.length} partners, ${data.users.length} sign-ins, ${data.devices.length} device(s), ` +
      `${data.batchCodePool.filter((p) => p.status === "RESERVED").length} reserved batch codes (used ones stay used), settings`,
  );
  return { cleared: found, backup };
}
