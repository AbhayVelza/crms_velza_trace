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

Every deploy runs `db/roles.sql` (idempotent) with passwords from Parameter Store:

| Role | Used by | Can |
| --- | --- | --- |
| owner (`velza_owner` on prod, `velza` on staging) | migrations only (`MIGRATE_DATABASE_URL`) | everything |
| `velza_app` | the app and the jobs container (`DATABASE_URL`) | read and write rows; **no** schema changes |
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
`compose.yml`'s `environment:`. Every file is `chmod 600`; `migrate.env` is deleted from the server at the end of a
successful deploy (each deploy copies it again), and its values reach the one-off containers as `-e NAME` from the
script's environment, never on a command line. **A new parameter must first be added to `files_for`**: a parameter
the mapping doesn't know stops the deploy with an error naming it. The CI smoke test checks that `app` and `jobs` see
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
   Note the outputs: `deploy_role_arns` (global), `static_ip` (each environment). The prod database has
   `prevent_destroy`; removing it needs a deliberate code change.
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
   both `/login` URLs, and two heartbeats whose URLs go into `HEARTBEAT_BACKUP_URL` and `HEARTBEAT_STOCK_CHECK_URL`
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
  build; staging and then production get that release. Older code runs on the newer schema: the app never moves the
  schema backwards, and migrations of an older release are skipped automatically.
- **What a deploy does on the server** (`deploy/remote-deploy.sh`): pull images → (staging) start its database →
  migrate as the owner → apply roles and grants → start the new containers and wait until healthy → delete
  `migrate.env`, prune old images.
  If any step fails, the running containers keep running. The workflow then checks `https://<domain>/login`.
- **Schema rule:** migrations run while the previous release is still serving, so every change must work with the
  previous release (add first, remove in a later release). CI's *schema upgrade = fresh install* job checks upgrades.
- **Schema v10** adds foreign keys (validated during the migration) and the `container_items` table. Before
  validating, the migration counts rows that point at missing rows (print orders or containers with an unknown partner,
  codes with an unknown print order, pool codes with an unknown device, container lot codes that are not codes). If
  there are any, it stops with a message naming each table and count and changes nothing; the deploy then fails at the
  migrate step and the running release keeps serving. Fix or remove those rows, then deploy again. `velza_app` gets
  the new table through the default privileges in `db/roles.sql`.

## 4. Scheduled jobs and backups

| Container | What | When |
| --- | --- | --- |
| `jobs` | `npm run db:stock -- rollup` (retries for up to 5 s while another rollup holds the lock) | every minute |
| `jobs` | `npm run db:stock -- check` (+ heartbeat) | daily 21:00 UTC (02:30 IST) |
| `backup` | `pg_dump` → `s3://<bucket>/db/daily/`, monthly copy on the 1st; damage photos → `uploads/`; prune (14 days / 12 months); heartbeat | daily 20:00 UTC (01:30 IST) |

- One-off backup: `docker compose run --rm backup now`.
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
| Docker images + stack smoke test | builds the three images; runs the real deploy script; HTTPS, sign-in, each container sees only its own secrets and `migrate.env` is gone, the app on the restricted `velza_app` role, stock check, backup dump (`deploy/smoke-test.sh`) |
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

## 7. Without Docker (fallback)

`deploy/deploy.sh`, `deploy/rollback.sh`, `deploy/ecosystem.config.cjs` and `deploy/crontab.example` deploy the same
app with PM2 on a plain VPS (Node 24, Nginx or Caddy in front). Kept for emergencies; the Docker path above is the
supported one.
