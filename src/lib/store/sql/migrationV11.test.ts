// Rehearsal of the Supabase → new v11 database move (migration/03_transform.sql, 04_report.sql) on embedded PostgreSQL,
// with the very files a human runs with psql. Steps 01/02 (pg_dump, pg_restore) need a server and are left out: the
// staged "src" schema they produce is built here directly from the v10 schema and the fake v10 data.
// Also proves that the checks inside 03 catch a copy that is wrong only in a column the old 7-column check ignored
// (review issue 10) and a live stock summary that differs from Supabase (issue 11).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reprintServedId } from "@/lib/services/printOrders";
import { runPsqlScript, type ScriptDb } from "../../../../tests/fixtures/psqlScript";
import { createPgliteDriver, type SqlDriver } from "./driver";
import { SCHEMA_SQL } from "./schema";

const root = process.cwd();
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");
const TRANSFORM = path.join(root, "migration", "03_transform.sql");
const REPRINT_ID = "5f0c3a2e-1b7d-4e8a-9c61-2d4f6b8a0e13";

let d: SqlDriver;
let script: ScriptDb;
const tmp = mkdtempSync(path.join(os.tmpdir(), "velza-migration-"));
/** A copy of 03 with one change, to prove its checks catch it. */
function sabotaged(name: string, from: string, to: string) {
  // Normalise line endings: a Windows checkout (core.autocrlf) gives CRLF, and the patterns below use \n.
  const text = read("migration", "03_transform.sql").replace(/\r\n/g, "\n");
  expect(text).toContain(from);
  const file = path.join(tmp, name);
  writeFileSync(file, text.replace(from, to));
  return file;
}
const count = async (sql: string) => Number((await d.query<{ n: string }>(sql))[0].n);

beforeAll(async () => {
  d = await createPgliteDriver();
  script = { exec: (sql) => d.exec(sql), query: async (sql) => ({ rows: await d.query(sql) }) };
  // Step 2's result: Supabase's tables (schema v10, with data) in schema src of the new database.
  await d.exec(`CREATE SCHEMA src; SET search_path = src;`);
  await d.exec(read("tests", "sql", "schema_v10.sql"));
  await d.exec(read("tests", "sql", "make_fake_supabase_v10.sql").replace(/^\\set.*$/gm, ""));
  await d.exec(`INSERT INTO code_history (event_id, record_type, code, event, item_kind, login_id, event_time)
                VALUES ('reprint-served:${REPRINT_ID}', 'MOVEMENT', '91ABC123LM00002', 'REPRINT_SERVED', 'LOT', 'MF0001-OP', '2026-10-02 11:00+05:30')`);
  await d.exec(`RESET search_path;`);
  // The new database: schema v11, no rows (psql -1 -f db/schema.sql).
  await d.exec(SCHEMA_SQL);
});
afterAll(async () => {
  await d.close();
});

/** Run a 03 that must fail; the failed transaction is rolled back like psql does at exit. */
async function failing(file: string) {
  const message = await runPsqlScript(script, file).then(
    () => "passed",
    (e: Error) => e.message,
  );
  await d.exec(`ROLLBACK`);
  return message;
}

describe("Supabase (v10) → v11 migration rehearsal", () => {
  it("[10] the history check compares every column: a copy wrong only in message is refused, and nothing is kept", async () => {
    const file = sabotaged(
      "03_history.sql",
      "SELECT history_id, pg_temp.vz_uuid(event_id), record_type, code, event, item_kind, context, location_id, from_id, to_id,\n       status_before, status_after, invoice_no, reason, ok, result, message,",
      "SELECT history_id, pg_temp.vz_uuid(event_id), record_type, code, event, item_kind, context, location_id, from_id, to_id,\n       status_before, status_after, invoice_no, reason, ok, result, upper(message),",
    );
    expect(await failing(file)).toMatch(/Migration checks FAILED, nothing was kept: 2 history rows differ;/);
    expect(await count(`SELECT count(*) AS n FROM public.codes`)).toBe(0);
  });

  it("[11] the stock check compares the live summary with Supabase per place, flavour and lot type", async () => {
    const file = sabotaged(
      "03_stock.sql",
      "SELECT stock_summary_rebuild();",
      "SELECT stock_summary_rebuild();\nINSERT INTO stock_deltas (location_id, status, code_type, lot_type, flavour, synced, units) VALUES ('RT0001', 'AT_RETAILER', 'PACK', 'TRAY', 'LM', true, 1);",
    );
    expect(await failing(file)).toMatch(/Migration checks FAILED, nothing was kept: 1 stock counts differ;/);
    expect(await count(`SELECT count(*) AS n FROM public.code_history`)).toBe(0);
  });

  it("copies everything with every check passing; the report runs; a second run is refused", async () => {
    await runPsqlScript(script, TRANSFORM);
    expect(await count(`SELECT count(*) AS n FROM public.codes`)).toBe(1900);
    expect(await count(`SELECT count(*) AS n FROM public.code_history`)).toBe(704);
    expect(await count(`SELECT count(*) AS n FROM public.codes WHERE status IS NULL`)).toBe(1569);
    expect(await count(`SELECT count(*) AS n FROM public.damage_reports`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM public.code_history_default`)).toBe(0);
    // The served reprint keeps the id the v11 app looks for, and its once-only guard.
    expect(await count(`SELECT count(*) AS n FROM public.code_history WHERE event_id = '${reprintServedId(REPRINT_ID)}'`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM public.code_history_once`)).toBe(1);
    // Identity numbers continue after the copied ones.
    await d.exec(`INSERT INTO public.code_history (event_id, record_type, code, event, event_time) VALUES (gen_random_uuid(), 'SCAN', 'X', 'SCANNED', now())`);
    expect(await count(`SELECT max(history_id) AS n FROM public.code_history`)).toBe(705);

    await runPsqlScript(script, path.join(root, "migration", "04_report.sql"));
    expect(await failing(TRANSFORM)).toMatch(/Target already has data .* made with: psql .* -f db\/schema\.sql/);
  });
});
