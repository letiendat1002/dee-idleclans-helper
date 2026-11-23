#!/usr/bin/env bash
#
# Restart the bot when Docker reports it unhealthy, and shout when a backup
# stops arriving.
#
# `restart: unless-stopped` covers a process that exits, not one that wedges: a
# bot whose event loop stalls keeps running and stays unhealthy forever, and only
# a restart clears it. A healthy stack is left alone.
set -euo pipefail

REPO_DIR=${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
# The bot and the collector each have their own healthcheck, so a wedged
# poller must not keep the bot alive (or the other way round).
SERVICES=${SERVICES:-"bot collector"}

cd "$REPO_DIR"

for service in $SERVICES; do
  container=$(docker compose ps -q "$service")
  if [ -z "$container" ]; then
    echo "$(date -Is) no container for $service, nothing to watch"
    continue
  fi

  state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
  if [ "$state" = unhealthy ]; then
    echo "$(date -Is) $service is unhealthy, restarting"
    docker compose restart "$service"
  fi
done

BACKUP_DIR=${BACKUP_DIR:-$HOME/backups/idleclans}
MAX_AGE_H=${MAX_AGE_H:-26}
MAX_AGE_H_REMOTE=${MAX_AGE_H_REMOTE:-30}
ALERT_ENV=${ALERT_ENV:-$HOME/.config/idleclans/watchdog-alert.env}
ALERT_STAMP=${ALERT_STAMP:-$BACKUP_DIR/.alert-stamp}
# One DM per 12h across every condition: a flare-up must not become a stream.
ALERT_COOLDOWN_S=${ALERT_COOLDOWN_S:-43200}

# Send one DM to the configured user, or say why it was not sent. Never fails
# the run: a broken alert channel must not stop the restart loop above.
send_alert() {
  local text=$1 token dm
  # shellcheck disable=SC1090
  [ -r "$ALERT_ENV" ] && . "$ALERT_ENV"
  if [ -z "${ALERT_DISCORD_USER:-}" ] || [ ! -f "$REPO_DIR/.env" ]; then
    echo "$(date -Is) WARN no alert target configured, not sent: $text"
    return 0
  fi
  if [ -f "$ALERT_STAMP" ] &&
     [ $(( $(date +%s) - $(stat -c %Y "$ALERT_STAMP") )) -lt "$ALERT_COOLDOWN_S" ]; then
    echo "$(date -Is) alert held back (one per ${ALERT_COOLDOWN_S}s): $text"
    return 0
  fi

  token=$(grep -m1 '^DISCORD_TOKEN=' "$REPO_DIR/.env" | cut -d= -f2-)
  dm=$(curl -sS -m 10 -H "Authorization: Bot $token" -H 'Content-Type: application/json' \
    -d "{\"recipient_id\":\"$ALERT_DISCORD_USER\"}" \
    https://discord.com/api/v10/users/@me/channels | sed -n 's/.*"id": *"\([0-9]*\)".*/\1/p')
  if [ -z "$dm" ]; then
    echo "$(date -Is) WARN could not open a DM channel for $ALERT_DISCORD_USER"
    return 0
  fi

  if curl -sS -m 10 -o /dev/null -H "Authorization: Bot $token" -H 'Content-Type: application/json' \
      -d "{\"content\":\"$text\"}" "https://discord.com/api/v10/channels/$dm/messages"; then
    touch "$ALERT_STAMP"
    echo "$(date -Is) alert sent to $ALERT_DISCORD_USER: $text"
  else
    echo "$(date -Is) WARN alert POST failed"
  fi
}

# Local dumps. If cron dies nothing else notices: the local dumps and the B2 copy
# both stop updating, and the first sign would be a restore that is a month short.
# shellcheck disable=SC2012  # dump names are generated, not user input
newest=$(ls -1t "$BACKUP_DIR"/idleclans-*.sql.gz 2>/dev/null | head -1 || true)
age_h=99999
if [ -n "$newest" ]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
fi
if [ "$age_h" -gt "$MAX_AGE_H" ]; then
  echo "$(date -Is) WARN newest backup is ${age_h}h old (limit ${MAX_AGE_H}h): ${newest:-none}"
  send_alert "BACKUP STALE on $(hostname): newest dump is ${age_h}h old (limit ${MAX_AGE_H}h)."
fi

# Off-site copy. A fresh local dump plus a failing upload looks like a healthy
# backup right up to the moment the disk dies, so freshness is checked on the
# remote independently of the local file.
if [ -n "${RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    remote_newest=$(rclone lsjson "$RCLONE_REMOTE/daily" 2>/dev/null \
      | tr ',' '\n' | sed -n 's/.*"ModTime":"\([^"]*\)".*/\1/p' | sort | tail -1 || true)
    if [ -z "$remote_newest" ]; then
      echo "$(date -Is) WARN nothing under $RCLONE_REMOTE/daily"
      send_alert "OFF-SITE BACKUP EMPTY on $(hostname): nothing under $RCLONE_REMOTE/daily."
    else
      remote_age_h=99999
      if remote_epoch=$(date -d "$remote_newest" +%s 2>/dev/null); then
        remote_age_h=$(( ($(date +%s) - remote_epoch) / 3600 ))
      fi
      if [ "$remote_age_h" -gt "$MAX_AGE_H_REMOTE" ]; then
        echo "$(date -Is) WARN newest remote dump is ${remote_age_h}h old (limit ${MAX_AGE_H_REMOTE}h): $remote_newest"
        send_alert "OFF-SITE BACKUP STALE on $(hostname): newest remote dump is ${remote_age_h}h old (limit ${MAX_AGE_H_REMOTE}h)."
      fi
    fi
  else
    echo "$(date -Is) WARN RCLONE_REMOTE is set but rclone is missing; off-site freshness not checked"
  fi
fi

# Restore drill. A dump nobody restored is a guess, so a passing drill leaves a
# stamp; a stamp that stops advancing is the failure this catches.
DRILL_MAX_AGE_D=${DRILL_MAX_AGE_D:-45}
drill_ref="$BACKUP_DIR/.last-drill"
if [ ! -f "$drill_ref" ]; then
  # No passing drill yet, which on a fresh host is the normal state for weeks.
  # Measure from the newest dump so the clock starts when the backup regime did;
  # a host that keeps backing up but never drills still trips the limit later.
  # shellcheck disable=SC2012  # dump names are generated, not user input
  drill_ref=$(ls -1t "$BACKUP_DIR"/idleclans-*.sql.gz 2>/dev/null | head -1 || true)
fi
if [ -n "$drill_ref" ] && [ -f "$drill_ref" ]; then
  drill_age_d=$(( ($(date +%s) - $(stat -c %Y "$drill_ref")) / 86400 ))
else
  drill_age_d=0
fi
if [ "$drill_age_d" -gt "$DRILL_MAX_AGE_D" ]; then
  echo "$(date -Is) WARN last restore drill was ${drill_age_d} days ago (limit ${DRILL_MAX_AGE_D})"
  send_alert "RESTORE DRILL OVERDUE on $(hostname): last passing drill was ${drill_age_d} days ago (limit ${DRILL_MAX_AGE_D})."
fi
