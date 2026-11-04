// npm run seed → a clean start in the active store (data/db.json, or the database when DATABASE_URL is set):
// country 91, the four flavours, default settings, and two sign-ins — Velza Admin (AD0001) and Velza HQ
// (HQ0001). Their passwords come from VELZA_ADMIN_PASSWORD / VELZA_HQ_PASSWORD, or are generated and shown once.
// Everything else is entered in the app (Admin portal).
//
// It only writes an EMPTY store. A store that already holds partners, batches, lots or history is refused;
// `npm run seed -- --force` replaces it after writing a timestamped backup, and never in production.
// The rules are in src/lib/store/seedGuard.ts.

import path from "node:path";
import { closeStores, dbFilePath, describeStore, getStore, storeKind } from "@/lib/store";
import { runSeed, SeedRefused } from "@/lib/store/seedGuard";
import { staffPasswords } from "@/lib/store/seedData";

async function main() {
  const force = process.argv.slice(2).includes("--force");
  const json = storeKind() === "json";
  const jsonFile = json ? path.resolve(dbFilePath()) : null;
  await runSeed({
    store: getStore(),
    description: describeStore(),
    jsonFile,
    backupDir: jsonFile ? path.dirname(jsonFile) : path.join(process.cwd(), "data", "backups"),
    force,
    production: process.env.NODE_ENV === "production",
    passwords: staffPasswords(),
    generated: { admin: !process.env.VELZA_ADMIN_PASSWORD, hq: !process.env.VELZA_HQ_PASSWORD },
  });
}

main()
  .catch((e) => {
    console.error(e instanceof SeedRefused ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeStores);
