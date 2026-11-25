#!/usr/bin/env bash
#
# Drive the failure paths of deploy.sh against stubs: a gate that rolls back
# without telling anyone, or a step that dies before a gate runs, is invisible on
# the host until the release is already broken. Nothing here touches Docker, the
# network, or the real checkout — the repo is cloned into a temp dir, the backup
# script is replaced by a no-op commit, and `docker`/`curl`/`npm` are stubs.
#
# Usage: bash scripts/deploy.failure.test.sh   (exit 0 = every case behaved)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/dih-deploy-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/tmp"
stubs="$work/bin"

cat >"$stubs/docker" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = compose ]; then
  case "${2:-}" in
    build) if [ "${STUB_FAIL:-}" = build ]; then echo 'stub: build failed' >&2; exit 1; fi ;;
    up)    if [ "${STUB_FAIL:-}" = up ];    then echo 'stub: up failed' >&2;    exit 1; fi ;;
    exec)  printf '%s\n' "${STUB_SCHEMA:-}"; exit 0 ;;
  esac
fi
exit 0
STUB

# The webhook body arrives as `--data @file`, so the stub has to copy the payload,
# not just the arguments, into the log the cases assert on.
cat >"$stubs/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    @*) [ -f "${arg#@}" ] && cat "${arg#@}" >>"${STUB_CURL_LOG:?}" ;;
  esac
done
printf '\n' >>"${STUB_CURL_LOG:?}"
exit 0
STUB

cat >"$stubs/npm" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$stubs"/*

# A bare origin built from this commit: the tree under test is what a release
# would deploy, and the cases must never reach the network.
stage="$work/stage"
mkdir -p "$stage"
git -C "$root" archive HEAD | tar -x -C "$stage"
printf '#!/usr/bin/env bash\nexit 0\n' >"$stage/scripts/backup-db.sh"
git -C "$stage" init -q -b develop
git -C "$stage" add -A
git -C "$stage" -c user.email=t@example.invalid -c user.name=test commit -qm 'fixture: release tree'
origin="$work/origin"
git init -q --bare "$origin"
git -C "$stage" push -q "$origin" develop:refs/heads/develop develop:refs/heads/production
git -C "$origin" symbolic-ref HEAD refs/heads/develop

status=0
run_case() { # <name> <text the webhook must carry> [env assignment ...]
  local name=$1 reason=$2
  shift 2
  local dir="$work/$name" out="$work/$name.log" hook="$work/$name.hook" before after rc
  git clone -q "$origin" "$dir"
  # One commit ahead of origin/production, so the deploy has something to move from.
  git -C "$dir" -c user.email=t@example.invalid -c user.name=test commit -q --allow-empty -m 'fixture: previous release'
  printf 'DISCORD_TOKEN=stub\nDIH_UPDATES_WEBHOOK=https://example.invalid/hook\n' >"$dir/.env"
  before=$(git -C "$dir" rev-parse HEAD)
  printf '%s\n' "$before" >"$dir/.deployed-sha"
  : >"$hook"

  set +e
  ( cd "$dir" && env PATH="$stubs:$PATH" TMPDIR="$work/tmp" REPO_DIR="$dir" STUB_CURL_LOG="$hook" \
      "$@" bash scripts/deploy.sh ) >"$out" 2>&1
  rc=$?
  set -e

  after=$(cat "$dir/.deployed-sha")
  if [ "$rc" -eq 0 ]; then
    echo "FAIL $name: exited 0"
    status=1
    return
  fi
  if [ "$after" != "$before" ]; then
    echo "FAIL $name: recorded a release despite failing"
    status=1
    return
  fi
  if ! grep -qF "$reason" "$hook"; then
    echo "FAIL $name: the webhook never said '$reason'"
    sed 's/^/    /' "$out" | tail -6
    status=1
    return
  fi
  echo "ok   $name: exited $rc, notified '$reason', release not recorded"
}

run_case build 'the build failed' STUB_FAIL=build
run_case health 'the health gate failed' STUB_FAIL=up
run_case schema 'the schema gate failed' STUB_SCHEMA=012_vault_deliveries

[ "$status" -eq 0 ] || echo 'deploy failure paths: see the FAIL lines above'
exit "$status"
