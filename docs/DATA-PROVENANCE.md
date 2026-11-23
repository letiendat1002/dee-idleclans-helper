# Data provenance — every figure the bot prints

The bot reports market facts. Every number must trace to a source; this file records that source
and when it was last checked. If a number is not in this table, the bot must not print it.

**Last live verification:** `2026-11-14T02:06:13Z` — `game-data` build **1.6800**,
`/Configuration/market-settings` → `sellTaxPercentage: 1`.

## 1. Market figures

| Figure | Source | Field | Verified | Observed at the check |
|---|---|---|---|---|
| Ask (what you pay) | `GET /PlayerMarket/items/prices/latest` | `lowestSellPrice` | live | 626 items returned |
| Bid (what you receive) | same | `highestBuyPrice` | live | 41 items at `0` (= no buy order) |
| Ask depth | same | `lowestPriceVolume` | live | 28 items at `lowestSellPrice: 0` (= no sell order) |
| Bid depth | same | `highestPriceVolume` | live | — |
| Sell tax | `GET /Configuration/market-settings` | `sellTaxPercentage` | live | `1` (percent, sell side, offers ≥ 100 gold) |
| 24h average ask / range | our own `price_snapshots.ask` | derived | **partial** | the window is 24 h *of rows we hold*; after an outage it is shorter (see audit finding 7). `/graph` now prints the covered span instead of calling a 1.7 h move a 24 h move; measured 2026-11-21: 52 polls / 1.65 h in the window, **609 of 609** quoted items under 20.4 h |
| Trade average 1d/7d/30d | `GET /PlayerMarket/items/prices/latest/comprehensive/{id}` | live, **cached 5 min** | `dee:averages:<id>`, TTL 300 s, behind a 20 calls/min budget that answers "no average" rather than waiting; a failed call is a missing line, never a failed card |
| Trade average | **never used** | `dailyAveragePrice` / `prices/summary` | rejected by design | not read anywhere in `src/` |

| Figure (unused) | Source | Field | Verified | Note |
|---|---|---|---|---|
| Traded prices (daily/half-hour) | `GET /PlayerMarket/items/prices/history/{id}?period=1d\|7d\|30d\|1y` | `lowesSellPrice`, `highestSellPrice`, `averagePrice`, `tradeVolume` | 2026-11-21, live | **trades, not listings** — Pine log 23:00–23:30 UTC: vendor 57 / 68 / 63 against our `ask 68 · bid 57`; `averagePrice` tracks the printed `trade avg 1d`; `tradeVolume` is units traded, not `ask_volume`. Reaches back a year, but the bucket widens with the window (30 min / 6 h / 1 day / 1 week) and other `period` values answer 400. **`/graph` reads it**; it may still never backfill `price_daily` (D14), whose open/close/low/high are ask-based |

## 2. Catalogue figures

| Figure | Source | Verified | Observed |
|---|---|---|---|
| Items | `GET /Configuration/game-data` + `/Items/metadata` → `items` | live (build 1.6800) | **1009** |
| Craftable outputs | same, `ItemReward > 0`, `BaseTime > 0`, ≥1 cost | live | **189** |
| Tradeable | `/Items/metadata`.`tradeable` → `items.tradeable` | live | **676** |
| Craftable **and** tradeable (the autocomplete set) | join of the two above | live | **161** |
| Display name | `/Items/metadata`.`name` | live | contract: ≤100 chars, no duplicates (max 44) |
| Recipe costs | `game-data.Tasks.*.Items[].Costs[].{Item,Amount}` | live | potion 410 = 135×15, 274×10, 2×2 |
| Level requirement | `game-data…LevelRequirement` | live | potion 30; titanium arrow 65 and 70 |
| Skill per recipe | `game-data…Skill` | live | potion 19 (Brewing); arrow 7 (Crafting) |
| Base task time | `3,600,000 / (BaseTime × ItemAmount)` | live | potion `72,500 ms` → 50/h |
| Category | derived from the producing skill | live | `deriveCategory()` |

**The counts drift.** On 2026-11-13 the same checks gave 627 quoted / 27 ask-0 / 43 bid-0 /
110 volume ≥ 1000; on 2026-11-14 they gave 626 / 28 / 41 / 111; on 2026-11-21 they gave
632 / 24 / 47. Treat every count in the docs as "as observed on <date>", never as a constant. No
code hard-codes them: the digest computes its eligible count at runtime.

**Coverage drift matters as much as counts.** On 2026-11-21 the raw table held 52 polls in the
previous 24 h (the bot was down on 11-19 and 11-20), so every quoted item's window covered
1.65 h. A 24 h card must never present that as a day's move: it prints the span it actually has.

## 3. Modifier figures (R53)

`docs/GAME-MECHANICS.md` is the authority: 37 mechanics, each with its source (wiki page or
game-data field) and a confidence class. Ten negative findings record what does **not** exist.
The 13 open gaps are listed there (§7) and are never guessed in code.

| Modifier | Mechanic id | Source | Status |
|---|---|---|---|
| Guardian's brewing spoon | M04 | wiki `Guardian's_brewing_spoon` + game-data item 741 | wiki-only, modelled |
| Delicate manufacturing | M06 | wiki `Delicate_manufacturing` | wiki-only, modelled |
| Arrow crafter | M07 | wiki `Arrow_crafter` | wiki-only, modelled |
| Smelting magic | M23 | wiki `Smelting_magic` + `Upgrades.Items` type 10 | verified-live, expected value |
| Potion of forgery | M24 | wiki `Potion_of_forgery` + `PotionData` id 3 | verified-live, expected value |
| Rounding of a fractional ingredient | gap U1 | — | **unknown** → labelled "expected", never guessed |

## 4. Item ids used in code and tests

All confirmed in `items` at the check above.

| Id | Name | Tradeable | Skill |
|---|---|---|---|
| 2 | Chestnut log | yes | 8 |
| 31 | Coal ore | yes | 12 |
| 42 | Titanium ore | yes | 12 |
| 46 | Titanium bar | yes | 13 |
| 135 | Cabbage | yes | 15 |
| 265 | Titanium arrow | yes | 7 (2 recipes) |
| 274 | Enchanted flax | yes | 14 |
| 410 | Potion of resurrection | yes | 19 |
| 741 | Guardian's brewing spoon | yes | 19 |
| 927 | otherworldly_bar | yes | 13 |

## 5. Test fixtures

| Fixture | Where | Provenance |
|---|---|---|
| `POTION_QUOTES` 11,197 / 420 / 115 / 118 | `CraftAdvisor.test.ts` | live-verified on 2026-11-13 (the market has since moved) |
| `BAR_QUOTES` 3,389 / 690 / 148 | `CraftAdvisor.test.ts` | live-verified on 2026-11-13 |
| `AMULET_QUOTES` 400 / 32 / 27 | `CraftAdvisor.test.ts` | live-verified on 2026-11-13 |
| `DOC_QUOTES` 11,454 / 496 / 141 / 116 | `CraftAdvisor.test.ts` | the worked example in `GAME-MECHANICS.md` §6 (2026-11-14) |
| ids 9996 / 9997 / 9998 | `CraftAdvisor.test.ts` | **synthetic** — structural fixtures, not market data |
| digest/alert/mention fixtures | those test files | **synthetic** — deterministic shapes |

A test never asserts a live price; it asserts arithmetic over a fixture. The live values above are
recorded so the fixtures can be refreshed against a real market day.
