// npm run db:convert-chain → convert the active store (data/db.json, or the database when DATABASE_URL is
// set) from the old chain to Manufacturer → Super Stockist → Distributor → Retailer: Outlets become
// Retailers (OT0001 → the next RT number), Suppliers are removed and their Retailers assigned to the
// Supplier's Distributor. Refuses, changing nothing, if a Supplier still has stock or history.
//   --dry-run  only show what would change
// Before writing, the original data is saved as JSON in data/backups/ (next to the JSON file). A v1
// database is upgraded to the current schema in the same transaction as the converted data is written.

import { promises as fs } from "node:fs";
import path from "node:path";
import { closeStores, dbFilePath, describeStore, getStore, storeKind } from "@/lib/store";
import { convertChain } from "@/lib/store/convertChain";

function backupDir(): string {
  return storeKind() === "json" ? path.join(path.dirname(dbFilePath()), "backups") : path.join(process.cwd(), "data", "backups");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const store = getStore();
  const before = await store.snapshot();
  const { data, report } = convertChain(before);
  const changed = JSON.stringify(data) !== JSON.stringify(before);
  console.log(`Chain conversion of ${describeStore()}${dryRun ? " (dry run)" : ""}:`);
  for (const line of report) console.log(`  ${line}`);
  if (!changed) return;
  if (dryRun) {
    console.log("Dry run: nothing written. Run without --dry-run to convert.");
    return;
  }
  const dir = backupDir();
  await fs.mkdir(dir, { recursive: true });
  const backup = path.join(dir, `before-chain-conversion-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  // Sign-ins with password hashes are in here: the folder is git-ignored; keep it private.
  await fs.writeFile(backup, JSON.stringify(before, null, 1), { encoding: "utf8", flag: "wx" });
  console.log(`Saved the original data to ${backup}`);
  await store.reset(data);
  console.log(`Converted data written to ${describeStore()}.`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(closeStores);
