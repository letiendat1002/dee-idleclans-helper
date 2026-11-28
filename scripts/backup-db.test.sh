#!/usr/bin/env bash
#
# Drive the failure paths of backup-db.sh against stubs. A dump that fails, or
# one that writes a truncated gzip and calls it today's backup, is only noticed
# the day a restore is needed -- and by then the good copy is gone.
#
# Nothing here touches Docker, the network, rclone or the real backup directory:
# `docker`, `rclone` and `curl` are stubs and BACKUP_DIR points into a temp dir.
#
# Usage: bash scripts/backup-db.test.sh   (exit 0 = every case behaved)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/dih-backup-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/backups"
stubs="$work/bin"

cat >"$stubs/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_DOCKER_LOG:?}"
case "${STUB_DUMP_MODE:-ok}" in
  fail) echo 'stub: pg_dump failed' >&2; exit 1 ;;
esac
printf 'fake dump of %s\n' "${*: -1}"
STUB

cat >"$stubs/rclone" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_RCLONE_LOG:?}"
exit 0
STUB

cat >"$stubs/curl" <<'STUB'
#!/usr/bin/env bash
[ "${STUB_CURL_OK:-0}" = 1 ] || exit 22
exit 0
STUB
chmod +x "$stubs"/*

failed=0
note() {
  echo "FAIL $1"
  failed=1
}

# One run of the real script against the stubs, with the temp backup dir.
run() {
  set +e
  PATH="${RUN_PATH:-$stubs:$PATH}" \
    BACKUP_DIR="$work/backups" \
    STUB_DOCKER_LOG="$work/docker.log" \
    STUB_RCLONE_LOG="$work/rclone.log" \
    bash "$root/scripts/backup-db.sh" >"$work/out" 2>&1
  code=$?
  set -e
}

reset() {
  rm -rf "$work/backups" "$work/docker.log" "$work/rclone.log" "$work/out"
  mkdir -p "$work/backups"
}

today="$work/backups/idleclans-$(date +%F).sql.gz"

# 1. A failing dump must not leave a file that looks like today's backup.
reset
STUB_DUMP_MODE=fail run
if [ "$code" -eq 0 ]; then note "failing dump: exited 0"; fi
[ -e "$today" ] && note "failing dump: wrote $today"
ls "$work"/backups/*.part >/dev/null 2>&1 && note "failing dump: left a .part"

# 3. The happy path writes a gzip that verifies.
reset
run
if [ "$code" -ne 0 ]; then
  note "good dump: exited $code"
  sed -n '1,3p' "$work/out"
fi
if [ ! -e "$today" ]; then
  note "good dump: $today missing"
elif ! gzip -t "$today" 2>/dev/null; then
  note "good dump: file is not valid gzip"
fi

# 4. The rolling window keeps KEEP files and drops the rest.
reset
for day in 01 02 03 04 05 06 07 08 09; do
  printf 'old\n' | gzip >"$work/backups/idleclans-2026-01-$day.sql.gz"
  touch -d "2026-01-$day 00:00" "$work/backups/idleclans-2026-01-$day.sql.gz"
done
run
kept=$(find "$work/backups" -name 'idleclans-*.sql.gz' | wc -l)
[ "$kept" -eq 7 ] || note "retention: kept $kept files, expected 7"
[ -e "$work/backups/idleclans-2026-01-01.sql.gz" ] && note "retention: kept the oldest file"

# 5. The monthly archive is written once, not every hour.
reset
run
archive="$work/backups/price_daily-$(date +%Y-%m).sql.gz"
if [ ! -e "$archive" ]; then
  note "archive: $archive missing after the first run"
else
  before=$(stat -c %Y "$archive")
  sleep 1
  run
  after=$(stat -c %Y "$archive")
  [ "$before" = "$after" ] || note "archive: rewritten on the second run of the same month"
fi

# 6. An off-site remote without rclone warns and still finishes.
reset
# A PATH built by hand: rclone may well be installed next to the real coreutils.
mkdir -p "$work/bin-bare"
for tool in bash mkdir date gzip mv ls tail xargs rm du; do
  ln -sf "$(command -v "$tool")" "$work/bin-bare/$tool"
done
cp "$stubs/docker" "$stubs/curl" "$work/bin-bare/"
RUN_PATH="$work/bin-bare" RCLONE_REMOTE=b2:bucket run
if [ "$code" -ne 0 ]; then note "rclone missing: exited $code"; fi
grep -q 'WARN RCLONE_REMOTE is set but rclone is not installed' "$work/out" ||
  note "rclone missing: no warning"

# 7. With rclone present the archive, today's dump and the old daily copies are handled.
reset
RCLONE_REMOTE=b2:bucket run
if [ "$code" -ne 0 ]; then note "rclone upload: exited $code"; fi
grep -q 'copy .*price_daily-.* b2:bucket' "$work/rclone.log" || note "rclone upload: archive not copied"
grep -q 'copy .*idleclans-.* b2:bucket/daily' "$work/rclone.log" || note "rclone upload: daily not copied"
grep -q 'delete b2:bucket/daily --min-age 30d' "$work/rclone.log" || note "rclone upload: old dailies not pruned"

# 8. A dead-man ping that fails is a warning, not a failed backup.
reset
HEALTHCHECK_URL=https://example.invalid/ping STUB_CURL_OK=0 run
if [ "$code" -ne 0 ]; then note "healthcheck down: exited $code"; fi
grep -q 'WARN healthcheck ping failed' "$work/out" || note "healthcheck down: no warning"

# 9. A ping that lands is reported.
reset
HEALTHCHECK_URL=https://example.invalid/ping STUB_CURL_OK=1 run
grep -q 'healthcheck pinged' "$work/out" || note "healthcheck up: not reported"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "backup-db: 8 cases behaved"
