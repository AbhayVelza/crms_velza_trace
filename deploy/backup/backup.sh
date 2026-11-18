#!/bin/sh
# velza-backup loop   wait for BACKUP_HOUR_UTC every day, then run a backup (default; the container's command)
# velza-backup now    run one backup now and exit (e.g. `docker compose run --rm backup now`)
#
# A backup = pg_dump (custom format, compressed) → s3://$BACKUP_BUCKET/db/daily/velza-<date>.dump, plus a copy under
# db/monthly/ on the 1st; then the damage photos are synced to s3://$BACKUP_BUCKET/uploads/ (never deleted there).
# Old dumps are removed: daily after BACKUP_KEEP_DAYS (14), monthly after BACKUP_KEEP_MONTHS (12).
#
# Environment: BACKUP_DATABASE_URL (else DATABASE_URL), BACKUP_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# AWS_DEFAULT_REGION (ap-south-1), optional HEARTBEAT_BACKUP_URL (called after every successful backup).

set -eu

DB_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:?DATABASE_URL or BACKUP_DATABASE_URL is required}}"
BUCKET="${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
HOUR="${BACKUP_HOUR_UTC:-20}"            # 20:00 UTC = 01:30 IST
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-12}"
UPLOADS="${UPLOADS_DIR:-/data/uploads}"

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }

# Delete objects under a prefix whose name carries a date (velza-YYYY-MM-DD.dump) older than a cut-off date.
prune() { # prefix cutoff(YYYY-MM-DD)
  aws s3 ls "s3://$BUCKET/$1" | awk '{print $4}' | while read -r key; do
    d="$(echo "$key" | sed -n 's/^velza-\([0-9-]\{10\}\)\.dump$/\1/p')"
    # Dates compared as numbers (20261101 < 20261117): portable to any POSIX sh.
    if [ -n "$d" ] && [ "$(echo "$d" | tr -d -)" -lt "$(echo "$2" | tr -d -)" ]; then
      aws s3 rm --only-show-errors "s3://$BUCKET/$1$key" && log "removed $1$key"
    fi
  done
}

# Every step checks its own result: inside `if backup_once` the shell ignores `set -e`, so a failed pg_dump must
# stop the backup explicitly instead of uploading a broken file.
backup_once() {
  today="$(date -u +%F)"
  file="/tmp/velza-$today.dump"
  log "dumping the database"
  pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$DB_URL" --file="$file" || { log "pg_dump failed"; rm -f "$file"; return 1; }
  pg_restore --list "$file" >/dev/null || { log "the dump is not readable"; rm -f "$file"; return 1; }
  size="$(du -h "$file" | cut -f1)"
  aws s3 cp --only-show-errors "$file" "s3://$BUCKET/db/daily/velza-$today.dump" || { log "upload failed"; rm -f "$file"; return 1; }
  if [ "$(date -u +%d)" = "01" ]; then
    aws s3 cp --only-show-errors "$file" "s3://$BUCKET/db/monthly/velza-$today.dump" || { log "monthly upload failed"; rm -f "$file"; return 1; }
  fi
  rm -f "$file"
  log "database dump uploaded ($size)"

  if [ -d "$UPLOADS" ]; then
    aws s3 sync --only-show-errors "$UPLOADS" "s3://$BUCKET/uploads/" || { log "photo sync failed"; return 1; }
    log "photos synced"
  fi

  prune "db/daily/" "$(date -u -d "-$KEEP_DAYS days" +%F)" || log "pruning daily dumps failed (kept)"
  prune "db/monthly/" "$(date -u -d "-$KEEP_MONTHS months" +%F)" || log "pruning monthly dumps failed (kept)"

  if [ -n "${HEARTBEAT_BACKUP_URL:-}" ]; then curl -fsS -m 10 -o /dev/null "$HEARTBEAT_BACKUP_URL" || true; fi
  log "backup complete"
}

case "${1:-loop}" in
  now)
    backup_once
    ;;
  loop)
    log "started: daily backup at ${HOUR}:00 UTC to s3://$BUCKET"
    last=""
    while true; do
      if [ "$(date -u +%H)" = "$HOUR" ] && [ "$last" != "$(date -u +%F)" ]; then
        if backup_once; then last="$(date -u +%F)"; else log "BACKUP FAILED, retrying in 10 minutes"; sleep 540; fi
      fi
      sleep 60
    done
    ;;
  *)
    echo "usage: velza-backup [loop|now]" >&2
    exit 2
    ;;
esac
