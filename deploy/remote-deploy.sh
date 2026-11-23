#!/usr/bin/env bash
# Runs ON THE SERVER: .github/workflows/deploy-env.yml copies it to /srv/velza with compose.yml, Caddyfile, roles.sql
# and .env, then runs `bash /srv/velza/remote-deploy.sh` with a short-lived GitHub token (to pull the images) as the
# only line on stdin, so the token never appears in a command line or a file.
#
# Order (each step stops the deploy if it fails; the running containers stay as they were until step 5):
#   1. pull the new images          4. apply database roles and grants (idempotent)
#   2. staging: start its database  5. start the new containers and wait until healthy
#   3. migrate the schema           6. tidy up
#
# SKIP_PULL=1 and DEPLOY_DIR=<dir> let CI run this same script against locally built images (deploy/smoke-test.sh).
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/velza}"
SKIP_PULL="${SKIP_PULL:-0}"
GHCR_TOKEN=""
[ "$SKIP_PULL" = 1 ] || read -r GHCR_TOKEN
cd "$DEPLOY_DIR"
chmod 600 .env

# Values are read one by one: .env holds URLs with & and ? that must never be evaluated by a shell.
val() { grep -m1 "^$1=" .env | cut -d= -f2- || true; }
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if [ "$SKIP_PULL" = 1 ]; then
  log "1/6 using local images (SKIP_PULL=1)"
else
  log "1/6 pulling images"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  docker compose pull --quiet
fi

if [ "$(val COMPOSE_PROFILES)" = "localdb" ]; then
  log "2/6 starting the staging database"
  docker compose up -d --wait db
else
  log "2/6 managed database: nothing to start"
fi

log "3/6 migrating the schema (owner role)"
docker compose run --rm --no-deps -T -e DATABASE_URL="$(val MIGRATE_DATABASE_URL)" jobs npm run -s db:migrate

log "4/6 database roles and grants"
docker compose run --rm --no-deps -T -v "$DEPLOY_DIR/roles.sql:/tmp/roles.sql:ro" --entrypoint psql backup \
  "$(val MIGRATE_DATABASE_URL)" -q -v ON_ERROR_STOP=1 \
  -v app_password="$(val APP_DB_PASSWORD)" -v readonly_password="$(val READONLY_DB_PASSWORD)" -f /tmp/roles.sql

log "5/6 starting the new release"
docker compose up -d --remove-orphans --wait --wait-timeout 180

log "6/6 tidying up"
docker image prune -f >/dev/null
echo "${DEPLOY_TAG:-unknown}" > DEPLOYED_TAG
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
log "deployed ${DEPLOY_TAG:-}"
