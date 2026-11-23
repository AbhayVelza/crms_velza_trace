#!/usr/bin/env bash
# Deploy a release of the app on the server, with no downtime and a one-command rollback.
#
#   deploy/deploy.sh            deploy origin/main
#   deploy/deploy.sh <git-ref>  deploy a tag, branch or commit (e.g. v2026.11.17)
#
# Layout (see docs/DEPLOYMENT.md):
#   /srv/velza/repo          a git clone, used only to fetch releases
#   /srv/velza/releases/<t>  one folder per release (the last 5 are kept)
#   /srv/velza/current       symlink to the live release (PM2 runs from here)
#   /srv/velza/shared/.env.local     the app's settings (DATABASE_URL = the velza_app role), chmod 600
#   /srv/velza/shared/migrate.env    DATABASE_URL for migrations (the owner/migrator role), chmod 600
#
# Order: build the new release → migrate the database → switch the symlink → reload PM2. If the install, build or
# migration fails, the script stops and the running release is untouched. Schema changes must stay backward
# compatible (add first, remove in a later release), because the old release keeps serving during the migration.

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/velza}"
REF="${1:-origin/main}"
KEEP="${KEEP_RELEASES:-5}"

REPO="$APP_DIR/repo"
SHARED="$APP_DIR/shared"
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ -d "$REPO/.git" ] || { echo "No git clone at $REPO (see docs/DEPLOYMENT.md, one-time setup)" >&2; exit 1; }
[ -f "$SHARED/.env.local" ] || { echo "Missing $SHARED/.env.local" >&2; exit 1; }
[ -f "$SHARED/migrate.env" ] || { echo "Missing $SHARED/migrate.env (DATABASE_URL of the migrator role)" >&2; exit 1; }

log "Fetching $REF"
git -C "$REPO" fetch --tags --prune origin
# A branch name means the branch as just fetched (origin/<name>), never a stale local branch of the server's clone.
if git -C "$REPO" rev-parse --verify --quiet "refs/remotes/origin/$REF" >/dev/null; then REF="origin/$REF"; fi
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
NEW="$RELEASES/$(date +%Y%m%d-%H%M%S)-${SHA:0:7}"

log "Preparing $NEW"
mkdir -p "$RELEASES"
# Until the switch, a failure removes the half-made release, so rollback.sh can never pick it.
switched=no
cleanup() { if [ "$switched" = no ] && [ -d "$NEW" ]; then rm -rf "$NEW"; echo "Deploy failed: the live release is unchanged" >&2; fi; }
trap cleanup EXIT
git -C "$REPO" worktree prune
git -C "$REPO" archive "$SHA" | (mkdir -p "$NEW" && tar -x -C "$NEW")
echo "$SHA" > "$NEW/REVISION"
ln -s "$SHARED/.env.local" "$NEW/.env.local"

cd "$NEW"
log "Installing dependencies"
npm ci --no-audit --no-fund
log "Building"
npm run build

log "Migrating the database (migrator role)"
# The variables from migrate.env win over .env.local (Node's --env-file never overrides what is already set).
( set -a; . "$SHARED/migrate.env"; set +a; npm run db:migrate )

log "Switching to the new release"
ln -sfn "$NEW" "$CURRENT.tmp" && mv -Tf "$CURRENT.tmp" "$CURRENT"
switched=yes

log "Reloading the app"
pm2 startOrReload "$CURRENT/deploy/ecosystem.config.cjs" --update-env
pm2 save >/dev/null

log "Checking the app answers"
healthy=no
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3000}/login"; then healthy=yes; break; fi
  sleep 2
done
[ "$healthy" = yes ] || { echo "The app does not answer on port ${PORT:-3000} after 60 s: check 'pm2 logs velza', or run deploy/rollback.sh" >&2; exit 1; }
log "Live: $SHA"

log "Keeping the last $KEEP releases"
ls -1dt "$RELEASES"/*/ | tail -n +"$((KEEP + 1))" | xargs -r rm -rf

# Leave the server's clone on the deployed commit, so the next run uses this release's deploy scripts.
git -C "$REPO" checkout -q --detach "$SHA"
