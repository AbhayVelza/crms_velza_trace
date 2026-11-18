#!/usr/bin/env bash
# CI smoke test of the whole Docker stack, using the same deploy script as the servers (deploy/remote-deploy.sh):
# builds nothing itself, expects images velza-app:ci, velza-ops:ci and velza-backup:ci, and runs a staging-style
# stack (database in a container) with Caddy serving https://localhost from its internal certificate authority.
# Checks: the deploy script completes, HTTPS answers, sign-in works, the app connects as the restricted velza_app
# role, the stock summary matches a recount, and a database dump can be made with the backup image.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then (cd "$DIR" && docker compose logs --no-color --tail 80) || true; fi
  (cd "$DIR" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$DIR"
  exit "$status"
}
trap cleanup EXIT

cp "$ROOT/deploy/compose.yml" "$ROOT/deploy/Caddyfile" "$ROOT/deploy/remote-deploy.sh" "$ROOT/db/roles.sql" "$DIR/"
cat > "$DIR/.env" <<'EOF'
NODE_ENV=production
DOMAIN=localhost
ACME_EMAIL=ci@example.com
APP_IMAGE=velza-app:ci
OPS_IMAGE=velza-ops:ci
BACKUP_IMAGE=velza-backup:ci
COMPOSE_PROFILES=localdb
LOCAL_DB_PASSWORD=CiOwner2026pass
MIGRATE_DATABASE_URL=postgres://velza:CiOwner2026pass@db:5432/velza
DATABASE_URL=postgres://velza_app:CiApp2026pass@db:5432/velza
BACKUP_DATABASE_URL=postgres://velza_readonly:CiRo2026pass@db:5432/velza
APP_DB_PASSWORD=CiApp2026pass
READONLY_DB_PASSWORD=CiRo2026pass
VELZA_ADMIN_PASSWORD=CiAdmin2026pass
VELZA_HQ_PASSWORD=CiHq2026pass
BACKUP_BUCKET=ci-not-used
AWS_DEFAULT_REGION=ap-south-1
EOF

echo "== deploy (same script as the servers)"
SKIP_PULL=1 DEPLOY_DIR="$DIR" DEPLOY_TAG=ci bash "$DIR/remote-deploy.sh"
cd "$DIR"

echo "== HTTPS answers"
curl -fsS -k -o /dev/null --retry 15 --retry-delay 2 --retry-all-errors https://localhost/login

echo "== sign in as Velza Admin"
curl -fsS -k -c cookies -H 'content-type: application/json' -H 'origin: https://localhost' \
  -d '{"loginId":"AD0001","password":"CiAdmin2026pass"}' https://localhost/api/auth/login | grep -q '"id":"AD0001"'
curl -fsS -k -b cookies https://localhost/api/auth/me | grep -q '"role":"ADMIN"'

echo "== the app is connected as the restricted velza_app role"
roles="$(docker compose exec -T db psql -U velza -d velza -tAc "SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity WHERE datname = 'velza' AND usename <> 'velza'")"
echo "connected roles: $roles"
echo "$roles" | grep -q velza_app
if docker compose exec -T db psql "postgres://velza_app:CiApp2026pass@localhost:5432/velza" -c "CREATE TABLE smoke(x int)" >/dev/null 2>&1; then
  echo "velza_app could create a table" >&2
  exit 1
fi

echo "== stock summary matches a recount"
docker compose exec -T jobs npm run -s db:stock -- check

echo "== a backup dump can be made (upload is not tested here)"
docker compose run --rm --no-deps -T --entrypoint sh backup -c \
  'pg_dump --format=custom --dbname="$BACKUP_DATABASE_URL" --file=/tmp/t.dump && pg_restore --list /tmp/t.dump >/dev/null && echo dump OK'

echo "== all containers healthy or running"
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "SMOKE TEST PASSED"
