// Safety rules for `npm run seed`, which replaces ALL data with a clean start. On 30 Oct 2026 a seed run
// wiped live data (a partner and 5,000 lots) with no way back, so a seed now:
//   - prints the exact target it is about to write,
//   - only writes an empty target (no partners, devices, batches, lots, history or extra sign-ins),
//   - needs --force to replace data, and then first writes a timestamped backup it never overwrites,
//     reads it back, and stops if that fails,
//   - never replaces data in a production environment,
//   - for the JSON store only writes a .json file in an existing folder (not a backup, link or folder).

import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DbSnapshot, Store } from "./Store";
import { ADMIN_LOGIN_ID, buildBaseSeed, HQ_LOGIN_ID, type StaffPasswords } from "./seedData";

export class SeedRefused extends Error {
  constructor(
    public code: "NOT_EMPTY" | "PRODUCTION" | "BAD_TARGET" | "BACKUP_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SeedRefused";
  }
}

/** Rows that mean the target holds real work. The clean start itself (staff sign-ins, reference data) does not count. */
export function dataSummary(s: DbSnapshot): Record<string, number> {
  const staff = new Set([ADMIN_LOGIN_ID, HQ_LOGIN_ID]);
  const counts: Record<string, number> = {
    partners: s.partners.length,
    "sign-ins (besides AD0001/HQ0001)": s.users.filter((u) => !staff.has(u.id)).length,
    devices: s.devices.length,
    "pool codes": s.batchCodePool.length,
    batches: s.batches.length,
    "print orders": s.printOrders.length,
    lots: s.lots.length,
    packs: s.packs.length,
    movements: s.movements.length,
    scans: s.scans.length,
    reprints: s.reprints.length,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/** A JSON target must be a .json file (not a backup, folder or link) in a folder that exists. */
export async function checkJsonTarget(file: string): Promise<void> {
  const resolved = path.resolve(file);
  const base = path.basename(resolved).toLowerCase();
  if (path.extname(base) !== ".json") throw new SeedRefused("BAD_TARGET", `Refusing to seed ${resolved}: the JSON store file must end in .json`);
  if (base.includes("backup")) throw new SeedRefused("BAD_TARGET", `Refusing to seed ${resolved}: that looks like a backup file`);
  const dir = await stat(path.dirname(resolved)).catch(() => null);
  if (!dir?.isDirectory()) throw new SeedRefused("BAD_TARGET", `Refusing to seed ${resolved}: folder ${path.dirname(resolved)} does not exist`);
  const existing = await lstat(resolved).catch(() => null);
  if (existing && !existing.isFile()) throw new SeedRefused("BAD_TARGET", `Refusing to seed ${resolved}: it is not a plain file (folder or link)`);
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

/** Writes the backup without ever replacing a file, then reads it back. Returns its path. */
async function writeBackup(snapshot: DbSnapshot, dir: string, now: Date): Promise<string> {
  const file = path.join(dir, `db.backup-${stamp(now)}-before-seed.json`);
  try {
    await mkdir(dir, { recursive: true });
    const text = JSON.stringify(snapshot, null, 1);
    await writeFile(file, text, { encoding: "utf8", flag: "wx" }); // wx: fail if the file exists
    const back = JSON.parse(await readFile(file, "utf8")) as DbSnapshot;
    if (back.partners.length !== snapshot.partners.length || back.lots.length !== snapshot.lots.length) throw new Error("read-back mismatch");
  } catch (e) {
    throw new SeedRefused("BACKUP_FAILED", `Backup to ${file} failed (${(e as Error).message}); nothing was changed`);
  }
  return file;
}

export interface SeedOptions {
  store: Store;
  /** Where the data lives, for the log (never includes a password). */
  description: string;
  /** JSON store file, or null for a database. */
  jsonFile: string | null;
  /** Folder for the pre-seed backup. */
  backupDir: string;
  force: boolean;
  production: boolean;
  passwords: StaffPasswords;
  /** Which passwords were generated here (shown once); the others came from the environment and are never printed. */
  generated: { admin: boolean; hq: boolean };
  now?: Date;
  log?: (line: string) => void;
}

export interface SeedResult {
  replaced: Record<string, number>;
  backup: string | null;
}

export async function runSeed(o: SeedOptions): Promise<SeedResult> {
  const log = o.log ?? console.log;
  log(`Seed target: ${o.description}`);
  if (o.jsonFile) await checkJsonTarget(o.jsonFile);

  // A JSON file that does not exist yet is empty; reading it through the store would create it.
  const exists = o.jsonFile ? !!(await stat(path.resolve(o.jsonFile)).catch(() => null)) : true;
  const current = exists ? await o.store.snapshot() : null;
  const found = current ? dataSummary(current) : {};
  const describe = Object.entries(found).map(([k, n]) => `${n} ${k}`).join(", ");

  let backup: string | null = null;
  if (describe) {
    if (o.production) throw new SeedRefused("PRODUCTION", `Refusing to replace data in production (target holds ${describe}). Nothing was changed.`);
    if (!o.force) {
      throw new SeedRefused(
        "NOT_EMPTY",
        `Refusing to seed: the target holds ${describe}. Nothing was changed. To replace it anyway run \`npm run seed -- --force\` (a backup is written first).`,
      );
    }
    backup = await writeBackup(current!, o.backupDir, o.now ?? new Date());
    log(`Backup written: ${backup}`);
  }

  await o.store.reset(buildBaseSeed(o.passwords));
  log(`Clean data written to ${o.description}${describe ? ` (replaced ${describe})` : ""}`);
  // A generated password is stored only as a hash, so this is the one time it can be shown.
  log(`  Velza Admin: sign-in ${ADMIN_LOGIN_ID}, password ${o.generated.admin ? o.passwords.admin : "from VELZA_ADMIN_PASSWORD"}`);
  log(`  Velza HQ:    sign-in ${HQ_LOGIN_ID}, password ${o.generated.hq ? o.passwords.hq : "from VELZA_HQ_PASSWORD"}`);
  log("Change both after the first sign-in (Account page). Register partners in the Admin portal.");
  return { replaced: found, backup };
}
