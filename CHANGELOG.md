# Changelog

All notable changes to Dee IdleClans Helper are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A release is cut from `[Unreleased]` after the host has deployed the commit and
the health gate has passed; the tag is `v` plus the version in `package.json`.

## [Unreleased]

### Added

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

### Security

- Every push is scanned by gitleaks and GitHub push protection; the tree is
  checked for operator paths in CI.
- The bot token lives in `.env` (mode 600) and is never committed.

## [1.0.0] — unreleased

First public release. The section above moves here, with the date of the deploy
that passed the health gate, when the tag is created.
