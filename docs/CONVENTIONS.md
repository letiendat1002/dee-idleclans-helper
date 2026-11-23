# Coding & product conventions — Dee IdleClans Helper

Binding convention for every change in this repository. It exists so that the bot behaves the
same way whether it was written in one session or ten, and so that a reviewer can check a diff
against a written rule instead of against taste.

Read `AGENTS.md` (repo root) first — it is the short map to this document.

---

## 1. Source-of-truth order

| # | Document | Binding on |
|---|---|---|
| 1 | `docs/CONVENTIONS.md` (this file) | how to build here |
| 2 | `docs/superpowers/specs/2026-11-11-dee-idleclans-helper-v2-design.md` | **behaviour** — a corrected item is marked `[corrected]` |
| 3 | `docs/superpowers/plans/2026-11-11-dee-idleclans-helper-v2.md` | the task list and the argument behind it |
| 4 | `.superpowers/sdd/2026-11-11-dee-idleclans-helper-v2/progress.md` | rulings, task states, deferred debt |

When two of them disagree, this file wins on style, the spec wins on behaviour, and the ledger
records the decision as a ruling. A conflict is never resolved silently: write the ruling down.

`docs/superpowers/` and `.superpowers/` are gitignored. They travel with the ticket, not with git.

---

## 2. Product invariants

### 2.1 Facts, not advice

The bot reports market facts and arithmetic over market facts. It never tells a player what to
do, and it never estimates profit.

v1 shipped `/profit` and recommended `otherworldly_dragon_slayer_crossbow` at 295,045,214,400
gold/hour — an item with exactly one listed unit and one trade in 24 hours, off by 720,000×. The
causes were: comparing an **ask** against a **24h trade average** (different units), ignoring
market depth, and ignoring player gear. The owner's own counter-example then showed buying ore
and smelting bars *is* profitable, because of `upgrade_smelting_cost` (Smelting magic tier 3 =
30% material saving) — which v1 had missed. The official Idle Clans calculator misses it too.

The lesson that shaped v2: a profit calculation multiplies many inputs; one wrong input flips
the sign, and the official site proves the problem is unsolved. **The owner ruled: no profit
output.**

### 2.2 Like-for-like units

| Market field | Means | Unit |
|---|---|---|
| `lowestSellPrice` | the **ask** — what you pay to buy | gold per unit |
| `highestBuyPrice` | the **bid** — what you receive selling | gold per unit |
| `lowestPriceVolume` | ask-side depth | units |
| `dailyAveragePrice` / `averagePrice` | **trade average** — a different unit | never compare with an ask |

Never compare an ask with a trade average. `prices/summary` and `dailyAveragePrice` are excluded
from the plan for exactly this reason.

On screen the two book sides are named after the player's action, never after the API field:
**ask → `sell price`**, **bid → `buy order`** (`docs/VOICE.md`, `docs/UI-DESIGN.md`). "Buy price"
is banned because it reads as the ask.

### 2.3 No unmodelled, undisclosed formulas

The v1 `/profit` command applied a mechanic it did not understand (`upgrade_smelting_cost` was
missed) and was wrong by 720,000×. The rule is no longer "no formulas": research first
(`docs/GAME-MECHANICS.md` is the authority), then model a modifier behind an explicit user
input or disclose it in the assumptions line. Never silently assume "no boosts", never hard-code
a bonus you cannot source, never apply a speed boost to the hour figure.

No number may be derived from gear boosts, enchantments, housing, houses, clan upgrades,
toolbelt or yield procs **without disclosure**. The only permitted *unconditional* derived rate
is:

```
3,600,000 / (baseTimeMs × itemAmount)      → labelled "base task time"
```

The label is not decoration: the first draft showed "222 bars/hour" for the titanium bar, a
figure that had silently applied a 46% speed boost — "exactly the formula risk this design
exists to avoid". The word **"bars"** must not appear in the UI.

### 2.4 Wording

Alert text states facts ("at 24h low"), never instructions ("BUY NOW"). The bot reports; the
player decides.

### 2.5 Privacy

A DM alert that cannot be delivered is recorded as `delivered = false` and surfaced in `/watchlist`
("DM blocked — enable DMs to receive alerts"). It is **never** posted publicly as a fallback.
The alert stays disarmed until the user re-issues `/watch`.

---

## 3. Live-data invariants

Verified against the live Idle Clans API (2026-11). These are facts about the feed, not
preferences.

1. **A price of `0` means "no offer".** The market writes `0` with volume `0` for "no sell
   order". 27 of 627 quoted items have no sell order, 43 have no buy order. A `0` is a *missing
   observation*, never a price of zero, and it must be filtered out **before** any average.
2. **Item id `0` is a real item** (Spruce log). Ids run 0..1008. A guard like `id <= 0` throws
   away every live poll.
3. **Tradeable comes from the catalogue**, `items.tradeable`. 676 catalogue items are tradeable
   but only 627 have a market price — deriving tradeability from quotes misreports up to 49 real
   tradeables and inflates the craft margin. A component is non-tradeable only when the
   catalogue explicitly says so; an unknown component is treated as tradeable (it then has no
   ask, which makes the verdict `UNAVAILABLE` — the safe outcome, because an unknown cost must
   never be silently priced at zero).
4. **Ask and bid are different sides.** An item with a bid but no ask cannot be bought. 161
   items are craftable+tradeable but only 158 of them have a lowest sell price.
5. **The sell tax is `1.0` %** (`/Configuration/market-settings` → `sellTaxPercentage: 1.0`). It
   applies to **both** legs of the raw comparison (both are sales) and **not** to craft-vs-buy
   (both are purchases). The tax-adjusted figures are exact — round at the display layer, never
   in the data.
6. **110 of 627** traded items pass the volume floor (`askVolume >= 1000`). That is the
   universe a digest can ever report; a header must count the eligible items, not the catalogue.

---

## 4. Architecture map

```
src/
  index.ts                 Discord client, interaction routing, job wiring
  registerCommands.ts      slash command registration — global only; the guild copy is cleared
  cache/CacheService.ts    Redis sliding window + rate limiter
  commands/                one file per slash command
  ui/theme.ts              colours, icon ids, money/footer formatters — the shared vocabulary
  ui/chart.ts              PURE: prices → PNG area chart (zlib only, no dependency)
  ui/chartHistory.ts       trade history → the 900×260 raster, drawn in-process; null under two points
  ui/reply.ts              safeReply — the one way to answer an interaction that may have expired
  ui/channel.ts            canPost — the one View+Send check every posting surface uses
  ui/share.ts              the `Post to channel` control: cooldown, attribution line
  events/MessageHandler.ts @mention → public showcase embed (Task 9)
  jobs/
    MarketDigest.ts        per-guild scheduled digest post
    VaultNotifier.ts       per-guild clan vault post, one message per poll
    AlertDispatcher.ts     /watch DM alerts, one-shot with hysteresis
  services/
    IdleClansApi.ts        the only place that talks to the Idle Clans API
    ItemCatalogue.ts       game-data + metadata → Postgres `items`; backs every autocomplete
    MarketService.ts       polls `prices/latest` → `price_snapshots`
    SnapshotStore.ts       reads snapshots + 24h ask history
    CraftAdvisor.ts        PURE: buy-vs-craft and sell-raw-vs-craft
    AlertEngine.ts         PURE: is this move notable?
    WatchlistService.ts    the /watch rows
    DigestSettings.ts      digest_channels rows (channel, interval, owner)
    VaultLog.ts            vault_channels + vault_events rows
  db/
    pool.ts, migrate.ts    Postgres pool + migration runner
    migrations/NNN_name.sql
  utils/                   logger, errors (DeeError tiers), RateLimiter
```

### 4.1 Layer rules

- **Pure functions stay pure.** `CraftAdvisor` and `AlertEngine` take their whole world through a
  context object and must not touch the clock, the database, Redis, the network or
  `Math.random()`. Their only imports are `import type` — so the emitted CommonJS has zero
  `require()` calls and no runtime dependency on `db/pool`. This is what makes them unit-testable
  without a network.
- **One owner per table.** `SnapshotStore` owns `price_snapshots`; `WatchlistService` owns the
  CRUD of `watchlists`; the `AlertDispatcher` owns the *state transitions* of a watch row
  (`armed`, `last_fired_at`, `delivered`) through its own UPDATEs. A second writer must not
  appear.
- **One place talks to the API.** `IdleClansApi` is the only module that calls `fetch`. Its
  requests carry a timeout (30 s) — without one a hung request never settles, the market poll's
  `finally` never resets the `polling` flag, and the feed dies silently and permanently.
- **Jobs take the Discord `Client` as a parameter** (`AlertDispatcher.run(client)`,
  `MarketDigest.start(client, intervalMs?)`). No global registry, no new infrastructure file.
- **Autocomplete never calls the Idle Clans API.** It answers from the catalogue in Postgres and
  must respond inside three seconds.

### 4.2 Data flow

```
Idle Clans API ──poll every 2 min──> MarketService ──> price_snapshots (Postgres)
ItemCatalogue  ──on build change───> items (Postgres) + recipes JSON
snapshot rows  ──> CraftAdvisor (pure) / AlertEngine (pure) ──> embeds + DMs
```

---

## 5. Discord platform rules

- **discord.js v14** (the repo pins `^14.28.1`).
  - DM: `const dm = await client.users.createDM(userId); await dm.send({ embeds: [embed] });`
    `client.users.create` and `client.channels.create` are the **v12** API and do not exist in v14.
  - Ephemeral: pass `flags: 64`. `flags: 4096` is `SUPPRESS_NOTIFICATIONS` — that is what a
    digest post uses so it does not ping the channel.
- **Privileged intents stay OFF.** The bot must work without `MessageContent`; Discord's
  documented exception makes the content of messages that @mention the app available anyway.
  Task 9 adds `GuildMessages` only. Any other client that connects with this bot's token (an
  MCP server, a script) must not request those intents either — Discord closes the gateway with
  4014 "Used disallowed intents".
- **Bot permissions**: `SEND_MESSAGES`, `EMBED_LINKS`, `VIEW_CHANNEL` only. The bot cannot create
  channels, list members or delete other people's messages. The owner creates the digest channel
  and runs `/digest #channel`.

### 5.1 Permissions: who owns what

Two different systems, and the line between them decides what we build:

| Question | Owner | Where |
| --- | --- | --- |
| Who may run which command, in which channel | **Discord** | `Server Settings > Integrations > Manage` (per-command roles/channels), plus `default_member_permissions` set at registration |
| What permissions the bot received at install | **Discord** | the authorize screen (checkbox list), later the bot's role in `Server Settings > Roles` |
| Whether the bot may post in *this* channel *right now* | **the bot** | `canPost()` in `src/ui/channel.ts` (`permissionsFor(me)` incl. overwrites) |
| Which channel gets the digest, which clan the vault | **the bot** | our own tables + `/digest`, `/vault`; Discord has no per-guild app-settings surface |
| A blocked DM, a deleted channel | **the bot** | mark `delivered = false`, evict the subscription, never fall back publicly |

Rules that follow:

- **Never build permission UI.** No role picker, no "who can use this" store, no custom command
  visibility. Discord owns that axis; a copy of it is a second source of truth that drifts the
  first time an admin edits the Integrations page. The bot token cannot write command permissions
  at all -- Discord requires a Bearer token and Manage Guild + Manage Roles for that.
- **Do keep the capability check.** Discord enforces permissions per request (403 / `50013`
  "You lack permissions to perform that action", `50001` missing access, `40043` interaction
  failed to send) and channel overwrites can be changed after install, so an install-time grant
  is a snapshot, not a contract. The check is a *capability* check with a friendly ephemeral
  error, not an *authorization* check.
- **Refuse before acting, with the missing capability named** (`I need Send Messages in this
  channel to post there.`), and never half-write: check, then write.
- **No channel permission exists in a DM**, so never gate a DM path on one; `canPost` returns true
  there by design.
- **An ephemeral reply still targets the channel**, so it can fail exactly when `SEND_MESSAGES` is
  missing; log that path instead of assuming the user saw the message.
- **Discord documents no prescribed missing-permission UX.** The ephemeral reply naming the
  capability is our house rule, not a Discord requirement -- do not cite it as one.
- **The OAuth invite must request `permissions=2147535872`** =
  `VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_APPLICATION_COMMANDS`.
  Omitting `USE_APPLICATION_COMMANDS` gives the invited bot slash commands that do not work;
  omitting `ATTACH_FILES` leaves `/graph` unable to upload its PNG.
- **The showcase's second button** points at `https://idleclans.wiki/w/<Name_with_underscores>`
  (verified 200; the `idleclans.com/wiki/...` form is a 404). The second button ("Website") is
  the owner's placeholder — keep it in one named constant.
- **The bot ignores bot-authored messages**, so an @mention test must come from a user.

---

## 6. Code patterns

Every rule below exists because the failure it prevents has happened here, or would happen the
first time the bot meets load. They are grouped by the property they protect; the numbered
subsections are the review checklist, not a style guide.

### 6.0 House rules

- **English comments only.** No Vietnamese in the code. Docs under `docs/` are Vietnamese.
- **Docblock `/** */`** for anything describing a function, method, class or module-level
  constant. No `//` standing in for a docblock; no comment that restates the line below it.
- **Never `as any`.** No `@ts-ignore`, no `@ts-expect-error`, no `as unknown as T`. A narrow
  structural cast (`channel as PermissionedChannel`) is acceptable when the alternative is
  duplicating a union; say why in one line.
- **`"type": "commonjs"`** stays; relative imports carry `.js`.
- **No new dependencies** without an owner decision.
- **`npm run build` cleans `dist` first.** `tsc` never prunes a renamed or deleted module, and the
  image copies `dist` verbatim (`COPY dist ./dist` in the Dockerfile), so a dirty tree ships a
  module nobody imports or a missing one as a broken `require`. Never hand-edit `dist`.

### 6.1 Shape and layering (maintainability)

- **Dependency direction**: `commands/` -> `services/` -> `db/`, with `ui/` and `utils/` as leaves.
  No service imports a command; nothing above `db/` is imported by it. A cycle means one file is
  doing two jobs.
- **Pure stays pure** (§4.1): `CraftAdvisor`, `AlertEngine`, `ui/chart.ts` take their world through
  arguments -- no clock, no IO, no `Math.random()`.
- **One owner per concern**: `ui/share.ts` renders and posts a control card, `ui/channel.ts`
  decides whether posting is possible, `ui/reply.ts` answers an interaction that may have expired,
  `ui/theme.ts` owns money/footers/colours, `utils/errors.ts` owns the tiers. A second copy of a
  rule is how two surfaces start answering differently (the digest and vault schedulers had four
  copies of the same permission test before `canPost`).
- **Custom ids are a protocol**, `<surface>:<action>:<ids...>` (`graph:range:46`,
  `price:share:410`). Route with `startsWith` in `src/index.ts`,
  let the handler slice its own suffix, and never put rendered content in the id: the message
  outlives the process.
- **Split by responsibility, not by line count.** A 400-line module with one job is fine; a
  100-line module with three is not.

### 6.2 Errors (error-proneness)

- **Throw `DeeError` with a tier**: `E1` user error (ephemeral, shown), `E2` internal (generic
  reply + error log), `E3` unexpected (generic reply + full log). Unknown throwables are `E3`.
- **Never swallow.** An empty `catch {}` is forbidden. The two legitimate best-effort paths
  (cache warming, Redis fail-open) keep the catch *and* say why in the block or the docblock.
- **Log once, at the boundary that answers the user.** Do not log and rethrow the same failure at
  two layers.
- **Unexpected errors get an id** (`generateErrorId`) that is logged and shown, so a user report
  maps to one log line.
- **User copy names the capability or the input**, never the stack or the table name.

### 6.3 Postgres (performance + reliability)

- **Type the query, not the result**: `query<Row>('SELECT ...')`, row type declared once at the
  query. Casting the result (`as { rows: Row[] }`) is how a renamed column becomes `undefined` at
  runtime instead of a compile error.
- **One pool, with its guards**: 5 s connect, 15 s statement, 20 s client query, 10 connections,
  and an `error` listener so a database restart does not end the process (`src/db/pool.ts`).
  Never construct a second `Pool` or a raw `Client`.
- **A transaction is a dedicated client**: `pool.connect()` + `BEGIN/COMMIT/ROLLBACK`
  (`ItemCatalogue.sync`). `query()` runs one statement; two calls are not one transaction.
- **One round trip per question**: aggregate in SQL (`unnest`, `ANY`, window functions) instead of
  looping queries. `SnapshotStore.latestQuotes` and the daily backfill are the reference.
- **Every hot `WHERE`/`ORDER BY` has an index**, added in the same migration as its query. Current
  set: `idx_snapshots_item_time`, `idx_snapshots_time`, `idx_items_name_ci`, `idx_watch_user`, plus
  the partial indexes on `items`.
- **Snowflake ids stay strings** end to end; never `Number(id)` a `BIGINT`.
- **Migrations are forward-only, idempotent, one concern per file.** Before a `DROP TABLE`, record
  the row count and the search that shows no reader in the file header (precedent:
  `010_drop_v1_tables.sql`, five tables, zero rows, zero references).
- **Never write SQL against dev/prod**; `npm run migrate` is the only writer.

### 6.4 Redis, cache and limits

- **Cache is fail-open**: a Redis outage makes the bot slower, never broken. Every cache call
  returns a value or `null`; none throws into the caller.
- **TTL is a safety net, not the invalidation strategy** (the catalogue sync deletes its key).
- **A limit is atomic or it is not a limit.** The sliding window is one Lua script because five
  round trips let two callers both read `count = max - 1` and both be admitted.
- **The bucket lives with the command** (`MAX_USES` / `WINDOW_MS` in the command file) and a click
  on its controls spends the same bucket. A second number for the same action is a bug.

### 6.5 Time, concurrency, lifecycle

- **Every network call has a timeout** (`AbortSignal.timeout(30_000)` in `IdleClansApi`) and the
  caller resets its in-flight flag in `finally` (the market poll). Without the timeout a hung
  request never settles and the feed stops silently for good.
- **One process.** The rate-limit clock and the share cooldown live in memory, which is correct
  only while one instance runs; going multi-instance moves both to Redis. Until then, do not add a
  third in-memory store.
- **No fixed sleeps** in code or tests; wait on the event or the state, with a bound.
- **Shutdown is one function** (`shutdown(signal)` in `src/index.ts`): stop producers, close the
  pool and Redis, destroy the client. Both signals call it so the two paths cannot drift.

### 6.6 Observability

- `createLogger('TAG')`, structured fields, level from `LOG_LEVEL`.
- Log the outcome and the counts (`market snapshot stored {quotes:628}`), not every row.
- Never log the Discord token, the B2 key or a full interaction payload.

### 6.7 Performance claims need a measurement

A change justified by performance needs a before/after: `EXPLAIN ANALYZE` for SQL, a logged
duration for a job, a hit rate for a cache. Capacity numbers and what breaks first live in
the architecture audit; do not restate them from memory.

## 7. Testing conventions

- `npx vitest run <file>` for the focused test, `npm test` for the suite, `npm run typecheck`
  for the compiler. `npm run build` before shipping.
- **A test must fail when the implementation is reverted.** Prove it on a scratch copy under
  `/tmp` (copy the module + the test, symlink `node_modules`), never by breaking the real file.
- **No wall-clock dependence.** No fixed sleeps, no polling waits, no `Date.now()` in a test.
  Use vitest fake timers (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`) or inject the
  delay.
- **A test asserts a computed value, not a call.** Re-derive the expected number in the
  assertion (`toBeCloseTo(3511 / 11197, 10)`), never a hand-rounded literal — the rounded
  literal fails on the correct value, and the default 2-digit precision proves nothing.
- **Test files are excluded from `tsconfig.json`**, so `npm run typecheck` does not check them.
  Check them by hand:
  ```bash
  npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext \
    --esModuleInterop --skipLibCheck --types node src/<file>.test.ts
  ```
- **A test file needs a matrix, not a handful of examples**: one case per rule branch, one per
  edge case the data can produce, each with its own name.
- Mock the boundary, not the unit under test. A test that mocks the function it is testing
  proves nothing.

---

## 8. Git conventions

- **This repo overrides the global commit rule.** The agent commits proactively at the end of each
  finished unit of work: one commit per coherent change, imperative message, no per-commit
  permission prompt. The global `~/.config/opencode/AGENTS.md` keeps "không commit tự động" as the
  default for other projects; the override applies here only.
- Hard bounds: `develop` only (no force-push, no history rewrite of pushed commits), never commit
  `.env` or tokens, `npm run typecheck && npm test` green before the commit, and **a push is not a
  deploy** — deployment runs `scripts/deploy.sh`.
- Feature work that spans sessions still gets a checkpoint report at each unit, so a review can
  land on a single commit rather than a range.

---

## 9. Known debt

Deferred findings live in `docs/DEFERRED.md` (owner blockers, verification gaps, tech debt,
marketing) and in the ticket ledger
(`.superpowers/sdd/2026-11-11-dee-idleclans-helper-v2/progress.md`). Current state, re-checked
2026-11-22 after the deploy work — anything also listed in `DEFERRED.md` follows that file:

- The graphify index is derived and its community labels are partly hub-named (43 saved labels for
  76 communities) because no LLM backend key is configured on this machine. `graphify label .
  --missing-only` with a key names the rest.
- Backups run from `dee-idleclans-backup.timer` (hourly tick, one dump per UTC day,
  `Persistent=true`) and `dee-idleclans-watchdog.timer` restarts a dead container. Both are
  installed and active since 2026-11-22; user cron is no longer part of the path.
- The deploy check runs from its own checkout outside the workspace through
  `dee-idleclans-deploy.timer` (5 minutes), not from this working tree: `deploy.sh` detaches its
  checkout, so pointing it at the dev tree would move `develop`. The timer is enabled and, until
  the release branch carries an application, every tick ends with `nothing to deploy`.
- `develop`'s gate is `.github/workflows/tests.yml` on a hosted runner with Postgres and Redis
  services. It reproduces the suite, but it is not the host's docker stack: a failure that needs
  the container image (Dockerfile drift, alpine differences) will only show at deploy time.

Resolved in the 2026-11-17 pass (kept so they are not re-opened):

- ~~`ItemCatalogue.test.ts` casts mocks with `as any`~~ -- `vi.mocked(...)` everywhere, 0 left.
- ~~v1 tables `watchlist`, `clans`, `guilds`, `payments`, `users`~~ -- migration
  `010_drop_v1_tables.sql`, verified empty and unreferenced first, applied to both databases.
- ~~`/buy-or-craft`'s wiki URL is not percent-encoded~~ -- `encodeURIComponent` plus a test with a
  name carrying `&`.
- ~~`/buy-or-craft` has no `Post to channel`~~ -- built; the modifiers travel in the custom id.
- ~~No automated gate on `develop`, nothing deploys `production`~~ -- `tests.yml` runs on every
  push, and the host deploys `production` from its own cron check.
- ~~Node version mismatch between image and test toolchain~~ -- both on Node 22 (vitest 4 needs
  `Map.groupBy`).
- ~~`AlertEngine` `lo === hi` guard untested~~ -- test (e) reaches it.
- ~~`MarketService.ts` describes a `0` as "a price of zero"~~ -- the comment is gone.
- ~~`npm audit` reports 6 advisories~~ -- 0, with and without devDependencies.
- ~~Live prices are stale until the market poller is wired~~ -- the poller runs every 120 s.

---

## 10. Legal constraints

These are not negotiable and they are not a style choice:

- Phase 1 is **free** — no payment code.
- Never sell gold, items or accounts in game (NĐ 147/2024 §57).
- Never build or operate a payment gateway (NĐ 52/2024 §3.18).
- If charging ever happens: register the business, declare the tax, and under 1 billion VND per
  year it is exempt from VAT and personal income tax with an annual report by 31 January.
- The Idle Clans and Discord terms of service around automation are a live risk — confirm before
  any wide promotion. The bot reads public market data and sends notifications; it does not
  automate game actions, does not trade on the player's behalf, and sells nothing.

---

## 11. Live testing

`docs/DISCORD-TESTING.md` — how to run the bot, how to drive each command in the test guild
(`<dev-guild-id>`, channel `general` = `<dev-channel-id>`), and what each response must
contain. The agent-side runbook with the MCP driver and the intent pitfalls is
`.superpowers/sdd/2026-11-11-dee-idleclans-helper-v2/DISCORD-TESTING.md`.
