// npm run db:stock -- <command> → look after the live stock summary (schema v9) in the database (DATABASE_URL).
//
//   rollup   fold stock_deltas into stock_summary. Safe any time; schedule it every minute (cron / systemd timer)
//            so stock_deltas stays small. Live counts are exact with or without it. The app also folds them by
//            itself (at most once a minute per process); stock_summary_rollup() never waits for another rollup, so
//            when one is running this command tries again for a few seconds instead of reporting 0.
//   check    recount every code and compare with the live summary. Exit code 1 if anything differs (alert on it).
//   rebuild  recount the summary from codes. Writes to codes wait until it finishes (minutes at full volume): only in
//            a maintenance window, after a failed check or a bulk change made with triggers switched off.
//
// Schema v11 (Option C, decision Q7): every code counts by its effective state: a pack that follows its sealed lot under
// the lot's state, a pack with its own state under that state only. The recount is the view stock_recount.
//
// rollup runs as one statement outside the app's SERIALIZABLE transactions, so it never makes a scan retry. check and
// rebuild read every code: at full volume that takes longer than the app role's 30 s statement limit, so they lift it
// for their own transaction only (VELZA_JOB_STATEMENT_TIMEOUT, default 30min).

import { closeStores, describeStore, getStore, storeKind } from "@/lib/store";
import { SqlStore } from "@/lib/store/sql/sqlStore";

const KEY = "location_id, status, code_type, lot_type, flavour, synced";
/** rollup: how often and how long to try again while another rollup holds the lock (20 × 250 ms = 5 s). */
const ROLLUP_ATTEMPTS = 20;
const ROLLUP_RETRY_MS = 250;
/** Time limit for one check / rebuild (a PostgreSQL interval such as 30min or 2h; 0 = none). */
const JOB_TIMEOUT = process.env.VELZA_JOB_STATEMENT_TIMEOUT || "30min";

async function main() {
  const command = process.argv[2];
  if (!["rollup", "check", "rebuild"].includes(command ?? "")) {
    console.error("Usage: npm run db:stock -- rollup | check | rebuild");
    process.exitCode = 2;
    return;
  }
  if (storeKind() === "json") {
    console.error("No database configured. Set DATABASE_URL (see .env.example). The JSON store has no stock summary to look after.");
    process.exitCode = 1;
    return;
  }
  const d = await (getStore() as SqlStore).driver();
  /** One transaction with this job's own statement time limit (set_config(…, true) = for this transaction only). */
  const long = <R>(sql: string) =>
    d.transaction(async (q) => {
      await q(`SELECT set_config('statement_timeout', $1, true)`, [JOB_TIMEOUT]);
      return q<R>(sql);
    });

  if (command === "rollup") {
    // 0 means "nothing to fold" or "another rollup holds the lock". In the second case deltas are still there
    // (that rollup has not committed yet): wait a moment and try again, so a scheduled run doesn't silently skip.
    let folded = 0;
    for (let attempt = 1; ; attempt++) {
      const [r] = await d.query<{ n: string }>(`SELECT stock_summary_rollup() AS n`);
      folded = Number(r.n);
      if (folded > 0) break;
      const [left] = await d.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM stock_deltas) AS any`);
      if (!left.any) break;
      if (attempt >= ROLLUP_ATTEMPTS) {
        console.log(`Another stock rollup kept the lock for ${(ROLLUP_ATTEMPTS * ROLLUP_RETRY_MS) / 1000} s; it folds the deltas (${describeStore()})`);
        return;
      }
      await new Promise((r) => setTimeout(r, ROLLUP_RETRY_MS));
    }
    console.log(`Folded ${folded} delta rows into stock_summary (${describeStore()})`);
    return;
  }

  if (command === "rebuild") {
    const started = Date.now();
    await long(`SELECT stock_summary_rebuild()`);
    const [r] = await d.query<{ n: string }>(`SELECT count(*) AS n FROM stock_summary`);
    console.log(`Rebuilt stock_summary from codes: ${r.n} rows in ${Date.now() - started} ms (${describeStore()})`);
    return;
  }

  // check: every key where the live summary and a full recount disagree.
  const diffs = await long<Record<string, string | boolean | null>>(
    `WITH live AS (SELECT ${KEY}, units FROM stock_current),
          real AS (SELECT ${KEY}, units FROM stock_recount)
     SELECT ${KEY.split(", ").map((c) => `COALESCE(live.${c}, real.${c}) AS ${c}`).join(", ")},
            COALESCE(live.units, 0) AS live_units, COALESCE(real.units, 0) AS real_units
       FROM live FULL JOIN real USING (${KEY})
      WHERE COALESCE(live.units, 0) <> COALESCE(real.units, 0)
      ORDER BY 1, 2, 3, 4, 5, 6`,
  );
  if (!diffs.length) {
    console.log(`Stock summary matches a full recount of codes (${describeStore()})`);
    return;
  }
  console.error(`Stock summary differs from a full recount in ${diffs.length} place(s) — run \`npm run db:stock -- rebuild\`:`);
  console.table(diffs);
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeStores);
