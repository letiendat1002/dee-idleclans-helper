#!/usr/bin/env bash
#
# Restore the newest backup into a scratch database and report what came back.
#
# A backup nobody restored is a guess. This runs the real dump through the real
# server, checks that the tables the bot depends on came back with rows, and drops
# the scratch database again. Run it monthly (docs/GITHUB-SETUP.md, OPERATIONS).
#
# Usage: scripts/restore-drill.sh [dump.sql.gz]
#   With no argument the newest local dump in $BACKUP_DIR is used. Set
#   DRILL_FROM_REMOTE=1 to copy the newest remote dump down first.
set -euo pipefail

CONTAINER=${CONTAINER:-dee-idleclans-helper-postgres}
DB_USER=${DB_USER:-idleclans}
DB_NAME=${DB_NAME:-idleclans_drill}
BACKUP_DIR=${BACKUP_DIR:-$HOME/backups/idleclans}
KEEP_DRILL=${KEEP_DRILL:-0}

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

dump=${1:-}
if [ "${DRILL_FROM_REMOTE:-0}" = "1" ]; then
  : "${RCLONE_REMOTE:?RCLONE_REMOTE is not set}"
  mkdir -p "$BACKUP_DIR/drill"
  rclone copy "$RCLONE_REMOTE/daily" "$BACKUP_DIR/drill" \
    --include "idleclans-*.sql.gz" --max-age 7d --log-level ERROR
  BACKUP_DIR="$BACKUP_DIR/drill"
fi
if [ -z "$dump" ]; then
  # shellcheck disable=SC2012  # dump names are generated, not user input
  dump=$(ls -1t "$BACKUP_DIR"/idleclans-*.sql.gz 2>/dev/null | head -1 || true)
fi
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  log "FAIL no dump found in $BACKUP_DIR"
  exit 1
fi

log "checking $dump"
gzip -t "$dump"

# The dump is piped in, never written to disk again: a 19 MB gunzip is cheap but
# the /tmp copy is not worth the disk on the host that also holds the database.
log "restoring into $DB_NAME"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" -c "CREATE DATABASE \"$DB_NAME\";"
gunzip -c "$dump" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -q \
  -v ON_ERROR_STOP=1 -o /dev/null

# Exact counts, not pg_stat estimates: a fresh restore has no statistics yet and
# would read zero for every table.
count() {
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT count(*) FROM $1;"
}
items=$(count items)
snapshots=$(count price_snapshots)
migrations=$(count schema_migrations)
log "restored: items=$items price_snapshots=$snapshots schema_migrations=$migrations"

fail=0
for pair in "items:$items" "price_snapshots:$snapshots" "schema_migrations:$migrations"; do
  name=${pair%%:*}; count=${pair#*:}
  if [ "${count:-0}" -gt 0 ] 2>/dev/null; then
    log "  ok $name=$count"
  else
    log "  FAIL $name is empty"
    fail=1
  fi
done

if [ "$KEEP_DRILL" != "1" ]; then
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -q \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
  log "drill database dropped"
else
  log "drill database kept, drop it with: DROP DATABASE \"$DB_NAME\";"
fi

[ "$fail" = "0" ] || exit 1
log "restore drill passed"
