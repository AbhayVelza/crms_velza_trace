// npm run db:migrate → connect to the database (DATABASE_URL, or STORE=pglite + PGLITE_DIR) and bring its schema to
// this release's version (run it as the database owner; the app itself can then use a user without rights to create
// tables). Safe to run again: a database already at this version is left as it is. An empty database also gets the
// clean start (two staff sign-ins, passwords shown once in the log). The app does the same on first use.
//
// npm run db:migrate -- --force → apply the current schema again to a database already at this version (repairs a
// dropped index or trigger). It re-creates the triggers on codes and code_history, so it waits for scans in progress
// and holds new ones for up to 10 s: only in a quiet moment, never while plants are scanning.

import { closeStores, describeStore, getStore, storeKind } from "@/lib/store";
import { SqlStore } from "@/lib/store/sql/sqlStore";

async function main() {
  if (storeKind() === "json") {
    console.error("No database configured. Set DATABASE_URL=postgres://user:password@host:5432/velza (see .env.example).");
    process.exitCode = 1;
    return;
  }
  const store = getStore() as SqlStore;
  const force = process.argv.slice(2).includes("--force");
  const d = await store.migrate({ force });
  if (force) console.log("Re-applied the current schema (--force).");
  const tables = await d.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`,
  );
  const [counts] = await d.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM partners) AS partners, (SELECT count(*) FROM users) AS sign_ins,
            (SELECT count(*) FROM codes) AS codes, (SELECT count(*) FROM code_history) AS history`,
  );
  console.log(`Schema is up to date in ${describeStore()}`);
  console.log(`Tables: ${tables.map((t) => t.table_name).join(", ")}`);
  console.log(`Rows: ${counts.partners} partners, ${counts.sign_ins} sign-ins, ${counts.codes} codes, ${counts.history} history`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeStores);
