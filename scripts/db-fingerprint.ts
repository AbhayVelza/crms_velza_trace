// npm run db:fingerprint -- [file] → write (to `file`, else print) the database's schema (DATABASE_URL, or STORE=pglite + PGLITE_DIR) as sorted lines:
// every column, constraint, index, trigger, function and view (src/lib/store/sql/fingerprint.ts; the monthly history
// partitions are left out, they depend on the date and the data). CI prints it for a database upgraded from the
// previous release and for a fresh one, and fails if they differ: an upgrade must leave exactly what a new install
// gets (an edited CREATE TABLE without an upgrade step shows up here). Column order is ignored on purpose (ALTER
// TABLE … ADD COLUMN appends), everything else is compared as PostgreSQL itself prints it.

import { writeFileSync } from "node:fs";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { schemaFingerprint } from "@/lib/store/sql/fingerprint";
import { SqlStore } from "@/lib/store/sql/sqlStore";

async function main() {
  if (storeKind() === "json") {
    console.error("No database configured. Set DATABASE_URL (see .env.example).");
    process.exitCode = 1;
    return;
  }
  // migrate() applies the schema first when the database is older (the same as the app on start).
  const d = await (getStore() as SqlStore).migrate();
  const lines = await schemaFingerprint(d.query);
  const out = process.argv[2];
  if (out) writeFileSync(out, lines.join("\n") + "\n");
  else console.log(lines.join("\n"));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeStores);
