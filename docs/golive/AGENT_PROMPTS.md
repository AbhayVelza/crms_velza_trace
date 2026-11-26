# Go-live on AWS — prompts for the Claude Code agents

How to use: open PowerShell in `crms_velza_trace`, run `claude`, press **Shift+Tab** until **plan mode** shows.
Paste ONE prompt. Read the plan, approve, let it finish. Then `Reviewer: check this.` Then commit, then `/clear`.
One PR per phase (see `docs/GO_LIVE_APP_CHANGES_AND_PLAN.md` §5). Infra track and App track can run on different days.

**Rule for the demo rehearsal: run it exactly as production will run.** Same Terraform, same sizes, same GitHub Actions
pipeline (PR → plan → approval → apply), same deploy, rollback and drills. The only differences: one demo account,
`protect = false` so it can be destroyed, a demo subdomain, and seed data instead of real data. The only manual step is
the one-time bootstrap (state bucket + GitHub OIDC role) in BOOTSTRAP.md.

Never paste AWS passwords or access keys into Claude. Agents are blocked from `aws` and `terraform apply/destroy`.

---

## Step 0 — Fix the sizing (volume is 3.43 crore PACKS a year)

```
Cloud agent + database agent: the yearly volume is 3,43,20,000 PACKS (not trays/cases). That is ≈57–86 lakh trays/cases, ≈4 crore barcodes, average ≈8–11 requests/s, peak ≈35/s, database growth ≈70–85 GB a year. Re-size the design in docs/GO_LIVE_ARCHITECTURE.md (sections 4, 5, 11, 13) and docs/DATABASE_GO_LIVE.md (section 2) for this volume: smallest safe Fargate task size and count (keep 2 tasks in 2 AZs), smallest RDS Multi-AZ class that fits (compare db.t4g.medium, db.t4g.large, db.m7g.large), starting storage, connection maths. Check CURRENT AWS Mumbai prices on the web, recompute monthly cost for staging, prod and the demo rehearsal (per day too), and update Q3. Show me a before/after table. Docs only, no code.
```

## Step 1 — Questions for Sir

```
Mentor: read docs/GO_LIVE_APP_CHANGES_AND_PLAN.md section 3 (Q1–Q16) and docs/DATABASE_PHASE1_REVIEW.md. Write docs/golive/QUESTIONS_FOR_SIR.md: each open question in one simple sentence, why it matters, your recommended answer, and by which phase we need it. Put the ones that block Phase 2 first.
```

---

## INFRA TRACK (cloud + devops agents)

### Phase 2 — Foundation (demo account)
```
Cloud agent: implement Phase 2 from docs/GO_LIVE_APP_CHANGES_AND_PLAN.md section 5, for our single DEMO account as in docs/GO_LIVE_ARCHITECTURE.md section 13, built exactly like production. I own the demo account; Terraform applies run through GitHub Actions with my approval. Create infra/aws modules state and ci_access, AWS Budgets alerts at $30/$60/$90 (tax included) plus Cost Anomaly Detection, and roots for staging and prod (names velza-staging-* and velza-prod-*). Put everything that differs between the demo and the company account (account ID, region, domain, protect flag, budget amounts, alert email) in ONE variables file per environment, nowhere else. Pin providers, default tags, remote state with locking. If terraform is not installed, install it with winget first. terraform fmt and validate only. Write docs/golive/BOOTSTRAP.md (the one-time steps I do by hand in the AWS console, click by click, simple words) and docs/golive/SWITCH_TO_COMPANY_ACCOUNT.md (checklist to move to the company account later).
```

### Phase 3 — Network
```
Cloud agent: implement Phase 3 (infra/aws/modules/network + staging and prod roots) exactly as docs/GO_LIVE_ARCHITECTURE.md sections 3–4: VPC over 2 AZs, public subnets for ALB and tasks, isolated DB subnets, S3 gateway endpoint, security groups (internet→ALB 443, ALB→app, app→DB 5432). No NAT. fmt + validate only.
```

### Phase 4 — Data
```
Cloud agent + database agent: implement Phase 4 (infra/aws/modules/data) per docs/DATABASE_GO_LIVE.md with the sizes from Step 0: RDS PostgreSQL Multi-AZ (version per decision D1), parameter group, storage autoscaling, 14-day PITR, cross-Region automated backups to Hyderabad, KMS, S3 buckets with versioning, SSM/Secrets placeholders, db-bootstrap task design (bootstrap_aws.sql → schema v11 → roles_v11.sql). deletion protection from the protect variable. fmt + validate only.
```

### Phase 5 — App platform
```
Cloud agent: implement Phase 5 (infra/aws/modules/{registry,app}): ECR with lifecycle, ECS cluster, Fargate service (2 tasks, autoscale to 4, sizes from Step 0), task definitions for app and ops images, ALB + ACM, WAF, Route 53 or records for demo.velzaglobal.com, EventBridge schedules for jobs. Health check on /api/health. fmt + validate only.
```

### Phase 6 + 7 — Monitoring and security
```
DevOps agent: implement Phase 6 (infra/aws/modules/observability) per docs/GO_LIVE_ARCHITECTURE.md §10: log groups, metric filters, dashboard, alarms (ECS CPU/memory, ALB 5xx and latency, RDS CPU, connections, free storage, replica lag), SNS email to me, ECS/RDS event rules. Then Phase 7: Access Analyzer, break-glass alarm, Trivy/Checkov clean on infra/aws. fmt + validate only.
```

### Phase 8 — Release pipeline
```
DevOps agent: implement Phase 8 per docs/RELEASE_PIPELINE.md: CI additions (terraform fmt-check, validate, trivy, plan on PRs touching infra/aws; a PostgreSQL 17 job), release-build.yml (build app/ops/backup images once, tag = commit SHA, push to ECR), release-deploy.yml (staging on merge to main; production after approval: RDS snapshot → migrate as one-off ECS task with owner role → rolling deploy → health + smoke + 10-min alarm watch → automatic rollback), infra-plan.yml / infra-apply.yml with GitHub environments and required reviewers, deploy/aws/* scripts. Keep the Lightsail workflows untouched. Write docs/golive/GITHUB_SETUP.md: every environment, variable and reviewer I must set in GitHub.
```

### Phase 9 — Runbooks
```
DevOps agent: write the 8 runbooks listed in docs/RELEASE_PIPELINE.md §8 into docs/runbooks/: deploy, rollback, restore to a point in time, monthly restore drill, failover drill, each alarm and what to do, daily cost check for the demo account, and demo teardown (terraform destroy per root, then check Cost Explorer for leftovers). Simple numbered steps.
```

---

## APP TRACK (database + backend agents) — runs in parallel with the infra track

### C11 — Schema v11 (do this first)
```
Database agent: implement C11 from docs/GO_LIVE_APP_CHANGES_AND_PLAN.md: bring schema v11 from C:\Users\KailashChaudhary\Downloads\Velza_Tracebility\velza_db_v11_aws into src/lib/store/sql/schema.ts (SCHEMA_VERSION 11, in-place v10→v11 upgrade for dev DBs: Option C packs follow their tray, monthly code_history partitions, damage_reports + attachments), regenerate db/schema.sql, roles_v11.sql in deploy, tests incl. the privilege suite. Fix the issues listed in docs/DATABASE_PHASE1_REVIEW.md §1b. No real database.
```
```
Backend agent: implement Option C in the store and services so the app runs on schema v11 (a sealed pack follows its tray; packs get their own state when a tray/case is opened). Keep JSON and pglite stores working. Full test suite must pass.
```

### C1–C10 — Ready for several servers
```
Backend agent: implement C1 (S3 photo storage with disk fallback for dev), C2 (/api/health checks the DB), C3 (graceful shutdown), C8 (lockout and rate limits shared across tasks, in PostgreSQL) and C9 (client IP behind the ALB) from docs/GO_LIVE_APP_CHANGES_AND_PLAN.md. Tests for each. Typecheck, lint, test.
```
```
Backend agent: implement C4 (pool sizing), C5 (advisory-lock connection), C6 (structured JSON logs), C7 (jobs as ECS tasks: db-maintenance, db-archive) and C10 (no DDL from the app in production) from docs/GO_LIVE_APP_CHANGES_AND_PLAN.md. Tests for each.
```

### Speed — slow screens
```
Backend agent: fix the slow queries in docs/SCALABILITY_REPORT.md (HQ dashboard, scan audit, alerts, batch list): counting and filtering in SQL, stock_summary tables, LIMIT/paging, missing indexes. Re-run the perf tests at 100k and 1M rows and give before/after numbers.
```

---

## Phase 10 — Rehearsal in the demo account

```
QA agent: write a k6 load test in tests/load for plant and partner scanning (QC, container load, dispatch, receive) at 35 requests/s for 30 minutes, then a 100/s burst for 5 minutes, against a URL I pass in. Report p50/p95/p99, error rate, and check zero double-receipts. Also write docs/golive/REHEARSAL.md: the order of the rehearsal (migration rehearsal, deploy, rollback, failover drill, restore drill, load test) with pass/fail criteria for each.
```

## Phase 11 — Cut-over checklist
```
Mentor: using all docs/golive and docs/runbooks files, write docs/golive/CUTOVER.md: a go-live day checklist for the REAL account (who does what, maintenance window, data move from the pilot/Supabase, DNS switch, watch period, rollback plan, pilot read-only for 2 weeks), plus what must be true before we start.
```

## After every prompt
```
Reviewer: review the changes on this branch against CLAUDE.md and the go-live docs. Security, nothing applies automatically, tests pass. Verdict + must-fix list.
```
