# Contributing

The bot answers questions about the Idle Clans player market inside Discord. A
change is good when the number a player reads is true and the sentence around it
says exactly what was measured.

## Run it

```bash
npm ci
cp .env.example .env          # fill DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL, REDIS_URL
npm run migrate
npm test
npm run typecheck
npm run build
```

`npm test` includes one integration test that needs a real Postgres schema, so
run `npm run migrate` first. The dev stack in `docs/ENVIRONMENTS.md` starts
Postgres and Redis in Docker if you do not have them locally.

## Rules

- **No new dependencies.** The four runtime packages cover the job; a chart is
  drawn with `node:zlib`, not a renderer. If something seems to need a package,
  open an issue first.
- **Comments in English**, and only where the code cannot say it itself. A
  function that needs explaining gets a docblock, not a `//` line above it.
- **Relative imports carry the `.js` extension** — the build is plain ESM.
- **`0` means "no offer"**, never "zero gold". Ask and bid are never mixed with
  trade averages. The bot does not give profit advice.
- **Secrets stay out of the tree.** `bash scripts/scan-secrets.sh` runs the same
  check CI runs.

## Branches and commits

`develop` is where work lands; `production` is what the host runs. A release is a
merge from `develop` into `production`, nothing else.

```
git switch -c fix/graph-flat-series
# work
git commit -m "Draw a flat series as a line, not as nothing"
```

Commit messages are imperative, one line, no trailer. Every user-visible change
gets an `[Unreleased]` entry in `CHANGELOG.md` in the same commit.

## What CI checks

| Workflow | Runs on | Must pass |
| --- | --- | --- |
| `tests` | every PR, pushes to `develop`/`production` | migrate → typecheck → test, plus the operator-path guard |
| `gitleaks` | every PR, pushes, nightly | no credential in the diff or the history |
| `version-guard` | tags `v*`, PRs touching the version | tag, `package.json` and `CHANGELOG.md` agree |
| `docker smoke` | PRs touching the image inputs | the image builds |

All four are free on a public repository with standard runners.
