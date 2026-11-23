# The `/graph` chart — what it draws, and why it looks like this

`docs/UI-DESIGN.md` owns how the card looks. This file owns what the picture *means*, what the
data can support, and every decision that shaped it. Read it before changing a series or a caption.

## What is on the card

| Element | Meaning |
|---|---|
| title | `<item> — average traded price, last <window>` |
| first subtext | the bucket the line is drawn in, and that the bars are units traded |
| meta line | the change from the first bucket to the last, and the price range that traded |
| `last` | the average traded price of the newest bucket |
| `low` / `high` | the lowest and highest price any bucket traded at |
| `volume` | units traded across the window |
| second subtext | how many buckets were drawn, and the span they cover |
| footer | the series, the bucket, and the newest bucket |
| image | 900×260 PNG: the average traded price as a line with a wash under it, volume bars below |

## The series is the game's, not ours

`/graph` reads `GET /PlayerMarket/items/prices/history/{id}?period=…`. The game decides the bucket
and the depth, and neither is configurable:

| range | period | bucket | points | depth |
|---|---|---|---|---|
| 24h | `1d` | 30 minutes | 49 | 24 hours |
| 7d | `7d` | 6 hours | 29 | 7 days |
| 30d | `30d` | 1 day | 31 | 30 days |
| 1y | `1y` | 1 week | 53 | 365 days |

Only those four values are accepted; `90d`, `2y`, `3d` and `all` answer **HTTP 400**. A bucket in
which nothing traded is **absent from the payload**, not zero — Refined crafting needle returns 41
of 53 weekly buckets. The line connects across a missing bucket, exactly as the vendor page does.

**These are trade averages, never asks.** `averagePrice` is the mean of prices that actually
traded; `lowesSellPrice` / `highestSellPrice` are the trade low and high of the bucket (the vendor
spells the field that way). Comparing one of them with an ask is the unit error that killed v1's
`/profit`, so the title says "average traded price" and the fence never says "sell".

## Why it looks like the vendor page

Measured from `idleclans.com/market/<id>`, not invented: 900×260, first and last point 8 px in from
the edges, price band 10–190, volume band 231–260, bars 60% of the point spacing, line `#f0b429`
2 px, wash `rgba(240,180,41,0.12)`, bars `rgba(174,191,200,0.35)`. **No y axis, no grid, no ticks**
— the vendor page carries the numbers in the HTML around the SVG, and so does this card. One
deliberate difference: the vendor prints only day-and-month on the axis, so a one-year chart reads
"20 Nov … 19 Nov" with no year; this card prints `YYYY-MM-DD` and includes the span in the subtext.

## Why the in-process encoder, not a renderer

The vendor's picture contains no text at all, so a font engine buys nothing: every label lives in
the embed. `src/ui/chartHistory.ts` therefore draws the geometry into an RGBA buffer at 2× and
averages it back down (that is the antialiasing), then encodes with the in-process PNG writer. No
network call, no rate limit, no dependency, and the same bytes every time.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-11-22 | Series moved from our own `price_snapshots` / `price_daily` to the game's trade history | our tables start 2026-11-12, so a year view was impossible; the game publishes a year, at weekly resolution |
| 2026-11-22 | The QuickChart render is gone; one in-process raster draws every range | the vendor chart has no in-image text, so the renderer's only advantage disappeared, and with it a network dependency and its failure mode |
| 2026-11-22 | A flat series is drawn, not replaced by a sentence | vendor parity, and the fence already states `low`, `high` and `change`; supersedes the "nearly flat, no image" rule that existed when the picture carried no numbers |
| 2026-11-21 | No candlesticks | the vendor page draws none, and `price_daily` mirrors laptop sleep |
| 2026-11-20 | The bid is not a second line | on one scale a 23% spread compresses a 3% day into four pixels; the other side of the book stays a number |
| 2026-11-20 | The window is pinned, never auto-fitted to the data | an auto-fit makes a 2% move look like a collapse |

## What the data cannot support

- **Daily history older than 30 days does not exist** upstream. `price_daily` may never be
  backfilled from this endpoint (D14): its open/close/low/high are ask-based, the endpoint is
  trade-based, and a year of weekly trade averages is not a year of daily closes.
- A year view is weekly. A one-week spike is invisible in it.
- Our own `price_daily` and `price_snapshots` remain the source for alerts and the digest; they
  answer "what is listed now", which the trade history never does.

## Where the code is

- `src/services/IdleClansApi.ts` — `getTradeHistory` and `getTradeHistoryCached` (per-window TTL,
  10 calls/minute budget kept apart from the poller's).
- `src/ui/chartHistory.ts` — geometry, raster, PNG encoder, `tradedRange`.
- `src/commands/graph.ts` — the card, the range menu, the share button.
- Tests: `src/ui/chartHistory.test.ts` (geometry, colours, flat, sparse, bars),
  `src/commands/graph.test.ts` (card text, windows, absence paths, controls).
