#!/usr/bin/env bash
#
# Start the dev stack, and refuse to start anything when the dev env is not the
# dev application. Both stacks run this compose file, so only the env file keeps
# them apart: on 2026-11-28 a `docker compose -p dih-dev up` without
# `--env-file .env.dev` booted the production token on the laptop against an
# empty database and registered the production commands.
#
# Usage: npm run dev:stack -- [docker compose up args]
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dev_env="$root/.env.dev"
prod_env="$root/.env"

die() {
  echo "dev-stack: $1" >&2
  exit 1
}

# Last value of a key in an env file; comments and blank lines are ignored.
read_env() {
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n 1
}

[ -f "$dev_env" ] || die "missing $dev_env"

env_file=$(read_env "$dev_env" ENV_FILE)
[ "$env_file" = ".env.dev" ] || die ".env.dev must set ENV_FILE=.env.dev (found: ${env_file:-unset})"

prefix=$(read_env "$dev_env" STACK_PREFIX)
[ -n "$prefix" ] || die ".env.dev must set STACK_PREFIX (found: unset)"
[ "$prefix" != "dee-idleclans-helper" ] || die ".env.dev must not reuse the production STACK_PREFIX"

dev_app=$(read_env "$dev_env" DISCORD_CLIENT_ID)
[ -n "$dev_app" ] || die ".env.dev has no DISCORD_CLIENT_ID"

if [ -f "$prod_env" ]; then
  prod_app=$(read_env "$prod_env" DISCORD_CLIENT_ID)
  [ "$dev_app" != "$prod_app" ] ||
    die ".env.dev carries the production DISCORD_CLIENT_ID; refusing to start"
fi

exec docker compose -p "$prefix" --env-file "$dev_env" up -d "$@"
