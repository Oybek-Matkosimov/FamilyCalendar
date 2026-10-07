#!/usr/bin/env bash
# Logical backup of the Family Calendar database.
#
#   DATABASE_URL=postgres://user:pass@host:5432/familycal ./ops/backup.sh
#
# What it does
#   1. pg_dump in custom format (compressed, restorable with pg_restore) into BACKUP_DIR
#   2. verifies the dump is readable (pg_restore --list) BEFORE it is kept
#   3. optionally copies it off-site to S3-compatible storage (needs the aws CLI)
#   4. applies retention: newest KEEP_DAILY dumps + the oldest dump of each of the last KEEP_MONTHLY months
#
# Requires: bash 4+, pg_dump / pg_restore (PostgreSQL client tools, same major version as the server or newer).
# Exit status is non-zero on any failure so cron / monitoring can alert on it.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAILY="${KEEP_DAILY:-30}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
S3_BUCKET="${S3_BUCKET:-}"
S3_ENDPOINT="${S3_ENDPOINT:-}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/familycal-$stamp.dump"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

log "dumping to $final"
pg_dump --format=custom --no-owner --no-privileges --file "$partial" "$DATABASE_URL"

log "verifying dump is readable"
entries="$(pg_restore --list "$partial" | grep -c . || true)"
if [ "$entries" -lt 10 ]; then
  log "ERROR: dump looks empty ($entries entries)"; exit 1
fi
mv "$partial" "$final"
trap - EXIT
size="$(wc -c < "$final" | tr -d ' ')"
log "ok: $final ($size bytes, $entries entries)"

if [ -n "$S3_BUCKET" ]; then
  command -v aws >/dev/null || { log "ERROR: S3_BUCKET set but the aws CLI is not installed"; exit 1; }
  endpoint=()
  [ -n "$S3_ENDPOINT" ] && endpoint=(--endpoint-url "$S3_ENDPOINT")
  log "uploading to s3://$S3_BUCKET/"
  aws "${endpoint[@]}" s3 cp "$final" "s3://$S3_BUCKET/$(basename "$final")" --only-show-errors
  log "uploaded"
fi

# ---- retention (local copies) ----
shopt -s nullglob
files=( "$BACKUP_DIR"/familycal-*.dump )
if [ "${#files[@]}" -gt 0 ]; then
  mapfile -t sorted < <(printf '%s\n' "${files[@]}" | sort -r)   # newest first (names sort by timestamp)
  declare -A keep=()
  i=0
  for f in "${sorted[@]}"; do
    i=$((i + 1))
    [ "$i" -le "$KEEP_DAILY" ] && keep["$f"]=1
  done
  # monthly: oldest dump in each month, for the newest KEEP_MONTHLY distinct months
  declare -A month_first=()
  declare -a months=()
  for ((j=${#sorted[@]}-1; j>=0; j--)); do            # oldest -> newest
    f="${sorted[$j]}"; b="$(basename "$f")"; m="${b:10:6}"   # familycal-YYYYMM...
    if [ -z "${month_first[$m]:-}" ]; then month_first["$m"]="$f"; months+=("$m"); fi
  done
  count=0
  for ((k=${#months[@]}-1; k>=0 && count<KEEP_MONTHLY; k--)); do
    keep["${month_first[${months[$k]}]}"]=1; count=$((count + 1))
  done
  removed=0
  for f in "${sorted[@]}"; do
    if [ -z "${keep[$f]:-}" ]; then rm -f -- "$f"; removed=$((removed + 1)); fi
  done
  log "retention: kept $(( ${#sorted[@]} - removed )), removed $removed"
fi
log "done"
