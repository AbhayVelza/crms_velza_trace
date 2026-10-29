# Velza Traceability CRM — Scalability Report (100,000+ records)

**Run date:** 28 Oct 2026 · **Branch:** `develop/aditya` (HEAD `8393c95`) · Raw results: `docs/qa/perf-1k.json`,
`perf-10k.json`, `perf-100k.json`

> **Status:** Part A (below) is the DEF-002 remediation and re-test of 28 Oct 2026. Part B is the original assessment,
> kept as it was written, before any code changed.

# Part A — DEF-002 remediation and re-test (28 Oct 2026)

Code: working tree on `develop/aditya` (HEAD still `8393c95`, nothing committed). Raw results: `docs/qa/def-002/`.

## A1. Verdict

**100,000-record support is NOT proven.** What the evidence supports:

| Store | At 100k code records, sequential (p95) | At 10 concurrent clients (p95) |
|---|---|---|
| **PostgreSQL 17.3 server** (first real-PostgreSQL run) | **PASS** exact lookup (38 ms), My partners (147 ms), My stock (74 ms), alerts (111 ms), batch list (407 ms), scan audit (188 ms), partner list (35 ms), writes (17–202 ms). **FAIL** HQ dashboard (1,641 ms; target 1,000) | **FAIL** for lookup (281 ms), dashboard (11.0 s), My partners (951 ms), alerts (557 ms), batch list (2.2 s), scan audit (1.4 s); PASS My stock (445 ms), partner list (224 ms), writes (≤ 105 ms). No errors and no timeouts (before: 40 % of lookups failed, every dashboard timed out) |
| **JSON file store** (development store) | **FAIL** exact lookup (2.75 s), dashboard (1.35 s), every write (2.3–3.1 s). PASS My partners (157 ms), My stock (79 ms), alerts (194 ms) | **FAIL** for almost everything (whole-file write per audit scan serializes requests) |

Measured on one 8 GB Windows PC with client, app and database on the same machine; concurrency figures are a lower
bound for a real deployment, not a capacity statement. Targets are the provisional internal ones in §2.

## A2. Root causes (confirmed in the source)

| Operation (endpoint) | Root cause | Evidence |
|---|---|---|
| Exact lookup (`GET /api/lookup/:code`, `lookup()` in `trace.ts`) | Read the whole movement ledger and the whole reprint ledger, filtered in memory; and loaded every partner, user and device for names | `trace.ts:47` (before), `:93`; PostgreSQL plan: scan of 104,127 rows, 73.6 ms → after: index scan on `code_history_code`, 7 rows, **0.5 ms** |
| Exact lookup under concurrency on PostgreSQL (**found in this re-test**) | Read and audit-scan insert in one `SERIALIZABLE` transaction: concurrent lookups of a code read the history rows the others insert into, and PostgreSQL aborts them (`40001 could not serialize access due to read/write dependencies`; the driver retries 5 times, then fails) | Before: 30 % (1k), 53 % (10k), 40 % (100k) of 10 concurrent lookups failed. Narrowing the reads alone still left 20 % at 1k; moving the read out of the transaction: **0 %** at every size |
| HQ dashboard (`dashboard()`) | `stockCounts()` filtered every lot and pack once **per partner** (partners × codes), damage units filtered per partner, and `alerts()` was called inside, reading every lot, pack and **every scan** a second time | 9.6 s (JSON) / 10.8 s (PostgreSQL) at 100k; all 10 concurrent requests timed out at 60 s |
| HQ alerts (`alerts()`) | Read every lot and pack to find in-transit units, and every scan, although only failed scans can raise an alert | 0.8–1.1 s at 100k |
| My partners (`myPartners()` in `movement.ts`) | Read every lot and pack, then `stockCounts()` per child partner (children × codes) | 1.3 s at 100k on both stores |
| My stock (`myStock()`) | Read every lot and pack (and every DAMAGED movement) to show one partner's stock | 0.63–0.64 s at 100k on both stores |
| Batch list (`listBatches()`) | Filtered every lot once per batch (batches × lots), read every batch | 0.5 s (PostgreSQL) at 100k |
| Same pattern, not benchmarked | `batchReport()` read the whole movement ledger; `recallReport()` every pack; `listDamaged()` every lot and pack; `codesForOrder()` every pack; `createPrintOrder()` every lot to check for duplicates; partner delete (`referencesTo()`) every lot, pack and movement | Source inspection; covered by the new regression tests |
| JSON store, any request that writes (including every lookup's audit scan) | Each transaction clones the whole database and rewrites the whole file | Profiled on the 100k file: clone ≈ 1.0 s, `JSON.stringify` ≈ 0.57 s, write ≈ 0.2 s per write. **Not changed** (development store; see A6) |

## A3. What was changed (application code)

| File | Function | Change |
|---|---|---|
| `src/lib/store/Store.ts` | `Where<T>` | A filter value may be an array = "any of" (SQL `= ANY(...)`); empty array matches nothing. Additive: existing filters unchanged |
| `src/lib/store/jsonStore.ts` | `matcher()` (was `matches()`) | Implements the array form with a `Set`, built once per call |
| `src/lib/store/sql/sqlStore.ts` | `makeRepo().where()` | Array → `column = ANY($n::type[])` (uses the column's index); `null` in the array → `OR column IS NULL`, same as the JSON store; refused on JSON/array columns |
| `src/lib/services/trace.ts` | `lookup()` | History by `itemCode` (lot + pack) and batch-wide events by batch code; reprints by code; names only for the partners, users and devices in the answer. Reads run outside a transaction; the audit scan is appended as its own one-step transaction (still written for every lookup, found or not) |
| | `names()` | Optional `only` IDs → one filtered query each |
| | `alerts()` | Reads in-transit lots/packs, **failed** scans (`ok = false`), DAMAGED movements, and the lots those refer to — nothing else |
| | `dashboard()` | Lots, packs and damage grouped by location **once** (`Map.groupBy`); status counts in one pass; alerts computed from the data already read (no second full read); failed scans only |
| | `myStock()` | Lots/packs **at** the partner and **on the way to** it (indexed `location_id`, `in_transit_to`), their lots, and its own whole-lot damage reports |
| | `listBatches()`, `batchReport()`, `recallReport()` | Batches filtered in the store; lots of those batches grouped once; movements by lot codes; packs only of lots that were opened |
| `src/lib/services/movement.ts` | `myPartners()` | Lots/packs at the child partners (`location_id = ANY`), what I sent them in transit, and the lots of those packs; grouped once |
| `src/lib/services/damage.ts` | `listDamaged()` | DAMAGED lots and packs plus the lots they and the damage reports refer to (all `damagedUnits()` reads) |
| `src/lib/services/printOrders.ts` | `createPrintOrder()`, `codesForOrder()` | Duplicate check reads only the new codes; codes view reads only the order's packs |
| `src/lib/services/admin.ts` | `referencesTo()` | Partner references counted by filtered queries (each row once) |

**Unchanged:** response shapes and field names of every endpoint; permissions (`requireAction`), partner scoping,
sync visibility, audit events (every lookup still logs a `LOOKUP` scan); business rules (one Super Stockist per state,
PIN/state validation, DEF-001 settings access); the database schema and indexes; no caching was added.

**One behaviour difference, by design:** a lookup's read and its audit scan are no longer one atomic transaction. The
scan is written right after the read; if another request changes the item in between, the logged message ("LOT
AT_SS") reflects the read. This is what removes the PostgreSQL serialization failures.

## A4. Regression tests added

| File | What it proves | Result |
|---|---|---|
| `tests/unit/scalability.test.ts` (new, 20 tests; runs on the JSON store **and** on PostgreSQL/PGlite) | Builds a network through the real services (6 cases through plant → SS → DB → retailer, an opened case, damaged pack and case, in-transit units, a NOT_RECEIVED case, failed scans, an unsynced case with a damage report, a recall). Each changed service is compared **field by field with the old whole-table computation** done from a full snapshot: lookup timeline/children/names, dashboard counts/stock/in-transit/alerts, alerts, My partners (SS and DB), My stock (5 partners), Damaged, batch list/report, recall report, codes view, partner delete. A read recorder wraps every `list()` (inside and outside transactions) and asserts **no whole-table read** of lots, packs, movements, scans or reprints on those paths. Also: unknown, malformed, empty and QR-URL codes; same code twice; 10 concurrent lookups of one code all answer and are all audited; answer unchanged after unrelated history is added; 401/403 for every wrong role; unsynced codes invisible; empty network (all zeros, empty lists) | JSON 20/20, PostgreSQL 20/20 |
| `src/lib/store/store.contract.test.ts` (+1 test, both stores) | "Any of" filters: order, with equality, `null` in the list, empty list, lots vs packs in the shared `codes` table, ledger by item codes | pass on JSON and PostgreSQL |
| Test of the test | The new file run against the **unmodified** code (HEAD): all 9 tests with a read assertion fail on exactly that assertion (e.g. lookup read `movements`, `reprints` whole), and every equivalence assertion before it passes | 9 fail as expected |
| Old-vs-new differential (one-off, not committed) | The old services (HEAD) and the new ones answered 105 calls on the same enriched 10k dataset (19 opened lots, 8 damaged lots, 53 damaged packs, 5 loose packs in transit, 12 unsynced lots, a recalled batch): **104 identical**; alerts differ only in the "in transit for 7d 20h / 7d 21h" age text (the two runs crossed an hour boundary) | equivalent |

Full suites after the change: lint pass; typecheck pass; unit JSON project 18 files / 249 tests pass; PostgreSQL project
7 files / 76 tests pass (run with `--no-file-parallelism`, see A7); production build pass; browser E2E: see the QA report.

## A5. Before and after (p50 / p95 ms)

Same harness, data and machine for before and after (before = HEAD re-run today, not the older report, which was
measured with more free memory and is 1.5–3× faster at 10k). Sequential = 1 client; c10 = 10 concurrent clients.
1k/10k: 15 sequential + 30 concurrent requests per endpoint; 100k: 5 + 10; 2 warm-up requests each.

**PostgreSQL 17.3, 100,000 code records (20,002 lots + 80,010 packs, 2,018 partners, 104,127 movements, 20,047 scans)**

| Operation | Sequential before | Sequential after | c10 before | c10 after |
|---|---:|---:|---:|---:|
| Exact lookup — case | 441 / 677 | **29 / 38** | 20,183 / 23,742 (40 % errors) | **190 / 281** (0) |
| Exact lookup — pack | 500 / 594 | **16 / 28** | 17,866 / 22,486 (40 % errors) | **101 / 105** (0) |
| HQ dashboard | 10,774 / 11,775 | **892 / 1,641** | 60,010 / 60,011 (all timed out) | **10,951 / 10,999** (0) |
| HQ alerts | 1,124 / 1,148 | **73 / 111** | 7,918 / 10,407 | **534 / 557** |
| My partners (Super Stockist) | 1,301 / 1,385 | **141 / 147** | 5,852 / 8,903 | **852 / 951** |
| My stock (Retailer) | 630 / 887 | **53 / 74** | 7,765 / 7,818 | **421 / 445** |
| Batch list | 503 / 690 | 366 / 407 | 2,936 / 3,986 | 2,091 / 2,155 |
| Partner list (Admin, all) | 39 / 78 | 27 / 35 | 235 / 458 | 143 / 224 |
| Scan audit (latest 300) — unchanged | 172 / 191 | 176 / 188 | 1,074 / 1,427 | 1,165 / 1,418 |
| Public QR check — unchanged | 8 / 11 | 9 / 11 | 55 / 229 | 43 / 50 |
| Dispatch scan check (write) | 19 / 20 | 14 / 17 | 98 / 106 | 61 / 66 |
| Register a partner (write) | 146 / 167 | 122 / 202 | — | — |

PostgreSQL at 10k: lookup 52/84 → 17/40 (c10 errors 53 % → 0), dashboard 335/433 → 79/115, alerts 137/175 → 20/26,
My partners 92/113 → 14/21, My stock 136/155 → 16/26. At 1k: lookup c10 errors 30 % → 0; every changed read ≤ 53 ms p95.

**JSON file store, 100,000 code records**

| Operation | Sequential before | Sequential after | c10 before | c10 after |
|---|---:|---:|---:|---:|
| Exact lookup — case | 2,694 / 4,168 | 2,476 / 2,751 | 14,076 / 29,006 | 12,489 / 24,864 |
| HQ dashboard | 9,599 / 9,994 | **988 / 1,350** | 60,015 / 60,016 (all timed out) | **11,693 / 11,786** (0) |
| HQ alerts | 768 / 908 | **167 / 194** | 7,659 / 7,812 | **1,485 / 1,515** |
| My partners (Super Stockist) | 1,285 / 1,489 | **139 / 157** | 5,609 / 11,484 | **1,251 / 1,348** |
| My stock (Retailer) | 643 / 1,273 | **72 / 79** | 9,005 / 9,191 | **724 / 749** |
| Public QR check — unchanged code | 2,145 / 2,265 | 2,457 / 2,612 | 10,332 / 22,474 | 14,416 / 26,201 |
| Dispatch scan check (write) ¹ | 2,203 / 2,668 | 2,434 / 3,058 | 11,198 / 23,994 | 11,503 / 23,110 |
| Register a partner (write) ¹ | 2,419 / 2,914 | 2,481 / 3,094 | — | — |

¹ From the earlier complete after-fix run (`new-json-100000-earlier.json`): in the final run the server was stopped by
a low-memory condition during these two scenarios (connection errors), so those rows of `new-json-100000.json` are invalid.

JSON at 10k: dashboard 251/480 → 155/244, alerts 86/119 → 18/23, My partners 70/284 → 21/44, My stock 81/128 → 16/29;
lookups stay write-bound (734/912 → 261/589). **At 1k the JSON results are within this machine's run-to-run noise**
(endpoints whose code did not change moved 2–3× between runs), so no 1k JSON conclusion is drawn.

Server memory (working set at the end / peak): PostgreSQL app process at 100k 902 / 1,039 MB → **653 / 691 MB**; at 10k
577 / 593 → 268 / 284 MB. JSON at 10k 496 / 512 → 457 / 473 MB; JSON 100k after: not captured (run stopped).
Payload sizes are unchanged (same responses): dashboard 589 KB, partner list 667 KB, alerts 285 KB at 100k.

## A6. PostgreSQL and the JSON store behave differently — not interchangeable

- **Reads:** on PostgreSQL the filtered reads use the existing indexes (`code_history_code`, `codes_location`,
  `partners_parent`, `code_history_type_event`; plans in `docs/qa/def-002/postgres-query-plans-100k.txt`). On the JSON store the same
  filter is an in-memory scan without cloning — fast, but still proportional to the table.
- **Writes:** PostgreSQL inserts one row (dispatch check 14–17 ms at 100k). The JSON store clones and rewrites the
  whole file (~1.8 s at 100k), so every lookup — which must log its audit scan — is bound by that, and requests queue on
  one in-process lock. **The JSON store cannot meet the lookup or write targets at 100k by design**; it is the
  development store. Nothing in it was changed.
- **Concurrency:** the serialization failures exist only on a PostgreSQL server (`SERIALIZABLE`, several connections).
  The embedded PGlite used by the unit tests runs one transaction at a time and cannot reproduce them.
- No JSON result was used to predict a PostgreSQL result or the other way round.

## A7. Remaining failures, blockers and environment notes

| Item | Status |
|---|---|
| HQ dashboard at 100k: p95 1.64 s (PostgreSQL), 1.35 s (JSON); 11 s at c10 | **FAIL.** It still reads every synced lot and pack (top statement: the packs `SELECT`, 80k rows) to build per-partner stock. Needs database-side aggregation — proposal P1 |
| c10 targets at 100k (lookup 281 ms, My partners 951 ms, alerts 557 ms, batch list 2.2 s, scan audit 1.4 s) | **FAIL on this PC.** Client, Next.js and PostgreSQL share 8 GB and 8 cores; re-measure with a separate client before concluding |
| JSON store lookups and writes at 10k–100k | **FAIL by design** (whole-file write); use PostgreSQL |
| Memory on this PC | Claude Code stopped two benchmark runs for low system memory (free RAM ≈ 0.5 GB). Runs were repeated one at a time; one final JSON 100k run lost its last two scenarios (footnote ¹) |
| Generated perf data on PostgreSQL | `perfGenerate.mjs` leaves batches without a print order, which `batches.print_order_id NOT NULL` refuses. The PostgreSQL copies got one synthetic printed order per batch (adapter outside the repo); "Print orders list" on PostgreSQL is therefore not comparable with JSON (432 KB vs 1 KB) |
| 1M / 2 crore records, soak, failure drills, separate client machine | Not run |
| Embedded-PostgreSQL unit tests timing out (`Hook timed out in 10000ms`) | **Cause established:** one PGlite start (`new PGlite()` + `waitReady`) takes ≈ 3.1 s alone and ≈ 12 s when 4 start in parallel, plus ≈ 2.6 s / 8.5 s to load the sample data; a test file's `beforeAll` needs ≈ 6 s alone and ≈ 20 s in parallel, over vitest's 10 s default hook timeout. Not a product defect. With `npx vitest run --project postgres --no-file-parallelism` all 76 tests pass. Test configuration **not** changed (proposal P6) |

## A8. Proposed (not implemented)

| # | Proposal | Evidence | Needs |
|---|---|---|---|
| P1 | Dashboard stock by database aggregation: a `countBy`/`GROUP BY location_id, status, lot_type` store method, plus opened lots and their packs by filter, instead of reading every lot and pack | Dashboard is the only 100k sequential failure on PostgreSQL; its top statements are the whole-table `codes` reads | A new `Store` method on both stores and careful equivalence tests (stock rules for opened cases); design approval |
| P2 | `ORDER BY … LIMIT` in the store for the scan audit (latest 300) and pagination for alerts and the partner list (DEF-004) | Scan audit reads all 20k scans to show 300 (1.4 s at c10); alerts 285 KB, partner list 667 KB at 100k | Response contract change (pagination fields) — UI change and approval |
| P3 | Partial index for in-transit lookups, e.g. `codes (row_no) WHERE status = 'IN_TRANSIT'` | Alerts' in-transit query uses `codes_location` and filters 5,115 heap rows (84 ms) | Schema change and migration; measure first at 1M |
| P4 | Batch list counts by aggregation (`GROUP BY batch_code, status`) | Batch list still reads every lot (p95 407 ms at 100k, 2.2 s at c10) | Same store method as P1 |
| P5 | `perfGenerate.mjs` should create one print order per batch so its data is valid on PostgreSQL | Import refused without the adapter | Harness change |
| P6 | PostgreSQL unit-test project: `fileParallelism: false` (or `maxWorkers: 2`) — preferred over a longer `hookTimeout` | A7 measurements | Test-configuration change; approval |
| P7 | Re-measure on PostgreSQL with a separate client machine, 1M records, `pg_stat_statements` and a soak | §7 of Part B | Hardware / environment |

## A9. How this re-test was run

| Item | Value |
|---|---|
| App | `next start` (production build) from an isolated copy of the working tree outside the repo; port 3400; sign-in ON; rate limits raised by env; `NODE_OPTIONS=--max-old-space-size=1200` at 100k |
| JSON runs | Unchanged `tests/qa/startQaServer.mjs start` and `tests/qa/perfBench.mjs`; each run on a fresh copy of the pristine generated file (so the bench's partner registrations never pile up) |
| PostgreSQL runs | PostgreSQL 17.3 (installed binaries), a private throwaway cluster in a temporary folder on `localhost:55432` (scram auth, `shared_buffers` 256 MB, `pg_stat_statements`); `npx tsx scripts/db-import-json.ts --force` (the `db:import-json` script) into a bench database before each run, `VACUUM ANALYZE`, then `next start` with `STORE=postgres`. The PostgreSQL already running on this PC (port 5432) was not touched |
| Data | `tests/qa/perfGenerate.mjs` files from the earlier run (fixed seed, identical MD5); sizes as in Part B §3 (1k: 1,012 code records; 10k: 10,012; 100k: 100,012) |
| Harness | No harness file in the repo was changed. Outside the repo: run scripts, the print-order adapter (A7), pre-picked bench codes for 1k/10k (the same codes `perfBench.mjs` picks). Note: `perfBench.mjs` labels every result "JSON file"; the copies in `docs/qa/def-002/` carry the correct store |
| Machine | Windows 11, 8 GB RAM (0.5–2.2 GB free during runs), 8 logical CPUs, Node 22.13.1 |

---

# Part B — Original assessment (before remediation)

## 1. Verdict (before remediation)

**FAIL — MEASURED** for the current JSON-file store at 100,000 code records: exact lookups (p95 5.6 s) and the HQ
dashboard (p95 10.6 s) miss their targets by 25× and 10×, and the dashboard timed out under 10 concurrent users.

**PostgreSQL: NOT LOAD-TESTED** (no PostgreSQL server was available). Code inspection shows the slow paths read whole
tables in the services, so moving to PostgreSQL alone is **not expected** to meet the targets (§5). No production
capacity claim can be made.

What did scale: the Admin partner list (2,018 partners: p95 65 ms) and the print-order preview (flat ~8 ms).

## 2. Targets (provisional, internal)

| Operation | Target |
|---|---:|
| Exact code lookup | p95 ≤ 200 ms |
| Paginated / filtered listing, partner detail | p95 ≤ 500 ms |
| Standard create / update | p95 ≤ 500 ms |
| Dashboard summary | p95 ≤ 1,000 ms |

## 3. Method

| Item | Value |
|---|---|
| Server | `next start` (production build) from an isolated copy of the repo, port 3400, `STORE=json`, sign-in ON, rate limits raised by env (`RATE_LIMIT_*_PER_MIN=1000000`) so the limiter is not what is measured; 100k run with `NODE_OPTIONS=--max-old-space-size=1200` to protect the PC |
| Machine | Windows 11 laptop/desktop, 8 GB RAM, 0.6–1.6 GB free; Node 22.13.1; client and server on the same machine (no network latency) |
| Data | `tests/qa/perfGenerate.mjs`, fixed seed (two runs → identical file, MD5 checked); built on the QA data file so the QA sign-ins work |
| Mix per case lot | 1 lot + 4 packs; GENERATED, PRINTED, VERIFIED + DISPATCHED/RECEIVED per hop; 1 VERIFY scan. 40% at the plant, 20% at an SS, 20% at a DB, 15% at a retailer, 5% in transit; RT0001 holds 1% of lots; one partner per 50 code records |
| Load | `tests/qa/perfBench.mjs`: 2 warm-up requests, then sequential (concurrency 1) and 10 concurrent clients. 1k/10k: 15 sequential + 30 concurrent per endpoint; 100k: 5 + 10. p99 only reported with ≥ 100 samples (not reached) |
| Timing | Client-side wall time per HTTP request (application response time). The JSON store has no query planner, so there are no separate database execution times or query plans |

| Dataset | Code records | Lots | Packs | Partners | Movements | Scans | File |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1k | 1,012 | 202 | 810 | 38 | 1,013 | 247 | 0.7 MB |
| 10k | 10,012 | 2,002 | 8,010 | 218 | 10,253 | 2,047 | 6.9 MB |
| 100k | 100,012 | 20,002 | 80,010 | 2,018 | 104,127 | 20,047 | 69 MB |

## 4. Results

Sequential (one request at a time), milliseconds, p50 / p95:

| Operation | 1k | 10k | 100k | Target met at 100k? |
|---|---:|---:|---:|:---:|
| Exact lookup — case (HQ trace) | 64 / 97 | 246 / 392 | **4,288 / 5,630** | ❌ |
| Exact lookup — pack | 65 / 86 | 238 / 338 | 2,591 / 2,705 | ❌ |
| Public QR check | 48 / 76 | 173 / 246 | 3,404 / 5,011 | ❌ |
| HQ dashboard | 45 / 55 | 233 / 271 | **9,215 / 10,589** | ❌ |
| HQ alerts | 22 / 40 | 74 / 140 | 925 / 1,216 | ❌ |
| Scan audit (latest 300) | 16 / 30 | 17 / 24 | 323 / 379 | ✅ |
| Batch list | 11 / 23 | 21 / 28 | 687 / 950 | ❌ |
| Partner list (Admin, all partners) | 9 / 12 | 7 / 14 | 51 / 65 | ✅ |
| My partners (Super Stockist) | 20 / 34 | 59 / 96 | 1,840 / 2,702 | ❌ |
| My stock (Retailer) | 24 / 48 | 59 / 73 | 674 / 740 | ❌ |
| Print orders list | 13 / 22 | 17 / 21 | 147 / 193 | ✅ |
| Print order preview ¹ | 8 / 10 | 6 / 9 | 8 / 18 | ✅ |
| Dispatch scan check (write) | 42 / 65 | 172 / 234 | 2,219 / 2,616 | ❌ |
| Register a partner (write) | 100 / 113 | 238 / 261 | 1,855 / 2,119 | ❌ |

At concurrency 10 (p50 / p95 ms, error rate):

| Operation | 1k | 10k | 100k |
|---|---:|---:|---:|
| Exact lookup — case | 562 / 667 | 2,303 / 2,433 | 13,787 / 30,313 (0) |
| HQ dashboard | 292 / 311 | 1,735 / 1,873 | 60,005 / 60,005 (**0.1 — 1 of 10 timed out at 60 s**) |
| Partner list | 63 / 116 | 62 / 87 | 245 / 396 (0) |
| Dispatch scan check (write) | 262 / 339 | 1,773 / 1,925 | 10,498 / 19,442 (0) |

Server memory (working set after the run): 1k 165 MB · 10k 469 MB · 100k 593 MB, **peak 1,176 MB** (at the 1.2 GB heap
cap). Payloads at 100k: dashboard 589 KB, partner list 667 KB, alerts 285 KB.

¹ The saved results call this scenario "reads every lot"; that label was wrong — the preview only plans the order. The
script label was corrected afterwards. Creating an order (not measured) does read every lot of the plant.

## 5. Why (code inspection)

| Cause | Evidence | Effect |
|---|---|---|
| Lookup reads the whole movement ledger for one code | `src/lib/services/trace.ts:47` — `(await tx.movements.list()).filter(...)` | Lookup time ∝ total movements (104k at 100k) |
| Dashboard computes stock per partner over every lot and pack | `dashboard()` → `stockCounts(p.id, lots, packs, …)` for each of `n.partners` | ∝ partners × code records |
| 19 unfiltered `.list()` calls on lots, packs, movements and scans in `src/lib/services` (more on batches and partners) | `grep -rnE "\.(lots\|packs\|movements\|scans)\.list\(\)" src/lib/services` → trace 10, admin 3, damage 2, printOrders 2, movement 1, demo 1 | Every such screen loads whole tables |
| JSON store rewrites the whole file on each write, one transaction at a time | `src/lib/store/jsonStore.ts` (serial `tail` promise) | Writes ∝ file size; lookups that log a scan also queue behind writes |
| Lookups run inside a write transaction | `lookup()` uses `getStore().transaction` | Concurrent lookups serialize (10× queueing at concurrency 10) |

**PostgreSQL store.** `SqlStore.list(filter)` pushes filters into `WHERE` (`src/lib/store/sql/sqlStore.ts`), and the
schema already has the right indexes — `code_history (code)`, `codes (lot_code)`, `codes (location_id, status)`,
`codes (in_transit_to)`, `partners (parent_id)`, `users (partner_id)` (`db/schema.sql`). But the services above call
`.list()` **without** a filter, which becomes `SELECT * … ORDER BY …` over the whole table, so the indexes are not used
on these paths. PostgreSQL would remove the whole-file rewrite on writes; it would not by itself fix lookups, the
dashboard, alerts or "My partners".

## 6. Recommended changes (proposals — none implemented)

Ordered by impact; each targets a measured cause.

1. **Lookup:** `tx.movements.list({ itemCode: … })` for the lot and pack codes (indexed `code_history.code`), and run
   the read outside a write transaction (log the scan separately). Expected: lookup independent of ledger size.
2. **Dashboard / alerts:** compute counts in SQL (`GROUP BY location_id, status`) and in-transit/age with indexed
   filters (`in_transit_to IS NOT NULL`), instead of per-partner scans in JavaScript; consider a short cache (e.g. 15 s,
   the page already refreshes every 15 s).
3. **My partners / My stock:** filter by `location_id` / `in_transit_to` (indexed) rather than loading all lots and packs.
4. **Partner list:** server-side search and pagination once partners grow (DEF-004).
5. **Production store:** PostgreSQL (`DATABASE_URL`); the JSON store is for development only.
6. Then re-run `perfBench.mjs` against PostgreSQL at 100k and 1M code records (2 crore stickers is the business target),
   with `EXPLAIN ANALYZE` for each query and realistic concurrency (k6 or Locust, as in WORKING_MODEL.md's testing plan).

## 7. Before a production capacity claim

- PostgreSQL instance sized like production; measure database time separately (`EXPLAIN ANALYZE`, `pg_stat_statements`).
- Datasets at 100k, 1M and 20M (2 crore) code records with the same generator.
- Load at realistic concurrency (all SS/DB/Retailers scanning at peak), 24–48 h soak, failure drills.
- Client on a separate machine from the server.
- Targets above met at p95 (and p99 with ≥ 100 samples).

## 8. Reproduce

```bash
# 1. A QA data file to start from (see docs/MANUAL_QA_GUIDE.md §2–3)
# 2. Generate (outside the repo or in a git-ignored folder):
node tests/qa/perfGenerate.mjs --codes 100000 --out ../perf-100k.json
# 3. Serve it (stop other `next dev` in this folder first; `next start` needs `npm run build`):
#    PowerShell:  $env:QA_PORT="3400"; $env:QA_DB_PATH="..\perf-100k.json"; $env:RATE_LIMIT_PER_MIN="1000000";
#                 $env:RATE_LIMIT_WRITES_PER_MIN="1000000"; $env:RATE_LIMIT_PUBLIC_PER_MIN="1000000"; $env:RATE_LIMIT_GLOBAL_PER_MIN="1000000"
#                 node tests/qa/startQaServer.mjs start
# 4. Measure:
QA_BASE=http://localhost:3400 QA_DB_PATH=../perf-100k.json node tests/qa/perfBench.mjs --label 100k --out docs/qa/perf-100k.json
```
