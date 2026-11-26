# Velza database go-live — Phase 1 review and plan

> **Sizing superseded (26 Nov 2026):** volume is 3,43,20,000 packs a year (≈ 57–86 lakh trays/cases, peak ≈ 35 req/s, ≈ 70–85 GB/yr). Instance, storage, cost and load-test figures in this review (S1–S3 at 51/150/600 req/s, 24 crore codes, db.m7g.large, ≈ ₹4,750 Hyderabad) are replaced by `DATABASE_GO_LIVE.md` §2a, §12–13 and `GO_LIVE_ARCHITECTURE.md` §11.

Status: for review. Nothing was changed in Supabase or AWS, and no repo code was changed.
New files only: `docs/DATABASE_GO_LIVE.md` (the production spec), this file, and `tests/test_v11_privileges.sql` in the v11 folder.
Companion: `docs/DATABASE_GO_LIVE.md` (instance, parameters, backups, RPO/RTO, connections, alarms, jobs, archive, drills, rotation, DevOps interface).

---

## 1. Review of the v11 files

Tested on PostgreSQL 16.15 with an RDS-like non-superuser master, and on PostgreSQL 18.6 (PGlite 0.5.11, the repo's
dev/test engine). Results: life-of-a-tray 34/34 on 16; 30/30 behavioural checks on 18 (the 4 privilege checks cannot
fail for a superuser, as expected); new privilege suite 27/27 on 16; migration rehearsal passes.
PostgreSQL 17 could not be installed in this sandbox (package mirror blocked) — CI must cover it (Phase 2).

### 1a. Proof that `velza_app` cannot alter history — `tests/test_v11_privileges.sql` (new)
All refused for `velza_app`: UPDATE / DELETE / TRUNCATE / MERGE-DELETE on the parent; UPDATE / DELETE / TRUNCATE
directly on a month partition and on the safety-net partition; disable or drop the append-only trigger; replace its
function; `session_replication_role = replica`; detach / drop / rename partitions or the table; GRANT itself rights
(nothing granted); become superuser or `velza_owner`; UPDATE / DELETE / TRUNCATE damage reports and photo records.
INSERT still works. The owner (`velza_owner`) *can* change history (by design: archive/reset) — that is why its
password is only present during deploys.

### 1b. Issues found (file and line refer to `velza_db_v11_aws/`)

| # | Severity | File:line | Issue | Proof | Fix (Phase 2, PR 1) |
|---|---|---|---|---|---|
| 1 | **High** | `db/schema_v11_aws.sql:479` | `CREATE TABLE … PARTITION OF code_history` takes an **ACCESS EXCLUSIVE lock on the whole history table**. If any report/read is running, the job waits, and every scan insert queues behind it until `lock_timeout` (10 s for the app). | Reproduced: a scan insert blocked 3 s (its lock timeout) behind the daily job waiting on a reader. | Create the month as a standalone table (`LIKE code_history`), then `ALTER TABLE … ATTACH PARTITION` (SHARE UPDATE EXCLUSIVE — reproduced: the insert went through in 0.04 s). Add `SET LOCAL lock_timeout = '5s'` and retry. |
| 2 | **High** | `db/schema_v11_aws.sql:429, 479` | A history row dated in a month that has no partition yet goes to the **default partition**; when that month's partition is later created, PostgreSQL refuses ("default partition would be violated"), so `velza_daily_maintenance()` fails **every day** from then on and the whole month lands in the default partition. Likely source: **offline plant PCs syncing with a wrong clock** (the app accepts a client `at`). | Reproduced with one row dated 2027-08. | (a) owner-only `code_history_repair_default()` that moves the default partition's rows into their months (detach default → create/attach months → move rows with the trigger disabled in that one transaction → re-attach); (b) the daily job reports `history_rows_without_partition` (already) and alerts; (c) app decision on client timestamps (open question Q6). |
| 3 | **High** | `db/schema_v11_aws.sql:468–471`, `db/roles_v11.sql:51` | `velza_app` may call `code_history_ensure_partitions(p_from)` with any old date: it created **82 partitions** from 2020 in one call (from 1900 it exhausted the lock table). An app bug or leaked password could bloat the catalog. | Reproduced (rolled back). | Clamp: callers other than the owner may only use `p_from ≥ current month − 1`; a separate owner-only function for backfills (the migration). |
| 4 | Medium | `db/schema_v11_aws.sql:279` | **Option C gap:** nothing stops a lot becoming OPENED (or RECALLED from OPENED) while its packs still inherit — they would then report "OPENED" as their own status. Today only `db_health` notices it. | By inspection. | Deferred constraint trigger on `codes` (UPDATE OF status, lot rows, new status OPENED): fails the commit if any of its packs still has NULL state. Costs nothing on ordinary moves. |
| 5 | Medium | `db/schema_v11_aws.sql:279`, `migration/03_transform.sql` | **Option C gap:** a pack may keep its own state while its lot is still sealed (allowed on purpose for odd migrated rows). The app counts a sealed tray as 6 packs, so such a pack is **counted twice** in stock. The rehearsal had 1 such pack. | Rehearsal report. | Decide per case before cut-over (Q7). Proposed: migration lists them; business confirms; either the lot is marked OPENED (packs keep state) or the pack's state is reset to the lot's. Then add a check to `db_health`. |
| 6 | Medium | `db/schema_v11_aws.sql:434–442` | **Missing indexes** for read paths the app uses today: `record_type = 'REPRINT'` (all reprints — seq scan), `context = 'PUBLIC_LOOKUP'` scans (uses the all-scans index — reads every scan), `from_id` / `to_id` (admin partner-delete check — seq scan). | EXPLAIN on the test DB. | Add partial indexes `WHERE record_type = 'REPRINT'` and `WHERE context = 'PUBLIC_LOOKUP'` (small). For from/to: change the admin check (app list §5 item 5) rather than index every row. |
| 7 | Medium | `deploy/jobs.sh` (repo) with `db/roles_v11.sql` (`statement_timeout 30s`) | The nightly stock check recounts all codes as `velza_app`; at full volume that takes minutes and will hit the **30 s** limit. Same for `stock_summary_rebuild()` (`schema:637`), which also **locks `codes` against writes** while it runs. | By design reading. | Jobs set their own `statement_timeout` (allowed per session); rebuild only in a maintenance window, documented in the runbook. |
| 8 | Medium | `migration/05_upload_photos.sh:36` | Inserts `attachment_id = '<id>-<seq>'`, but `attachment_id` became **uuid** in the last change → the script fails. Also uses report ids from file names, which differ for non-UUID test ids. | By reading. | Let the default make the uuid; `ON CONFLICT (report_id, seq) DO NOTHING`; map file ids with the same `vz_uuid()` rule. |
| 9 | Low | `migration/02_stage_into_target.sh:18` | `${SCRATCH_URL%/*}/velza_src` breaks if the scratch URL has a query string (`?sslmode=…`). | By reading. | Build the URL with `psql` `dbname=` override instead of string cutting. |
| 10 | Low | `migration/03_transform.sql:190` | The history equality check compares 7 columns, not the whole row. | By reading. | Compare every column (hash of the row). |
| 11 | Low | `migration/04_report.sql:38` | No explicit **stock comparison with Supabase** (only effective state per barcode is checked in 03). | By reading. | Add: per location × flavour × lot type, effective packs from `src.codes` = from `code_state`; and lot counts = `stock_current`. |
| 12 | Low | `db/schema_v11_aws.sql:41` (whole file) | One big transaction with `DROP/CREATE TRIGGER` on `codes` and `code_history` (ACCESS EXCLUSIVE). Safe on an empty database; **must never be re-run against production** while scanning. No `lock_timeout` set. | By reading. | Header + guard: refuse to run if `schema_info.version` exists and data is present, unless `-v force=1`. After go-live only numbered migrations run (with `lock_timeout`). |
| 13 | Low | `db/schema_v11_aws.sql:661` | `CREATE OR REPLACE VIEW` fails if a view's columns change (happened once between drafts). | By reading. | Numbered migrations use `DROP VIEW IF EXISTS … ; CREATE VIEW …`. |
| 14 | Low | `db/bootstrap_aws.sql:26` | If someone runs it as `velza_owner` (Lightsail master), `ALTER ROLE velza_owner CREATEROLE` errors (a login cannot change its own attributes). | By reading. | Guard with `WHERE current_user <> 'velza_owner'`. |
| 15 | Info | `db/roles_v11.sql:56`, requirements doc | `default_transaction_read_only` is a default the user can switch off; the real protection is that `velza_readonly` has only SELECT. Docs said "enforced by the login". | Test. | Wording fix (done in `DATABASE_GO_LIVE.md`). |
| 16 | Info | `db/schema_v11_aws.sql` | A bulk load of many codes with deferred foreign keys is slow (1.4 M codes took minutes at COMMIT). Irrelevant for test-data migration; matters only if we ever load crore-scale data. | Measured. | Note in the migration runbook. |

Checked and fine: IST month boundaries (a row at 23:59:59.999 IST on 30 Nov goes to November, 00:00 IST 1 Dec to
December; partition bounds are correct even when the session time zone is New York); identity counters after
migration; FKs across hash partitions (a tray and its packs in different partitions); stock triggers on the
partitioned `codes`; partial indexes for DAMAGED / RETURN_* / failed scans are used; re-running schema + roles +
bootstrap on an empty database.

---

## 2. Engine recommendation

**In one line: pilot on Lightsail (Standard, PostgreSQL 16, as already in Terraform); go live on Amazon RDS for
PostgreSQL 17, Multi-AZ, db.m7g.large, 500 GB gp3 with autoscaling.**

### Cost per month of the database only (₹94/USD, on-demand, before GST)

| | Year 1 (420 GB) | Year 2 (840 GB) | Year 3 (1.1 TB) | Price basis |
|---|---|---|---|---|
| **RDS Multi-AZ**, db.m7g.large, gp3 | **₹45,250** ($481: compute $350 + 500 GB × $0.262) | **₹58,800** ($626: 1,050 GB allocated) | **₹67,400** ($717: 1,400 GB allocated) | Mumbai list: $0.240/h single-AZ (×2), gp3 $0.131/GB-mo (×2 copies) — matches the cost plan's ₹45,214 |
| **Aurora PostgreSQL** Standard, writer + reader db.r7g.large | ≈ ₹53,500 ($569) | ≈ ₹58,800 ($625) | ≈ ₹62,400 ($664) | Compute $229/mo each (Mumbai). **Estimates:** storage ≈ $0.11/GB-mo on used GB, I/O ≈ $0.22/million with 150–460 M I/O a month ($33–101) |
| Aurora I/O-Optimized | ≈ ₹65,800 | ≈ ₹75,000 | ≈ ₹82,000 | +30 % compute, ≈ 2.25× storage; only pays when I/O > ~25 % of the bill — not our case with Option C |
| **Lightsail HA** (fixed plans) | ₹46,060 (480 GB plan, $490) → must move to the 960 GB plan (₹92,120) around month 9 | ₹92,120 ($980, 88 % full by year end) | **Does not fit** (960 GB is the largest plan) | US list prices; Mumbai may differ |
| Pilot: Lightsail Standard 4 GB / 120 GB | ₹5,640 ($60) | — | — | Already in Terraform |

Not in the table, the same for every option: Hyderabad copy (≈ ₹4,750/month in the cost plan), staging DB. A 1-year
RDS reservation saves ≈ ₹8,800/month after 2–3 stable months. Aurora storage and I/O prices for Mumbai are
**estimates from US prices** — confirm in the AWS Pricing Calculator before choosing Aurora.

### The comparison

| | Lightsail | RDS Multi-AZ instance | Aurora |
|---|---|---|---|
| Storage growth | Fixed plans; changing plan = snapshot restore with downtime; max 960 GB | Autoscaling to a max you set, online | Grows by itself, billed on use, up to 128 TiB |
| Failover / RPO (AZ) | Standby in another AZ (HA plans); time not published | 60–120 s, RPO 0 | ≈ 30 s with a reader, RPO 0 |
| PITR | 7 days | up to 35 days (we use 14) | up to 35 days |
| I/O billing | included | included (12,000 IOPS baseline at ≥ 400 GB) | per I/O (Standard) — Option C's ≈ 8× fewer writes keeps this small; without Option C it could add ₹10–20k/month |
| Read replicas | none | yes (+ an instance) | the HA reader is usable for reports |
| Parameter control | limited | full parameter group | full |
| Performance Insights | no | yes | yes |
| Cross-region copy | not for databases in the docs we checked (we use pg_dump to S3) | AWS Backup / snapshot copy | AWS Backup / snapshot copy, or Global Database |
| PostgreSQL 17 | no (12–16) | yes (18 too) | yes |
| Advisory lock (code allocation) | Works (direct connection) | Works; failover drops sessions, which **releases** the lock — the app must retry (load test S7) | Same, on the writer endpoint |
| Lock-in | low (community Postgres; exit by dump) | low (dump or logical replication out) | medium (Postgres-compatible, proprietary storage; exit by dump/logical replication) |

### Why RDS for go-live
Cheapest or equal in years 1–2, fixed and predictable bill (no I/O meter), already costed and in the approved plan,
simplest Terraform, best fit for our "same files everywhere" rule, and an easy later move to Aurora (RDS → Aurora via
an Aurora read replica, minutes of downtime) if year 3 makes it cheaper.

### Why PostgreSQL 17 (not 16, not 18)
16 reaches RDS end of standard support on 28 Feb 2029 — a forced major upgrade ~2 years after go-live. 17 lasts to
28 Feb 2030 and runs on RDS **and** Aurora. 18 (to Feb 2031, and what PGlite already runs) would close the Aurora
option for now (not confirmed as available on Aurora). The data move from Supabase is a logical copy anyway, so the
version jump costs nothing extra. The pilot stays on 16 (Lightsail's maximum); v11 has no version-specific features.

### What would change my mind
- Load test p95 > 500 ms with a low buffer-cache hit ratio → `db.r7g.large` (16 GiB) on RDS (≈ +₹4,000/month, estimate).
- Failover must be < 35 s → RDS Multi-AZ **DB cluster** (2 readable standbys, ≈ 1.5× cost) or Aurora.
- Reports need a replica anyway, or year-2 storage is clearly heading past ~1 TB → Aurora becomes cheaper; measure
  real I/O on RDS (`ReadIOPS`/`WriteIOPS`) for 2–3 months, then decide.
- Real volume < ⅓ of management's figure → Lightsail HA could carry year 1, but I would still pick RDS for PITR,
  Performance Insights and the Hyderabad copy.

---

## 3. Production specification
See `docs/DATABASE_GO_LIVE.md` (instance, parameter group with justified changes, KMS, backups + daily/monthly
Hyderabad copy, deletion protection, RPO/RTO per failure, connection budget, alarms, jobs, archive with approval,
restore drill, password rotation, source disagreements).

## 4. Interface with DevOps
See `docs/DATABASE_GO_LIVE.md` §12 (inputs we need: VPC/subnets, SGs, KMS keys in both regions, SNS topic,
EventBridge Scheduler role and jobs task definition, deploy-role rights, Backup vault; outputs we give: endpoint,
SG + rules, SSM parameter names, alarm list, parameter group and log groups).

---

## 5. App changes the database depends on

| # | Change | Files | Effort |
|---|---|---|---|
| 1 | **Option C store layer** — sealed packs stored with NULL state; reads return effective state; state filters as `UNION ALL` of own-state packs and inherited packs via their lot (index-backed); writes materialize; `setLotState` updates only the lot row unless opening; `markPrinted` stops touching packs; `recall` touches only own-state packs | `src/lib/store/sql/sqlStore.ts`, `src/lib/store/Store.ts`, `src/lib/store/store.contract.test.ts`, `src/lib/services/common.ts`, `printOrders.ts`, `trace.ts`, `movement.ts`, `returns.ts`, `damage.ts`, new `tests/unit/packInheritance.test.ts` (+ `jsonStore.ts` if kept) | **4.5 d** (6 d if the JSON store is kept) |
| 2 | **schema.ts → v11**: `SCHEMA_VERSION = 11`; fresh install = v11 SQL; in-place **v10 → v11** for dev/staging/test DBs (rename old tables, create partitioned ones, copy with Option C clearing and uuid ids, re-create keys/triggers, rebuild stock); regenerate `db/schema.sql`; fingerprint check must still say "upgraded = fresh" | `src/lib/store/sql/schema.ts`, `sqlStore.ts` (startup apply), `scripts/db-migrate.ts`, `scripts/db-fingerprint.ts` (partitions), `scripts/db-stock.ts` (count `status IS NOT NULL`, own timeout), new `schemaV11.test.ts`, `db/schema.sql` | **4 d** |
| 3 | **S3 photos**: storage driver `disk` / `s3` behind `VELZA_PHOTO_STORE`; upload inside the report flow, then write `damage_reports` + `attachments` in the same transaction (orphan files cleaned by a lifecycle rule on an `incoming/` prefix); reads return a 5-minute signed URL; SHA-256 recorded | `src/lib/services/damagePhotos.ts`, `damage.ts`, the photo API route, `Store.ts` + `sqlStore.ts` (two repos), `package.json` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), `.env.example`, docs | **3 d** |
| 4 | **UUID check → 404** for event/report/reprint ids before any query | new helper in `src/lib/core`, `damage.ts` (`damagePhoto`), `printOrders.ts` (~832–836), any route taking an event id | **0.5 d** |
| 5 | **Whole-ledger reads → time-bounded / small tables**: failed + PUBLIC_LOOKUP scans (`trace.ts:237`) → last 30 days; DAMAGED movements (`trace.ts:249, 397, 503`, `damage.ts:171`) → `damage_reports` with a date range; all reprints (`operator.ts:69`, `trace.ts:573, 606`) → by code / plant / last 90 days; RETURN_PICKUP (`returns.ts:230`) → open pickups or last 90 days; REPRINT_SERVED (`operator.ts:69`) → by device; admin delete checks (`admin.ts:398–415`) → `EXISTS … LIMIT 1` on indexed columns; `Store` list filters gain `since` / `limit` | files listed + `Store.ts`, `sqlStore.ts`, UI date filters where lists are shown | **3.5 d** |
| 6 | **Jobs**: daily `velza_daily_maintenance()` with heartbeat; monthly archive **export + verify** (detach is a separate, approved step); jobs set their own `statement_timeout` | `deploy/jobs.sh`, new `scripts/db-maintenance.ts`, `scripts/db-archive.ts`, `package.json` | **2 d** |
| 7 | **Deploy**: run `roles_v11.sql` (not `roles.sql`); `MIGRATE_DATABASE_URL` = `velza_owner` (already so on Lightsail); never run the fresh-install file against a database with data | `deploy/remote-deploy.sh`, `.github/workflows/deploy-env.yml`, `db/roles.sql` → `db/roles_v11.sql` | **1 d** |
| 8 | **Recommendation: retire the JSON store as a runtime store; make PGlite the dev default.** PGlite is real PostgreSQL (18.6 here) and already runs the v11 schema; keeping JSON means writing Option C, partitions-aware stock and every new rule twice. Keep `db:import-json` for old files. | `src/lib/store/index.ts` (default `pglite`, `PGLITE_DIR=data/pglite`), `jsonStore.ts` + tests removed, `vitest.config.mts`, Playwright config, README / WORKING_MODEL | **1 d** (saves ≈ 1.5 d in item 1 and every later change) — **decision for Abhay** (dev workflow) |
| 9 | **Client timestamps** for offline plant PCs: decide whether history keeps the device time; if so, record server receive time too and refuse times > 1 day ahead | `operator.ts` (sync), `sqlStore.ts` append | 0.5–1 d after decision (Q6) |

Total app work ≈ **20 days** (one developer), plus tests that already exist must keep passing.

---

## 6. Supabase → AWS migration plan

**Decision for Abhay first (Q2): migrate the test data, or start clean** with only partners, users and reference
lists? Test data contains demo trays, damage reports without photos (Vercel `/tmp`), and weak passwords. Starting
clean is simpler and safer; migrating keeps the test history. The runbook below works for both (clean start = steps
with a filtered table list).

### Rehearsals (at least two, on staging)
1. Restore a fresh Supabase export (read-only `pg_dump`) into staging's v11 database with `01 → 03`.
2. Run `04_report.sql`; check: every barcode's effective state = Supabase; per-location stock = Supabase (new check,
   issue 11); history rows identical; containers consistent; non-UUID ids listed; sealed-lot packs with own state
   listed (issue 5).
3. Point a staging app at it; run the e2e suite and the manual QA guide; time every step.

### Cut-over runbook (production)
| Time | Step | Owner |
|---|---|---|
| T-7 d | Production RDS created, bootstrap + schema + roles, alarms green, restore drill done once | DB |
| T-2 d | Last rehearsal on staging with a fresh export; go/no-go meeting | Team |
| T-0 00:00 | Maintenance banner on the test site; set Supabase app to read-only (or stop Vercel production) | DevOps |
| T+0:05 | `01_export_supabase.sh` (session pooler, read-only) | DB |
| T+0:15 | `02_stage_into_target.sh` → AWS `src` schema | DB |
| T+0:25 | `03_transform.sql` (one transaction, self-checking) | DB |
| T+0:35 | `04_report.sql` → saved to the change record; go/no-go checks below | DB + Abhay |
| T+0:45 | `05_upload_photos.sh` only if photo files exist | DB |
| T+0:50 | `06_cleanup.sql`; set **new Admin/HQ passwords** (SSM) | DB |
| T+0:55 | App on ECS points to RDS; smoke test; DNS switch (Route 53, low TTL set the day before) | DevOps |
| T+1:30 | Watch alarms, scans, errors for 1 h; remove banner | Team |

### Go / no-go checks
All `03` checks passed; `04`: row counts equal; per-barcode effective state equal; per-location stock equal;
`db_health` all zero; non-UUID ids and double-state packs reviewed; smoke test passes (login, scan, dispatch,
receive, open lot, damage with photo, HQ dashboard); alarms green; backup and Hyderabad copy configured.

### Rollback
Supabase is never written by the migration. Until the DNS switch: abort, nothing to undo. After it: switch DNS/app
back to Supabase; scans made on AWS in between are exported from AWS `code_history` (`event_time > cut-over`) for
re-entry. Decide the rollback deadline (e.g. 24 h) at the go/no-go meeting.

---

## 7. Load-test plan (on the chosen engine, before go-live)

Environment: a temporary **production-size** RDS (same class and storage, Multi-AZ) in staging for 2 days
(≈ ₹3,000), loaded with **12 months of generated data** (24 crore codes, ≈ 80 crore history rows — generator based
on the capacity script used for sizing). App on ECS like production. Tools: k6 for HTTP, a Node script for print
orders, SQL for the database checks.

| # | Scenario | Pass criteria |
|---|---|---|
| S1 | Steady 51 req/s, 30 min (scan mix: receive 40 %, dispatch 30 %, verify 15 %, lookup 10 %, open/damage 5 %) | p95 < 300 ms |
| S2 | **Peak 150 req/s, 60 min**, same mix | **p95 scan < 500 ms**, p99 < 1.5 s, errors < 0.1 %, DB CPU < 60 % |
| S3 | Burst 600 req/s, 15 min (cost plan figure) | no errors beyond 429s; recovery < 2 min after |
| S4 | **Bulk move of 50,000 sealed trays** (container receive + dispatch) during S2 | S2 targets still met; move rewrites ≈ 50,000 code rows, not 3.5 lakh |
| S5 | **Month rollover**: run across an IST month boundary with partitions created by the job while a long report runs | no insert waits > 1 s; rows land in the right month; default partition empty |
| S6 | **Concurrent code allocation**: 10 plant PCs create print orders of 5,000 lots at once under the advisory lock | no lock timeouts; no duplicate or skipped lot numbers; queue time recorded |
| S7 | Forced Multi-AZ failover during S2 | service back < 120 s; no committed scan lost; allocation retries cleanly |
| S8 | 4-hour soak at S1 + nightly jobs | autovacuum keeps dead rows < 10 % per code partition; XID age stable; stock check passes |
| S9 | Daily maintenance + stock check + archive export at full size | each finishes in its timeout |

Evidence collected: k6 reports, Performance Insights top SQL, CloudWatch metrics, `pg_stat_user_tables`, a short PDF.

---

## 8. Risks, open questions, plan

### Top risks
1. **App work is on the critical path** (≈ 20 days: Option C store, v10→v11 path, bounded reads). The database is
   ready long before the app can use it.
2. **Sizing rests on unconfirmed inputs** (3.43 crore units, all trays, ≈ 24 history rows per tray). Wrong inputs
   move storage and cost; the load test with real mixes is the check.
3. **Partition maintenance edge cases** (issues 1–3): locking during partition creation and future-dated rows from
   offline devices can stop history housekeeping — must be fixed before go-live.
4. **Recovery is slower than promised**: mistake recovery is 2–4 h at 400 GB (not < 1 h), region loss loses up to
   24 h — management should accept these numbers explicitly.
5. **8 GiB RAM vs ~420 GB of data**: random barcode lookups may miss the cache and push p95 up; the load test decides
   between m7g.large and r7g.large.

Also: version drift (PGlite 18 / CI 16 / Lightsail 16 / prod 17) — CI must test 17; the double-counted pack case
(issue 5) needs a business answer.

### Decisions needed
| # | Question | Who |
|---|---|---|
| Q1 | Approve RDS PostgreSQL 17 Multi-AZ for go-live and Lightsail PG 16 for the pilot | You + management |
| Q2 | Migrate Supabase test data, or start clean (partners/users/lists only)? | Abhay |
| Q3 | Retire the JSON store, PGlite as dev default? | Abhay |
| Q4 | History retention: scans 24 months; movements for ever online (option B) or in S3 after 24 months (option A)? | Business / Abhay |
| Q5 | Hyderabad copies: daily (costed) + monthly kept 12 months (≈ ₹4–5k/month more)? | Management |
| Q6 | Offline plant PCs: keep device time in history, or server time (with device time kept as a note)? | Abhay |
| Q7 | What to do with packs whose state differs from their sealed tray (count once)? | Abhay / business |
| Q8 | Accept RPO/RTO: AZ 0 / 2 min; mistake ≈ 5 min / 2–4 h; region 24 h / 4–8 h | Management |
| Q9 | Confirm volume inputs: plants, lines, partners, peak scans/hour, tray/case mix | Management |

### Open questions (not decisions)
- Which PostgreSQL version is the Supabase test project on, and which schema version is stored there? (`01` prints both.)
- Is the AWS provider/Terraform version new enough for write-only secrets (`value_wo`)? (Phase 4.)
- Does Lightsail Mumbai price its database plans like the US list? (only matters for the pilot.)

### Phased plan (one PR per phase; effort in working days)
| Phase | Content | Days |
|---|---|---|
| 2 / PR 1 | v11 files into the repo (`db/`, `migration/`, `tests/db/`) **with the fixes in §1b**; CI: postgres **17** service (and 16 while the pilot lives) → schema twice, roles, 34 + 27 SQL checks as `velza_app`, migration rehearsal, existing e2e on Postgres | 3 |
| 3 / PR 2 | Option C store layer + v10 → v11 in-place path + whole-ledger reads + UUID 404 (app items 1, 2, 4, 5) | 12 |
| 4 / PR 3 | S3 photos behind a setting (item 3) | 3 |
| 5 / PR 4 | Terraform `modules/velza_db` (RDS, subnet group, parameter group, KMS, backups, AWS Backup copy, SSM, SG, alarms); Lightsail module untouched; `terraform validate` in CI | 4 |
| 6 / PR 5 | Jobs (maintenance, rollup, check, archive export) as scripts for EventBridge, heartbeats (item 6) + deploy changes (item 7) | 3 |
| 7 / PR 6 | Runbooks: cut-over, rollback, PITR restore, restore drill, region failover, archive a month, rotate passwords, add an index on a big partitioned table | 2 |
| — | Load test (§7) and two migration rehearsals | 5 |
| — | Cut-over | 1 |
| | **Total** | **≈ 33 days** |
