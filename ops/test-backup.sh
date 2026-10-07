#!/usr/bin/env bash
# Regression test for ops/backup.sh using stub pg_dump / pg_restore / aws programs (no database needed).
#   bash ops/test-backup.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/b"
cat > "$T/bin/pg_dump" <<'EOS'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --file) f="$2"; shift 2;; *) shift;; esac; done
for i in $(seq 1 30); do echo "entry $i"; done > "$f"
EOS
cat > "$T/bin/pg_restore" <<'EOS'
#!/usr/bin/env bash
for i in $(seq 1 20); do echo "; entry $i"; done
EOS
cat > "$T/bin/aws" <<'EOS'
#!/usr/bin/env bash
exit "${FAKE_AWS_EXIT:-0}"
EOS
chmod +x "$T"/bin/*
export PATH="$T/bin:$PATH" DATABASE_URL=postgres://stub BACKUP_DIR="$T/b" KEEP_DAILY=5 KEEP_MONTHLY=3
fail() { echo "FAIL: $*" >&2; exit 1; }

# 100 daily dumps before 2026-10-06
for d in $(seq 1 100); do ts=$(date -u -d "2026-10-06 - $d days" +%Y%m%d); echo x > "$T/b/familycal-${ts}T020000Z.dump"; done

bash "$here/backup.sh" >/dev/null
left=$(ls "$T/b" | wc -l | tr -d ' ')
[ "$left" -eq 8 ] || fail "retention kept $left files, expected 8 (5 newest + oldest of 3 months)"
for m in 20260801 20260901 20261001; do ls "$T/b" | grep -q "familycal-${m}T" || fail "monthly keeper $m missing"; done
echo "ok: retention keeps the newest 5 and the oldest dump of each of the last 3 months"

# a failing upload must not skip retention, and must be reported
for d in $(seq 1 12); do echo x > "$T/b/familycal-2026100$((d % 9 + 1))T0${d}0000Z.dump" 2>/dev/null || true; done
before=$(ls "$T/b" | wc -l | tr -d ' ')
if S3_BUCKET=bucket FAKE_AWS_EXIT=1 bash "$here/backup.sh" >/dev/null 2>&1; then fail "a failed upload must make backup.sh exit non-zero"; fi
after=$(ls "$T/b" | wc -l | tr -d ' ')
[ "$after" -lt "$before" ] || fail "retention was skipped after a failed upload ($before -> $after files)"
echo "ok: failed upload is reported (non-zero exit) and retention still ran"

# an empty dump is refused and leaves no partial file
cat > "$T/bin/pg_restore" <<'EOS'
#!/usr/bin/env bash
echo "; only one line"
EOS
if bash "$here/backup.sh" >/dev/null 2>&1; then fail "an empty-looking dump must be rejected"; fi
ls "$T/b" | grep -q partial && fail "partial file left behind"
echo "ok: suspiciously small dumps are rejected"
echo "all backup checks passed"
