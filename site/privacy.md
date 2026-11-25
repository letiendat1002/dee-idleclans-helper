---
---

# Privacy Policy

Dee IdleClans Helper ("the bot") is a free Discord bot that reports Idle Clans market data. It is
run by an individual developer ("we"). It is not affiliated with Idle Clans or with Discord.

Last updated: 2026-11-25.

## What the bot stores

| What | Why | How long |
| --- | --- | --- |
| Your Discord user ID, the item you watch, `below`/`above`, your threshold, the arm state and the last time an alert fired | send you a DM when the price crosses your threshold | until you remove it with `/unwatch` |
| Guild ID, channel ID, the ID of the member who added it, the digest cadence | post the market digest to a channel on your cadence | until it is removed with `/digest` |
| Guild ID, channel ID, clan name, the ID of the member who added it | post a clan vault log to a channel | until it is removed with `/vault` |
| Clan log lines: in-game member names, item names, quantities, timestamps | de-duplicate vault posts | 14 days |
| Market prices and the item catalogue | price, chart, digest and alert answers | price samples 30 days; daily rollups kept |

The bot does **not** store message content, DM history, email addresses or payment details. It does
not request Discord's Message Content or Server Members intents.

## Where the data lives

A PostgreSQL database and a Redis cache on the operator's own server. Nightly database dumps are
encrypted and uploaded to Backblaze B2: daily dumps are deleted after 30 days, one table-only dump
per month is kept as a long-term restore point.

## Who else sees it

- Discord, to receive and answer your commands and to deliver DMs.
- The public Idle Clans API, to read market prices and clan logs. Only item ids and clan names are
  sent; no Discord user data.
- Backblaze, as the backup storage above.

No analytics, no advertising, no selling or sharing of data with anyone else.

## Your choices

`/unwatch`, `/watchlist`, `/vault remove` and `/digest remove` delete what they name, immediately.
For anything else — including a full deletion of every row tied to your Discord ID — open an issue
on the repository or ask in the support server. We answer within 30 days.

## Children

The bot is not directed at anyone under 13, the minimum age for a Discord account.

## Changes

This policy is versioned in the public repository; the history shows every change and its date.

## Contact

- Repository issues: <https://github.com/letiendat1002/dee-idleclans-helper/issues>
- Support server: <https://discord.gg/fepAZKG2Ss>
