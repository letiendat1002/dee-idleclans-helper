# Dee IdleClans Helper — server guide

Everything a server owner or player needs, from the invite to every command.
Written against the shipped bot (**8 commands**, v1.1.0); every output below was
observed on a real server, not copied from the code.

---

## 1. What the bot is

It answers from the game's own market API, on a 2-minute snapshot:

- **Prices** — an item's sell price and buy orders right now, with the average
  traded price over 24 h, 7 d and 30 d.
- **Trends** — a price chart built from the game's trade history.
- **Alerts** — a DM when an item crosses a price you set.
- **Digest** — one channel per server gets the notable market moves, on a
  schedule you choose. It never pushes a notification.
- **Clan vault** — follows a clan's public vault log in a channel you choose.

It does **not** trade, read inventories, create channels, or forecast. Every
number comes from the same snapshot, so two players quoting a price in the same
minute see the same number.

---

## 2. Invite and first run

**Invite the bot.** Use the link on `/help` or:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=2147535872
```

That permission set is View Channel, Send Messages, Embed Links, Read Message
History and Use Application Commands — nothing else. The bot cannot create
channels, delete messages or manage roles.

**Create the channels first.** The bot will not create them for you:

| Channel | Needed for |
|---|---|
| `#market-digest` (or any text channel) | `/digest add` |
| `#clan-vault` (or any text channel) | `/vault add` |

The bot must be able to **View Channel** and **Send Messages** in that channel —
a per-channel overwrite later can take that away without any integration
setting changing, and the bot will say so when it cannot post.

**First run.**

```
/digest add channel:#market-digest
/digest interval hours:1 minutes:0
/vault add clan:<your clan> channel:#clan-vault
```

**Commands appear within an hour.** They are registered globally; a client that
cached the old list may need a reload.

**One bot per server.** The digest, vault and alert tables are keyed by server,
not by bot. Two copies of the bot (for example production plus a dev build) in
the same server share the same subscriptions and both post.

---

## 3. Commands

All commands are slash commands with autocomplete on item and clan names.
A rate limit of **5 invocations per minute per user per command** protects the
upstream API; a normal session never meets it.

### `/price` — right now

```
/price item:Teak log
```

Shows sell price with depth, best buy order, and the 1 d / 7 d / 30 d trade
average. A share button posts the card to the channel.

- `price` accepts an item name or an id.
- No sell order and no buy order prints a plain sentence instead of a card.

### `/graph` — trend

```
/graph item:Abyssal Maul range:7d
```

Draws the average traded price from the game's trade history, with the change
over the range and the traded price band. `range` is `24h`, `7d`, `30d` or `1y`;
the chart has buttons to switch range in place.

### `/watch` — a DM at your price

```
/watch item:Abyssal Maul
```

Opens a form: type `above` or `below`, then the threshold (pre-filled with the
current sell price). The alert fires **once** when the price crosses, then
re-arms after the price moves back across your threshold.

- Alerts are per user, not per channel, and arrive as a DM.
- `/watchlist` lists your armed alerts; `/unwatch item:<name>` removes one.

### `/digest` — scheduled market moves

| Subcommand | Does |
|---|---|
| `add channel:<#channel>` | subscribe a channel (max **1 per server**) |
| `remove channel:<#channel>` | unsubscribe |
| `list` | show the subscription and interval |
| `interval hours:<n> minutes:<n>` | `hours` 0–24 required, `minutes` 15/30/45 optional — any quarter hour from 15 min to 24 h |

Posts only when there are notable moves, always in one message, never as a
notification. Requires **Manage Server** to change; anyone can read `list`.

### `/vault` — clan vault log

| Subcommand | Does |
|---|---|
| `add clan:<name> channel:<#channel>` | follow a clan (max **5 channels per server**) |
| `remove clan:<name> channel:<#channel>` | stop following |
| `list` | show what this server follows |

The bot reads the game's public clan log: a **14-day window**, and an entry can
arrive up to about **30 minutes late**. Requires **Manage Server** to change.

### `/help`

Lists the commands and the invite link. Also answers an `@mention` with the same
overview.

---

## 4. Limits, in one place

| Thing | Limit |
|---|---|
| Commands per user per minute | 5, per command |
| Digest channels per server | 1 |
| Vault channels per server | 5 |
| Digest cadence | any quarter hour, 15 min – 24 h |
| Snapshot freshness | ~2 minutes |
| Alert check | every 2 minutes |
| Vault log window | 14 days, entries up to ~30 min late |

---

## 5. Data and privacy

Stored: server id, channel id, user id, item ids, your alert thresholds and the
digest/vault subscriptions. Not stored: message content, usernames, inventories
or anything about your game account. Price data is public market data. Removing a
subscription deletes its row; alerts are deleted by `/unwatch`.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A command is missing | global commands propagate up to an hour | reload Discord; re-invite if the app was added after the cache |
| "I need Send Messages in this channel" | channel overwrite denies the bot | grant View Channel + Send Messages to the bot in that channel |
| "The bot cannot create channels" | by design | create the channel yourself, then run the command again |
| Digest never posts | not subscribed, or no notable moves in the interval | `/digest list`; lower the interval |
| No DM for an alert | DMs from server members are off, or the price never crossed | enable DMs for the server; `/watchlist` to confirm it is armed |
| Vault post is late | the game's clan log lags up to ~30 minutes | wait; the window is 14 days |
| "Slow down. Try again in Ns." | 5/minute rate limit | wait N seconds |

---

## 7. FAQ

**Does it forecast prices?** No. It reports the snapshot and the trade history;
the assumptions behind every derived number are printed on the card.

**Can it post to more than one digest channel?** One per server. Use the vault
channels or a second server for more.

**Can I self-host it?** Yes — see [SETUP.md](SETUP.md) and
[ENVIRONMENTS.md](ENVIRONMENTS.md).

**What changed recently?** [CHANGELOG.md](../CHANGELOG.md).

---

Maintainer notes for this document live in [DISCORD-TESTING.md](DISCORD-TESTING.md)
(how each behaviour was verified) and [ARCHITECTURE.md](ARCHITECTURE.md) (how the
bot is built).
