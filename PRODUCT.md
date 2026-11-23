# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Idle Clans players on Discord. The public bot can be invited to any server, and the primary user
is a market trader or clan lead who reads prices daily and wants the numbers without trusting a
third-party estimate. Secondary: clan members who consume the vault feed and the digest channel.

## Product Purpose

Report Idle Clans market facts inside Discord: what an item costs right now, how it moved today,
what its materials cost, and when a price crosses a line the player set. Success is mixed and all
three count — retained week-over-week use of the commands and the watchlist, growth in invites and
in servers that keep a digest channel configured, and answers that match the in-game market
exactly (proved by tests and docs, never by assertion).

## Positioning

Facts, not forecasts. Every number printed is a market fact or arithmetic over market facts, and
every answer comes from the same two-minute snapshot, so two players comparing notes in the same
minute see the same price. A neighbouring profit calculator cannot truthfully copy this because
its output *is* the unverifiable part: this product was built after a profit command proved wrong
by 720,000× and has refused to reintroduce one. The DB is also the only long-term price record —
the upstream serves raw prices only live — which no read-only scraper can offer.

## Operating Context

Slash commands in servers and threads; opt-in DMs for alerts; one digest channel per server; up to
five vault-feed channels per server, 14-day window. Prices come from the Idle Clans API and are
polled every two minutes; the market is read in-game and by clan-mates comparing the same snapshot.
Distribution is a public listing (top.gg) plus the README and repo docs. Self-hosters deploy via
`scripts/deploy.sh`; a push does not deploy.

## Capabilities and Constraints

Ships `/price`, `/graph`, `/watch`, `/unwatch`, `/watchlist`, `/digest`, `/vault`,
`/help`, and an @mention public showcase embed. No profit advice, no profit estimate, no
undisclosed formula (decision D3); no game formula may be applied without an explicit user input
or a stated assumption. Units are strict: ask = `lowestSellPrice` = "sell price", bid =
`highestBuyPrice` = "buy order", never mixed with a trade average; "buy price" is banned. A price
of `0` means "no offer", never "free". Tradeable comes from `items.tradeable`, not from having a
quote. A blocked DM alert is recorded `delivered = false`, shown in `/watchlist`, and never
posted publicly. Runtime is TypeScript on Node >= 22 (the image and the test toolchain share one line: vitest 4 needs `Map.groupBy`, Node 21+), CommonJS, discord.js v14, Postgres and
Redis, no new dependencies; MessageContent and ServerMembers intents stay off. Raw snapshots are
kept 30 days, `price_daily` forever, and a raw row is deleted only after its UTC day is archived
(both book sides) — price history is irreplaceable. Digest is capped at one channel per server.
Undecided/future: a web dashboard is a stated possibility; no date, no scope.

## Brand Commitments

Author: **HRDDee**. Community server: **the Horde server**, `https://discord.gg/fepAZKG2Ss` -- the
same URL the showcase button and `/help` use, and the Support Server field of the listing. It is an
Idle Clans **clan** server, not a bot support server: the in-game clan is `DeeCorp` today and is due
a rename to a Horde-standard name, so user-facing copy names the server, never the clan. There is no
dedicated DIH server yet; the plan is a bot category there (announcements, feedback) that reaches
the clan's members and the lurkers who visit it.

Name: Dee IdleClans Helper. User-facing copy (embeds, footers, README, Discord application
description) is English; internal agent docs are English too. Voice follows `docs/VOICE.md`;
marketing never frames a limitation as the pitch — "no notifications" and "no advice" are banned
as selling points (D5).

## Evidence on Hand

`docs/` (conventions, architecture, operations, data provenance, UI design, voice, marketing copy),
`docs/reference/idleclans-swagger.json` (upstream API), `docs/assets/marketing.png`, real measured numbers in
`ARCHITECTURE.md`/`OPERATIONS.md` (catalogue 676 tradeable vs 627 quoted; 43 items with no buy
order; rate table), and a ~400-test suite. There are no customers, testimonials, press mentions
or benchmarks on hand — future work must not fabricate any.

## Product Principles

1. A number is a fact or arithmetic over facts; when it cannot be sourced, it is not printed.
2. Like-for-like or nothing: never compare an ask to a trade average.
3. Every player reading the same minute sees the same numbers.
4. The record outlives the session: archive both sides before deleting anything.
5. The bot reports; the player decides.

## Accessibility & Inclusion

Embeds must hold up in Discord's dark and light themes and at mobile width; colour and chart
choices follow `docs/UI-DESIGN.md`, and no state may be conveyed by colour alone.
