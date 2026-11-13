// npm run clear-activity → delete all activity (batches, print orders, lots, packs, movements,
// scans, reprints) but keep the setup: countries, flavours, partners, sign-ins, sessions, devices,
// batch code pool, ID sequences and settings, exactly as they are.
//
// It first prints the target and what would be removed, and changes nothing. `npm run clear-activity -- --force`
// deletes it after writing a timestamped backup; never in production, never on an ambiguous target.
// The rules are in scripts/clearActivityGuard.ts.

import path from "node:path";
import { closeStores, dbFilePath, describeStore, getStore, storeKind } from "@/lib/store";
import { ClearActivityRefused, runClearActivity } from "./clearActivityGuard";

async function main() {
  const force = process.argv.slice(2).includes("--force");
  const json = storeKind() === "json";
  const jsonFile = json ? path.resolve(dbFilePath()) : null;
  await runClearActivity({
    store: getStore,
    description: describeStore(),
    jsonFile,
    backupDir: jsonFile ? path.dirname(jsonFile) : path.join(process.cwd(), "data", "backups"),
    force,
    production: process.env.NODE_ENV === "production",
    env: process.env,
  });
}

main()
  .catch((e) => {
    console.error(e instanceof ClearActivityRefused ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeStores);
