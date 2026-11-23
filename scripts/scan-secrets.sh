#!/usr/bin/env bash
#
# Fails when a tracked file holds a credential or an operator path.
#
# Two jobs in one command because they fail the same way and both must run before
# a push: gitleaks (or a grep fallback) for secrets, and a path guard for the
# names that must never appear in a public repository.
#
# Only tracked files are read. `.env`, `bot.log` and tool caches are ignored on
# purpose — they hold the real values this check exists to keep out of the tree.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

status=0

# The scanners themselves name the patterns they look for; skip them so they do
# not match their own source.
tracked() {
  git ls-files -z | grep -zv -e '^scripts/scan-secrets.sh$' -e '^gitleaks.toml$' || true
}

if command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks: scanning the working tree"
  gitleaks detect --no-git --redact --config gitleaks.toml --source . || status=1
else
  echo "gitleaks: not installed, using the grep fallback"
  if tracked | xargs -0 grep -IE '[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}' --; then
    echo "a Discord token shape is tracked" >&2
    status=1
  fi
  if tracked | xargs -0 grep -IE 'K00[0-9a-zA-Z]{20,}' --; then
    echo "a Backblaze key id shape is tracked" >&2
    status=1
  fi
fi

# Operator paths: any absolute home, the deploy checkout, the backup bucket and
# the test guild. None of them is a secret, all of them point at the operator.
# The GitHub handle in package.json and FUNDING.yml is the repository's owner and
# is public by construction, so it is not matched here.
if tracked | xargs -0 grep -IE '/home/[a-z0-9_-]+/|/opt/dee-idleclans|b2:discord-bot-dih|1179062402' --; then
  echo "an operator path is tracked" >&2
  status=1
fi

if [ "$status" -ne 0 ]; then
  echo "scan-secrets: FAILED" >&2
  exit 1
fi

echo "scan-secrets: clean"
