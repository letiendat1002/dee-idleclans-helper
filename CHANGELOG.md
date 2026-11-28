# Changelog

All notable changes to Dee IdleClans Helper are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A release is cut from `[Unreleased]` after the host has deployed the commit and
the health gate has passed; the tag is `v` plus the version in `package.json`.

Changes to this repo's docs (GUIDE, UI-DESIGN, VOICE, ROADMAP) are named on a
`Docs:` line under the version that ships them. The private notes repo is never
referenced here; it keeps its own history.

## [1.7.1] - 2026-11-28

### Added

- `/price` carries a **Watch price** button beside **Post to channel**. It opens the
  `/watch` form already pointed at that item with its current sell price filled in, so
  setting an alert no longer means retyping the item name. A card with nothing to quote
  keeps no buttons at all: nothing to post, no price to alert on.

### Changed

- The insight feed ignores items nobody offers: a card needs at least 20 units on the
  sell side over its seven-day window. Measured on eight days of production book, the
  feed posted 1.38 cards a day without the floor — a third of them items offering two or
  six units a week — and 0.63 a day with it, with every posted finding still holding 92%
  of the time (`docs/DEFERRED.md` D24).
- The insight card leads with the fact a reader wants — `No sell orders for 3 days · Elite hammer`
  — instead of the internal state name `Off the board`, and its second line is the last sell order
  with its price, units and UTC timestamp (`last sell order 500,000g · 64 units · 23 Nov, 22:00 UTC`).
  A `-#` scope line says what the card is and how often it may post, and the footer carries
  provenance only. `/insight add` no longer calls the finding a "book state" and no longer tells a
  reader who just subscribed to create a channel first; `/insight list` shows how many findings are
  waiting.

### Fixed

- A vault line no longer prints a count marker in front of a currency: gold reads
  `**6,969,696 Gold**`, while items keep theirs (`**5x Shark tooth**`).

Docs: `docs/GUIDE.md` and `docs/DISCORD-TESTING.md` for the two `/price` buttons and the
muted-card rule, `docs/CONVENTIONS.md` for what `ui/share.ts` now holds, `docs/DEFERRED.md`
D24 (thin-item floor, closed with its measurement), `docs/ROADMAP.md` row for this release,
`docs/UI-DESIGN.md` and `docs/VOICE.md` for the insight card wording.

## [1.7.0] - 2026-11-27

### Added

- `/insight` posts an item whose sell side has been empty for a day or more, at most every 4 hours
  by default. It is a rate cap, not a schedule — no finding, no post — and it never pushes a
  notification. Migration `015` adds `insight_channels`, `insights` and `book_hourly`;
  `book_hourly` is rolled up from `price_snapshots` on the first run (30 days) and then hourly in
  the job's own tick. The flip and the range edge were measured below the design's 90%
  persistence gate and do not ship (`docs/DEFERRED.md` D21).

### Fixed

- `/insight` acknowledges the click before its first query, so a slow Redis round-trip no longer
  spends Discord's 3s budget. Measured on DIH Dev: 3.39s between the click and the acknowledgement,
  and the user saw "The application did not respond".
- `/price`, `/graph`, `/unwatch`, `/watchlist`, `/digest`, `/vault` and the share buttons acknowledge
  before the rate limiter, so a slow Redis can no longer spend Discord's 3s budget on them either;
  `/graph`'s range menu reports a refusal in a follow-up so a refused click cannot replace the
  chart. `/watch` still acknowledges after the limiter because a deferred interaction cannot open a
  modal (`docs/DEFERRED.md` D23).

## [1.6.0] - 2026-11-26

### Changed

- A clan vault post groups its entries by direction (`In`, `Out`, `Moved`) and leads each line with
  its UTC date and time and the bold item, so the feed reads as a ledger instead of thirty flat
  sentences. The footer is `clan log · last 14 days`; the "deltas only, the game publishes no vault
  totals" disclaimer is gone.
- `/vault remove` answers with the same success card as `/vault add`, `/vault recent` caps `limit`
  at 30 and labels the card `Newest N entries`, and `/vault list` counts distinct channels against
  the cap.
- A vault card opens with the net change recorded per vault tier since the oldest stored entry,
  capped to the three largest items per tier. It sums recorded deltas only, so it is never
  presented as a vault balance.
- `/vault list` shows when each channel last accepted a post (`never` until the first one), so a
  subscription that looks dead can be told apart from a clan that is quiet. Migration `014` adds
  `vault_channels.last_post_at`; it applies on start like every other migration.
- The vault surfaces carry their own `vault` icon instead of borrowing the digest newspaper, and
  `/help` names the clan block with the same icon.
- An error reply carries the application icon set instead of Unicode emoji, so a failure renders the
  same on every client and looks like the rest of the bot.

### Fixed

- A vault tick with more than 30 new entries marked the overflow delivered without printing it. Only
  the batch that was posted is marked now, and the rest posts on the next tick.
- A traded item the catalogue has never stored is listed with its recorded price instead of being
  dropped, and the item search escapes `%` and `_`, so a name holding them no longer matches the
  wrong rows.

## [1.5.2] - 2026-11-26

### Fixed

- A mention that arrives while the cooldown still runs is answered again. The per-user window is ten
  seconds instead of a minute, and a skipped mention is logged with how long it had left, so silence
  in a channel no longer hides a working cooldown.

## [1.5.1] - 2026-11-25

### Changed

- `/help` links `ko-fi.com/letiendat1002`. A player has a card or PayPal, not a GitHub account; the
  GitHub Sponsors link stays in the README for the people who do.
- The mention card gains `Source on GitHub`, so a stranger can read the code before inviting the bot.

### Fixed

- The policy links in `/help` reached the reader as literal `[Privacy](…)` brackets: Discord draws
  embed footers as plain text. They sit in the Links field now, and the test checks the footer has no
  markdown instead of copying the broken string.
- A release that failed while building exited without telling anyone. The build and the rollback now
  share one function, and a failed build posts to the updates channel like a failed gate.
- `package-lock.json` no longer drifts behind the manifest: the release guard fails when the three
  version strings disagree.


## [1.5.0] - 2026-11-25

### Added

- `/help` links the GitHub Sponsors page. The bot stays free: sponsoring unlocks nothing.
- `/vault recent` shows the newest entries of a clan on demand, ephemeral and outside the subscription.

### Changed

- A vault post names the UTC window it covers, lists up to 30 entries (was 10), and its footer
  says the game publishes deltas only, so no message claims a vault total.

### Fixed

- The backup timer's catch-up tick no longer leaves a red unit: the service retries for up to five
  minutes after boot instead of failing while Postgres is still starting.
- The first tick after the delivery ledger shipped replayed every entry in the retain window.
  Migration `013` marks the events a subscriber has already been given, so the replay stops.

## [1.4.1] - 2026-11-25

### Fixed

- A clan vault post that Discord refused no longer loses the entries: delivery is recorded per
  channel after the message is accepted, so the next tick retries it.

## [1.4.0] - 2026-11-25

### Added

- Published Terms of Service and Privacy Policy pages, linked from the `/help` footer. They are
  the two URLs Discord asks for at app verification.

## [1.3.1] - 2026-11-25

### Changed

- The vault post names the chest as `vault 1` instead of the game's `tier 1`, and reads
  the same way for every action: `added … to vault 1`, `withdrew … from vault 1`,
  `moved … from vault 1 to vault 2`.

## [1.3.0] - 2026-11-25

### Added

- **Release notifications.** A `v*` tag posts that version's changelog section to a Discord
  webhook (`DIH_UPDATES_WEBHOOK`), and a deploy that fails its gate posts the reason and the commit
  that was rolled back. Both are silent when the webhook is unset, so a fork is unaffected.

### Changed

- The bot and the collector resolve names through `1.1.1.1` / `8.8.8.8` instead of the host's
  resolver stub: on 2026-11-24 that stub timed out on `AAAA` records for `discord.com` for nine
  seconds and the interaction in flight failed with `EAI_AGAIN`.

### Fixed

- `/help` described `/digest interval` by minutes only, while the command has taken `hours` plus an
  optional `minutes` since 1.1.0.

## [1.2.0] - 2026-11-24

### Changed

- `/digest` and `/vault` no longer re-check `Manage Server` inside the handler. Discord owns
  command access (`Server Settings > Integrations`), so a role the server allows — such as
  `Guildmaster [Idle Clans]` in Horde — is no longer refused after passing that gate. `/help`
  now points at that screen instead of naming the permission.
- `/digest interval` drops the redundant `0 minutes` choice: `minutes` is optional,
  so leaving it blank already means a whole number of hours.

## [1.1.0] - 2026-11-24

### Changed

- **`/digest interval` now covers every quarter hour from 15 minutes to 24 hours.**
  The old option offered seven presets (15 min → 24 h), so 45 minutes or 1 h 45
  did not exist. Discord caps one option at 25 choices, so the cadence is now two
  dropdowns — `hours` (0–24) and `minutes` (0/15/30/45) — and the reply speaks
  hours ("every 1 hour 45 minutes") instead of raw minutes.

## [1.0.3] - 2026-11-24

### Changed

- **Backups now run hourly with a one-hour recovery point.** The hourly timer used
  to dump once per UTC day and re-upload the same file on later ticks, so a crash
  late in the day lost up to 23 hours of watchlists, digest and vault settings. The
  dump is now rewritten on every tick; the bucket still keeps one object per day,
  and the watchdog's staleness limit drops from 26 h to 3 h (local and off-site).
- The test guild is dev-only: the production bot left it, because the digest,
  vault and watch tables are keyed by guild and two bots in one guild post twice.

### Removed

- `guild_settings.digest_channel_id` and `digest_enabled`, legacy single-channel
  columns nothing has read since migration 005 moved subscriptions to
  `digest_channels` (migration 011).
- Twelve lint findings: dead imports in `src/index.ts`, `unwatch.ts` and
  `watch.ts`, plus four test-file nits.

### Added

- `npm run lint` (oxlint, warnings are errors) and a CI step for it. Prettier is
  not adopted: the tree is not formatted with it today and a full reformat would
  bury the real diff.
- Coverage thresholds (statements 84, branches 71, functions 85, lines 85) and a
  CI `npm run coverage` step, so coverage cannot drop silently.

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
