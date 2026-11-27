#!/usr/bin/env bash
# Step 5 (only if damage photos exist on a disk) — copy them to S3 and record them in attachments.
# The Vercel test site keeps photos in /tmp, which is temporary, so for the Supabase test data there is usually
# nothing to copy. Use this for a server that kept VELZA_UPLOAD_DIR on disk (e.g. the Lightsail pilot).
#
#   UPLOAD_DIR=/srv/velza/uploads BUCKET=velza-prod-media TARGET_URL='postgresql://velza_owner:…/velza' \
#     ./migration/05_upload_photos.sh
#
# Files today: <UPLOAD_DIR>/damage/<report id>.<jpg|png|webp> (barcode photo) and <report id>.<n>.<ext> (photo n).
# S3 key:      damage/<yyyy>/<mm>/<report uuid>/<n>.<ext>   (n = 0 for the barcode photo)
# The report id in a file name is the DAMAGED movement's old event id. It is mapped to the report's uuid with the same
# rule as 03_transform.sql (a UUID stays as it is, anything else becomes md5(id)::uuid), so files of hand-made test
# reports are found too (review issue 8). attachment_id is made by the table's default; a photo already recorded for
# the same report and position (report_id, seq) is skipped, so the script is safe to re-run.
# Only reports that exist in damage_reports are copied.
set -euo pipefail
: "${UPLOAD_DIR:?}"; : "${BUCKET:?}"; : "${TARGET_URL:?}"
shopt -s nullglob
declare -A TYPES=([jpg]=image/jpeg [png]=image/png [webp]=image/webp)

for f in "$UPLOAD_DIR"/damage/*; do
  name=$(basename "$f")
  if [[ "$name" =~ ^(.+)\.([1-4])\.(jpg|png|webp)$ ]]; then id=${BASH_REMATCH[1]}; seq=${BASH_REMATCH[2]}; ext=${BASH_REMATCH[3]}; kind=DAMAGE_PHOTO
  elif [[ "$name" =~ ^(.+)\.(jpg|png|webp)$ ]];        then id=${BASH_REMATCH[1]}; seq=0;                 ext=${BASH_REMATCH[2]}; kind=BARCODE_PHOTO
  else echo "skip (unknown name): $name"; continue; fi

  found=$(psql "$TARGET_URL" -XAt -F ' ' -v id="$id" <<'SQL'
SELECT report_id, to_char(reported_at AT TIME ZONE 'Asia/Kolkata', 'YYYY/MM') FROM damage_reports
 WHERE report_id = CASE WHEN :'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN :'id'::uuid ELSE md5(:'id')::uuid END;
SQL
)
  [[ -z "$found" ]] && { echo "skip (no damage report $id): $name"; continue; }
  report="${found%% *}"; ym="${found#* }"

  key="damage/$ym/$report/$seq.$ext"
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  size=$(stat -c %s "$f")
  aws s3 cp "$f" "s3://$BUCKET/$key" --content-type "${TYPES[$ext]}" --only-show-errors \
     --metadata "sha256=$sha" --sse AES256
  psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 -v report="$report" -v seq="$seq" -v kind="$kind" -v key="$key" \
       -v ctype="${TYPES[$ext]}" -v size="$size" -v sha="$sha" <<'SQL'
INSERT INTO attachments (report_id, kind, seq, storage_key, content_type, size_bytes, sha256, uploaded_at)
VALUES (:'report'::uuid, :'kind', :'seq'::smallint, :'key', :'ctype', :'size'::integer, :'sha', now())
ON CONFLICT (report_id, seq) DO NOTHING;
SQL
  echo "copied $name -> s3://$BUCKET/$key"
done
