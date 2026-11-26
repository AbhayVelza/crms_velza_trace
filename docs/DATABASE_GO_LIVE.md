# Velza Traceability — production database on AWS (go-live specification)

Status: **Phase 1 proposal, for review.** Nothing here has been created on AWS.
Scope: everything database-specific. VPC, ECS/ALB, CI/CD and accounts belong to the DevOps workstream (interface in section 12).
Sources: design PDF v1.1 (25 Nov), `DB_REQUIREMENTS_FOR_DEVOPS.md`, the v11 SQL files, the go-live cost plan (25 Nov), this repo.
Where they disagree, section 13 says which wins and why.

---

## 1. Engine and version

| | Pilot (user testing) | Go-live |
|---|---|---|
| Engine | Lightsail managed PostgreSQL, **Standard** plan `medium_2_0` (2 vCPU, 4 GB, 120 GB) — already in `infra/terraform/modules/velza_env` | **Amazon RDS for PostgreSQL, Multi-AZ DB instance (one standby)** |
| Version | **PostgreSQL 16** (Lightsail's newest major per AWS docs and our Terraform) | **PostgreSQL 17** (RDS standard support until 28 Feb 2030; also offered by Aurora, so the Aurora option stays open) |
| Why | Cheapest real Postgres; fine for test data | Full parameter control, 14-day PITR, Performance Insights, storage autoscaling, read replicas, cross-region copies, no lock-in (community Postgres) |

The comparison and costs behind this are in `DATABASE_PHASE1_REVIEW.md` §2.
Versions in use today differ: PGlite (dev/tests) is **PostgreSQL 18.6**, CI and Lightsail are **16**. The v11 schema was tested on 16 (all checks) and on 18 in PGlite (all behavioural checks). CI must add a **17** job before go-live (section 11).

## 2. Instance, storage, parameter group

| Item | Value | Notes |
|---|---|---|
| Instance class | `db.t4g.large` (2 vCPU Graviton2, 8 GiB, burstable) ✱ | Smallest safe class for 3.43 crore **packs** a year (§2a). Was `db.m7g.large`, sized for 3.43 crore trays/cases. Same 8 GiB, so the step to `db.m7g.large` is CPU only. **Approved by Kailash 26 Nov 2026**; the load test confirms it before go-live. |
| Deployment | Multi-AZ DB instance, 1 standby | Standby is not readable. Failover 60–120 s. |
| Storage | gp3, **200 GiB** allocated, **max allocated 500 GiB** (autoscaling) ✱ | Under 400 GiB RDS gp3 gives **3,000 IOPS / 125 MiB/s** baseline (cannot be raised below 400 GiB). That is enough with a wide margin (§2a). At ≥ 400 GiB it becomes 12,000 IOPS / 500 MiB/s by itself. Storage grows online but **never shrinks**. |
| Staging DB | `db.t4g.small` (2 GiB), Single-AZ, gp3 **50 GiB** — **keep** | Holds test data only (a few GB). Needs its own parameter group (below). The load test uses a temporary production-class instance, not staging. |
| Encryption | KMS **customer-managed key**, chosen at creation | Cannot be added later without a restore. A matching key in `ap-south-2` is needed for the DR copy. |
| Network | DB subnet group = 2+ private subnets in 2 AZs; `publicly_accessible = false` | Ingress 5432 only from the app/jobs security group and the admin access path (SSM port-forward). |
| Master user | `postgres_admin` (not `velza_owner`), password **managed by RDS in Secrets Manager** (`manage_master_user_password`) | Emergencies only. Never in Terraform state. |
| Deletion | `deletion_protection = true`, final snapshot on delete, Terraform `prevent_destroy` | |
| Maintenance window | Sun 20:00–20:30 UTC = Mon 01:30–02:00 IST ✱ | Outside shifts; ends before `db:maintenance` starts at 02:00 IST. Clear of the RDS backup window (00:30–01:00 IST) and of `velza-backup` (moved to 03:00 IST). Minor-version auto upgrade **off** (we choose the date). |
| Backup window | 19:00–19:30 UTC = 00:30–01:00 IST | Same as the Lightsail module. |
| Logs to CloudWatch | `postgresql`, `upgrade` | 30-day retention. |
| Performance Insights | On, 7 days (free tier) | Enhanced Monitoring 60 s. |

**Parameter group** `velza-pg17` (family `postgres17`). Starts from `DB_REQUIREMENTS_FOR_DEVOPS.md` §4; changes marked ✱.

| Parameter | Value | Why |
|---|---|---|
| `rds.force_ssl` | 1 | TLS only |
| `shared_preload_libraries` | `pg_stat_statements` | |
| `pg_stat_statements.track` | `top` | |
| `track_io_timing` | 1 | |
| `max_connections` ✱ | 150 | Was 200. Budget in §6; memory in §2a. `velza_app` `CONNECTION LIMIT 100` |
| `work_mem` | 16MB | |
| `maintenance_work_mem` | 512MB | |
| `autovacuum_work_mem` | 256MB | |
| `autovacuum_max_workers` ✱ | 4 | 16 code partitions + monthly history; needs reboot, so set before go-live |
| `autovacuum_vacuum_cost_limit` | 2000 | |
| `autovacuum_naptime` | 30 | |
| `random_page_cost` | 1.1 | |
| `effective_io_concurrency` | 200 | |
| `wal_compression` ✱ | `lz4` (or `on` if RDS does not offer lz4) | less CPU than `pglz` for a similar saving |
| `max_wal_size` | 4096 (MB) | |
| `checkpoint_timeout` | 900 | |
| `log_min_duration_statement` | 500 | |
| `log_lock_waits` | 1 | |
| `log_autovacuum_min_duration` | 10000 | |
| `log_temp_files` | 10240 | |
| `log_connections` / `log_disconnections` | 1 | |
| `idle_in_transaction_session_timeout` ✱ | 300000 (5 min) | Server-wide safety net; `velza_app` already has 60 s |
| `timezone` | UTC | Database `velza` is set to Asia/Kolkata by `bootstrap_aws.sql`; all columns are `timestamptz` |

Memory parameters (`shared_buffers`, `effective_cache_size`) stay on the RDS formulas (≈ 25 % and ≈ 50 % of RAM: about 2 GiB and 4 GiB on 8 GiB).

**Staging parameter group** `velza-pg17-staging`: same as above except `max_connections` 60, `work_mem` 8MB,
`maintenance_work_mem` 128MB, `autovacuum_work_mem` 64MB, `autovacuum_max_workers` 3. The production values would let
maintenance alone ask for ~1.5 GB on a 2 GiB instance.

### 2a. Sizing basis (3.43 crore packs a year)

| Input | Value |
|---|---|
| Volume | 3,43,20,000 **packs** a year ≈ 57–86 lakh trays/cases ≈ **4 crore barcodes** |
| Requests | average ≈ 8–11 req/s, peak ≈ **35 req/s** |
| Growth | ≈ **70–85 GB a year**: `codes` ≈ 18 GB (≈ 450 B a row with indexes), `code_history` ≈ 52–67 GB (≈ 1.2–1.5 crore rows a month, ≈ 375 B a row) |

Hot data that must stay in RAM (estimate; check with `db_table_sizes` and cache-hit ratio):

| Part | End of year 1 | End of year 2 |
|---|---|---|
| `codes` primary key + `codes_lot` (random barcode lookups) | ≈ 2 GB | ≈ 4 GB |
| `codes` rows of stock still in the chain (≈ 3 months; Option C touches mainly tray/case rows) | ≈ 1 GB | ≈ 1 GB |
| Current month of `code_history` (its `code` index takes random inserts) | ≈ 0.7 GB | ≈ 0.7 GB |
| Small tables (partners, stock summary, sessions, batches) | < 0.3 GB | < 0.5 GB |
| **Total** | **≈ 3–4 GB** | **≈ 5–6 GB** |

Memory on 8 GiB: RDS/OS ≈ 1 GB, `shared_buffers` ≈ 2 GB, ≈ 100 connections × ~10 MB ≈ 1 GB, maintenance/autovacuum
up to ≈ 1.5 GB at night → ≈ 3–4 GB of OS cache, so ≈ 5–6 GB of data cached. Year 1 fits; year 2 is the point to watch.

| Class (Multi-AZ) | CPU | RAM | Verdict |
|---|---|---|---|
| `db.t4g.medium` | 2 vCPU burstable, baseline 20 % | 4 GiB | **Does not fit.** After RDS/OS, ~1 GB `shared_buffers`, 100+ connections and nightly maintenance memory, only ≈ 1 GB is left for cache — below the year-1 hot set. Random barcode lookups would go to disk within months. |
| `db.t4g.large` | 2 vCPU burstable, baseline 30 % (earns 36 credits/h, holds up to 864) | 8 GiB | **Fits — chosen; approved by Kailash 26 Nov 2026.** Estimated DB CPU (≈ 5–10 ms per request, to be measured): ≈ 3–5 % average, ≈ 10–20 % at 35 req/s; nightly maintenance, stock check and `pg_dump` (while the DB is < 50 GB) use 1 vCPU for 10–30 min. Daily average stays well under the 30 % baseline, so credits build up during the day and cover peaks and the night. RDS runs T classes in **Unlimited** mode: it never throttles, but CPU above baseline averaged over 24 h is billed as surplus credits — that is the signal to move up. AWS advises T classes mainly for non-production; acceptable here only because the alarm in §7 catches sustained use and the change is quick. |
| `db.m7g.large` | 2 vCPU fixed (Graviton3, ~25 % faster per vCPU) | 8 GiB | Fits, with CPU headroom we do not need at this volume. Same RAM, so it does **not** solve a memory problem. First step if CPU credits run out. |

**Bounded worst case of Unlimited mode:** even at 100 % CPU all month, surplus ≈ (1.0 − 0.3) × 2 vCPU × 730 h × $0.075
≈ ₹7,200 → ≈ ₹30,100/month in total, still below `db.m7g.large` at ≈ ₹32,870. So the burstable class never costs more
than the fixed one; it only signals when to move.

**Upgrade triggers** (each change is a Multi-AZ modify: standby first, then a **~1–2 minute failover**; do it in the Mon 01:30–02:00 IST maintenance window (Sun 20:00–20:30 UTC); 02:00 IST is when `db:maintenance` starts):

| Signal (CloudWatch / SQL) | Threshold | Move to |
|---|---|---|
| `CPUSurplusCreditsCharged` | > 0 on 3+ days in a week | `db.m7g.large` |
| `CPUCreditBalance` | < 200 at 08:00 IST (not refilled overnight), or 24-h average `CPUUtilization` > 25 % | `db.m7g.large` |
| `FreeableMemory` | < 1 GB for 1 h in working hours | `db.r7g.large` (16 GiB, same vCPU) |
| Buffer cache hit ratio on `codes` and its indexes (`pg_statio_user_tables` / `_indexes`) | < 99 % over a day, with `ReadIOPS` rising | `db.r7g.large` |
| Load test (review §7): 50 req/s sustained (35 peak + margin) for 1 h plus a 70 req/s (2× peak) burst | p95 or DB CPU target missed; burst must pass with no 5xx and p95 back under target within 2 min | `db.m7g.large` (CPU-bound) or `db.r7g.large` (cache-bound) |

**Storage and IOPS.** A scan request writes ≈ 1 tray/case row + 1 history row and their index entries; most pages are
merged in `shared_buffers` and written at checkpoints, plus one WAL flush per commit. At 35 req/s that is a few hundred
IOPS, well under 3,000. The nightly jobs are sequential reads limited by 125 MiB/s: stock check reads `codes`
(≈ 10 GB heap in year 1 ≈ 1.5 min; ≈ 30 GB in year 3 ≈ 4 min), `pg_dump` under 50 GB ≈ 7 min — both inside their
timeouts. Used space: ≈ 100–110 GB end of year 1, ≈ 200–215 GB year 2, ≈ 300–320 GB year 3 (data + 20 % bloat/free
+ WAL up to `max_wal_size` + temp files), less once the monthly archive (§9) starts at month 24. 200 GiB gives ~2 years
before autoscaling acts and room for a rebuild (`REINDEX CONCURRENTLY`, a table rewrite needs ~2× the table). The
500 GiB ceiling covers year 3 without archiving and caps a runaway (e.g. a bug writing history in a loop).
If `ReadIOPS + WriteIOPS` > 2,400 or throughput > 100 MiB/s for 15 min outside the nightly jobs, or `DiskQueueDepth`
stays high, raise allocated storage to **400 GiB** (online, one-way) to get 12,000 IOPS / 500 MiB/s.

## 3. Logins

| Login | Created by | Secret | Use |
|---|---|---|---|
| RDS master `postgres_admin` | RDS | Secrets Manager (RDS-managed) | Emergencies, running `bootstrap_aws.sql` once |
| `velza_owner` | `bootstrap_aws.sql` | SSM `/velza/<env>/db/owner_password` | Deploy migrations only (`MIGRATE_DATABASE_URL`) |
| `velza_app` | `roles_v11.sql` | SSM `/velza/<env>/db/app_password` | App tasks and jobs (`DATABASE_URL`) |
| `velza_readonly` | `roles_v11.sql` | SSM `/velza/<env>/db/readonly_password` | Reports, BI, backups (`READONLY_DATABASE_URL`) |

On Lightsail (pilot) the Terraform master user **is** `velza_owner`, so `bootstrap_aws.sql` is skipped there.

## 4. Backups, copies and deletion protection

| What | Setting |
|---|---|
| Automated backups | Retention **14 days**, PITR to any second within the window (latest restorable time is normally within ~5 min of now) |
| Cross-region copy | **RDS cross-Region automated backups** to `ap-south-2` (Hyderabad), retention **14 days**, CMK in Hyderabad: snapshots **and** transaction logs, so PITR works in Hyderabad (architecture D3) ✱ |
| Long-term copy | **Option, not chosen; open decision for the real account** — a monthly copy kept 12 months; priced in `GO_LIVE_ARCHITECTURE.md` §11 "Not included" |
| Snapshot before every production deploy | Taken by the deploy pipeline (cost plan step 7) |
| Logical exports | Monthly archive of closed history months to S3 (§9). The nightly `pg_dump` in `deploy/backup/` stays for the Lightsail pilot only |
| Deletion protection | On; final snapshot required |

✱ The requirements doc said *weekly* copy; the cost plan costed an AWS Backup *daily* copy (region-loss RPO up to 24 h). Decision D3 (`GO_LIVE_ARCHITECTURE.md` §1) replaces both with RDS cross-Region automated backups: region-loss RPO drops to **minutes**, and it costs less (cost in architecture §11). Without the optional monthly long-term copy, bad data noticed after 14 days **cannot be restored**; decision for management (review §8).

## 5. Recovery objectives — honest per failure type

| Failure | What happens | Data loss (RPO) | Back in service (RTO) |
|---|---|---|---|
| App task dies | ALB routes around it | 0 | seconds |
| DB instance / AZ failure | Multi-AZ failover; DNS flips to standby; app reconnects | **0** (synchronous standby); in-flight transactions are rolled back and retried by the app | **60–120 s** |
| Planned maintenance / minor upgrade | Failover first, then patch | 0 | 60–120 s, in the Mon 01:30–02:00 IST window |
| Bad data or a mistake (wrong bulk update, bug) | PITR to a **new** instance at the minute before; compare; fix forward (copy correct rows back) or switch the app to the restored instance | Up to the chosen restore point; work done after it must be re-entered or merged | **≈ 1–3 h** plus checks and the switch at ≈ 100–110 GB (end of year 1); longer as the database grows (≈ 300 GB by year 3 without archiving). First reads are slow while blocks load from S3. Measured in the monthly drill (§10); same as architecture §8 |
| Bad data noticed after 14 days | **Not covered** unless the optional monthly long-term copy (§4) is chosen; then restore it | Up to 1 month (with the option) | 4–8 h (with the option) |
| Whole Mumbai region | PITR from the cross-Region automated backups in Hyderabad to a new instance, re-deploy the app stack there (DevOps Terraform for `ap-south-2` must exist) | **Minutes** (log copy lag, typically < 15 min; to be measured) | **4–8 h** (restore ≈ 100–300 GB in years 1–3), if the Hyderabad stack has been rehearsed; otherwise a day |
| Accidental delete of the DB | Blocked by deletion protection; else final snapshot | 0 | 1–2 h |

The ≤ 5-minute promise in the cost plan holds for **AZ failure (0)** and **PITR (≈ 5 min)**; region loss is **minutes** (not guaranteed ≤ 5; measure it in the quarterly Hyderabad drill).

## 6. Connection budget

| Client | Count | Connections each | Total |
|---|---|---|---|
| App tasks (ECS, normal) | 2 | `PG_POOL_MAX` 10 | 20 |
| App tasks at peak (auto scaling max) | 4 | 10 | 40 |
| Rolling deploy (old + new tasks briefly) | 8 | 10 | 80 |
| Jobs task (rollup, maintenance, checks) | 1 | 3 | 3 |
| Backup / archive export (`velza_readonly`) | 1 | 2 | 2 |
| Migrations during deploy (`velza_owner`) | 1 | 1 | 1 |
| Read-only / BI / people | — | — | ≤ 5 |
| RDS reserved (rdsadmin, superuser reserve) | — | — | ~5 |
| **Worst case** | | | **≈ 96** (matches `GO_LIVE_ARCHITECTURE.md` §5) |

`max_connections = 150` ✱ (was 200) leaves ≈ 1.5× headroom and keeps backend memory on the 8 GiB instance near 1–1.5 GB
(§2a); 200 mostly-idle slots would only waste RAM we want for cache. `velza_app` gets **`CONNECTION LIMIT 100`** ✱
(was 150, which would equal the new maximum): 80 app connections in a rolling deploy + 3 jobs + spare, leaving ≥ 45 slots
for `velza_owner`, `velza_readonly` and RDS admin even if the app pool runs away. On RDS the lock pool is not separate
(`DATABASE_URL_UNPOOLED` unset), so `PG_LOCK_POOL_MAX` is unused. Rule: **max tasks × PG_POOL_MAX × 2 (rolling deploy)
+ 25 ≤ 0.7 × max_connections** (was 0.6; relaxed to 0.7 so 4 tasks fit at max_connections 150; today 105 ≤ 105) and **velza_app limit ≥ max tasks × PG_POOL_MAX × 2 + 10**; recheck
both when auto scaling max or `PG_POOL_MAX` changes. Moving to `db.r7g.large` would allow 200 again; no need before then.

## 7. Monitoring and alarms (CloudWatch → SNS on-call topic)

| Alarm | Threshold | Why |
|---|---|---|
| CPUUtilization | > 60 % for 15 min | Cost plan's growth trigger (stricter than the requirements doc's 80 %) |
| FreeStorageSpace | < 20 % of allocated | Autoscaling should act first; this means it could not |
| FreeableMemory | < 500 MB for 15 min | Page now; < 1 GB for 1 h is the upgrade trigger in §2a |
| CPUCreditBalance ✱ | < 200 | Burstable class (§2a): credits not refilling. **Fires falsely for ~24 h after a Multi-AZ failover or class change** (the new primary starts with a low balance) — ignore it in that window. The real upgrade trigger is `CPUSurplusCreditsCharged` > 0 on 3+ days a week and the 24-h CPU average |
| CPUSurplusCreditsCharged ✱ | > 0 (daily sum) | We are paying for CPU above baseline; 3+ days a week → `db.m7g.large` |
| DatabaseConnections | > 110 | ≈ 75 % of max (150) |
| ReadLatency / WriteLatency | > 10 ms for 15 min | |
| DiskQueueDepth | > 20 for 15 min | |
| MaximumUsedTransactionIDs | > 1,000,000,000 | Vacuum falling behind (wraparound at 2 billion) |
| ReplicationSlotDiskUsage / OldestReplicationSlotLag | > 5 GB | Only if logical replication is ever used |
| RDS event subscription | failover, failure, low storage, maintenance, backup failure | |
| Job heartbeats (Healthchecks/Better Stack, or CloudWatch custom metric) | maintenance missing > 26 h; stock check missing > 26 h; archive missing > 35 days | |
| `velza_daily_maintenance()` returns `"ok": false` | any | Stray history rows or opened lots without pack state |

Dashboard: CPU, connections, latency, IOPS, free storage, `db_table_sizes` (monthly), top queries from Performance Insights.

## 8. Scheduled database jobs (EventBridge Scheduler → ECS RunTask of the jobs image, as `velza_app` unless stated)

| When (IST) | Job | Timeout | Alert if |
|---|---|---|---|
| Every minute | `stock_summary_rollup()` (today's loop in `deploy/jobs.sh`) | 30 s | 5 failures in a row |
| Daily 02:00 | `SELECT velza_daily_maintenance();` — next 3 months of history, old sessions, health | 5 min | `"ok": false` or no heartbeat |
| Daily 02:30 | `npm run db:stock -- check` — **must `SET statement_timeout = '15min'`** (the app login's 30 s limit would kill a full recount at scale) | 20 min | difference found |
| Monthly, 3rd at 03:00 | Archive export of history months past retention (§9), **export only**; detach waits for approval | 2 h | export or verification fails |
| Monthly, 1st working day | Restore drill (§10) — person-run with a script | — | not done by the 10th |
| Every 90 days | Password rotation (§11) — person-run | — | overdue |

## 9. Monthly archive and detach (human approval)

Retention (proposal, business to confirm): **scans 24 months, movements kept for ever.** Scans and movements share
each month partition and history is append-only, so rows cannot be deleted out of a month; a month is archived as a
whole. Two options, decision for Abhay:

- **A (simple):** keep whole months for 24 months, then export the month to S3 and detach/drop it. Movement history
  older than 24 months then lives only in S3 (queryable with Athena).
- **B (keeps movements online):** at 24 months, first copy the month's MOVEMENT/REPRINT rows into
  `code_history_archive_movements` (plain append-only table, same columns), then export and detach/drop the month.
  ≈ 54 % of the month's rows stay online.

Procedure (either option):
1. Job lists candidates: `SELECT * FROM db_history_partitions WHERE months_old >= 24;`
2. Job exports each candidate: `pg_dump -Fc -t <partition>` (as `velza_readonly`) → `s3://velza-<env>-archive/code_history/<yyyy_mm>.dump` (S3 Object Lock, 7 years) and a Parquet copy for Athena; records row count + SHA-256.
3. Job verifies: restores the dump into a scratch database and compares the row count and a checksum of `event_id`.
4. **A person approves** in GitHub (environment protection on the `archive` workflow).
5. As `velza_owner`, with `SET lock_timeout = '5s'` and a retry loop: (option B copy step) then
   `ALTER TABLE code_history DETACH PARTITION <p>; DROP TABLE <p>;`. (`DETACH … CONCURRENTLY` is not allowed while
   the table has a default partition, so the plain form is used: it needs a brief exclusive lock, hence the short
   lock timeout and retries in a quiet hour.)
6. Record in the change log: month, rows, S3 keys, checksum, approver.

## 10. Monthly restore drill

1. Restore the latest automated backup (PITR "latest") to `velza-drill-<date>` (`db.t4g.medium`, single-AZ, same subnet group, no public access).
2. Run: `SELECT version FROM schema_info; SELECT * FROM db_health; SELECT count(*) FROM codes; SELECT max(event_time) FROM code_history;` and the stock check.
3. Record: start/finish times (our real RTO), data age (our real RPO), problems.
4. Every 3rd month restore the **Hyderabad** copy in `ap-south-2` instead.
5. Delete the drill instance the same day. Cost ≈ ₹300 per drill.

## 11. 90-day password rotation (velza_owner, velza_app, velza_readonly)

1. Generate a new password; write it to SSM as the **next** value (`/velza/<env>/db/app_password` new version).
2. `ALTER ROLE velza_app PASSWORD '<new>';` as `velza_owner` (old sessions stay connected).
3. Re-run the deploy env step so tasks read the new value; rolling restart; check `/api/health`.
4. Watch `pg_stat_activity` until no session uses the old login time; done. Rollback: set the previous SSM version and `ALTER ROLE` back.
RDS master: rotation by Secrets Manager (automatic). CI: run `roles_v11.sql` only with values from SSM (never hard-coded).

## 12. Interface with the DevOps workstream

**We need from DevOps (Terraform inputs to `modules/velza_db`):**

| Input | Form |
|---|---|
| `vpc_id`, `private_subnet_ids` (≥ 2 AZs, no internet route needed) | IDs per environment |
| `app_security_group_id`, `jobs_security_group_id` | SG IDs allowed to reach 5432 |
| `admin_access_security_group_id` | SSM port-forward / bastion SG |
| `kms_key_arn` (ap-south-1) and `dr_kms_key_arn` (ap-south-2) | or agreement that the DB module creates them |
| `alarm_sns_topic_arn` | on-call topic |
| EventBridge Scheduler: schedule group + role allowed to `ecs:RunTask` the jobs task definition | ARNs |
| Jobs task definition with env from SSM (`DATABASE_URL`, `READONLY_DATABASE_URL`, heartbeat URLs) | |
| Deploy role (GitHub OIDC) allowed: `ssm:GetParameter` on `/velza/<env>/db/*`, `rds:CreateDBSnapshot` | |
| Permission for the DB module to start RDS cross-Region automated backup replication to `ap-south-2` (D3), using `dr_kms_key_arn` | no AWS Backup vault needed |
| Tag set, environment name | |

**We give DevOps (module outputs):**

| Output | Value |
|---|---|
| `db_endpoint`, `db_port` | writer endpoint, 5432 |
| `db_instance_arn`, `db_resource_id` | for alarms, backups, IAM |
| `db_security_group_id` | with ingress rules from the input SGs |
| SSM names (SecureString) | `/velza/<env>/MIGRATE_DATABASE_URL`, `/velza/<env>/DATABASE_URL`, `/velza/<env>/READONLY_DATABASE_URL` (all with `sslmode=verify-full&sslrootcert=/etc/ssl/aws/rds-global-bundle.pem`) |
| `alarm_arns` | the list in §7 |
| `parameter_group_name`, `log_group_names` | |

Passwords are generated with ephemeral resources and written with write-only arguments (`value_wo` / `password_wo`) so they never land in Terraform state (needs Terraform ≥ 1.11 and a recent AWS provider — confirm versions in Phase 4).

## 13. Where the sources disagree, and which wins

| Topic | Design PDF / requirements | Cost plan | Proposed winner |
|---|---|---|---|
| Yearly volume ✱ | 3.43 crore units, read as trays/cases | same | **3,43,20,000 packs** (≈ 57–86 lakh trays/cases, ≈ 4 crore barcodes) — corrected input; every size below follows from it |
| Year-1 storage | 420 GB (measured row sizes + 20 % free) | 400 GB (108 codes + 300 history) | **≈ 100–110 GB** ✱ (≈ 70–85 GB data + bloat/WAL); both old figures were for trays/cases. Allocate 200 GiB (§2) |
| Year 2 / 3 | 840 GB / 1.1 TB | ≈ 1 TB / 1.3 TB | **≈ 200–215 GB / ≈ 300–320 GB** ✱ without archiving; autoscaling max 500 GiB |
| Instance class ✱ | — | `db.m7g.large` Multi-AZ | **`db.t4g.large`** Multi-AZ at the corrected volume (§2a); `m7g.large` stays the first step up |
| Peak request rate ✱ | 150 req/s | — | **35 req/s** (average 8–11) |
| DR copy | weekly | daily AWS Backup copy (costed) | **RDS cross-Region automated backups** ✱ (D3; PITR in Hyderabad, RPO minutes, 14 days); monthly 12-month copy is an option, not chosen |
| DB CPU alarm | 80 % | 60 % | **60 %** |
| Mistake recovery time | — | under 1 hour | **≈ 1–3 h** ✱ plus checks at ≈ 100–110 GB (year 1); longer as it grows (≈ 300 GB by year 3) |
| Load-test rate | 150 req/s | 600 scans/s for an hour | **50 req/s sustained (35 peak + margin) for 1 h plus a 70 req/s (2× peak) burst; burst passes with no 5xx and p95 back under target within 2 min** ✱; review §7 S1–S3 and its 12-month data set (now ≈ 4 crore codes, ≈ 15–18 crore history rows) must be rescaled |
| gp3 IOPS | — | 3,000 included | **3,000 IOPS / 125 MiB/s** ✱ at 200 GiB (under 400 GiB) — enough (§2a); 12,000 only once ≥ 400 GiB |
| Engine version | — | PostgreSQL 16 | **17** for go-live |
| Read-only login | "read-only by default" | — | Enforced by **grants**; `default_transaction_read_only` is only a default the user can change |
| Daily job | design PDF: `code_history_ensure_partitions()` | — | **`velza_daily_maintenance()`** (newer; wraps it) |
