# Test deployment on Vercel + Neon

The test deployment runs on Vercel with a PostgreSQL database on Neon:

- **Production:** every merge to `main` deploys to the production URL, using Neon's main database branch.
- **Preview:** every pull request gets its own preview URL and its **own Neon database branch** (a copy of
  production taken when the preview is created), so testing a PR never touches production data.

These steps are done once, by hand, in the Vercel, Neon and GitHub dashboards. Nothing here needs secrets in git.

## Why the setup looks like this

| Fact | Consequence |
|---|---|
| Vercel's disk is read-only and is not kept between requests. | The JSON store (`data/db.json`) cannot work: production and previews must use PostgreSQL. |
| The app holds a **session-level advisory lock** across a transaction when it allocates codes (`src/lib/store/sql/driver.ts`). Neon's pooled address runs PgBouncer in transaction mode, which does not support session-level locks. | The app must use Neon's **direct** (non-pooled) address. It reads `DATABASE_URL_UNPOOLED` first, which the Neon integration sets to the direct address, and falls back to `DATABASE_URL`. |
| Neon has no Mumbai region; the closest is Singapore (`aws-ap-southeast-1`). Every request makes several database round trips. | The functions run next to the database, in Vercel's Singapore region `sin1` (`vercel.json`). One Mumbai ↔ Singapore hop per request (about 60 ms) is cheaper than one per query. |
| Damage photos are saved as files (`src/lib/services/damagePhotos.ts`). | On Vercel they go to `/tmp/velza-uploads` (the default when `VERCEL` is set), which is temporary and not shared between function instances. See [Known limits](#known-limits). |
| The Docker image uses `output: "standalone"`. | `next.config.ts` turns it off when `VERCEL` is set (during Vercel builds); Vercel packages the app itself. |
| The app falls back to the JSON file when no database is set. | On Vercel it refuses to start instead, with a message pointing here, so a missing Neon connection is obvious. |

## 1. Vercel project

1. Vercel → **Add New → Project** → import `AbhayVelza/crms_velza_trace` from GitHub. Use a **Pro team** with all
   three of you as members: Hobby is for personal, non-commercial use and doesn't let a team share the project.
2. Framework preset: **Next.js** (detected). Leave the build command, output directory and install command at
   their defaults. Root directory: the repository root.
3. **Settings → Build and Deployment → Node.js Version: 24.x.**
4. Don't deploy yet if Vercel offers to (or let the first deploy fail; it will be redeployed in step 4). The
   database comes first.
5. **Settings → Git:** production branch `main`. Leave "preview deployments for every branch" on.
6. **Settings → Deployment Protection:** keep **Vercel Authentication** on for preview deployments (previews hold a
   copy of production data). Production stays public: the app has its own sign-in, and the QR page `/t/<code>`
   must be reachable by anyone.

`vercel.json` pins the functions to `sin1`. If you create the Neon database in another region, change it to the
Vercel region closest to that database.

## 2. Neon through the Vercel Marketplace

1. In the Vercel project → **Storage → Create Database → Neon** (Marketplace). Accept the Neon terms.
2. Region: **Asia Pacific (Singapore), `aws-ap-southeast-1`**. Name it e.g. `velza-test`.
3. Connect it to the project with:
   - Environments: **Production** and **Preview**. **Do not tick Development**, so `vercel env pull` never writes the
     production database address into anyone's `.env.local`.
   - **Preview deployments: create a database branch for each preview deployment** (Neon names it after the Git
     branch, e.g. `preview/feature-abhay-customs-export`).
   - Environment variable prefix: **leave it empty**, so the variables are named `DATABASE_URL`,
     `DATABASE_URL_UNPOOLED`, `PGHOST`, … exactly. The app reads `DATABASE_URL_UNPOOLED`.
4. In the Neon console for this project: turn on **automatic deletion of preview branches** when their Git branch
   is deleted (or delete old `preview/*` branches by hand). Check your Neon plan's branch limit: one branch per
   open PR adds up.

## 3. Environment variables

Vercel → Project → **Settings → Environment Variables**. Mark passwords **Sensitive**.

| Variable | Production | Preview | Notes |
|---|---|---|---|
| `DATABASE_URL` | set by the Neon integration | set by the Neon integration (per preview branch) | Pooled address. Don't edit; the app uses it only if `DATABASE_URL_UNPOOLED` is missing. |
| `DATABASE_URL_UNPOOLED` | set by the Neon integration | set by the Neon integration (per preview branch) | Direct address. **This is the one the app uses.** Don't edit. |
| `PG_POOL_MAX` | `5` | `3` | Connections per function instance. Instances × `PG_POOL_MAX` must stay under the Neon compute's limit (about 100 on the smallest, 0.25 CU). Idle connections close after 10 s. |
| `VELZA_ADMIN_PASSWORD` | a strong, unique password | a different strong password | Used only when the database is empty (first start). Change it in the app after the first sign-in. |
| `VELZA_HQ_PASSWORD` | a strong, unique password | a different strong password | As above. |
| `HTTPS_ONLY` | `1` | `1` | Vercel serves HTTPS only: turns on HSTS and `upgrade-insecure-requests`. |
| `CLIENT_IP_HEADER` | `x-real-ip` | `x-real-ip` | Vercel sets this header to the visitor's IP; clients can't fake it. Without it, rate limits and the sign-in lockout trust `X-Forwarded-For`. |
| `VELZA_UPLOAD_DIR` | optional | optional | On Vercel it already defaults to `/tmp/velza-uploads` (the usual `data/uploads` is read-only there). Photos stored in `/tmp` are **temporary**: see [Known limits](#known-limits). |

Leave these **unset** on Vercel:

| Variable | Why |
|---|---|
| `STORE`, `PGLITE_DIR`, `VELZA_DB_PATH` | They would switch the app to the JSON file or embedded PostgreSQL, which write to the read-only disk. |
| `SIGN_IN` | Sign-in is on in production builds by default. **Never set `SIGN_IN=off` on Vercel**: anyone could act as anyone. |
| `NEXT_PUBLIC_DEMO_HELPER` | Shows a click-to-scan helper that lists codes. For local demos only. |
| `RATE_LIMIT_*`, `VELZA_ALLOCATION_LOCK_WAIT_MS` | The defaults are fine (see SECURITY.md). |
| `NODE_ENV` | Vercel sets it. |

## 4. First deploy: create the tables and the two staff sign-ins

The app creates its tables and the two staff sign-ins (`AD0001`, `HQ0001`) itself on the first request to an
empty database. Don't rely on that for production: if several functions start at once on an empty database they
race (one request can fail with an error, and the seed can run twice), and the seed prints both passwords into
Vercel's runtime logs, which everyone on the team can read. Run it once by hand instead:

1. Neon console → the project → branch **main** → **Connect** → copy the connection string with
   **connection pooling off** (the host has no `-pooler`).
2. On your own machine, in the repository (Node 24, after `npm ci`):

   ```powershell
   # PowerShell
   $env:DATABASE_URL = "<direct connection string from step 1>"
   $env:VELZA_ADMIN_PASSWORD = "<the Production value from step 3>"
   $env:VELZA_HQ_PASSWORD = "<the Production value from step 3>"
   npm run db:migrate
   Remove-Item Env:DATABASE_URL, Env:VELZA_ADMIN_PASSWORD, Env:VELZA_HQ_PASSWORD
   ```

   ```sh
   # bash
   DATABASE_URL='<direct connection string>' VELZA_ADMIN_PASSWORD='…' VELZA_HQ_PASSWORD='…' npm run db:migrate
   ```

   Variables set in the shell win over `.env.local`. The output ends with `Schema is up to date …` and lists the
   tables. It also prints the two passwords once: clear your terminal afterwards.
3. Vercel → **Deployments** → redeploy the latest `main` deployment (or push a commit to `main` through a PR).
4. Open the production URL, sign in as `AD0001`, and change both staff passwords on the Account page.

Preview branches are copies of production, so they already have the tables and sign-ins: nothing to run for them.

### When a PR changes the schema

If a PR bumps `SCHEMA_VERSION` in `src/lib/store/sql/schema.ts`:

- Its preview upgrades its own Neon branch on the first request (harmless; a request may fail once if two
  functions start at the same moment).
- **Before merging**, run `npm run db:migrate` against the production direct address as in step 4. Upgrades are
  additive, so the old code keeps running on the new schema until the merge deploys the new code. Otherwise
  every new function instance tries the upgrade on its own at the same time.

## 5. GitHub: protect `main`

GitHub → repository → **Settings → Branches → Add branch ruleset** (or a classic branch protection rule) for
`main`:

- **Require a pull request before merging**
  - Required approvals: **1**
  - Dismiss stale pull request approvals when new commits are pushed: on (recommended)
  - Require review from Code Owners: **off** until `.github/CODEOWNERS` has the real usernames
- **Require status checks to pass before merging**, with these two checks from `.github/workflows/ci.yml`:
  - `Typecheck, lint, test, build`
  - `Schema upgrade = fresh install`

  GitHub only lists a check after it has run once on the repository, so this works once `ci.yml` is on `main`
  and has run on a PR. Optionally also require the `Vercel` check (the preview deployment built).
- **Block force pushes**
- **Restrict deletions**
- Don't allow anyone to bypass the rules (in a classic rule: **Do not allow bypassing the above settings**).

## Known limits

These are fine for a test deployment, but each needs fixing before Vercel could host the real production system.

- **Damage photos are temporary.** With `VELZA_UPLOAD_DIR=/tmp/velza-uploads` a damage report succeeds, but its
  photos live only in that function instance's `/tmp`. They disappear when the instance stops and other instances
  can't see them, so viewing a report's photos will often show none. Keeping them needs object storage (e.g.
  Vercel Blob or S3) in `damagePhotos.ts`.
- **Large damage reports can be refused.** Vercel limits a request body to 4.5 MB. The app accepts up to about
  8 MB of photos per report. The page shrinks photos before sending, so normal reports fit, but one with five large
  photos would get HTTP 413.
- **Rate limits and the sign-in lockout are per function instance.** They are kept in memory
  (`src/lib/security.ts`, `src/lib/services/auth.ts`), so with several instances the effective limits are higher,
  and they reset when an instance stops. Vercel's firewall (WAF) rate limiting can cover this.
- **Live stock summary upkeep.** Counts are exact without it, but `stock_deltas` grows until it is folded. Now and
  then run `npm run db:stock -- rollup` (and `-- check`) from a laptop with the direct Neon address in
  `DATABASE_URL`, as in step 4. Vercel Hobby crons run at most once a day, so there is no per-minute job here.
- **Connections.** Each function instance keeps up to `PG_POOL_MAX` direct connections. If Vercel logs show
  `too many connections` / `remaining connection slots are reserved`, lower `PG_POOL_MAX` or give the Neon
  compute more CU.
