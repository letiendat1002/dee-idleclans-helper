# Architecture — dee-idleclans-helper

Who reads this: an agent changing a flow, a poller, a table, a cache key or a budget — when: before that change, so the topology it touches is known.
Neighbours: [CONVENTIONS.md](CONVENTIONS.md) · [ROADMAP.md](ROADMAP.md) · [ENVIRONMENTS.md](ENVIRONMENTS.md) · [DEFERRED.md](DEFERRED.md).

How the bot is put together, what talks to what, and where it breaks. Read this
before changing a poller, a cache key or a permission gate.

## 1. Topology

Four containers, one bridge network, **no published ports**. Nothing outside
Docker can reach the bot, Postgres or Redis; the bot reaches Discord and the
Idle Clans API over outbound HTTPS only.

```
   Discord ──gw/rest──▶ ┌──────────────────────────────────────┐
                        │ dee-idleclans-helper  (node, 512 MB) │
                        │ 8 slash commands, 4 jobs (no poller) │
                        └───────────┬──────────────┬───────────┘
                                    │              │
   Idle Clans API ──https──▶ ┌──────▼──────────────▼───────────┐
                             │ collector      (node, 384 MB)   │
                             │ market poller, rollup, prune     │
                             └──────────┬──────────────┬────────┘
                                        │ pg           │ redis
                             ┌──────────▼───┐   ┌──────▼───────┐
                             │ postgres 16  │   │ redis 7      │
                             │ (4 GiB)      │   │ (256 MB)     │
                             └──────────────┘   └──────────────┘

   systemd timer hourly ─▶ scripts/backup-db.sh ─▶ 7 dumps + monthly archive ─▶ rclone ──https──▶ B2
```

Why the database moved into the stack: on this host Docker is served by a
desktop VM, so `network_mode: host` reaches the VM's loopback, not the machine
(`ECONNREFUSED 127.0.0.1:5432`, measured). Publishing ports would work but
exposes Postgres on the host. A private bridge with the data inside is the
smallest correct arrangement.

Everything is `restart: unless-stopped`; Docker is the supervisor, there is no
systemd unit and no process manager inside the container.

One thing does leave the host: an hourly systemd timer runs `scripts/backup-db.sh`,
which dumps the database and copies the newest dump plus the monthly `price_daily`
archive to a private Backblaze B2 bucket through `rclone`. The dump file is named
after the UTC day and rewritten on every tick, so the newest backup is never more
than an hour old and the bucket keeps one object per day. That is the only
outbound dependency besides Discord, the API and the chart renderer, and the only
copy of the data that survives a dead disk.

There is no chart renderer call any more. `/graph` used to POST a Chart.js config to
`quickchart.io`; since 2026-11-22 the picture is drawn in-process by
`ui/chartHistory.ts` from the game's own trade history, so the only outbound calls
are Discord, the API and B2. The `NODE_OPTIONS=--dns-result-order=ipv4first` flag
stays on the service: the API host is reached over the compose network, and the
container still has **no IPv6 route** (measured 2026-11-21).

Since 1.3.0 the bot and the collector also skip the host's resolver stub: `docker-compose.yml` sets
`dns: [1.1.1.1, 8.8.8.8]`, because on 2026-11-24 the stub stopped answering `AAAA` for
`discord.com` for nine seconds and the interaction in flight died with `EAI_AGAIN`. That override
does *not* replace `--dns-result-order=ipv4first` — public resolvers do return `AAAA` records, and
with no IPv6 route a `connect` to one fails, so the ordering flag is what keeps the A record
chosen. Two independent faults, two fixes.
or the renderer goes back to intermittent local PNGs.

Neither process publishes a port, so no healthcheck is an HTTP probe. The bot
stamps `/tmp/dee-bot-alive` every minute and the check fails after five stale
minutes; the collector stamps `/tmp/dee-heartbeat` when a poll cycle finishes,
whatever its outcome, and the check fails after ten. Two files on purpose: after
the split one liveness signal cannot vouch for the other, and an upstream outage
still does not look like a wedged poller. Both catch a wedged process, which
`restart: unless-stopped` cannot see.

## 2. Boot sequence

`src/index.ts` calls `client.login()` at module load (`src/index.ts:289`).
Everything else runs inside the single `clientReady` handler
(`src/index.ts:112`), in this order:

1. Presence — `Listening /help`.
2. `migrate()` — applies every `src/db/migrations/*.sql` in name order, records
   them in `schema_migrations`. Idempotent; runs on every start.
3. One log line per cached guild — this is what warms the guild and channel
   caches the pollers read.
4. `registerCommands()` — PUTs the nine slash commands globally. Discord
   propagates in minutes; a command that fails to register is a deploy bug.
5. The four jobs that need Discord, in one block: `ItemCatalogue.start(30 min)`
   (fetches the catalogue, derives recipe trees, deletes `dee:catalogue:index` so
   the next autocomplete rebuilds it from Postgres), `AlertDispatcher.start(120 s)`,
   `MarketDigest.start(60 s tick)`, `VaultNotifier.start(5 min)`.
6. `beat()` now, then every minute — the bot's own heartbeat.

Market collection is not among them. `src/collector.ts` runs the same image from a
different entry point: `migrate()` (strict — a failed migration exits instead of
polling into a schema it does not know), then a session advisory lock
(`COLLECTOR_LOCK_KEY`), then `MarketService.start(120 s)`, still the only writer of
`price_snapshots` and the only runner of the daily rollup and the 30-day prune.
No Discord token is read on that path, so a gateway outage, a login failure or a
bot rebuild no longer stops collection.

Every step is wrapped in its own `try/catch` and a failure only logs — `Migration
skipped — database unavailable`, `Command registration failed`, `Job startup
failed` (`src/index.ts:126-163`). The process therefore keeps running on a
broken step instead of crash-looping: the container stays up so the heartbeat
check and `docker logs` carry the failure. The cost is honest: a failed migrate
leaves the collector writing into missing tables, and a failed register leaves the
previous command set live.

`SIGTERM`/`SIGINT` stop the bot's four jobs, then `closePool()` and
`redis.quit()`; the collector stops its poller and releases the advisory lock the
same way. Docker sends `SIGTERM` on stop, so a restart drains instead of cutting a
query.

## 3. Command flow

Every command follows the same shape, and the shape is the contract:

```
interaction
  → rateLimiter.check(userId, command, 5, 60 s)      fail-open, Redis window
                                                     (every command except /help)
  → [config commands only] inCachedGuild()? no → silent return
  → [config commands only] no permission re-check: Discord decided who may run it
  → deferReply(ephemeral)
  → service call (DigestSettings / SnapshotStore / MarketService / …)
  → EmbedBuilder from ui/theme.ts constants
  → editReply / safeReply (handles 10062 Unknown interaction)
```

Only the two commands that write server-wide configuration (`/digest`, `/vault`)
check the guild and the permission. Read-only commands (`/price`, `/graph`,
`/watch`, `/unwatch`, `/watchlist`, `/help`) answer anywhere,
including DMs — a member who can see the bot can ask it a question about a price.

| Command | Reads | Writes | Permission gate |
| --- | --- | --- | --- |
| `/price` | snapshots, cache | — | none |
| `/graph` | snapshots, daily | — | none |
| `/watch` | — | `watchlists` | none |
| `/unwatch`, `/watchlist` | `watchlists` | `watchlists` | none |
| `/digest add\|remove\|list\|interval` | `digest_channels` | `digest_channels` | **Discord** (default Manage Server) |
| `/vault add\|remove\|list` | `vault_channels` | `vault_channels` | **Discord** (default Manage Server) |
| `/help` | — | — | none |

Server-wide configuration is a server decision, and the server makes it in
Discord: both commands are registered with `ManageGuild` as their default, and
an admin narrows or widens that per role and per channel in Server Settings →
Integrations. The handlers do not re-check the permission. An earlier build did,
as the fix for a defect where the *bot's* permissions were read instead of the
member's; that check cannot see Integrations overrides, so it refused the roles
a server had explicitly allowed. Discord is the only source of truth for command
access (`CONVENTIONS.md` §5.1).

Rendered diagrams (runtime flow, data lifecycle, deploy flow) are generated from the code with
the `archify` skill and live with the private notes under `docs-private/diagrams/`; they are not
tracked here. The sketch above stays because it survives a terminal.

## 4. Pollers

| Poller | Cadence | Outbound calls | Failure behaviour |
| --- | --- | --- | --- |
| `ItemCatalogue` | 30 min | 1 catalogue + N recipes | keeps the previous snapshot |
| `MarketService` | 120 s | 1 price call | skips the tick, logs |
| `AlertDispatcher` | 120 s | 0 (reads DB) | skips the tick, logs |
| `MarketDigest` | 60 s tick, per-row `last_sent_at` | 0 (reads DB) | per-channel try/catch |
| `VaultNotifier` | 5 min, daily prune | 1 clan-log call per followed clan | per-clan and per-channel try/catch |

Pacing: `AlertDispatcher` sends at most one message per second and re-checks a
10-minute staleness guard before posting, so a burst after a restart cannot
spam a channel. `MarketDigest` suppresses notifications and holds a 6-hour
in-memory cooldown per guild+item+direction on top of the database cadence.

All timers are `setInterval` inside one Node process. There is no distributed
lock: running two bot containers against one database would double-post. The
compose file therefore keeps a single replica.

## 5. Data model

| Table | Rows now | Grows | Purpose |
| --- | --- | --- | --- |
| `price_snapshots` | 291 k | ~452 k/day (628 quotes × 720 polls) | every price observation, indexed `(item_id, captured_at desc)`; raw tier, pruned at 30 days |
| `price_daily` | 1 821 | ~628/day | one row per item per UTC day: ask OHLC + bid OHLC, `samples` per side; **never pruned** |
| `items` | 1 009 | on patch | catalogue + derived recipes |
| `watchlists` | — | per user | per-user item watch |
| `alert_cooldowns` | 88 | per guild+item | digest repeat suppression, 6 h window |
| `digest_channels` | new | per guild channel | digest subscriptions, `last_sent_at` |
| `vault_channels` | new | per guild channel + clan | clan vault subscriptions, `created_at` is the no-backfill line |
| `vault_events` | new | per clan entry | dedupe of the public clan log, pruned at 14 days |
| `vault_deliveries` | new | per clan entry + channel | which channel already received an entry; written **after** a successful post, so a refused post is retried instead of lost. Pruned when its entry is pruned |
| `guild_settings` | — | per guild | the live per-guild digest cadence (`digest_interval_min`); channel columns legacy |
| `clans` | 0 | — | unused legacy table |
| `schema_migrations` | 6 | per migration | applied migration versions |

Two tiers, because the upstream serves a short window and the DB is the only
long-term record:

- **Raw** — `price_snapshots`, kept 30 days. `MarketService` runs
  `housekeeping()` at startup and every 24 h: `SnapshotStore.rollupCompleteDays(30)`
  first, then `pruneOlderThan(cutoff)`. The order is not the guarantee: the
  prune only deletes a raw row whose UTC day already exists in `price_daily`,
  so a failed rollup deletes nothing and the day is archived by the next run.
  Each step is still guarded on its own, so neither can stop the poller.
- **Daily** — `price_daily`, one row per item per UTC day: `open`, `close`,
  `low`, `high`, `samples` for the ask, `bid_open`, `bid_close`, `bid_low`,
  `bid_high`, `bid_samples` for the bid. It is never pruned, so a price that
  leaves the raw window survives. A side with no offer all day is `NULL`, never
  `0`: the two sides are independent (on 2026-11-16, 31 items had a buy order
  and no sell order and 56 the reverse), which is why the ask columns are
  nullable after migration 008. `ask_volume` is deliberately not rolled up: it is
  order-book depth, not trade volume, and a summed depth would be a fake
  metric. The rollup is one `INSERT ... SELECT` over the completed days with
  `NOT EXISTS`/`ON CONFLICT DO NOTHING`, so re-running it inserts nothing;
  measured: 1 209 rows on the first run, 0 on the next start.
- **Durability.** Postgres lives in the `postgres_data` volume, so a container
  rebuild keeps the data and a dead disk takes it. Neither tier is re-fetchable
  from upstream (the API serves the current market, not the past), so the tiers
  are backed up, not regenerated: 7 local dumps + the monthly archive on disk,
  and the same two files on B2 with 30 days of dailies kept remotely.

```
  upstream ──2 min──▶ price_snapshots ──▶ prune (daily, after rollup)
                          │                ▲
                          │ rollup (daily) │ deletes a raw row only when its
                          ▼                │ UTC day is already in price_daily
                    price_daily ◀─────────┘
                  one row per item per UTC day, never pruned
                          │
                          └──▶ nightly dump + monthly archive ──▶ B2
```

- **One reader now.** `/graph` reads the daily tier for its `7d` and `30d` ranges:
  `SnapshotStore.dailyHistory(itemId, days)` returns the last `days` completed UTC
  days, oldest first, and the card states how many days the table actually holds,
  so a young table never presents itself as a month of history. The `24h` range
  still reads `price_snapshots`, and so do the digest and the alerts. The table
  exists so a price outlives the raw window — do not delete it because the raw
  path is the one most commands use.

`alert_cooldowns` is never pruned: it is keyed
`(guild_id, item_id, direction)` and bounded by the number of watched items, so
stale rows are cheap and rewriting a row is the normal update path.

Retention is the real capacity knob for the raw tier: one poll writes 628 rows,
720 polls a day is ~452 k rows/day, and at the measured ~158 bytes/row (heap
plus indexes) that is ~70 MB/day — bounded at the 30-day window by ~13.6 M rows
and ~2.1 GB. The daily tier adds ~40 MB/year.

## 6. Caching and rate limits

- **Redis, not memory**: two pollers and every command read the same derived
  catalogue, so a process-local map would duplicate work and diverge.
- Keys are namespaced `dee:<domain>:<id>`. `TTL.catalogueIndex` is 40 minutes,
  deliberately longer than the 30-minute sync: a shorter TTL expires the entry
  just before the refresh and sends every reader to Postgres for nothing.
- `CacheService` is **fail-open**: any Redis error logs a warning and serves
  the request. Rate limiting is a courtesy, not a security control, so an
  outage must not take the commands down with it.
- `retryStrategy` reconnects forever with a delay capped at 10 s. Returning
  `null` (giving up) is wrong here: ioredis would drop the connection for good
  after one restart and every later call would silently fail open.
- The limiter is a Redis sorted-set sliding window, 5 requests / 60 s / user /
  command, decided by **one Lua script**: prune, count, admit or refuse, write.
  Five separate round trips let overlapping callers all read `count = max - 1`;
  measured against the running Redis, the round-trip version admitted **20 of
  20** concurrent requests at a cap of 5, the script admits exactly 5. The
  script uses the caller's clock, which is sound because exactly one bot process
  exists; a second process would need a server-side clock.
- The cap itself lives in one table, `LIMITS` in `src/utils/RateLimiter.ts`, one
  row per surface: seven identical copies of `5` and `60_000` across the command
  files made a per-command tweak a silent divergence. Every refusal is logged
  (`[RATE] rate limited`, user, command, `retryAfterMs`), because the log is the
  only evidence that 5 is the right number — a spent averages budget and a
  failed Redis are logged for the same reason.
- `PEXPIRE` inside the same script gives the key the window's lifetime, so a
  one-off visitor does not leave a key behind; measured after a refused probe,
  the key carried `ttl = 47 s`.
- **A user cannot amplify the upstream API.** Idle Clans allows 50 req/min per
  IP. Pollers spend ~0.6/min (no clan) to ~5/min (20 clans). Every command reads
  `price_snapshots`; autocomplete answers from the local `ItemCatalogue`. The
  one exception *was* the trade averages: `/price`, `/graph` and the digest
  called the comprehensive endpoint on every use, which broke this invariant.
  They now go through `getPriceAveragesCached()`: a 5-minute Redis key
  (`dee:averages:<id>`) behind a 20 calls/min process budget that answers `null`
  when spent, so a burst cannot take the poller's share. Measured in the
  container on 2026-11-21 — miss **2 942 ms**, hit **1 ms**, 20/20 first calls
  answered, the 21st answered `null` in **1 ms**.
- **Degradation, not a retry storm.** A failed poll logs and keeps the previous
  snapshot; a command then answers with the stored price and its capture time. No
  retry loop exists for Idle Clans, and the Discord library owns its own retries.

## 7. Discord API budget

- The library owns rate limiting: it queues and retries per route. No
  hand-written 429 handling exists, and none should be added.
- `invalidRequestWarningInterval: 100` is on so a 401/403/429 storm shows up in
  the logs. Without it the library stays silent and a permission slip looks
  like "the bot ignores me".
- Message sends are the only bulk traffic: one alert per second at most, one
  digest per subscribed channel per interval (one channel per guild),
  one vault message per channel per 5-minute tick (at most 5 channels per
  guild).
- The clan log is fetched once per clan per tick and shared by every channel
  that follows that clan, so the API sees one call per clan, not per channel.

## 8. Trust boundaries

1. **Discord → bot**: every field of an interaction is untrusted input. Guild
   and channel ids are re-checked against the cache before use; a channel the
   bot cannot see is refused, never assumed.
2. **Idle Clans API → bot**: player-supplied strings (item names, usernames,
   clan names) reach Discord messages. They are inserted as plain text in
   embeds, never parsed as markdown or mention syntax; a clan name in a URL is
   `encodeURIComponent`-encoded.
3. **Bot → Postgres**: every query is parameterised (`query(text, values)`);
   no string interpolation of user input anywhere.
4. **Bot permissions ≠ member permissions**: the bot never uses its own rights
   to justify an action for a member.

## 9. Capacity (measured on this host)

Host: 8-core i5-1135G7, 30 GiB RAM (21 GiB available), 446 GB free on `/`.

| Component | Used | Limit | Headroom |
| --- | --- | --- | --- |
| bot | 32 MiB | 512 MiB | 16× |
| bot heartbeat | 1 file, 60 s cadence | 5 min stale = unhealthy | — |
| collector | 26 MiB | 384 MiB | 14× |
| collector heartbeat | 1 file, 2 min cadence | 10 min stale = unhealthy | — |
| postgres | 357 MiB | 4 GiB | 11× |
| redis | 40 MiB | 256 MiB | 6× |
| database | measured in `ROADMAP.md` §2 (rows, size, free space); ~2.1 GB at the 30-day raw ceiling | — | raw tier capped at 30 days (~13.6 M rows); `price_daily` adds ~40 MB/year and is never pruned |
| off-host copy | 274 MB on B2 in the steady state | 10 GB free tier | ~7.9 MB/day × 30 + a 30 KB archive/month; inside the free tier with ~35× headroom |
| hot query (latest quote) | 0.087 ms | — | index scan, constant time |

Two guilds (measured), ~452 k snapshots/day, one message send at most per second. The bot is
idle 99% of the time; the limits in the compose file are there to contain a
leak, not because the host is short of memory.

## 10. Where it breaks first

1. **Two bots** → double posts. Keep one. Two collectors cannot diverge: the
   second exits at the advisory lock.
2. **Redis down for good** → rate limits and the catalogue cache go fail-open;
   Postgres takes the read load. Recoverable, degraded.
3. **Postgres down** → commands fail with a formatted error; pollers skip
   ticks. The container restarts under `unless-stopped`.
4. **Upstream API changed shape** → pollers log and skip; the last snapshot
   stays and commands keep serving stale numbers, which the UI labels with the
   snapshot time.
5. **Item catalogue renamed an item** → recipe derivation degrades, not
   crashes: unknown items are skipped and logged.
6. **The host disk dies** → container and database are gone, and the local
   dumps with them. Loss is bounded by the 04:00 copy: at most one day of raw
   ticks, while `price_daily` loses at most the current day. Restore from B2,
   not from a directory inside the repository.
