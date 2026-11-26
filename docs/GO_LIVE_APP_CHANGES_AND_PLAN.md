# Go-live: app changes, disagreements, open questions, risks and phased plan

Status: **design for review (Phase 1)**. Companion docs: [`GO_LIVE_ARCHITECTURE.md`](GO_LIVE_ARCHITECTURE.md),
[`RELEASE_PIPELINE.md`](RELEASE_PIPELINE.md). Effort is in working days for one developer who knows the codebase.

## 1. App changes required for go-live

| # | Change | Files | Effort |
|---|---|---|---|
| C1 | **S3 photo storage** | `src/lib/services/damagePhotos.ts`, `src/app/api/damaged/route.ts`, `src/app/api/damaged/photo/[id]/route.ts`, `src/lib/store/sql/sqlStore.ts`, `package.json` | 2.5 |
| C2 | **Health endpoint** | `src/app/api/health/route.ts` (new), `Dockerfile`, `deploy/compose.yml` | 0.5 |
| C3 | **Graceful shutdown** | `src/instrumentation.ts` (new), `src/lib/store/index.ts` | 0.75 |
| C4 | **Pool sizing per task vs RDS `max_connections`** | `src/lib/store/sql/driver.ts`, `.env.example`, `roles_v11.sql` | 0.5 |
| C5 | **Advisory-lock connection** | `src/lib/store/index.ts`, `src/lib/store/sql/driver.test.ts`, docs | 0.5 |
| C6 | **Structured logs** | `src/lib/log.ts` (new), `src/lib/api.ts`, `src/lib/security.ts`, `src/lib/store/sql/driver.ts`, `src/lib/store/sql/sqlStore.ts`, `scripts/*.ts` | 1.5 |
| C7 | **Jobs as EventBridge-triggered ECS tasks** | `scripts/db-maintenance.ts` (new), `scripts/db-archive.ts` (new), `package.json`, `deploy/backup/backup.sh`, `deploy/backup/Dockerfile` | 2 |
| C8 | **Sign-in lockout and rate limits shared across tasks** (from the go-live plan) | `src/lib/services/auth.ts`, `src/lib/security.ts`, `src/lib/api.ts`, schema | 2 |
| C9 | **Client IP behind the ALB** | `src/lib/security.ts`, `src/lib/security.test.ts` | 0.25 |
| C10 | **No DDL from the app in production** | `src/lib/store/sql/sqlStore.ts` | 0.5 |
| C11 | **v11 schema: Option C, partitions, migration paths** | see C11 below | 12–14 |
| | **Total** | | **≈ 23–25 days** |

### C1 — S3 photo storage

- Add a small storage interface in `damagePhotos.ts` with two implementations: `disk` (today's code: dev, tests, pilot)
  and `s3` (when `PHOTO_BUCKET` is set). Keys: `damage/<yyyy>/<mm>/<reportId>/<n>.<ext>`, as in the v11 design.
- `PutObject` with `ChecksumSHA256` and `IfNoneMatch: "*"` (never overwrite evidence). Store key, type, size and
  SHA-256 in `attachments`, and the report in `damage_reports` (v11 tables, so this lands together with C11).
- **Reading:** keep streaming through `GET /api/damaged/photo/[id]` (role and partner checks stay in one place; the CSP
  stays `img-src 'self'`). The v11 design says "signed URLs". Streaming is simpler and safer now: photos are ≤ 2 MB and
  rarely viewed. Revisit only if photo traffic grows. (Disagreement R5.)
- New dependency `@aws-sdk/client-s3`. Credentials come from the task role, never from environment variables.
- `Dockerfile`: keep `VELZA_UPLOAD_DIR` for the pilot. The ECS task needs no volume.
- Tests: the existing photo tests run against the disk store; add an S3 test against a local S3 stub (e.g. a
  `minio` service in CI).

### C2 — Health endpoint

- `GET /api/health` → `200 {"ok":true,"release":"<RELEASE_SHA>","schema":11,"db":"ok","ms":12}`. It runs `SELECT 1`
  with a 2-second timeout, the result cached for 5 s per process so ALB checks never load the database. It returns 503
  if the database check fails or the database schema is **older** than the code (C10).
- `GET /api/health?live=1` → process-only liveness (no database), for the container `HEALTHCHECK`.
- No sign-in and no rate limit (excluded from `handler()`); it reveals no data. `proxy.ts` already skips `/api`.
- `Dockerfile` `HEALTHCHECK` and `deploy/compose.yml` move from `/login` to `/api/health?live=1`.
- Why the ALB check uses the DB variant: a task whose database connection is broken should leave the pool. If **all**
  tasks fail at once (the database is down), the ALB fails open and keeps sending traffic, so nothing gets worse.

### C3 — Graceful shutdown

- ECS sends `SIGTERM`, waits `stopTimeout` (30 s), then `SIGKILL`. The ALB stops routing new requests when draining
  starts (deregistration delay 30 s).
- The Next.js standalone server is documented to handle `SIGTERM` by closing the HTTP server and finishing in-flight
  requests. **Verify this for 16.4 in `node_modules/next/dist/docs/` before coding (AGENTS.md rule)**, including the
  `NEXT_MANUAL_SIG_HANDLE` behaviour.
- Add `src/instrumentation.ts` (`register()`, Node runtime only) that, on `SIGTERM`, waits for the server to close and
  then calls `closeStores()` so `pg` pools end cleanly. A test sends `SIGTERM` to a built server during a slow request
  and expects the request to complete.

### C4 — Pool sizing

- Keep `PG_POOL_MAX=10` per app task and 2 for jobs. Totals and limits are in architecture §5 (≈ 96 worst case vs
  `max_connections` 150, `velza_app CONNECTION LIMIT 100`; both lowered from 200/150 for `db.t4g.large`, see
  `DATABASE_GO_LIVE.md` §6). Auto scaling max 4 × `PG_POOL_MAX` 10 is the most that budget allows.
- In `driver.ts`, set `connectionTimeoutMillis: 5000` so requests fail fast during a 1–2 minute failover instead of
  hanging. Set `idleTimeoutMillis: 30000` and `keepAlive: true` so dead connections are dropped after a failover.
  Already in place: the role-level `statement_timeout` 30 s and `idle_in_transaction_session_timeout` 60 s
  (`roles_v11.sql`).
- Document in `.env.example` and the runbook: *tasks × PG_POOL_MAX × 2 (deploy surge) + 20 < 150*.

### C5 — The advisory-lock connection

- Code allocation takes `pg_try_advisory_lock` **before** `BEGIN` on the same pooled client and needs a session-level
  connection (`driver.ts`). On RDS every connection is direct, so leave `DATABASE_URL_UNPOOLED` **unset**: allocation
  shares the main pool, as on Docker/Lightsail today. This needs no code change.
- Add a test that, if a connection drops while it holds the lock (failover), the next allocation still gets the lock.
  The server releases session locks when the session ends; the test makes sure the pool doesn't reuse a broken client.
- Write down in `docs/DEPLOYMENT.md` and the architecture doc: **no RDS Proxy or PgBouncer in transaction mode**. If
  one is ever added, set `DATABASE_URL_UNPOOLED` to the direct endpoint (the code path already exists for Neon).

### C6 — Structured logs

- `src/lib/log.ts`: one JSON object per line on stdout:
  `{"t":"…","level":"info","msg":"request","route":"/api/receive","status":200,"ms":43,"req":"<X-Amzn-Trace-Id>","release":"<sha>"}`.
  No bodies, passwords, cookies or session ids are ever logged.
- `handler()` in `api.ts` logs one line per API request. `[security]` lines become
  `{"level":"warn","msg":"security","reason":…}`. Failed scans get `{"msg":"scan_failed","reason":…}`; jobs log
  `{"job":"maintenance","ok":true}`. The CloudWatch metric filters in the architecture doc §10 match these fields.
- Pretty output stays under `npm run dev` (`NODE_ENV !== "production"`).

### C7 — Jobs

- **Every-minute rollup: dropped** (D7). `SqlStore.rollupStock` already runs after requests and
  `stock_summary_rollup()` prevents two from running at once. `deploy/jobs.sh` stays for the pilot only.
- `npm run db:maintenance` (new): calls `velza_daily_maintenance()`, prints the JSON, exits 1 if `ok` is false.
- `npm run db:stock -- check` (exists).
- `npm run db:archive -- --month 2028-12 [--dry-run]` (new): lists `db_history_partitions`, exports one month
  (`COPY … TO STDOUT` streamed to `s3://…/archive/code_history/2028-12.csv.gz` with a row count and SHA-256 manifest),
  verifies, then detaches and drops as `velza_owner`. It runs only from an approved `workflow_dispatch`.
- Backup image: client `postgres:17` (D1; `pg_dump` must be at least the server version). Drop the
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` requirement (the task role supplies credentials). Read
  `READONLY_DATABASE_URL` first, then `BACKUP_DATABASE_URL` for the pilot.

### C8 — Lockout and rate limits shared across tasks

- Today both live in process memory (`auth.ts` `__velzaLoginFailures`, `security.ts` `RateLimiter`). With 2–4 tasks, an
  attacker gets 5 guesses **per task** before lockout, and a new task forgets every lock.
- **Lockout → database**: table `login_failures(key text primary key, count int, locked_until timestamptz)` in v11,
  using an `INSERT … ON CONFLICT` upsert. The `velza_app` grant is limited to this table.
- **Rate limits**: per-IP floods are handled by WAF rate rules (architecture §4). The in-memory limiter stays as a
  second layer per task. Its numbers are per task, so the effective limit is N times higher; this is documented, not
  changed.

### C9 — Client IP behind the ALB

- The ALB adds the real client IP as the **last** `X-Forwarded-For` entry. `clientIp()` already uses the rightmost entry
  when `CLIENT_IP_HEADER` is unset, but then logs a warning and treats the IP as untrusted.
- Change: `CLIENT_IP_HEADER=x-forwarded-for` means "trusted: take the rightmost entry". Add a unit test.

### C10 — No DDL from the app in production

- `SqlStore` upgrades the schema on first use when the database is older than the code (`ensure` path, `version <
  SCHEMA_VERSION`). In production the app runs as `velza_app`, which can't run DDL, so this can only fail. Worse, it
  would turn a forgotten migration into errors on every request.
- Add `VELZA_SCHEMA_AUTO=off` (set in ECS): the app never runs DDL. If the database is older than the code, it logs
  once and `/api/health` returns 503, so the rolling deploy stops and the old tasks keep serving. Default stays `on`
  for `npm run dev`, tests, Render and Vercel.

### C11 — v11 schema: what has to happen, and the two migration paths

The v11 design (`Velza_Tracebility/velza_db_v11_aws/`) is **not in this repo yet**, and `main` is still schema v10
without Option C (`SCHEMA_VERSION = 10`; no inherited pack state in `schema.ts`).

| Step | Files | Effort |
|---|---|---|
| a. Bring `db/bootstrap_aws.sql`, `db/schema_v11_aws.sql`, `db/roles_v11.sql`, `migration/01…06`, `tests/sql/*` into the repo | `db/`, `migration/`, `tests/sql/` | 0.5 |
| b. Option C in the store layer (prepared prompt, renumbered to v11) | `src/lib/store/sql/sqlStore.ts`, `src/lib/store/jsonStore.ts`, `src/lib/core/*`, `src/lib/services/movement.ts`, tests | 4–5 |
| c. `SCHEMA_VERSION = 11`: fresh install = `schema_v11_aws.sql`; an **in-place v10 → v11 upgrade** for dev, test and pilot databases (same rules as `migration/03_transform.sql`); `npm run db:schema` | `src/lib/store/sql/schema.ts`, `db/schema.sql` | 3 |
| d. History ids are uuid: check the format before querying (404 otherwise) | `src/lib/services/details.ts`, `src/app/api/details/[code]/…`, `reprint/[id]` | 0.5 |
| e. Time-bound the whole-ledger reads (reprints list, all `DAMAGED`, failed and public-lookup scans, return pickups, reprints served), as listed in the DB handoff §10 | `src/lib/services/*`, `sqlStore.ts` | 3–4 |
| f. `login_failures` table (C8) and `damage_reports`/`attachments` writes (C1) | `schema.ts` | (in C1/C8) |
| g. CI jobs for v11 (release pipeline §2) | `.github/workflows/ci.yml` | 1 |

**Migration paths**

1. **Dev, test and pilot databases (Supabase, Neon, Lightsail):** `npm run db:migrate` runs the in-place v10 → v11
   upgrade. CI's *upgrade = fresh install* job proves it. Only for small databases (minutes at test size).
2. **Production RDS (new):** created empty. `bootstrap_aws.sql` (master) → `db:migrate` fresh v11 (owner) →
   `roles_v11.sql`. Then the data, from one source:
   - **Supabase test data** (if decision Q5 says to keep it): `migration/01_export_supabase.sh` →
     `02_stage_into_target.sh` → `03_transform.sql` (all checks inside one transaction) → `04_report.sql` →
     `05_upload_photos.sh` (usually nothing; Vercel photos are temporary) → `06_cleanup.sql`.
   - **Lightsail pilot** (if the pilot holds real data by then): the pilot is already v11 through path 1, so it's a plain
     `pg_dump` → `pg_restore` into RDS (16 → 17 works upward), plus the photo sync from the pilot bucket to the new
     photos bucket. Rehearse in staging first.
   - Either way: maintenance window, the old site read-only, row counts and `04_report.sql` saved with the change
     record, old site kept untouched for rollback (point DNS back).

---

## 2. Where the documents and the code disagree

| # | Topic | Documents say | Code / repo says | Proposal |
|---|---|---|---|---|
| R1 | AWS database type | DB handoff and v11 PDF: "Lightsail, RDS or Aurora still open"; `CLAUDE.md`: "final AWS database not decided" | go-live PDF (approved): RDS Multi-AZ | **Follow the go-live PDF.** Update `CLAUDE.md` after you approve |
| R2 | PostgreSQL version | `CLAUDE.md`, pilot Terraform, backup image, v11 tests: 16 | CI schema-upgrade and scalability report: 17 | **17** (D1), v11 checks on both until the pilot is retired |
| R3 | Every-minute stock rollup | DB handoff §7, `deploy/jobs.sh`, `docs/DEPLOYMENT.md` §4 | the app rolls up after requests (`SqlStore.rollupStock`) | **Drop the scheduled job** in ECS (D7); keep it in the pilot |
| R4 | Hyderabad copy | DB handoff: **weekly** snapshot copy | go-live PDF: **daily** copy | **Neither: continuous** (RDS cross-Region automated backups, D3), ≈ ₹1,640/month at year-1 size vs ₹4,747 budgeted (architecture §11). A monthly 12-month copy is an option, not chosen (architecture §11) |
| R5 | Reading photos | v11 PDF: short-lived signed URLs | app streams through `/api/damaged/photo/[id]` with `img-src 'self'` | **Keep streaming** (C1) |
| R6 | Read-only DB URL name | DB handoff: `READONLY_DATABASE_URL` | pilot: `BACKUP_DATABASE_URL` | **`READONLY_DATABASE_URL`**; backup script reads both |
| R7 | Schema source of truth | v11 is psql files outside the repo | the schema is code (`schema.ts`) with a CI equality check | **Both in the repo**, CI proves they match (pipeline §2) |
| R8 | gp3 performance | go-live PDF: "3,000 IOPS included" | — | at 200 GiB the baseline is **3,000 IOPS / 125 MiB/s**, which is enough (`DATABASE_GO_LIVE.md` §2a); 12,000 IOPS / 500 MiB/s only once allocated storage is ≥ 400 GiB (was a 500 GiB start) |
| R9 | Secrets in the pilot | DB handoff: secrets only in SSM | pilot Terraform keeps DB passwords in state (`random_password`) and long-lived bucket keys in SSM | fine for the pilot; go-live generates passwords outside Terraform and uses task roles (D5) |
| R10 | Option C | `CLAUDE.md`: decided | `main` is v10 without Option C | C11b is on the critical path |
| R11 | Rate limits / lockout | go-live PDF: "move to the database before full volume" | in memory per process | C8 (lockout to DB; rate limits via WAF + per-task) |

---

## 3. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | Does the AWS account for the pilot exist? Will it become the Organizations **management** account? Who is the owner of the root user, billing and MFA device? | Phase 2 |
| Q2 | Where is the DNS for `velzaglobal.com` hosted? Can we delegate `app.velzaglobal.com` (and `staging.`) to Route 53, or do we add records at the current provider? | Phase 5 |
| Q3 | Confirm the sizing inputs. The design now uses **3,43,20,000 packs a year** (3.43 crore **packs**, not trays/cases) ≈ 57–86 lakh trays/cases ≈ 4 crore barcodes, ≈ 8–11 req/s average, **≈ 35 req/s peak**, ≈ 70–85 GB database growth a year. Older figures (3.43 crore trays/cases, 150 req/s peak, 400 GB/yr) are oversized. Still to confirm: packs per tray and trays per case (which set the 57–86 lakh range), number of plants and packing lines, shifts and working days, peak scans per hour per line, concurrent users by role (plant, Customs, SS, DB, retailer, HQ), and expected public QR lookups. App tasks (1 vCPU / 2 GB, 2–4; 0.5 vCPU only after the load test) and `db.t4g.large` are sized on these figures, so a higher answer can change them | load test (Phase 10) |
| Q4 | Retention: scans 24 months, movements forever? (Also needs a DPDP Act check.) | first archive (~2029), but the schema assumes it now |
| Q5 | Move the Supabase test data, or start production empty (partners and users only)? | Phase 11 |
| Q6 | Will the Lightsail pilot hold real data before RDS goes live? (That decides the migration source.) | Phase 11 |
| Q7 | Approve PostgreSQL 17 (D1)? | Phase 4 |
| Q8 | On-call: who, which hours, which channel? SNS email works at once. SMS to Indian numbers needs DLT sender registration. A phone/Slack tool (PagerDuty, Opsgenie) is not costed. | Phase 6 |
| Q9 | Terraform apply: through GitHub Actions with an approval (proposed), or by named people from laptops through Identity Center? | Phase 2 |
| Q10 | Is a region-loss RTO of 4–8 h acceptable? Do we want S3 replication of photos (+₹100–150)? | Phase 4 |
| Q11 | What happens at the plant when the internet is down? There is no offline mode (open item in the go-live PDF). | before go-live |
| Q12 | Restrict `/admin/*` to office/VPN IPs with a WAF rule (`SECURITY.md` recommends it)? Which IPs? | Phase 5 |
| Q13 | Staging data: seed data only, or a masked copy of production? | Phase 10 |
| Q14 | Customer-managed KMS keys in production (D4, +₹188)? | Phase 4 (can't change later without a restore) |
| Q15 | Load-test tool and window (k6 from an ECS task in staging is proposed). Run it against a temporary production-class instance (`db.t4g.large`, as `DATABASE_GO_LIVE.md` §2 says, not staging): Multi-AZ ≈ ₹750/day, Single-AZ ≈ ₹380/day before GST (Mumbai on-demand, 26 Nov 2026), instance only (storage ≈ ₹160/day and app tasks extra). In the demo-account rehearsal the production-size stack already exists, so no extra instance is needed there. | Phase 10 |
| Q16 | GitHub plan: is `AbhayVelza/crms_velza_trace` on GitHub Team? Required reviewers on environments in a private repo need it. | Phase 8 |

---

## 4. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| K1 | **v11 + Option C isn't in the app yet** (C11 ≈ 12–14 days); go-live can't happen without it | high / high | start now in parallel with the Terraform phases; v11 SQL already tested (34 checks, rehearsal) |
| K2 | **p95 < 500 ms not proven**: the dashboard and batch list fail at 100k rows under concurrency | high / high | C11e plus the dashboard fixes in `SCALABILITY_REPORT.md`; load test at 50 req/s sustained (35 peak + margin) for 1 h plus a 70 req/s (2× peak) burst, against a temporary production-class instance (Q15), with a 12-month data set at the corrected volume; the burst passes if there are no 5xx and p95 returns under target within 2 min |
| K3 | **WAF blocking legitimate traffic** (8 KB body rule, shared shop IPs) | medium / high | D8; WAF in Count mode in staging for a week, then production Count for 3 days before Block |
| K4 | **Region loss = hours of downtime**; all copies in one account | low / high | D3 brings RPO to minutes; separate backup account later; quarterly DR drill |
| K5 | **Lockout bypass across tasks** until C8 ships | medium / medium | C8 before go-live; WAF rate rules |
| K6 | Client behaviour during RDS failover (1–2 min of errors; serializable retries; pool reconnects) | medium / medium | C4 timeouts; failover drill in staging (`reboot --force-failover`) |
| K7 | Next.js 16 standalone shutdown behaviour unverified | medium / low | C3 test before Phase 5 |
| K8 | Storage cost grows ≈ ₹3,000–4,500/month per year of data at the corrected volume (≈ 100 GiB Multi-AZ gp3 = ₹2,463, plus the bigger Hyderabad backup copy; was ₹12,000–18,000 at 400 GB/yr) | certain / medium | archiving after 24 months (Q4); RDS reservation |
| K9 | GitHub plan doesn't support environment approvals (Q16) | unknown / medium | GitHub Team (budgeted) |
| K10 | Internet outage at the plant stops printing and scanning | medium / high | out of scope here; needs an offline design (Q11) |

---

## 5. Phased plan

One PR per phase. Nothing is applied to a real AWS account until you say so.

| Phase | Content | Effort (days) | Depends on |
|---|---|---|---|
| 1 | **This design** | done | — |
| 2 | Terraform: org, accounts, Identity Center permission sets, state buckets, org CloudTrail, GuardDuty, Budgets, GitHub OIDC + roles (`infra/aws/live/management`, `modules/{org,state,ci_access}`) | 3 | Q1, Q9 |
| 3 | Network: VPC, subnets, routes, S3 gateway endpoint, security groups (staging + prod) | 1.5 | 2 |
| 4 | Data: KMS, RDS 17 Multi-AZ + parameter group + cross-Region backups, S3 buckets, SSM placeholders, Secrets Manager, `db-bootstrap` task design | 3 | 3, Q7, Q14 |
| 5 | App platform: ECR + replication, ECS cluster/services/task definitions, ALB, ACM, WAF, Route 53, EventBridge schedules | 4 | 4, Q2 |
| 6 | Observability: log groups, metric filters, dashboard, alarms, SNS, ECS/RDS/GuardDuty event rules | 2 | 5, Q8 |
| 7 | Security: Access Analyzer, break-glass alarms, permissions boundary review, Trivy/Checkov clean | 1.5 | 6 |
| 8 | Pipeline: CI additions, `release-build.yml`, `release-deploy.yml`, rollback, `infra-plan/apply.yml`, `deploy/aws/*` scripts | 4 | 5, Q16 |
| 9 | Runbooks (8, see pipeline §8) | 2 | 8 |
| App | C1–C11 (in parallel with 2–9) | 23–25 | C11 first |
| 10 | Staging rehearsal: v11 migration rehearsal, failover drill, restore drill, load test | 4 | all above, Q15 |
| 11 | Cut-over: maintenance window, data move, DNS switch, watch; pilot kept read-only for 2 weeks, then retired | 1 + window | 10, Q5, Q6 |

Infrastructure and pipeline: about **21 days**. App: about **23–25 days**. With one person on each, about **6–7 weeks**
of calendar time, including the rehearsal, before cut-over.
