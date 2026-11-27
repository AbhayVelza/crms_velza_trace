# Deployment and operations

The app runs as Docker containers on AWS Lightsail in Mumbai. Terraform creates the cloud resources, GitHub Actions
builds the images once and deploys them to staging and then (after an approval) to production. Costs and sizing are
in the *Cloud Infrastructure & Cost Plan*.

| Piece | Where | File |
| --- | --- | --- |
| Images: `app` (web), `ops` (migrations, jobs), `backup` (pg_dump) | GitHub Container Registry | `Dockerfile`, `deploy/backup/` |
| Stack on each server: Caddy (HTTPS) + app + jobs + backup (+ db on staging) | `/srv/velza` on the server | `deploy/compose.yml`, `deploy/Caddyfile` |
| Server, static IP, firewall, managed database, bucket, settings | AWS (Terraform) | `infra/terraform/` |
| GitHub → AWS sign-in (OIDC) and deploy roles | AWS (Terraform) | `infra/terraform/global/` |
| CI on every PR; build + deploy on `main` | GitHub Actions | `.github/workflows/` |

## 1. Environments

| | staging | production |
| --- | --- | --- |
| Domain | `staging.velzaglobal.com` | `app.velzaglobal.com` |
| Server | Lightsail 2 vCPU / 2 GB (`small_3_0`) | Lightsail 2 vCPU / 4 GB (`medium_3_0`) |
| Database | PostgreSQL 16 container on the server | Lightsail managed PostgreSQL 16, 4 GB / 120 GB (`medium_2_0`) |
| Backups | bucket 5 GB | bucket 100 GB + Lightsail's automatic backups / point-in-time restore |
| Settings | Parameter Store `/velza/staging/*` | Parameter Store `/velza/prod/*` |
| Deploys | Actions → Deploy → Run workflow (automatic after CI on `main` once AWS is set up, see deploy.yml) | same release, after a reviewer approves |

**Developers never use the production database.** Use `STORE=pglite`, a local PostgreSQL, or a Neon dev branch in
`.env.local`. Under `npm run dev` sign-in is off and every request acts as Velza Admin.

### Database roles

Every deploy runs `deploy/roles_v11.sql` (idempotent; `db/roles.sql` includes it for running by hand) with passwords
from Parameter Store:

| Role | Used by | Can |
| --- | --- | --- |
| owner (`velza_owner` on prod, `velza` on staging) | migrations only (`MIGRATE_DATABASE_URL`) | everything |
| `velza_app` | the app and the jobs container (`DATABASE_URL`) | read and write rows; **no** schema changes; `code_history` (every monthly partition too), `damage_reports` and `attachments` only read and appended (no update, delete or truncate); `code_history_once` read only (its trigger writes it); at most 100 connections; a lock wait over 10 s fails with 409 "busy, try again"; may call `code_history_ensure_partitions()` and `velza_daily_maintenance()` |
| `velza_readonly` | the backup container, reports (`BACKUP_DATABASE_URL`) | read only |

### Settings (Parameter Store → one file per container)

Terraform writes these under `/velza/<env>/`. The deploy workflow (`.github/workflows/deploy-env.yml`, `files_for`)
writes each parameter only to the files of the containers that need it (`-` means "not set" and is skipped), so the
internet-facing app never holds the owner password, the bucket keys or the seed passwords. Nothing secret lives in the
repo or in GitHub except the SSH deploy key.

| File in `/srv/velza` | Read by | Keys |
| --- | --- | --- |
| `.env` | Compose itself (substituted into `compose.yml`; no container gets it) | `DOMAIN`, `ACME_EMAIL`, `COMPOSE_PROFILES` (`localdb` on staging), `CLIENT_IP_HEADER`, `LOCAL_DB_PASSWORD` (staging's own `db` container), and the image tags the workflow adds |
| `app.env` | `app` | `NODE_ENV`, `DATABASE_URL` (`velza_app`), `PG_POOL_MAX`; optional `PG_LOCK_POOL_MAX`, `DATABASE_URL_UNPOOLED`, `VELZA_ALLOCATION_LOCK_WAIT_MS`, `RATE_LIMIT_*_PER_MIN` |
| `jobs.env` | `jobs` | `DATABASE_URL` (`velza_app`), optional `HEARTBEAT_STOCK_CHECK_URL`, `STOCK_CHECK_HOUR_UTC` |
| `backup.env` | `backup` | `BACKUP_DATABASE_URL` (`velza_readonly`), `BACKUP_BUCKET`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (this bucket only), `AWS_DEFAULT_REGION`; optional `HEARTBEAT_BACKUP_URL`, `BACKUP_HOUR_UTC`, `BACKUP_KEEP_DAYS`, `BACKUP_KEEP_MONTHS` |
| `migrate.env` | only the one-off migrate and roles steps of `deploy/remote-deploy.sh` | `MIGRATE_DATABASE_URL` (owner), `APP_DB_PASSWORD`, `READONLY_DB_PASSWORD`, `VELZA_ADMIN_PASSWORD` / `VELZA_HQ_PASSWORD` (the first-start seed runs inside `db:migrate`) |

`DEPLOY_HOST` is used by the workflow only and is written to no file. `CLIENT_IP_HEADER` reaches the app through
`compose.yml`'s `environment:`. Every file is `chmod 600`; `migrate.env` is deleted from the server whenever the
deploy script exits, after a success or a failure (each deploy copies it again), and its values reach the one-off
containers as `-e NAME` from the script's environment, never on a command line. **A new parameter must first be
added to `files_for`**: a parameter the mapping doesn't know stops the deploy with an error naming it. The CI smoke test checks that `app` and `jobs` see
none of the migrate or bucket secrets.

The managed database is reached over verified TLS: URLs end with
`?sslmode=verify-full&sslrootcert=/etc/ssl/aws/rds-global-bundle.pem` (the AWS certificate bundle is in every image).

**Connection pools.** Here the app talks to the database directly, so leave `DATABASE_URL_UNPOOLED` and
`PG_LOCK_POOL_MAX` unset. Every query, and code allocation for print orders (which holds a session-level advisory
lock), then uses `DATABASE_URL` through one pool of `PG_POOL_MAX` connections (default 10). The second, small pool on
`DATABASE_URL_UNPOOLED` exists for Neon on Vercel, where `DATABASE_URL` is a transaction-mode pooler
(docs/VERCEL.md).

## 2. One-time setup

Do these in order. Nothing in AWS is created until you run `terraform apply`.

1. **AWS account** (company card): root MFA, IAM Identity Center logins for people, AWS Budgets alarms
   (e.g. ₹5,000 / ₹8,000 / ₹12,000 a month), CloudTrail on, default region Asia Pacific (Mumbai).
2. **Terraform state bucket**, by hand, once: S3 bucket `velza-terraform-state` in `ap-south-1`, versioning on,
   encryption on, public access blocked. (If the name is taken, change it in the four `backend "s3"` blocks.)
3. **Check the Lightsail IDs** used in `infra/terraform/envs/*/main.tf` exist in Mumbai, and change them if not:
   ```bash
   aws lightsail get-bundles --region ap-south-1 --query 'bundles[].[bundleId,price,ramSizeInGb]' --output table
   aws lightsail get-relational-database-bundles --region ap-south-1 --query 'bundles[].[bundleId,price,ramSizeInGb,diskSizeInGb]' --output table
   aws lightsail get-relational-database-blueprints --region ap-south-1 --query 'blueprints[?engine==`postgres`].[blueprintId,engineVersion]' --output table
   aws lightsail get-bucket-bundles --region ap-south-1 --query 'bundles[].[bundleId,price,storagePerMonthInGb]' --output table
   aws lightsail get-blueprints --region ap-south-1 --query 'blueprints[?contains(blueprintId,`ubuntu`)].blueprintId'
   ```
4. **Deploy SSH keys**, one per environment: `ssh-keygen -t ed25519 -N "" -C velza-staging-deploy -f velza-staging-deploy`
   (and the same for prod). The `.pub` goes to Terraform; the private key goes to GitHub (step 7). Delete the local copies afterwards.
5. **Terraform**, as an admin with AWS credentials:
   ```bash
   terraform -chdir=infra/terraform/global init && terraform -chdir=infra/terraform/global apply
   terraform -chdir=infra/terraform/envs/staging init
   terraform -chdir=infra/terraform/envs/staging apply -var "deploy_ssh_public_key=$(cat velza-staging-deploy.pub)"
   terraform -chdir=infra/terraform/envs/prod init
   terraform -chdir=infra/terraform/envs/prod apply -var "deploy_ssh_public_key=$(cat velza-prod-deploy.pub)"
   ```
   Note the outputs: `deploy_role_arns` (global), `static_ip` and `backup_bucket` (each environment). The prod
   database has `prevent_destroy`; removing it needs a deliberate code change.
   **Then turn on versioning for each backup bucket, once** (the Terraform AWS provider has no setting for it on
   `aws_lightsail_bucket`, checked up to v6.73):
   ```bash
   aws lightsail update-bucket --bucket-name "$(terraform -chdir=infra/terraform/envs/staging output -raw backup_bucket)" --versioning Enabled --region ap-south-1
   aws lightsail update-bucket --bucket-name "$(terraform -chdir=infra/terraform/envs/prod output -raw backup_bucket)" --versioning Enabled --region ap-south-1
   aws lightsail get-buckets --region ap-south-1 --query 'buckets[].[name,objectVersioning]' --output table   # both: Enabled
   ```
   See *Backups: what versioning protects* in section 4.
6. **DNS**: A records `staging.velzaglobal.com` and `app.velzaglobal.com` → the two static IPs. Caddy gets the HTTPS
   certificates on the first deploy once these resolve.
7. **GitHub** → Settings → Environments: create `staging` and `production`.
   - Each: secret `DEPLOY_SSH_KEY` (the private key), variable `AWS_DEPLOY_ROLE_ARN` (from step 5), and variable
     `DEPLOY_KNOWN_HOSTS` = the server's host key (`ssh-keyscan -t ed25519 <static_ip>`, checked against the Lightsail
     console's browser SSH).
   - `production`: add **required reviewers**, so every production deploy waits for an approval.
   - Settings → Branches: protect `main`, require the CI checks and one review.
8. **Monitoring** (by hand): Lightsail console → each server and the database → *Metrics* → alarms for CPU > 80%,
   status-check failures, database free storage < 20 GB, with email/SMS contacts. Better Stack (free) uptime checks on
   both `/api/health` URLs (they fail when the database is unreachable, not only when the server is down), and two heartbeats whose URLs go into `HEARTBEAT_BACKUP_URL` and `HEARTBEAT_STOCK_CHECK_URL`
   (`aws ssm put-parameter --overwrite --name /velza/prod/HEARTBEAT_BACKUP_URL --value <url>`).
9. **Data from Neon** (production, once, in a quiet hour, **before the first production deploy**, while the new
   database is still empty; the database is private, so this runs on the prod server):
   ```bash
   # anywhere with pg_dump 16+: pause scanning first
   pg_dump --format=custom --no-owner --no-privileges "$NEON_DIRECT_URL" > neon.dump
   scp neon.dump ubuntu@<prod static ip>:/srv/velza/
   # on the prod server; MIGRATE_DATABASE_URL from Parameter Store /velza/prod/MIGRATE_DATABASE_URL (not kept on the
   # server: migrate.env is deleted after each deploy)
   docker run --rm -v /srv/velza/neon.dump:/tmp/neon.dump:ro \
     -v /srv/velza/rds-global-bundle.pem:/etc/ssl/aws/rds-global-bundle.pem:ro postgres:16 \
     pg_restore --no-owner --no-privileges --dbname="$MIGRATE_DATABASE_URL" /tmp/neon.dump
   ```
   (download the bundle first: `curl -o /srv/velza/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`).
   Then approve the first production deploy: it upgrades the schema to the current version, creates the roles, and
   starts the app on the restored data. Check with `docker compose exec jobs npm run -s db:stock -- check`, sign in,
   compare a few counts with Neon. Keep Neon read-only for a week, then delete it.

## 3. Deploying and rolling back

- **Normal release:** merge to `main`. CI runs; when it passes, *Deploy* builds the three images (tagged with the
  commit SHA), deploys to staging, then waits for a reviewer to approve production.
- **Rollback:** Actions → *Deploy* → *Run workflow*, `image_tag` = the commit SHA of the release to go back to. No
  build; staging and then production get that release. This is the only rollback: Docker Compose through the deploy
  workflow is the one deployment method (the old PM2 scripts were removed on 21 Nov 2026). Older code runs on the
  newer schema: the app never moves the schema backwards, and migrations of an older release are skipped
  automatically (since schema v10, triggers keep `container_items` right for a release that doesn't know it).
  **Exception: schema v11 is one-way.** A v10 release can't run on a v11 database (see "Schema v11" below), so
  rolling back across v11 means restoring the snapshot taken before the migration, not redeploying an older `image_tag`.
- **What a deploy does on the server** (`deploy/remote-deploy.sh`): pull images → (staging) start its database →
  migrate as the owner → apply roles and grants → start the new containers and wait until healthy → prune
  old images. `migrate.env` is deleted when the script exits, whatever the outcome.
  If any step fails, the running containers keep running. The workflow then checks `https://<domain>/api/health`.
- **Health check:** `GET /api/health` (no sign-in) answers `{ "ok": true }` when the app reaches its database (a
  `SELECT 1`; the data file for the JSON store), else 503 `{ "ok": false }` within 3 s; nothing else is in the answer,
  and the reason goes to the app's log. The Docker `HEALTHCHECK`, the deploy workflow's last step and the smoke test use
  it, so a release that can't reach its database fails the deploy. It counts against the per-client rate limit like any
  request (1,200 a minute by default); an uptime check every 30 s is far below that.
- **Schema rule:** migrations run while the previous release is still serving, so every change must work with the
  previous release (add first, remove in a later release). CI's *schema upgrade = fresh install* job checks upgrades.
  Schema v11 is the one exception to this rule (below): it needs a maintenance window.
- **Schema v10** adds foreign keys (validated during the migration) and the `container_items` table. Before
  validating, the migration counts rows that point at missing rows (print orders or containers with an unknown partner,
  codes with an unknown print order, pool codes with an unknown device, container lot codes that are not codes). If
  there are any, it stops with a message naming each table and count and changes nothing; the deploy then fails at the
  migrate step and the running release keeps serving. Fix or remove those rows, then deploy again. `velza_app` gets
  the new table through the default privileges in `db/roles.sql`.
- **Schema v11** (Option C, monthly history partitions, damage reports). **DO NOT MERGE ALONE: it ships only in the
  same release as the Option C store/service change.** The upgrade clears the state of every pack whose case/tray is
  still sealed (it follows its tray), and a v10 release reads a pack's own columns, so it would see NULL. It is a
  **one-way** upgrade: the previous release can't run on v11 (history ids become UUIDs, sealed packs have NULL state).
  Procedure:
  1. **Snapshot first:** a Lightsail/RDS snapshot, or `pg_dump -Fc` of the database (Supabase/Neon: a backup or a
     `pg_dump`).
  2. **Stop the app or show a maintenance page** for the migration: the old release must not serve requests on the
     new schema. **Vercel production and Render (autoDeploy)** have no migrate step: the new release upgrades the
     database on its **first request**, so put the site in maintenance or run `npm run db:migrate` as the owner
     yourself before traffic reaches the new release.
  3. Migrate, run the roles, start the new release, check `npm run db:stock -- check` and `SELECT * FROM db_health`.
     **Before letting traffic in:** `SELECT sealed_lot_packs_with_own_state FROM db_health` must be 0. Otherwise those
     packs have their own state inside a sealed case/tray and **stay behind when it moves** (accepted behaviour);
     fix them by hand first, as in `migration/README.md` ("Before cut-over").
  4. **Rollback = restore the snapshot** (and redeploy the previous release on it). Redeploying an older `image_tag`
     alone does not work.
  The migration rebuilds `codes` and `code_history` as partitioned tables and copies every row into them, in the one
  migration transaction. On a pilot-size database that takes seconds to minutes and locks both tables meanwhile: deploy
  it outside plant hours. It waits at most 10 s for its locks; if the tables are busy it stops, changes nothing, and
  can simply be run again. After it,
  `npm run db:migrate` does nothing on a current database (`npm run db:migrate -- --force` re-runs the schema, only in a
  quiet moment). The roles step must be `deploy/roles_v11.sql` (it also covers every history month).

## 4. Scheduled jobs and backups

| Container | What | When |
| --- | --- | --- |
| `jobs` | `npm run db:stock -- rollup` (retries for up to 5 s while another rollup holds the lock) | every minute |
| `jobs` | `npm run db:stock -- check` (+ heartbeat) | daily 21:00 UTC (02:30 IST) |
| `backup` | `pg_dump` → `s3://<bucket>/db/daily/`, monthly copy on the 1st; damage photos → `uploads/`; prune (14 days / 12 months); heartbeat | daily 20:00 UTC (01:30 IST) |

- One-off backup: `docker compose run --rm backup now`.
- **Backups: what versioning protects.** With versioning on (one-time step in section 2), a delete or overwrite in
  the bucket, including `backup.sh`'s own pruning of old dumps, only hides the object behind a delete marker; the
  older version stays and can be restored (`aws s3api list-object-versions --bucket <name> --prefix db/`, then
  `aws s3api get-object --version-id <id>`, with the bucket's key or an admin login). The pruning logic is unchanged,
  so pruned dumps now stay as older versions and the bucket grows by one dump a day. Look at its size in the Lightsail
  console now and then, and remove old versions by hand from an admin login when needed.
  **Limits, honestly:** a Lightsail bucket access key can't be made write-only; the key on the server can read, and
  with a version ID even permanently delete, everything in the bucket. Versioning protects against mistakes and
  careless scripts, not against someone who has taken over the server and knows to delete versions. Lightsail's own
  automatic database backups (production) are out of that key's reach. The full fix, S3 with Object Lock and
  lifecycle rules and a put-only role, comes with the move to ECS + RDS.
- **Restore test, monthly:** download the latest dump from the bucket, restore it into staging's database
  (`pg_restore --clean --no-owner`), redeploy staging, run the stock check, sign in and look around.
- Production also has Lightsail's own automatic backups and point-in-time restore (Lightsail console → database →
  *Backups*).

Useful commands on a server (`cd /srv/velza`): `docker compose ps`, `docker compose logs -f app`,
`docker compose exec jobs npm run -s db:stock -- check`, `cat DEPLOYED_TAG`.

## 5. CI checks (`.github/workflows/ci.yml`)

| Job | Checks |
| --- | --- |
| Typecheck, lint, test, build | the app (tests on the JSON store and embedded PostgreSQL) |
| Schema upgrade = fresh install | a database from the previous commit, upgraded, equals a fresh install; stock summary = recount |
| Docker images + stack smoke test | builds the three images; runs the real deploy script; HTTPS and `/api/health`, sign-in, each container sees only its own secrets and `migrate.env` is gone, the app on the restricted `velza_app` role, stock check, backup dump (`deploy/smoke-test.sh`) |
| Terraform fmt + validate | every Terraform folder is valid (formatting is reported as a warning) |

## 6. Live stock summary (schema v9)

Triggers on `codes` append signed counts to `stock_deltas`; `stock_current` (summary + deltas) is always exact and
reads a few hundred rows whatever the number of codes. The HQ dashboard reads it (plus opened lots and their packs,
units in transit, recalled and damaged units) instead of every code.

**Folding the deltas.** The app folds `stock_deltas` into `stock_summary` by itself, at most once a minute per app
process, after a successful write and when the summary is read. It runs as its own short statement outside the
request's transaction and is not awaited, and an error is only logged. `stock_summary_rollup()` takes its lock with
`pg_try_advisory_xact_lock` and returns 0 at once if another rollup (another process, or the jobs container) holds it,
so app processes and the jobs container never wait for each other. The jobs container's every-minute rollup stays as
the backstop and keeps the daily check. Measured on PostgreSQL 16 with 5 lakh codes: 0.3 ms after a
rollup (1.6 ms with 4,000 deltas waiting) against 171 ms for a full `GROUP BY`; about 10% extra on bulk inserts and
0.04 ms per single-code scan. `npm run db:stock -- rebuild` recounts it (blocks writes to `codes` while it runs:
outside shift peaks).
