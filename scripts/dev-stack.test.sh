#!/usr/bin/env bash
#
# Drive the guards of dev-stack.sh against stubs. Every refusal below is a case
# that must never reach `docker compose`, because reaching it on the laptop means
# the production application is what boots.
#
# Usage: bash scripts/dev-stack.test.sh   (exit 0 = every case behaved)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/dih-dev-stack-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/stack/scripts"

cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_DOCKER_LOG:?}"
exit 0
STUB
chmod +x "$work/bin/docker"

cp "$root/scripts/dev-stack.sh" "$work/stack/scripts/dev-stack.sh"

failed=0
note() {
  echo "FAIL $1"
  failed=1
}

# Run the script against the current fake env files and record where it landed.
run_case() {
  rm -f "$work/docker.log"
  set +e
  PATH="$work/bin:$PATH" STUB_DOCKER_LOG="$work/docker.log" \
    bash "$work/stack/scripts/dev-stack.sh" --build bot >"$work/out" 2>&1
  code=$?
  set -e
}

expect_refusal() { # case message-fragment
  run_case
  if [ "$code" -eq 0 ]; then
    note "$1: expected a refusal, script exited 0"
    return
  fi
  if ! grep -q "$2" "$work/out"; then
    note "$1: refusal did not mention '$2'"
    sed -n '1,3p' "$work/out"
  fi
  if [ -f "$work/docker.log" ]; then
    note "$1: docker was called before the refusal"
  fi
}

expect_start() { # case
  run_case
  if [ "$code" -ne 0 ]; then
    note "$1: expected a start, script exited $code"
    sed -n '1,3p' "$work/out"
    return
  fi
  want="compose -p dih-dev --env-file $work/stack/.env.dev up -d --build bot"
  if ! grep -qxF "$want" "$work/docker.log"; then
    note "$1: docker was not called with '$want'"
    sed -n '1,3p' "$work/docker.log" 2>/dev/null
  fi
}

# 1. No env file at all: the failure that started this script.
rm -f "$work/stack/.env.dev" "$work/stack/.env"
expect_refusal "missing .env.dev" "missing"

# 2. The container would read another env file, so the boot token is not the dev one.
printf '%s\n' 'ENV_FILE=.env' 'STACK_PREFIX=dih-dev' 'DISCORD_CLIENT_ID=dev-app' >"$work/stack/.env.dev"
expect_refusal "ENV_FILE points elsewhere" "ENV_FILE=.env.dev"

# 3. No prefix: container, network and volume names collide with production.
printf '%s\n' 'ENV_FILE=.env.dev' 'DISCORD_CLIENT_ID=dev-app' >"$work/stack/.env.dev"
expect_refusal "prefix unset" "STACK_PREFIX"

# 4. The production prefix spelled out is the same collision.
printf '%s\n' 'ENV_FILE=.env.dev' 'STACK_PREFIX=dee-idleclans-helper' 'DISCORD_CLIENT_ID=dev-app' >"$work/stack/.env.dev"
expect_refusal "production prefix" "production STACK_PREFIX"

# 5. The dev env carrying the production application is the 2026-11-28 incident.
printf '%s\n' 'ENV_FILE=.env.dev' 'STACK_PREFIX=dih-dev' 'DISCORD_CLIENT_ID=prod-app' >"$work/stack/.env.dev"
printf '%s\n' 'DISCORD_CLIENT_ID=prod-app' >"$work/stack/.env"
expect_refusal "production application" "production DISCORD_CLIENT_ID"

# 6. A sound dev env starts the dev stack, with the env file and project pinned.
printf '%s\n' 'ENV_FILE=.env.dev' 'STACK_PREFIX=dih-dev' 'DISCORD_CLIENT_ID=dev-app' >"$work/stack/.env.dev"
printf '%s\n' 'DISCORD_CLIENT_ID=prod-app' >"$work/stack/.env"
expect_start "valid dev env"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "dev-stack: 6 cases behaved"
