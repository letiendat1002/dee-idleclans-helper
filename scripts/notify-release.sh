#!/usr/bin/env bash
#
# Post the release note of this tag to the updates webhook.
#
# Runs from the release-notify workflow on a v* tag. The tag is pushed after the
# host has deployed, so a tag means "this is live"; there is no deploy step here.
#
# Silent by default: without DIH_UPDATES_WEBHOOK (a repository secret) the script
# prints why and exits 0, so forks and a repo that has not created the webhook yet
# still get a green run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version=$(node -p "require('./package.json').version")
tag=${GITHUB_REF_NAME:-v$version}
hook=${DIH_UPDATES_WEBHOOK:-}
role=${DIH_RELEASE_ROLE_ID:-}

# A pre-release tag is staging: version-guard does not require a manifest match,
# and nothing was announced for it.
if [[ "$tag" == *-* ]]; then
  echo "pre-release $tag: no announcement"
  exit 0
fi

if [ -z "$hook" ]; then
  echo "DIH_UPDATES_WEBHOOK is not set: skipping the note for $tag"
  exit 0
fi

# The section of this version is the note; it stops at the next "## [" heading.
# Discord caps a message at 2000 characters, so the body is cut well below it.
# Only whole lines are kept: a note that stops mid-sentence reads like a bug.
body=$(awk -v v="$version" -v max=1400 '
  $0 ~ "^## \\[" v "\\]" { found = 1; next }
  found && /^## \[/ { exit }
  found && /^[[:space:]]*$/ { next }
  found {
    if (len + length($0) + 1 > max) { print "..."; exit }
    print
    len += length($0) + 1
  }
' CHANGELOG.md)

if [ -z "$body" ]; then
  echo "CHANGELOG.md has no body for $version: sending the version line only"
fi

# shellcheck disable=SC2016  # the template literals belong to node, not to bash
payload=$(
  TAG="$tag" BODY="$body" ROLE="$role" node -e '
    const roles = process.env.ROLE ? [process.env.ROLE] : [];
    const mention = roles.length ? `<@&${roles[0]}> ` : "";
    const content = `${mention}**${process.env.TAG}**\n${process.env.BODY}`.slice(0, 1990);
    process.stdout.write(JSON.stringify({ content, allowed_mentions: { parse: [], roles } }));
  '
)

echo "posting the note for $tag"
curl -fsS -m 15 -o /dev/null \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "${hook}?wait=true"
