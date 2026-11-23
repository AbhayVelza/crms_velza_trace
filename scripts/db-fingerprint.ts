// npm run db:fingerprint -- [file] → write (to `file`, else print) the database's schema (DATABASE_URL, or STORE=pglite + PGLITE_DIR) as sorted lines:
// every column, constraint, index, trigger, function and view. CI prints it for a database upgraded from the
// previous release and for a fresh one, and fails if they differ: an upgrade must leave exactly what a new install
// gets (an edited CREATE TABLE without an upgrade step shows up here). Column order is ignored on purpose (ALTER
// TABLE … ADD COLUMN appends), everything else is compared as PostgreSQL itself prints it.

import { writeFileSync } from "node:fs";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { SqlStore } from "@/lib/store/sql/sqlStore";

const FINGERPRINT = `
SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' nullable=' || is_nullable
       || ' default=' || COALESCE(column_default, '') || ' identity=' || is_identity AS line
  FROM information_schema.columns WHERE table_schema = current_schema()
UNION ALL
SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = current_schema()::regnamespace
UNION ALL
SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = current_schema()
UNION ALL
SELECT 'trigger ' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'pg_%'
UNION ALL
SELECT 'function ' || p.proname || ' ' || md5(pg_get_functiondef(p.oid))
  FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace
UNION ALL
SELECT 'view ' || viewname || ' ' || md5(definition) FROM pg_views WHERE schemaname = current_schema()
ORDER BY 1`;

async function main() {
  if (storeKind() === "json") {
    console.error("No database configured. Set DATABASE_URL (see .env.example).");
    process.exitCode = 1;
    return;
  }
  // migrate() applies the schema first when the database is older (the same as the app on start).
  const d = await (getStore() as SqlStore).migrate();
  const lines = (await d.query<{ line: string }>(FINGERPRINT)).map((r) => r.line);
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
