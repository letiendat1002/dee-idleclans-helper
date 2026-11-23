# Changelog

All notable changes to Dee IdleClans Helper are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A release is cut from `[Unreleased]` after the host has deployed the commit and
the health gate has passed; the tag is `v` plus the version in `package.json`.

## [Unreleased]

Nothing yet.

## [1.0.2] - 2026-11-23

### Fixed

- **A fresh host is no longer "overdue" for a restore drill on day one.** With no
  `.last-drill` stamp the watchdog reported `9999 days`, which on the next
  install (or after a stamp is deleted) would have sent a DM that says nothing
  true. The clock now starts at the newest dump, so a host that backs up but
  never drills still trips the 45-day limit, while a host that has simply not
  drilled yet stays quiet.

## [1.0.1] - 2026-11-23

### Added

- **A dead-man's switch for the whole host.** The watchdog cannot report its own
  death, so a successful backup now pings `HEALTHCHECK_URL` when it is set (a
  healthchecks.io-style URL); no ping for longer than the grace period is what
  tells the owner the machine, not just a container, went away. Unset means no
  ping is sent, so the script keeps working on a host with no external checker.
- **A monthly restore drill.** `deploy/dee-idleclans-drill.{service,timer}` runs
  `scripts/restore-drill.sh` on the first of the month, and a passing drill writes
  `$BACKUP_DIR/.last-drill`. `watchdog.sh` alerts when that stamp is older than 45
  days, so a drill that stops running is noticed instead of assumed.

### Changed

- **The watchdog checks the off-site copy too.** A fresh local dump plus a failing
  upload used to look healthy; `watchdog.sh` now reads the newest object under
  `RCLONE_REMOTE/daily` and alerts past 30 hours, on top of the 26-hour local
  check. Both share one DM path and one 12-hour cooldown.
- **TypeScript 7.0.2** (the native compiler) replaces 5.9.3. The emitted `.js` is
  byte-identical to the 5.9.3 build across all 36 files; only `.d.ts` quoting and
  source maps differ.

### Fixed

- The `1.0.0` changelog section had collected entries that landed after the
  release, and carried two `### Changed` headings. Both are corrected here; the
  `v1.0.0` tag now matches its own section again.

## [1.0.0] - 2026-11-23

### Added

- **`scripts/restore-drill.sh`** restores the newest dump into a scratch database,
  counts the tables the bot depends on and drops it again, so a backup is proven
  by a restore instead of by its existence.
- **`type: subject` commit format, merge-commit policy and the five-step release**
  are written down in `docs/CONVENTIONS.md` §8 and `CONTRIBUTING.md`.
- **`docs/CONVENTIONS.md` §12** records deviations (ADR); the first four are the
  merge policy, manual releases, one production tier, and the public/private split.
- **`/graph item <item> [range]` draws the game's own trade history.** The series
  is the average traded price per bucket, with units traded as bars, at
  `900x260`, rendered in-process by `src/ui/chartHistory.ts`. Four windows:
  `24h` (30-minute buckets), `7d` (6-hour), `30d` (daily), `1y` (weekly). The
  card states the bucket size, the covered span and the traded range, and the
  range can be changed on the card without a new command.
- **`/price <item>`** reads the current ask, the buy order and the game's trade
  averages, and stamps the snapshot time of the item's own row.
- **`/watch`, `/unwatch`, `/watchlist`** send a DM when a price crosses a line.
- **`/digest`** posts a scheduled market digest to a channel; `/vault` posts clan
  vault events.
- **`/help`** lists the commands and the invite link.
- Price collection runs in its own process (`collector`), so a Discord outage or
  a bot restart no longer stops the history.

### Changed

- **`deploy.sh` asks Discord before recording a release.** After the health and
  schema gates it calls `GET /users/@me`, so a revoked or rotated token fails the
  deploy and triggers the rollback instead of surfacing on the next command.
- **CI lints the shell scripts** with `shellcheck` before the install; the four
  scripts now pass with zero findings.
- **`backup-db.sh` retries the off-site copy** (`--retries 3` by default) instead
  of failing the day's upload on a transient DNS error.
- The chart no longer calls an external renderer. The same geometry as the
  market page on `idleclans.com` is drawn with `node:zlib`, which removed the
  network dependency and the renderer's timeout path.
- Trade averages are cached for five minutes behind their own rate budget and
  never throw; a failed lookup degrades to "no data" rather than an error card.
- The digest refuses to post a stale snapshot instead of presenting old prices as
  current.

### Fixed

- A flat series draws a line instead of an empty image.
- A bucket with no trades is a gap, not a zero, and a bucket outside the visible
  price band is not painted against the edge.
- The daily rollup is idempotent: a restart writes no duplicate rows.

- Runtime dependencies refreshed: `dotenv` 16 → 18, `ioredis` 5 → 6 (RESP3 on
  Redis 7), `vitest` and its coverage provider 5.1.0 → 5.1.1; CI actions moved to
  `checkout` v7 and `setup-node` v7, still pinned by commit SHA.

### Security

- Every push is scanned by gitleaks and GitHub push protection; the tree is
  checked for operator paths in CI.
- The bot token lives in `.env` (mode 600) and is never committed.

First public release.
