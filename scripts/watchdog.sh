#!/usr/bin/env bash
#
# Restart the bot when Docker reports it unhealthy.
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

# shellcheck disable=SC2086  # space separated list, word splitting is the point
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

# Backup freshness. If cron dies nothing else notices: the local dumps and the
# B2 copy both stop updating, and the first sign would be a restore that is a
# month short. A stale dump is reported once per 12h, by DM when an alert target
# is configured.
BACKUP_DIR=${BACKUP_DIR:-$HOME/backups/idleclans}
MAX_AGE_H=${MAX_AGE_H:-26}
ALERT_ENV=${ALERT_ENV:-$HOME/.config/idleclans/watchdog-alert.env}

# shellcheck disable=SC2012  # dump names are generated, not user input
newest=$(ls -1t "$BACKUP_DIR"/idleclans-*.sql.gz 2>/dev/null | head -1 || true)
age_h=99999
if [ -n "$newest" ]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
fi

if [ "$age_h" -gt "$MAX_AGE_H" ]; then
  echo "$(date -Is) WARN newest backup is ${age_h}h old (limit ${MAX_AGE_H}h): ${newest:-none}"
  # shellcheck disable=SC1090
  [ -r "$ALERT_ENV" ] && . "$ALERT_ENV"
  stamp="$BACKUP_DIR/.alert-stamp"
  if [ -n "${ALERT_DISCORD_USER:-}" ] && [ -f "$REPO_DIR/.env" ] &&
     { [ ! -f "$stamp" ] || [ $(( $(date +%s) - $(stat -c %Y "$stamp") )) -gt 43200 ]; }; then
    token=$(grep -m1 '^DISCORD_TOKEN=' "$REPO_DIR/.env" | cut -d= -f2-)
    dm=$(curl -sS -m 10 -H "Authorization: Bot $token" -H 'Content-Type: application/json' \
      -d "{\"recipient_id\":\"$ALERT_DISCORD_USER\"}" \
      https://discord.com/api/v10/users/@me/channels | sed -n 's/.*"id": *"\([0-9]*\)".*/\1/p')
    if [ -n "$dm" ]; then
      curl -sS -m 10 -o /dev/null -H "Authorization: Bot $token" -H 'Content-Type: application/json' \
        -d "{\"content\":\"BACKUP STALE on $(hostname): newest dump is ${age_h}h old (limit ${MAX_AGE_H}h).\"}" \
        "https://discord.com/api/v10/channels/$dm/messages" && touch "$stamp"
      echo "$(date -Is) stale-backup alert sent to $ALERT_DISCORD_USER"
    else
      echo "$(date -Is) WARN could not open a DM channel for $ALERT_DISCORD_USER"
    fi
  fi
fi
