#!/usr/bin/env bash
# Put the previous release back live (or a named one): deploy/rollback.sh [release-folder-name]
# The database is not rolled back: schema changes are backward compatible, so the older code runs on the newer schema.

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/velza}"
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"

live="$(readlink -f "$CURRENT")"
if [ $# -ge 1 ]; then
  target="$RELEASES/$1"
else
  target="$(ls -1dt "$RELEASES"/*/ | sed 's:/*$::' | grep -vxF "$live" | head -n 1)"
fi
[ -n "$target" ] && [ -d "$target" ] || { echo "No release to roll back to" >&2; ls -1t "$RELEASES" >&2; exit 1; }

echo "Rolling back: $(basename "$live") → $(basename "$target")"
ln -sfn "$target" "$CURRENT.tmp" && mv -Tf "$CURRENT.tmp" "$CURRENT"
pm2 startOrReload "$CURRENT/deploy/ecosystem.config.cjs" --update-env
pm2 save >/dev/null
echo "Live: $(cat "$CURRENT/REVISION" 2>/dev/null || basename "$target")"
