# Discord live testing — Dee IdleClans Helper

Who reads this: an agent verifying a command on the real Discord surface — when: before claiming a live behaviour, and after every rebuild of the image.
Neighbours: [CONVENTIONS.md](CONVENTIONS.md) · [GUIDE.md](GUIDE.md) · [ENVIRONMENTS.md](ENVIRONMENTS.md) · [SETUP.md](SETUP.md).

How to run this bot against a real Discord server and verify each command end to end. Written
from verified sessions (2026-11-13, 2026-11-14) — every expected output below was actually
observed, not imagined.

Test server: guild `<dev-guild-id>` ("DeeLY's test server"), channel `general` =
`<dev-channel-id>`. The curl snippets below take the guild id from a shell variable you export
for the test guild; the bot itself does not read it.

The test guild belongs to the **dev** bot only. The production bot left it on
2026-11-24: the digest, vault and watch tables are keyed by guild with no bot
column, so two bots in one guild share the same subscriptions and both post.


## 1. Build, migrate, run

```bash
npm install            # once
npm run migrate        # idempotent; applies src/db/migrations/*.sql to the local database
npm run build          # tsc → dist/
setsid nohup node dist/index.js > bot.log 2>&1 < /dev/null &   # survives the tool shell
```

A healthy start logs, in order: `Redis connected`, `Logged in as DIH Dev#5813`, the migration
summary (`Skipping …` for every applied file), `Synced guild: DeeLY's test server`, then

```
[REGISTER] Registered 8 commands globally
[REGISTER] Cleared the guild-scoped commands of guild <dev-guild-id>
```

Eight = `/price`, `/graph item`, `/watch`, `/unwatch`, `/watchlist`, `/digest`, `/vault`,
`/help`. Only the global set is written: registering the same names on a guild as
well makes Discord list each command twice in the picker. Global propagation takes up to an
hour, so a new command may show up late on a client that cached the old list.

To test a new command *now*, register it on the guild for the duration of the test and clear it
afterwards (guild scope is instant, global is not):

```bash
curl -X PUT -H "Authorization: Bot $DISCORD_TOKEN" -H "Content-Type: application/json" \
  --data @body.json "https://discord.com/api/v10/applications/$DISCORD_CLIENT_ID/guilds/$DISCORD_GUILD_ID/commands"
curl -X PUT -H "Authorization: Bot $DISCORD_TOKEN" -H "Content-Type: application/json" \
  --data "[]" "https://discord.com/api/v10/applications/$DISCORD_CLIENT_ID/guilds/$DISCORD_GUILD_ID/commands"
```

The `body.json` must carry only `name`, `description`, `type` and `options`: copying a registered
command verbatim fails with `APPLICATION_COMMANDS_INVALID_ID`, because it carries its own id.

`bot.log` is gitignored. Only one instance may run per token: a second `node dist/index.js` with
the same token makes Discord drop the first session. Look for the running pid before starting
another (`pgrep -af "[n]ode dist/index.js"` — the bracket keeps `pkill`/`pgrep` from matching its
own command line).

## 2. Two ways to interact, and what each is for

| Need | Use |
|---|---|
| Invoke a slash command, open a modal, type a message | the **user** session — a normal Discord client (this repo's sessions use the chrome-devtools browser) |
| Read what the bot posted, read its DMs, server admin | the **bot** session — the Discord MCP, or the REST API with the bot token |

A bot cannot invoke a slash command: Discord has no API for it. Only a user can.

## 3. Driving a slash command in the user session

The picker is the only reliable path. Typing the text and pressing Enter without a picker row
selected sends the literal text as a chat message (this produced a stray `/` in `general`).

1. Focus the message box and type `/` then a **prefix** (`pri`, `gra`, `buy`, `hel`).
2. **Click the picker row** of this bot (the row whose label carries `DIH`). Enter on its own
   does not reliably select it.
3. A command with a subcommand (`/graph`) inserts `/graph item` directly, because `item` is the
   only subcommand.
4. Type the option value; autocomplete from the catalogue answers within a second. Click the
   row.
5. `Enter` sends.

**Ephemeral replies are invisible to everything except the invoking user.** They are not in the
channel history and not in the Discord REST API. To read one, query the invoking session's DOM for
the last message node and take its text:

```js
[...document.querySelectorAll('[id^="chat-messages-"]')].slice(-1)[0].innerText
```

## 4. What each command must produce (observed)

### `/help` — ephemeral

Observed 2026-11-14 20:11 (after the footer fix):

```
Dee IdleClans Helper
Commands
 Market
/price <item> — sell price, buy order and trade averages
/graph item <item> — a 24h sell-price trend
/watch <item> — arm a DM price alert
/unwatch <item> — remove a price alert
/watchlist — the items you watch, with their sell price
 Server
/digest #channel — post the market digest in a channel
 Share
Add Dee IdleClans Helper to your server
5 uses per minute per command · only the digest posts publicly
Only you can see this
```

The brand appears once, in the author line; the title is `Commands`. The footer must not claim
every reply is private — `/digest` posts in the channel.

### `/price` — ephemeral

Observed for Teak log on 2026-11-14 19:50:

```
Dee IdleClans Helper
Teak log
Sell price 115g · 20,367 units
Buy order 56g · 1,302 units

trade avg 1d 60g · 7d 89g · 30d 74g · 413,182 traded (1d)
Sell prices · snapshot 12:49 UTC
Only you can see this
```

The card carries two buttons unless it is muted (nothing to quote): `Post to channel`, which
behaves as it does on `/graph item` -- see the controls note there -- and `Watch price`, which
opens the `/watch` form on that item with its current sell price filled in. The share button
spends the `/price` bucket; the watch button spends the `/watch` bucket (5 a minute each). A
muted card carries neither, because there is nothing to post and no price to compare against.

`sell price` is the ask and `buy order` is the bid; the unit count beside each is the depth on
that side. A side with no order prints `No sell order right now.` / `No buy order right now.`,
never `0g`. Both sides empty turns the card muted (`No sell order and no buy order right now.`).
The trade averages are a separate line and are never compared with either side of the book.

### `/graph item` — ephemeral

Observed for Teak log on 2026-11-14 22:58:

```
Dee IdleClans Helper
Teak log — 24h
now    108g
low    56g
high   120g
change +92.9%

trade avg 1d 60g · 7d 90g · 30d 74g · 428,819 traded (1d)
Sell prices · snapshot 15:57 UTC · 24h, 324 snapshots
Only you can see this
```

Above the block sits the chart: a 480x110 PNG attached as `price.png`, named by the embed as
`attachment://price.png`, drawn from `price_snapshots` asks over 24h, oldest first. It is encoded
with `zlib` and the PNG chunk format — no chart library, no renderer, no upload service. `0`
prices are dropped before drawing, because `0` means "no sell order". A day that moved under 2%
prints `Nearly flat: … to … in 24 hours.` and attaches no image, because a flat line hides the
fact it is meant to show. One snapshot prints `Only one sell price recorded in the last 24
hours…`; no snapshot turns the card muted. The footer counts the snapshots actually drawn, so a
short history is visible instead of implied.

**Controls, added 2026-11-17.** Under the card sit a range select menu (`Range: 24h`, options
`24 hours` / `7 days` / `30 days`, the current one marked default) and a `Post to channel` button.

- Picking a range edits the same message in place: title and footer follow the range, and the old
  PNG is replaced rather than stacked under the new one.
- `Post to channel` posts the same card to the channel with a muted `-# requested by @you` line,
  and the ephemeral reply becomes `Posted in <#channel>.` (`<#id>` renders as the channel name,
  no `#`). A second click within a minute answers `Posted that one a moment ago.`; without
  `Send Messages` in the channel it names that permission and posts nothing.
- Both controls spend the command's own 5-per-minute bucket, so the sixth interaction in a minute
  answers `Slow down.` (the menu answers it ephemerally; the card is untouched).
- The custom id carries the item id and range, so both keep working after a bot restart. A restart
  also forgets the one-post-a-minute memory, so one duplicate post is possible right after one.

**Verified live 2026-11-17 11:10-11:17 UTC+7** in `DeeLY's test server` `#general`, driven over CDP
(real key events into the composer, DOM clicks for the components):

| Surface | Action | Observed |
|---|---|---|
| `/price Teak log` | send | `Sell price 88g · 94,496 units` / `Buy order 58g · 12,987 units` + `Post to channel` |
| `/price` | click the button | public post with `-# requested by @HRD Dee`, ephemeral becomes `Posted in general.` |
| `/price` | click again inside a minute | `Posted that one a moment ago.`, nothing posted |
| `/graph item Teak log` | send | `Teak log — 24h`, select reading `24 hours`, `Post to channel` |
| `/graph item` | pick `7 days` | same message re-rendered: `Teak log — 7d`, `(edited)`, one chart, no second message |
| `/graph item` | click the button | `Posted in general.` + public card `requested by @HRD Dee` |

**Watch price button — driven live on the dev guild 2026-11-28.** The card carried both buttons
(`Post to channel`, `Watch price`); the click opened the form titled `Teak log` with `66` in the
threshold field and an empty direction field whose placeholder is `below`; saving it answered
`Alert armed — Teak log`, the item showed up in `/watchlist`, and `/unwatch` removed it. Still
unrun: the six-clicks-in-a-minute limiter ca and the no-quote card.

| Surface | Action | Expected |
|---|---|---|
| `/price Teak log` | click `Watch price` | the `/watch` form opens titled `Teak log`, sell price filled with the card's ask, nothing posted |
| `/price` | save the form with a lower threshold | ephemeral confirmation for `Teak log`; the same item appears in `/watchlist` |
| `/price` on an item with no quote | send | `No sell order and no buy order right now.`, **no** buttons |
| `/price` | click `Watch price` six times in a minute | sixth answers `Slow down.` ephemerally, no form |

One `/graph item` invocation at 11:09 failed with `Unknown interaction` (10062) because the ack
arrived after the 3 s window — the composer was still mid-autocomplete when Enter landed. Re-sent
after the picker settled, it answered normally; treat it as a driver artefact, not a bot defect.

Replaced the same day: the first version drew 48 block characters in a fence. Two problems
surfaced in the client — stacked `█` rows leave a gap at Discord's line height (a multi-row plot
reads as floating bars) and a 48-column line wraps on a phone, which breaks the alignment a
fence exists for.

### `/watch` — ephemeral, modal

Type `/watch`, pick the item. The modal must open **instead of** a deferred reply (a deferred
interaction cannot show a modal). It carries two fields: direction (`below` / `above`) and a
threshold pre-filled with the current ask. Submitting a valid positive integer stores a row in
`watchlists` and answers with a confirmation embed. A threshold equal to the current ask must NOT
fire an alert on the next run — the comparison is strict.

### `/unwatch` — ephemeral

Removes the row(s) for the item; "not found" is also ephemeral.

### `/watchlist` — ephemeral

Lists the user's alerts with the current sell price and a select menu (max 25). Choosing an
entry deletes that watchlist row through the select-menu handler in `src/index.ts`. A blocked DM
shows as `DM blocked — enable DMs to receive alerts`; the bot never posts a public fallback. The
empty state is a muted embed that points at `/watch`.

### `/digest #channel` — ephemeral

Who may run it is decided by Discord: `ManageGuild` is the default and a role override in
Server Settings → Integrations replaces it (Horde allows the `Guildmaster [Idle Clans]` role). The
handler does not re-check the permission, so test both sides: a member the server allowed
succeeds, a member it did not allow never sees the command. It writes one row into `digest_channels` — the single-channel columns of `guild_settings`
were dropped in migration 011. The
digest job then posts on its own schedule and logs
`[DIGEST] market digest posted {"guildId":…,"channelId":…,"items":N}`; the post carries
`flags: 4096` so it does not ping.

### `@DIH` mention — public

Reply with the showcase embed (feature bullets, "Add to server" button, wiki button) and
`flags: 4096` so it does not ping. The message must come from a **user**: the bot ignores
bot-authored messages.

## 5. Known pitfalls

| Symptom | Cause |
|---|---|
| A stray `/` or the command name posted as a chat message | Enter was pressed without clicking the picker row. Use the prefix, then click the row. |
| The command is inserted but not sent | a command with options needs the final Enter after the option row is chosen. |
| No reply, no error in `bot.log` | an ephemeral reply exists but is only visible in the invoking user's client. |
| A new command is missing from the picker | global propagation takes up to an hour; register it on the guild for an instant test. |
| A command appears twice in the picker | the same names were written both globally and on the guild. Clear the guild copy. |
| `Discord login failed: Used disallowed intents` (any client using the bot token) | the bot keeps MessageContent and ServerMembers OFF; the client must not request them either. |
| `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` | `DATABASE_URL` is missing/empty in the process env. |

## 6. Control checks run live (2026-11-17, second pass)

The three branches below were confirmed on the real surface in `DeeLY's test server`, driving the
composer with real key events and the components with DOM clicks (`DeeLY's test server`,
`#general`). Results, not intentions:

| Check | How | Observed |
|---|---|---|
| 5-per-minute bucket | six `/price` invocations inside one minute as the same user | sixth answers `Slow down. Try again in 37s.`; no reply is delivered for it |
| `Send Messages` denied | deny the `DIH` role **Send Messages** on `#general`, then click `Post to channel` on an existing card | `I need Send Messages in this channel to post there.`, nothing posted |

Two facts learned that the earlier text had wrong, or did not know:

- **An ephemeral refusal still reaches the invoker while `Send Messages` is denied.** The old note
  guessed the reply itself would fail. It does not: the reply is part of the interaction response
  path, not a channel message, so the copy is visible and the check is testable in place.
- **A component on an old ephemeral expires before the 15-minute token window suggests.** A click
  on the 4:29 card at 4:37 answered `Unknown interaction` (10062) at `deferReply`, logged as
  `[/<command>] Error <id>` and `Failed to reply to interaction`. Re-send the command rather
  than re-clicking a stale card.

Side effect to undo by hand after testing this: adding a role overwrite **unsyncs the channel from
its category**. Automatic `Sync Now` clicks did not take in the headless client -- right-click the
channel -> `Edit Channel` -> `Permissions` -> `Sync Now` restores inheritance. The permission
matrix was **not** restored: `GET /channels/<dev-channel-id>` on 2026-11-18 still returns one
overwrite, role `DIH`, `deny = 2048` (`Send Messages`), so the bot cannot post in `#general` and
the next share check has to run in `#digest` (inherits the category, no overwrites) until someone
clears it. The bot cannot clear it itself: the role carries `Send Messages` + `Attach Files` only,
so `PATCH` answers `Missing Permissions`.

Still not exercised live, kept as a note rather than a promise: six *valid* invocations (four of
the six above spent the bucket on invalid input, which still counts), and the menu path's
`graph:range` refusal under rate limit.

## 6.1 `/graph` redraw checked live (2026-11-18)

Same test server, same driver. The bot was rebuilt from `develop` and restarted before the pass, so
these are the shipped bytes.

| Check | How | Observed |
|---|---|---|
| 24h card | `/graph item: Pine log` (400+ snapshots, min 76g, max 254g) | `now 226g / low 76g / high 254g`, `Scale cut at 84g - 97 samples above.`, `No sell price 12:42-13:56 UTC.`, footer `24h, 409 snapshots`, 480x110 PNG attached |
| 7d card | range menu -> `7 days` on that card | re-rendered **in place** (same message, one attachment): `Daily range bars, one per UTC day; the line joins the closes.`, `Priced days: 4 of the last 7.`, `last day 2026-11-16` |
| 30d card | range menu -> `30 days` | same card: `Priced days: 4 of the last 30.`, attachment replaced, no second card |
| flat card | `/graph item: Bronze helmet` (218g all day) | `Nearly flat: 218g to 218g in 24 hours.`, local range and gap note still printed, **no image** |
| no snapshot | `/graph item: Raw roach` (no priced row in 24h) | `No sell price in the last 24 hours. The item may have no sell order.`, footer `no snapshot yet`, no image |
| share | `Post to channel` from `#digest` | public card with `-# requested by @HRD Dee`, ephemeral becomes `Posted in #digest.`, PNG attached |
| log | `docker compose logs` over the pass | 0 `ERROR`, 0 warnings across six interactions |

Defect this pass found and closed: the polyline stepped along x only, so a fall from 84g to 76g
(25 rows in one column) painted its two end points and nothing between them -- the shipped card
read as disconnected dashes. Fixed in `3efb117` (`steps = max(|dx|, |dy|)`); the test walks the rows
between two columns and fails against the old loop. Re-rendered live afterwards: one continuous
line across the plateau, the dip and back, with the four real outages (43/25/74/30 min) as holes.

## 6.2 `/graph` on the renderer checked live (2026-11-18, later pass)

The card posts a PNG drawn in-process from the game's trade history (`ui/chartHistory.ts`), and the
encoder stays as the fallback. The bot was rebuilt from `develop` and restarted before the pass.
Driven in `#digest` (an ephemeral card, so nothing hit the channel): `/graph` autocomplete, click
the command, type `Pine log`, pick the item, Enter.

| Check | How | Observed |
|---|---|---|
| 24h card | `/graph item: Pine log` | `now 100g / low 76g / high 254g`, `Scale cut at 100g - 108 samples above.`, `No sell price 17:36-01:19 UTC.`, footer `24h, 432 snapshots`, 512x203 PNG (760x300 rendered) whose text reads `Pine log - 24h`, `scale cut at 100g - 108 above`, axes `Price (g)` 76-100 and `On sale` 0-40,000, hour ticks 3 AM-12 AM |
| 7d card | range menu -> `7 days` | re-rendered in place: day ticks `Nov 12-Nov 17`, `Day range` bars + `Sell price` line, `Priced days: 5 of the last 7.`, `last day 2026-11-17` |
| 30d card | range menu -> `30 days` | same card: `Priced days: 5 of the last 30.`, x axis spans the priced days only |
| fallback | in-container probe with the endpoint pointed at a dead port | renderer returned `null` in 179 ms, local encoder still produced `price.png`; `graph.test.ts` asserts the attachment when the renderer mock returns null |
| log | `docker compose logs` over the pass | 0 `ERROR`, no renderer warning: every render answered |

Reference image for the shape the user asked for: Idle Clans Tools posts `item-trend.png`, 512x238,
three series on two axes over 30 days (average price, trades, units on sale) plus a summary block.
That is a live Highcharts page on their site, not an image render; the bot output is a PNG of the
same idea. Our equivalent is one price series plus units on sale, with every number already in the
card text.

## 7. Full command pass + data audit (2026-11-21)

Whole surface on the live bot (`docker compose ps`: bot, postgres, redis all `healthy`), driven in
`#digest` of `DeeLY's test server`. Every reply below was ephemeral except the two that are meant
to be public (`Post to channel`, the `@mention` showcase).

### 7.1 Data audit — the database against upstream

| Check | How | Observed |
|---|---|---|
| Latest poll vs upstream | newest `price_snapshots` poll compared field by field with `query.idleclans.com/api/PlayerMarket/items/prices/latest` | `db=631 upstream=631`, no missing or extra id, **0** mismatch on `ask`, `bid`, `ask_volume`, `bid_volume`; snapshot 72 s old |
| `0` means "no offer" | count in the latest poll, then `/price` on a row with `ask=0` | `ask=0` on 22 rows, `bid=0` on 45, no `NULL`s; the command printed `No sell order right now.` and `Buy order 800,000,000g · 1 unit` |
| Tradeable comes from the catalogue | `items.tradeable` against the quoted set | `tradeable=false 333`, `tradeable=true 676`, 631 quoted → **45** tradeable but unquoted |
| `price_daily.samples` | `sum(samples)` against raw rows with `ask>0`, per day | `2026-11-17` 255,875 = 255,875; `2026-11-18` 157,224 = 157,224 |
| Missing days | raw rows per day | no raw rows for 11-19/11-20 (bot off) → no daily rows; nothing to roll up |
| Poll cadence | `distinct captured_at` per hour | 27-31 polls/hour while the host is awake (≈2 min); the 09:01→10:52 UTC hole is host suspend, not the poller (`PM: suspend entry/exit` at 16:01–16:31 and 16:31–17:48 local) |
| Stale guard | digest tick inside that hole | `WARN [DIGEST] market digest skipped: the snapshot is stale {"capturedAt":"2026-11-21T09:01:29.956Z"}` — it refused a 2 h old snapshot instead of posting it |
| Poll failure | two failed upstream fetches after resume | `ERROR [MARKET] market poll failed: the market API request failed, keeping the previous snapshot` at 10:50:29 and 10:56:29 UTC; no crash, previous snapshot kept |

### 7.2 Every command, observed

| Command | How | Observed |
|---|---|---|
| `/price` | item `Pine log` | `Sell price 74g · 10,827 units`, `Buy order 57g · 5,001 units`, `trade avg 1d 68g · 7d 67g · 30d 68g · 153,824 traded (1d)`, `snapshot 11:06 UTC`; DB at 11:08 UTC held `ask=74 ask_volume=10827 bid=57 bid_volume=5001` |
| `/price` off-market | item `Otherworldly Leather Trousers` (`ask=0`) | `No sell order right now.`, `Buy order 800,000,000g · 1 unit` |
| `/graph item` 24h | item `Pine log`, default range | `now 74g / low 74g / high 77g / change -1.3%`, `The window holds 6.2 h of quotes, so change is measured over that span.`, `No sell price 09:01–10:52 UTC.`, footer `snapshot 11:18 UTC · 24h, 132 snapshots`, image `Pine log — 24h` rendered 512×203 |
| `/graph item` 7d | range menu → `7 days` | re-rendered in place (`(edited)`): `Pine log — 7d`, `Daily range bars, one per UTC day; the line joins the closes.`, `Priced days: 5 of the last 7.`, `last day 2026-11-18`, image 512×203 |
| `Post to channel` | button on the 7d card | public card `requested by @HRD Dee` with the same body and image |
| `/watch` | item `Pine log` → modal | modal `Watch Pine log`, threshold prefilled `74`; submitted `below` → `Alert armed — Pine log`, `A DM when the sell price  falls below 74g.`, `Sell price now 74g` |
| `/watchlist` | no options | `Your watchlist is empty` before; after `/watch`: `Pine log — below 74g · sell price 74` |
| `/unwatch` | item `Pine log` | `Alert removed — Pine log`, `No DM will fire for this item.`; `watchlists` went 1 → 0 |
| `/digest list` | no options | `Every 60 minutes · 1 channel subscribed.`, `#digest — last digest 10:53 UTC` |
| `/vault list` | no options | `0 of 5 channels subscribed · 0 clans.`, `No channel follows a clan vault yet.` |
| `/help` | no options | all eight commands grouped Market / Server / Clan vault, `Access is set in Server Settings > Integrations · one channel per server`, `5 uses per minute (except /help) · digest and vault post publicly` |
| `@mention` | `@DIH pine log` | public showcase `Idle Clans market intel`, `Free · every answer comes from the same 2-minute snapshot.`, `Add to server` / `Community server` links — a pitch, not an item answer, which is the designed behaviour |

### 7.3 Findings from this pass

1. **The daily card calls the last close `now`.** `graph.ts:304` takes `closes[closes.length - 1]`
   and line 311 prints it as `now`, so the 7d card read `now 99g` while the live ask was `74g`.
   The footer names the day (`last day 2026-11-18`), but the word `now` is the wrong word for a
   close. **Fixed 2026-11-21** — the row now reads `close`, and the card carries the buy side
   (`buy`, `spread`) off `price_daily.bid_close`; see §7.5.
2. **`trade avg 0g` for an item that never traded.** `theme.ts:105` prints whatever the game
   published; for an item with no trades the game publishes `0`, so the card read
   `trade avg 1d 0g · 7d 0g · 30d 0g · 0 traded (1d)`. A zero average reads like a traded price
   of zero, which is the `0 = no offer` hazard applied to the trade series.
3. **Double space in the `/watch` confirmation** (`watch.ts:166`): `the sell price  falls below`.
4. **`AGENTS.md` lists `/price-list` as one of this bot's commands.** `src/commands/` holds eight
   and `registerCommands.ts` registers those eight; `/price-list` in this guild belongs to the
   `Phoenix` bot. `## 2` of this file already had the right count.

### 7.4 Not exercised in this pass

`/digest add`, `/digest remove`, `/digest interval`, `/vault add`, `/vault remove` — all
state-changing and Manage-Server gated. `digest_channels` held 2 rows and `vault_channels` 0 at
the end of the pass, so nothing was left subscribed by the test.

## 7.5 Chart v2 re-check (2026-11-21)

Driven in `#digest` on the rebuilt image, item `Pine log`, one invocation and then the range
select twice. Nothing was posted to the channel.

| Step | How | Observed |
|---|---|---|
| 24h card | `/graph item: Pine log` | `sell   69g` / `buy    57g` / `spread 12g (17%)` / `low    69g` / `high   77g` / `change -8.0%`; `The window holds 10.3 h of quotes…`; `No sell price 09:01–10:52 UTC.`; footer `24h, 256 snapshots`; image 512×203 with a visible break at the gap |
| 7d card | range select → `7 days` | re-rendered in place: `close  99g` / `buy    55g` / `spread 44g (44%)` / `low    51g` / `high   254g`; `Priced days: 5 of the last 7.`; `last day 2026-11-18` |
| 30d card | range select twice → `30 days` | `Pine log — 30d`, `change -1.0%`, `Priced days: 6 of the last 30.`, same image size |
| `price_daily.bid_close` | `SnapshotStore.dailyHistory(122, 7)` inside the container | three rows carried `bidClose` 42 / 42 / 43 against closes 82 / 43 / 91 — the buy row is real data, not a stub |
| Type at the reader's size | the delivered 512 px WebP, read directly | title, legend (`Sell price`, `Day range`, `Units on sale`), `Price (g)`, `On sale` and the x labels all legible; nothing unreadable |
| Legend / x-label spacing | bottom-left crop at 4× | two separate rows with a ~5 px gap at 512 px — tight, **no glyph collision**, so the layout was left alone |
| Renderer timeout | `[GRAPH] chart image: the renderer gave no image` | one QuickChart call timed out at 2.5 s and the local encoder produced the PNG; the card still rendered |

Two notes for whoever repeats this. A select driven with synthetic `dispatchEvent` clicks fires
the handler more than once, and the second call hits `10062 Unknown interaction` — that error in
the log is the test driver, not the bot; a single trusted click or `Enter` renders fine. Not
exercised here: an item whose name is long enough to wrap the title, and a 24h card for an item
with no buy order at all.

## 7.6 Wording pass after an owner read (2026-11-21, later)

The owner read the delivered 30d image and asked what the window meant. The card said `30d` while
the axis ran Nov 12 → Nov 18, so the title and the picture disagreed.

| Step | How | Observed |
|---|---|---|
| 24h card | `/graph item: Pine log` on the rebuilt image | `Pine log — sell price, last 24 hours`, image 512×203 with caption `10.8 h of quotes in this 24 h`; the axis now runs the full 24 h, so the suspend gap is a blank half rather than a shorter series |
| 30d card | range select → `30 days` | `Pine log — sell price, last 30 days`, caption `6 of the last 30 days priced`, axis `Oct 22 → Nov 21`, legend `Sell price` / `Day low–high`; the six priced days sit in the right fifth, which is the truth about the table |
| fence | same card | `Each bar is that day’s low to high; the line is that day’s close.` replaced `Daily range bars, one per UTC day; the line joins the closes.` |
| renderer after the IPv6 fix | `docker compose exec -T bot node -e 'fetch(...)'` | `2606:4700:20::…` gave `ENETUNREACH`; with `NODE_OPTIONS=--dns-result-order=ipv4first` the same POST answered 200 / 13,424 B in 1.4 s, and the next live card came back 512 wide instead of the 480×110 local PNG |



## 7.7 Dense axis (2026-11-22)

| Step | How | Observed |
|---|---|---|
| 30d card | `/graph item: Pine log`, range `30 days` | `Pine log — sell price, last 30 days`, caption `7 of the last 30 days priced`, axis `Nov 12 → Nov 21` (nine days, not thirty), seven bars: dense and readable where the pinned-axis build showed a blank panel |
| 24h card | default range | `19.0 h of quotes`, `No sell price 16:07–23:27 UTC.`, image 512×203 with the step break drawn at the hole |
| stale-card trap | first read after a rebuild | the ephemeral card fetched at 23:26Z was rendered by the **pre-rebuild** image (dist mtime 00:07Z) and still showed the old axis. Check the card's snowflake time against the image build before believing a render |

## 7.8 Chart v3 — the game's own series, checked live (2026-11-23)

`/graph` now draws the history endpoint's average traded price per bucket, at 900×260, by the
in-process encoder. The bot was rebuilt from `develop` (`0f9bed4`) and restarted before the pass
(commands re-registered globally, 8 commands). Driven in `#general` of `DeeLY's test server` with
the bot token, page 3 of the CDP session.

| Check | How | Observed |
|---|---|---|
| 24h card | `/graph item: Coal ore`, default range | `Coal ore — average traded price, last 24 hours`, `Average traded price per 30 minutes; the bars are units traded.`, `+0.0% over 24 hours · traded 144g to 150g`, fence `last 145g / low 144g / high 150g / volume 14.42m units`, `49 buckets of 30 minutes · 2026-11-22 00:30 → 2026-11-23 00:30 UTC`, footer `Traded prices · 30 minutes buckets · last 2026-11-23 UTC`, PNG attached (512×148) |
| 1y card | range select → `1 year` | same message re-rendered in place: `last 1 year`, `Average traded price per 1 week`, `+9.0% over 1 year · traded 99g to 190g`, `last 146g / low 99g / high 190g / volume 4.78b units`, `53 buckets of 1 week · 2025-11-20 → 2026-11-19 UTC`, new attachment 512×148 |
| 7d card | range select → `7 days` | `last 7 days`, `-1.4% over 7 days · traded 143g to 150g`, `last 144g / low 143g / high 150g / volume 93.41m units`, `29 buckets of 6 hours · 2026-11-16 → 2026-11-23 UTC`, attachment replaced |
| 30d card | range select → `30 days` | `last 30 days`, `-1.4% over 30 days · traded 143g to 153g`, `last 144g / low 143g / high 153g / volume 442.97m units`, `31 buckets of 1 day · 2026-10-24 → 2026-11-23 UTC` |
| site parity | `idleclans.com/market/31` against the cards | 1y: site `+9.0% over 1y`, `traded 99 to 190`, `volume 4.78b`, 53 points — identical. 1d: site `0.0% over 24h`, `traded 144 to 150`, 49 points — identical. 30d: traded range `143–153` on both; the percentage differs because the window rolls (the site row is cached 8–14 min behind) |
| image | downloaded the attachment | 512×148 lossless WebP: amber line 2 px over the panel wash, slate volume bars at 60% of the step, no text, no axis — the vendor page's information design |

Two driver notes. The range select needed a synthetic `pointerdown`/`click` pair (the CDP click tool
timed out on a screenshot mid-pass); the card text reads stale for up to ~3 s after the click until
the fetch lands, so poll for the new title rather than reading once. And the first attempt typed
`1y` into the range option, which Discord's static choice list rejected — the item stayed selected
and the default 24h was sent.
