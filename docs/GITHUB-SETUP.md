# GitHub setup

The repository is public, so its settings are part of the product: a fork must be
able to build, and a leak must be stopped before it lands. Every setting below is
something a maintainer can check or restore.

## Repository

| Setting | Value | Why |
| --- | --- | --- |
| Visibility | public | free standard runners, and secret scanning is only available here |
| Default branch | `production` | visitors land on what actually runs |
| Issues | on | the only support channel besides Discord |
| Wiki, projects, discussions | off | unused surfaces go stale and appear in search |
| Topics | `discord-bot`, `idleclans`, `market-data`, `postgresql`, `typescript` | discovery |
| Merge | squash only, linear history, delete branch on merge | one commit per change, no merge bubbles |
| Auto-merge | on | Dependabot patches can land without a click once checks pass |

## Branch protection

Both `develop` and `production` are protected identically. Administrator
enforcement is on, so the rules apply to the maintainer too.

| Rule | Value |
| --- | --- |
| Required checks | `check` (tests) and `scan` (gitleaks), strict — the branch must be up to date |
| Pull request | required, **0 approvals** — a single maintainer cannot approve their own PR |
| Enforce for admins | on |
| Linear history | on |
| Force push / branch deletion | blocked |
| Conversation resolution | required |

`version-guard` and `docker smoke` are deliberately **not** required: the first
only runs on tags and on PRs touching the version, the second only when the image
inputs change. Requiring a check that does not run on every PR blocks the PR
forever.

## Security

| Setting | Value |
| --- | --- |
| Secret scanning | enabled, with push protection |
| Dependabot alerts + security updates | enabled |
| Actions token default | read-only (`contents: read` in each workflow as well) |
| Action pinning | every `uses:` is a full commit SHA with the release in a comment |

There is no `GITLEAKS_LICENSE`: `gitleaks-action` is free for a personal account
and only asks for a licence inside an organization.

## Dependabot

`.github/dependabot.yml` runs weekly for npm and for GitHub Actions, against
`develop` — **not** the default branch. A pull request against `production` would
put an unreleased bump straight into the branch the host deploys.

- `@types/node` majors are ignored on purpose: the runtime is Node 22
  (`Dockerfile`, `engines`, CI), so types for a newer runtime would compile code
  the image cannot execute. Bump it together with the runtime, never before it.
- A patch bump that a package and its provider share (`vitest` and
  `@vitest/coverage-v8`) has to land together; merging one alone leaves a peer
  requirement unsatisfied.
- npm and action majors get read before they are merged: `ioredis` 6 switched the
  default wire protocol to RESP3, `actions/checkout` 7 changed its runtime. The
  test suite covers the first (real Redis 7 in CI); the second is exercised by
  the workflow itself.

## Restoring the settings

```bash
SLUG=letiendat1002/dee-idleclans-helper

# `gh repo edit` has no flag for turning the wiki or projects off in every gh
# release, so those go through the API with the security settings.
gh repo edit "$SLUG" --default-branch production --enable-issues \
  --enable-squash-merge --delete-branch-on-merge

gh api -X PATCH "repos/$SLUG" --input - <<'JSON'
{ "has_wiki": false, "has_projects": false, "has_discussions": false, "allow_auto_merge": true,
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON

gh api -X PUT "repos/$SLUG/actions/permissions" --input - <<'JSON'
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": true }
JSON
gh api -X PUT "repos/$SLUG/actions/permissions/workflow" \
  -f default_workflow_permissions=read >/dev/null

for b in develop production; do
  gh api -X PUT "repos/$SLUG/branches/$b/protection" --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["check", "scan"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null, "required_linear_history": true,
  "allow_force_pushes": false, "allow_deletions": false,
  "required_conversation_resolution": true }
JSON
done
```

## A note on the old history

The repository was recreated on 2026-11-23 with a single root commit. Operator
notes, legal drafts, the vendor API description and the marketing assets had been
in the previous history and are now kept outside the repository. That is why this
tree has one commit: the alternative was a history rewrite that leaves unreachable
objects behind.
