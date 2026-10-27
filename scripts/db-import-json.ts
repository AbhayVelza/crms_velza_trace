// npm run db:import-json → copy everything in the JSON file (data/db.json, or VELZA_DB_PATH) into the
// database (DATABASE_URL). Refuses if the database already has partners or codes, unless --force
// (which replaces what is there). The JSON file is not changed. Data from before the chain change
// (Suppliers, Outlets) is converted on the way in, as `npm run db:convert-chain` does.

import { convertChain } from "@/lib/store/convertChain";
import { JsonStore } from "@/lib/store/jsonStore";
import { closeStores, dbFilePath, describeStore, getStore, storeKind } from "@/lib/store";

async function main() {
  if (storeKind() === "json") {
    console.error("No database configured. Set DATABASE_URL=postgres://user:password@host:5432/velza (see .env.example).");
    process.exitCode = 1;
    return;
  }
  const source = new JsonStore(dbFilePath(), () => {
    throw new Error(`${dbFilePath()} does not exist`);
  });
  const { data, report } = convertChain(await source.snapshot());
  const target = getStore();
  // Read as it is, so a database still on an older schema can be replaced too.
  const existing = await target.snapshot();
  if (existing.partners.length + existing.lots.length + existing.packs.length > 0 && !process.argv.includes("--force")) {
    console.error(`${describeStore()} already has partners or codes. Run with --force to replace them with the JSON data.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Chain conversion of ${dbFilePath()} (the file itself is not changed):`);
  for (const line of report) console.log(`  ${line}`);
  await target.reset(data);
  console.log(`Copied ${dbFilePath()} → ${describeStore()}:`);
  console.log(
    `  ${data.partners.length} partners, ${data.users.length} sign-ins, ${data.lots.length} lots + ${data.packs.length} packs = ` +
      `${data.lots.length + data.packs.length} codes, ${data.movements.length + data.scans.length + data.reprints.length} history rows`,
  );
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(closeStores);
