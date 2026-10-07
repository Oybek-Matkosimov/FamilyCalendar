#!/usr/bin/env bash
# Restore a Family Calendar backup.
#
# Safe drill (default): restores into a throw-away database on the same server and prints row counts,
# proving the backup is usable. Nothing in production is touched.
#   DATABASE_URL=postgres://user:pass@host:5432/familycal ./ops/restore.sh backups/familycal-20261007T020000Z.dump
#
# Real restore: replaces the contents of the target database. STOP THE APP FIRST and take a fresh backup.
#   RESTORE_TARGET_URL=postgres://user:pass@host:5432/familycal ./ops/restore.sh <dump> --into-production --yes
#
# See ops/RESTORE.md for the full procedure.
set -euo pipefail

dump="${1:-}"
[ -n "$dump" ] && [ -f "$dump" ] || { echo "usage: restore.sh <dump-file> [--into-production --yes]" >&2; exit 2; }
shift || true
production=0; yes=0
for a in "$@"; do
  case "$a" in
    --into-production) production=1 ;;
    --yes) yes=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

counts() {
  psql "$1" -At -c "select 'calendars=' || (select count(*) from calendars) || ' members=' || (select count(*) from members) || ' events=' || (select count(*) from events) || ' audit=' || (select count(*) from event_audit)"
}

pg_restore --list "$dump" >/dev/null || { log "ERROR: $dump is not a readable pg_dump custom-format file"; exit 1; }

if [ "$production" -eq 1 ]; then
  : "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL is required with --into-production}"
  [ "$yes" -eq 1 ] || { echo "Refusing to overwrite $RESTORE_TARGET_URL without --yes" >&2; exit 2; }
  log "restoring $dump INTO $RESTORE_TARGET_URL (existing objects are dropped)"
  pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction --dbname "$RESTORE_TARGET_URL" "$dump"
  log "restored. row counts: $(counts "$RESTORE_TARGET_URL")"
  log "next: run migrations (npm run db:migrate or AUTO_MIGRATE=true), start the app, check /api/health"
  exit 0
fi

: "${DATABASE_URL:?DATABASE_URL is required (used to create the scratch database on the same server)}"
scratch="familycal_restore_check_$(date -u +%s)"
admin_url="${DATABASE_URL%/*}/postgres"
scratch_url="${DATABASE_URL%/*}/$scratch"
cleanup() { psql "$admin_url" -q -c "drop database if exists \"$scratch\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "creating scratch database $scratch"
psql "$admin_url" -q -c "create database \"$scratch\""
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname "$scratch_url" "$dump"
log "backup restored OK into scratch database. row counts: $(counts "$scratch_url")"
log "scratch database dropped. This backup is usable."
