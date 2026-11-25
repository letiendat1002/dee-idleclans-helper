# Dee IdleClans Helper — Agent Guide

Who reads this: every agent starting work in this repo — when: before the first tool call, and again after a compaction.
Neighbours: [docs/CONVENTIONS.md](docs/CONVENTIONS.md) · [docs/ROADMAP.md](docs/ROADMAP.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DEFERRED.md](docs/DEFERRED.md).

**`docs/CONVENTIONS.md` is the binding source of truth.** Read it before implementing anything in
this repo. This file is only the map: what the project is, the five rules that would break it, and
where every other doc lives. The conventions win over anything written here.

## What this project is

A Discord bot that reports Idle Clans market facts: sell price, buy order, a 24h / 7d / 30d / 1y
chart per item, opt-in DM price alerts, a market digest, a clan vault log, and a public showcase
embed on @mention. Every number it prints is a market fact or arithmetic over market facts: no
profit advice, no forecast, no undisclosed formula.

## The five rules that break the product if violated

Each rule is owned by a section of `docs/CONVENTIONS.md`; that section is the text to follow, this
list is only the pointer.

1. **Like-for-like units.** Never compare an ask (`lowestSellPrice`, what a buyer pays) with a
   trade average (`dailyAveragePrice` / `averagePrice`, a different unit), and never confuse the
   ask with the bid. Owned by `docs/CONVENTIONS.md` §2.2.
2. **No unmodelled, undisclosed formula.** Research the mechanic first
   (`docs/GAME-MECHANICS.md`), then model it behind an explicit user input or disclose it in the
   assumptions line; the only unconditional derived rate is
   `3,600,000 / (baseTimeMs × itemAmount)`, labelled "base task time". Owned by
   `docs/CONVENTIONS.md` §2.3.
3. **A price of `0` means "no offer", never "free", and item id `0` is a real item.** Filter zeros
   out before any average and never guard an item id with `id <= 0`. Owned by
   `docs/CONVENTIONS.md` §3.
4. **Tradeable comes from the catalogue** (`items.tradeable`), never from "this item has a quote".
   Owned by `docs/CONVENTIONS.md` §3.
5. **A blocked DM is never made public.** Mark `delivered = false`, surface it in `/watchlist`, and
   never post a public fallback. Owned by `docs/CONVENTIONS.md` §2.5.

## Docs map

Every doc below carries a "Who reads this" line and a "Neighbours" line at the top. Read what the
task touches, not everything.

| File | Who reads it | When |
| --- | --- | --- |
| `docs/CONVENTIONS.md` | any agent writing, reviewing or releasing a change | before the first edit, and before a commit |
| `docs/ROADMAP.md` | an agent starting or resuming a session | at session start and after every compaction |
| `docs/ARCHITECTURE.md` | an agent changing a flow, poller, table, cache key or budget | before that change |
| `docs/VOICE.md` | anyone writing a user-facing string | before shipping copy |
| `docs/UI-DESIGN.md` | an agent touching an embed, chart card, DM or label | before editing a surface |
| `docs/CHART.md` | an agent changing a chart series, caption, bucket or window | before editing `/graph` code or copy |
| `docs/DATA-PROVENANCE.md` | an agent adding or defending a printed figure | a number has no traceable source |
| `docs/GAME-MECHANICS.md` | an agent modelling a game formula or modifier | before adding a derived number |
| `docs/DEFERRED.md` | an agent deciding whether a known problem can wait | before re-opening a parked item |
| `docs/DISCORD-TESTING.md` | an agent verifying a command on real Discord | before claiming a live behaviour |
| `docs/ENVIRONMENTS.md` | an operator running, cloning or rotating a stack | production-versus-dev, a second stack, a token rotation |
| `docs/SETUP.md` | an operator or contributor running the bot | first run on a new machine |
| `docs/GITHUB-SETUP.md` | a maintainer changing a repo setting or workflow | before editing `.github/` or repo config |
| `docs/GUIDE.md` | a server owner or player | installing and using the bot |
| `docs/DIGEST-CONFIG-DESIGN.md` | an agent changing `/digest` behaviour or its permissions | before editing the digest command, table or job |
| `docs/MARKETING-COPY.md` | whoever edits a listing surface | before publishing copy |
| `PRODUCT.md` | anyone deciding what the bot is for, or writing listing copy | positioning, users, brand commitments |

`CONTRIBUTING.md` is the human front door, `SECURITY.md` the private-report path, `CHANGELOG.md`
the release record.

Deploy, release, operations, legal, competitor research, the vendor API spec and the marketing
assets are **not in this repository**; they live in the maintainer's private notes, versioned in
the private repository `dee-idleclans-private` (`docs/CONVENTIONS.md` §1). A doc that needs one of
them names what it needs instead of linking a path that does not exist here.

## Maintenance notes: the derived index (graphify)

`graphify-out/` is a derived index and gitignored; the docs above stay the source of truth.
`graphify update .` refreshes **code only** -- after editing any `.md`, the doc nodes hold the old
text until a semantic pass runs.

Refresh recipe (verified 2026-11-17 at 940 nodes / 2116 edges / 76 communities):

- Code layer: `graphify update .`. Doc layer: re-extract only the changed docs, then merge with
  `build_merge(prune_sources=None, root=INPUT_PATH, directed=False)`.
- `build_merge` drops every node **and edge** whose `source_file` is one of the re-extracted files,
  matched on the edge's own `source_file`. Re-emit all of them, cross-file edges included, or they
  disappear without an error.
- **Never re-run `cluster()` on a curated graph.** It renumbers communities and duplicates labels.
  Keep the existing partition and assign new nodes to the majority community of their neighbours.
- `graphify update .` can drop labels for communities it touches; if a curated cluster loses its
  name, restore it in `.graphify_labels.json` **and** set `community_name` on those nodes.
- Delete dated snapshot dirs under `graphify-out/` (`graphify-out/2026-11-16/`): a run read one and
  spent its time comparing against a stale graph.
- `graph.html` only regenerates on `graphify update` or `graphify export html`; after a manual label
  fix, run the export or the visual index disagrees with `graph.json`.
- `manifest.json` is flat -- every top-level key is a file path. Do not add metadata keys.
