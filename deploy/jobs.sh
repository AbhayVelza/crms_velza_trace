#!/bin/sh
# Scheduled jobs, run by the `jobs` container (ops image).
#   every minute        npm run db:stock -- rollup   (fold stock deltas into the summary)
#   once a day          npm run db:stock -- check    (recount; a difference means investigate, then rebuild)
# STOCK_CHECK_HOUR_UTC picks the hour (default 21 UTC = 02:30 IST). HEARTBEAT_STOCK_CHECK_URL, if set, is called
# after every successful check (a Better Stack / healthchecks.io heartbeat that alerts when it stops arriving).

set -u
CHECK_HOUR="${STOCK_CHECK_HOUR_UTC:-21}"
last_check=""

log() { echo "[jobs $(date -u +%FT%TZ)] $*"; }
heartbeat() { [ -n "${1:-}" ] && node -e "fetch(process.argv[1]).catch(()=>{})" "$1"; return 0; }

log "started (rollup every 60 s, stock check daily at ${CHECK_HOUR}:00 UTC)"
while true; do
  npm run -s db:stock -- rollup >/dev/null 2>&1 || log "rollup FAILED (will retry in 60 s)"
  today="$(date -u +%F)"
  if [ "$(date -u +%H)" = "$CHECK_HOUR" ] && [ "$last_check" != "$today" ]; then
    if npm run -s db:stock -- check; then
      log "stock check OK"
      heartbeat "${HEARTBEAT_STOCK_CHECK_URL:-}"
    else
      log "STOCK CHECK FAILED: run 'npm run db:stock -- rebuild' after investigating"
    fi
    last_check="$today"
  fi
  sleep 60
done
