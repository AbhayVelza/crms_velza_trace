#!/usr/bin/env bash
# Runs ON THE SERVER: .github/workflows/deploy-env.yml copies it to /srv/velza with compose.yml, Caddyfile, roles_v11.sql
# and the environment files (.env, app.env, jobs.env, backup.env, migrate.env; see compose.yml), then runs
# `bash /srv/velza/remote-deploy.sh` with a short-lived GitHub token (to pull the images) as the only line on stdin, so
# the token never appears in a command line or a file.
#
# Order (each step stops the deploy if it fails; the running containers stay as they were until step 5):
#   1. pull the new images          4. apply database roles and grants (idempotent)
#   2. staging: start its database  5. start the new containers and wait until healthy
#   3. migrate the schema           6. tidy up
#
# migrate.env (owner URL, role passwords, first-start seed passwords) is read only by steps 3 and 4, never by a
# long-running container, and is deleted when this script exits, whether the deploy worked or failed (also on Ctrl-C,
# SIGTERM or a dropped SSH connection); every deploy copies it again.
#
# SKIP_PULL=1 and DEPLOY_DIR=<dir> let CI run this same script against locally built images (deploy/smoke-test.sh).
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/velza}"
SKIP_PULL="${SKIP_PULL:-0}"
GHCR_TOKEN=""
[ "$SKIP_PULL" = 1 ] || read -r GHCR_TOKEN
cd "$DEPLOY_DIR"
DEPLOY_DIR="$PWD"

# On every exit: remove migrate.env (owner URL and passwords), and log out of the registry if this run logged in.
LOGGED_IN=0
cleanup() {
  rm -f "$DEPLOY_DIR/migrate.env"
  if [ "$LOGGED_IN" = 1 ]; then docker logout ghcr.io >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
# Signals end the script through `exit`, so the EXIT trap runs for them too.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for f in .env app.env jobs.env backup.env migrate.env; do
  [ -f "$f" ] || { echo "missing $DEPLOY_DIR/$f (the deploy workflow writes it)" >&2; exit 1; }
  chmod 600 "$f"
done

# Values are read one by one: the files hold URLs with & and ? that must never be evaluated by a shell.
val() { grep -m1 "^$2=" "$1" | cut -d= -f2- || true; } # file key
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if [ "$SKIP_PULL" = 1 ]; then
  log "1/6 using local images (SKIP_PULL=1)"
else
  log "1/6 pulling images"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin >/dev/null
  LOGGED_IN=1
  docker compose pull --quiet
fi

if [ "$(val .env COMPOSE_PROFILES)" = "localdb" ]; then
  log "2/6 starting the staging database"
  docker compose up -d --wait db
else
  log "2/6 managed database: nothing to start"
fi

# The owner URL and the seed passwords reach the one-off containers through `-e NAME` (value taken from this
# script's environment), never through a command line or a long-running container's env_file.
log "3/6 migrating the schema (owner role)"
DATABASE_URL="$(val migrate.env MIGRATE_DATABASE_URL)" \
VELZA_ADMIN_PASSWORD="$(val migrate.env VELZA_ADMIN_PASSWORD)" \
VELZA_HQ_PASSWORD="$(val migrate.env VELZA_HQ_PASSWORD)" \
  docker compose run --rm --no-deps -T -e DATABASE_URL -e VELZA_ADMIN_PASSWORD -e VELZA_HQ_PASSWORD \
  jobs npm run -s db:migrate

log "4/6 database roles and grants"
PGURL="$(val migrate.env MIGRATE_DATABASE_URL)" \
APP_DB_PASSWORD="$(val migrate.env APP_DB_PASSWORD)" \
READONLY_DB_PASSWORD="$(val migrate.env READONLY_DB_PASSWORD)" \
  docker compose run --rm --no-deps -T -e PGURL -e APP_DB_PASSWORD -e READONLY_DB_PASSWORD \
  -v "$DEPLOY_DIR/roles_v11.sql:/tmp/roles.sql:ro" --entrypoint sh backup -c \
  'psql "$PGURL" -q -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" -v readonly_password="$READONLY_DB_PASSWORD" -f /tmp/roles.sql'

log "5/6 starting the new release"
docker compose up -d --remove-orphans --wait --wait-timeout 180

log "6/6 tidying up"
docker image prune -f >/dev/null
echo "${DEPLOY_TAG:-unknown}" > DEPLOYED_TAG
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
log "deployed ${DEPLOY_TAG:-}"
