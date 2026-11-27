// The database's schema as sorted lines: every column, constraint, index, trigger, function and view. CI prints it for
// a database upgraded from the previous release and for a fresh one, and fails if they differ: an upgrade must leave
// exactly what a new install gets (an edited CREATE TABLE without an upgrade step shows up here). The schema tests
// compare the same lines. Column order is ignored on purpose (ALTER TABLE … ADD COLUMN appends); everything else is
// compared as PostgreSQL itself prints it.
//
// History months (code_history_YYYY_MM, schema v11) are left out: which months exist depends on the day the database
// was made and on its data (an upgraded database gets a partition for every month it has rows in), not on the schema.
// Each month is a copy of the code_history parent, whose columns, keys, indexes and triggers are compared.

import type { Query } from "./driver";

/** A monthly history partition's name. */
const MONTH = `'^code_history_[0-9]{4}_[0-9]{2}'`;

export const FINGERPRINT_SQL = `
SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' nullable=' || is_nullable
       || ' default=' || COALESCE(column_default, '') || ' identity=' || is_identity AS line
  FROM information_schema.columns WHERE table_schema = current_schema() AND table_name !~ ${MONTH}
UNION ALL
SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conrelid::regclass::text !~ ${MONTH}
UNION ALL
SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename !~ ${MONTH}
UNION ALL
SELECT 'trigger ' || pg_get_triggerdef(oid) FROM pg_trigger
 WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'pg_%' AND tgrelid::regclass::text !~ ${MONTH}
UNION ALL
SELECT 'function ' || p.proname || ' ' || md5(pg_get_functiondef(p.oid))
  FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace
UNION ALL
SELECT 'view ' || viewname || ' ' || md5(definition) FROM pg_views WHERE schemaname = current_schema()
ORDER BY 1`;

/** The schema fingerprint of the database behind `q`, one line per object. */
export async function schemaFingerprint(q: Query): Promise<string[]> {
  return (await q<{ line: string }>(FINGERPRINT_SQL)).map((r) => r.line);
}
