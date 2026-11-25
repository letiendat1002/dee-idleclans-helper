#!/usr/bin/env bash
#
# Deploy the bot from origin/<BRANCH> on this host.
#
# Idempotent: when origin already points at the release recorded in
# .deployed-sha the script exits without touching the stack, so a timer can call
# it on a schedule and a git push can call it from a runner.
#
# The migrations run inside the bot during startup and a failure only logs, so
# the health gate cannot see them. The schema gate below compares the newest
# migration on disk with the applied version and rolls back when they differ.
set -euo pipefail

REPO_DIR=${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
BRANCH=${BRANCH:-production}
SERVICE=${SERVICE:-bot}
# The collector runs the same image from a different entry point, so it has to
# move with the bot or it would keep polling with the previous build.
SERVICES=${SERVICES:-"bot collector"}
SHA_FILE="$REPO_DIR/.deployed-sha"

cd "$REPO_DIR"

# Each release gets its own image tag, so a restart can only ever start the build
# that was deployed, and the previous tag stays addressable for a rollback.
image_tag() { printf 'sha-%s' "${1:0:8}"; }

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# A failed release is the one event somebody must see without reading the host.
# The webhook lives in .env and is optional: without it the deploy behaves exactly
# as before. Only failures post; a tag is pushed after this script succeeded, so
# the release note from CI is what tells the channel a version went live.
notify_failure() {
  local hook text
  hook=$(grep -m1 '^DIH_UPDATES_WEBHOOK=' "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  [ -n "$hook" ] || return 0
  # shellcheck disable=SC2016  # the backticks are Discord markdown, not a substitution
  text=$(printf '**Deploy failed** · `%.8s` — %s' "$target" "$1")
  printf '{"content":"%s","allowed_mentions":{"parse":[]}}' "$text" > /tmp/dih-deploy-notify.json
  curl -fsS -m 10 -o /dev/null -H 'Content-Type: application/json' \
    --data @/tmp/dih-deploy-notify.json "$hook" || log 'release notification failed to post'
  rm -f /tmp/dih-deploy-notify.json
}

# A cron line and the systemd timer can overlap on a slow build (docker compose
# build takes minutes); the second run exits instead of racing the first.
exec 9>"${TMPDIR:-/tmp}/dee-idleclans-deploy.lock"
flock -n 9 || { log 'another deploy is running, skipping this tick'; exit 0; }

# Build the image for one commit. The deploy and the rollback both call it, so
# the two directions cannot drift, and a build that dies tells the channel
# instead of exiting before any gate could.
build_at() {
  local sha=$1
  git checkout --quiet --detach "$sha"
  npm ci
  npm run build
  IMAGE_TAG="$(image_tag "$sha")"
  export IMAGE_TAG
  docker compose build "$SERVICE"
}

# Restore the previous release and stop. Code only: the pre-deploy dump is not
# replayed automatically, because the database may have taken writes since it
# was taken and a dump that old would delete them.
rollback() {
  notify_failure "${1:-a gate failed}"
  if [ "$current" = none ]; then
    log "no previous release recorded, nothing to roll back to"
    exit 1
  fi

  log "rolling back to ${current:0:8}"
  build_at "$current" || true
  # shellcheck disable=SC2086  # two services, word splitting is the point
  docker compose up -d --wait $SERVICES || true
  log "rollback finished; inspect the stack before the next attempt"
  exit 1
}

git fetch --prune origin "$BRANCH" >/dev/null
target=$(git rev-parse "origin/$BRANCH")
current=$(cat "$SHA_FILE" 2>/dev/null || echo none)

if [ "$target" = "$current" ]; then
  log "nothing to deploy: $BRANCH is at ${target:0:8}"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "refusing to deploy: the working tree has uncommitted changes"
  exit 1
fi

# Before the first release, the branch holds no application yet, and a tick
# would otherwise take a full database dump, upload it, then die in `npm ci`.
# That is not an error, so the tick ends quietly and the next release deploys.
if ! git cat-file -e "${target}:package.json" 2>/dev/null; then
  log "nothing to deploy: ${BRANCH} has no application at ${target:0:8}"
  exit 0
fi

# The compose file reads the token from .env; a checkout without it would
# recreate the containers with no credentials.
if [ ! -f "$REPO_DIR/.env" ]; then
  log "refusing to deploy: ${REPO_DIR}/.env is missing"
  exit 1
fi

log "deploying ${target:0:8} (was ${current:0:8}) as image $(image_tag "$target")"

# A migration is the only step that can destroy data, so the backup runs first
# and a failed backup aborts the deploy.
if ! bash "$REPO_DIR/scripts/backup-db.sh"; then
  log "refusing to deploy: the pre-deploy backup failed"
  notify_failure "the pre-deploy backup failed"
  exit 1
fi

build_at "$target" || rollback "the build failed"

# shellcheck disable=SC2086  # two services, word splitting is the point
if docker compose up -d --wait $SERVICES; then
  # The healthcheck only proves the process is alive, and the bot tolerates a
  # failed migration (it logs and keeps polling), so a healthy container says
  # nothing about the schema. Ask the database itself before recording the
  # release: the newest migration on disk must be the newest one applied.
  expected=$(basename "$(printf '%s\n' "$REPO_DIR"/src/db/migrations/*.sql | sort | tail -1)" .sql)
  applied=$(docker compose exec -T postgres sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"' \
    | tr -d '[:space:]') || applied=""

  if [ "$applied" = "$expected" ]; then
    # The healthcheck only proves the process runs. Ask Discord itself so a
    # revoked or rotated token fails the release instead of the next command.
    smoke_token=$(grep -m1 '^DISCORD_TOKEN=' "$REPO_DIR/.env" | cut -d= -f2- || true)
    if ! curl -fsS -m 10 -o /dev/null -H "Authorization: Bot $smoke_token" \
        https://discord.com/api/v10/users/@me; then
      log "discord smoke failed: the API rejected the bot token"
      rollback "the Discord API rejected the bot token"
    fi
    printf '%s\n' "$target" > "$SHA_FILE"
    log "deployed ${target:0:8}"
    exit 0
  fi

  log "schema gate failed: expected ${expected}, the database reports '${applied:-none}'"
  # shellcheck disable=SC2086
  docker compose logs --tail 40 $SERVICES || true
  rollback "the schema gate failed"
fi

log "health gate failed for ${target:0:8}"
# shellcheck disable=SC2086
docker compose logs --tail 40 $SERVICES || true
rollback "the health gate failed"
