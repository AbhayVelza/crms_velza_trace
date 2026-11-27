# Supabase (test) → new v11 database

Moves the Supabase test data into a **new, empty** schema v11 database (the production RDS). From
`velza_db_v11_aws/migration/`, with `docs/DATABASE_PHASE1_REVIEW.md` §1b issues 8–11 and 16 fixed. Dev, test and pilot
databases don't need this: `npm run db:migrate` upgrades them in place with the same rules (`src/lib/store/sql/schema.ts`).

Supabase is only read. Nothing here runs against a database by itself: a person runs each step, after a rehearsal on
staging (`docs/DATABASE_PHASE1_REVIEW.md` §6). `npm test` rehearses steps 3 and 4 on embedded PostgreSQL
(`src/lib/store/sql/migrationV11.test.ts`).

## The new database (once)

```bash
# 1. As the AWS master user (skip on Lightsail through our Terraform: the master user is already velza_owner)
psql "host=<endpoint> dbname=postgres user=<master> sslmode=verify-full sslrootcert=global-bundle.pem" \
     -v owner_password="$OWNER_PW" -f db/bootstrap_aws.sql
# 2. The schema, as velza_owner. Use the schema file, not `npm run db:migrate`: on an empty database db:migrate also adds
#    the first-start sign-ins and lists, which would collide with the copied ones (03 refuses that).
psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/schema.sql
# 3. Roles, as velza_owner
psql "$MIGRATE_DATABASE_URL" -v app_password="$APP_PW" -v readonly_password="$RO_PW" -f deploy/roles_v11.sql
```

## The data

```bash
docker run -d --name velza-scratch -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17
SUPABASE_URL='…session pooler :5432…' ./migration/01_export_supabase.sh
SCRATCH_URL=postgresql://postgres@localhost:55432/postgres TARGET_URL="$MIGRATE_DATABASE_URL" ./migration/02_stage_into_target.sh
psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -f migration/03_transform.sql   # all-or-nothing, self-checking
psql "$MIGRATE_DATABASE_URL" -f migration/04_report.sql > out/migration_report.txt
# only if photo files exist on a disk (the Vercel test site keeps none):
# UPLOAD_DIR=… BUCKET=… TARGET_URL="$MIGRATE_DATABASE_URL" ./migration/05_upload_photos.sh
psql "$MIGRATE_DATABASE_URL" -f migration/06_cleanup.sql
```

Then set new Admin/HQ passwords. Rollback = point the app back to Supabase (it was only read).

What 03 checks before it commits (any failure keeps nothing): same row counts; every barcode's effective state equals
Supabase's; every history row equal in every column (ids mapped to uuid); stock per place, status, lot type and flavour
equal to Supabase, live summary included; no history row outside its month; no opened lot with following packs; every
container's rows equal its lot list. 04 lists the packs kept with their own state under a sealed lot (decision Q7).

Loading crores of codes this way is slow at COMMIT (deferred foreign keys check each row): fine for test data; for a
crore-scale load, load first and add the keys afterwards.
