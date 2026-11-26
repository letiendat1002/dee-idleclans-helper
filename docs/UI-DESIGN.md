# UI design

Who reads this: an agent touching an embed, a chart card, a DM or a user-facing label — when: before editing any surface, and before choosing a new style, palette or icon.
Neighbours: [VOICE.md](VOICE.md) · [CHART.md](CHART.md) · [PRODUCT.md](../PRODUCT.md) · [CONVENTIONS.md](CONVENTIONS.md).

This file is the **design system of record** for the bot. Product context (users, positioning,
constraints, brand commitments) lives in `PRODUCT.md` at the repo root; do not create a second
`DESIGN.md` or a duplicate brand page -- a future session reads this file and `docs/VOICE.md`. — Dee IdleClans Helper

An embed is the whole UI. Discord gives us one colour bar, one author line, a title, a
description, up to 25 fields, one footer and one image/thumbnail per embed — no fonts, no CSS,
no spacing control. The design below works inside those limits.

Binding rules from `docs/CONVENTIONS.md` still win: no profit advice, no unmodelled formula,
`0` means "no offer", every number is a sell price, and the assumptions line is mandatory.

## Assessment of the current surfaces

| Surface | Now | Problem |
|---|---|---|
| `/watch` confirmation | green, three fields | "Your alert" / "Delivery" read like form labels; no "what happens next"; `Alert 1268` (internal id) in the footer |
| `/watchlist` | green, bullet lines, one long sentence per row | a wall of `•` text; DM-blocked and re-armed states are buried at the end of each line; no empty-state embed |
| `/unwatch` | plain text reply | the only market command without a card — inconsistent with every other response |
| `/digest` confirmation | green embed | fine, but "The bot cannot create channels" in the footer is an ops note, not user value |
| Digest post | **no colour**, fake-aligned table via padded spaces, footer | proportional font breaks the padding, so the table is ragged; no brand; arrows `▲▼` carry meaning but not colour |
| Alert DM | blue, one description block | title says "Price Alert — X" for both directions; the number the user waited for is the third line, not the title |
| `/profile` | `#5865f2` (Discord's own blurple) | brand colour borrowed from the platform; "Hours offline" is a raw number with `h` |
| `/help` | green, five text fields, timestamp | dense, undifferentiated; timestamp on a static reference is noise; no bot image |
| `@mention` showcase | blue, author line + thumbnail + description + two link buttons (`Add to server`, `Community server`) | the only public surface that advertises; the author line is what makes the reply recognisable, so it carries the name and avatar instead of repeating them in the title. The second button is the community server, not the game wiki: the label must name where it goes. The closing line claims only what is checkable -- every answer from the same 2-minute snapshot, so two readers in the same minute see the same number -- and not the price (`free`), which is the business model rather than a reason to install, nor "never stores your data", which the database contradicts |

Colour today means nothing: blue = info, green = success, blurple = borrowed, digest = none.

## Design system

One accent per embed, chosen by **state**, never by recommendation.

| Token | Hex | When |
|---|---|---|
| `brand` | `#6366F1` | market facts and reference surfaces (price, graph, digest post, help, showcase) |
| `success` | `#22C55E` | a user action that succeeded (alert armed, alert removed, digest enabled) |
| `warning` | `#F59E0B` | the data cannot carry the claim (thin market, no sell order, DM blocked, unfollowed item) |
| `danger` | `#EF4444` | the command failed |
| `muted` | `#64748B` | empty states |

Green is **never** used for "craft is cheaper": that would read as advice. The comparison stays
brand-coloured; only the market's own state (thin, missing, blocked) earns amber.

### Icons: custom application emojis

Unicode emoji render at whatever size and weight the client's font decides, so the same card
looked different on desktop, mobile and web. The bot now ships its own set as **application
emojis** on the Discord app (`POST /applications/{id}/emojis`, 128×128 PNG, one upload per icon),
so the artwork is identical everywhere and independent of the platform font.

Source: [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (Microsoft, MIT licence),
**Flat** variant rasterised from SVG at 128 px. Flat was chosen over the repository's 3D PNGs
because at Discord's ~16 px rendering size the 3D shading turns into mud, while the flat shapes
stay readable.

| Token | Fluent asset | Used for |
|---|---|---|
| `buy` | Money bag | `Buy ready-made` field, market list |
| `craft` | Hammer and wrench | `Craft it yourself`, showcase |
| `margin` | Abacus | `Margin` field, `/help` market block |
| `depth` | Bar chart | `Market depth` |
| `note` | Memo | `Assumptions`, craft modifiers |
| `wiki` | Link | item link, share block |
| `up` / `down` | Chart increasing / decreasing | price direction, alert DM |
| `alert` | Bell | alert surfaces, showcase |
| `watchlist` | Clipboard | watchlist list and empty state |
| `digest` | Newspaper | digest surfaces, `/help` server block |
| `paused` | Pause button | disarmed alert |
| `warning` | Warning | thin market, blocked DM, no sell order, every error reply |
| `clock` | Mantelpiece clock | fired alert, snapshot, rate limit |
| `lock` | Locked | level requirement |

**Platform limit that shapes the layout:** Discord expands `<:name:id>` only in embed
*descriptions* and *field names/values* — never in `title`, `author` or `footer`, where it shows
up as raw markup. Titles therefore carry no icon at all (they read better that way), and the
footer stays plain text.

The ids live in `src/ui/theme.ts`. Re-uploading an emoji creates a new id, so an icon swap means
editing that one file.

Brand line on hero surfaces: `setAuthor({ name: 'Dee IdleClans Helper', iconURL: <bot avatar> })`,
and `setThumbnail(<bot avatar>)` where text density allows it (help, showcase, empty state).
The avatar comes from `client.user.displayAvatarURL()`, so no asset is shipped and nothing goes
stale. Data-dense embeds (the digest table) keep the author line but skip the
thumbnail so the columns keep their width.

### Money and prices

Gold is written the way the game writes it: `formatMoney(1000)` → `1,000g`. No surface prints a
bare number as a price, and no surface appends the word "gold" to a figure. Rounding is
deliberate: a fractional figure is not a tradeable price.

Two units exist and never mix:

- **ask** — the lowest price someone is selling at, what a buyer pays. The code and the database
  call it `ask`; **the UI never prints that word**, it says *sell price* (`Sell prices · snapshot
  05:56 UTC` in the footer). Every table figure, every margin and every alert threshold is a sell
  price.
- **trade average** — the game's own `averagePrice1Day/7Days/30Days` from
  `/PlayerMarket/items/prices/latest/comprehensive/{id}`, the mean of prices that *traded*. It is
  labelled `trade avg` on its own line, with the window beside each figure (`1d 3,378g · 7d 3,391g
  · 30d 3,388g`), and is never compared with a sell price or used in a margin. A failed request omits the
  line; it never guesses one.

A third figure is not a third unit but the other side of the book: the **bid**, the highest price
someone is paying, i.e. what a seller receives. The UI says **buy order** (`Buy order 56g · 1,302
units`). It is not called "buy price": that reads as the price you pay when buying, which is the
sell price. Only `/price` prints a bid; every other surface quotes asks, because a comparison of
purchases compares asks throughout.

The brand appears once per embed: the author line. A title that repeats `Dee IdleClans Helper`
reads like a form letter, so a title names the surface or the subject instead (`Commands`,
`Market Watch — 08:26 UTC`, `Pine log — 24h`). Wording follows `docs/VOICE.md`.

Footer is provenance, not metadata: `Sell prices · snapshot 05:56 UTC`. Item ids, guild ids and
alert ids never appear in the UI; they belong in logs.

## Per surface

- **price** — brand colour; author line; title = the item name (`Teak log`), thumbnail allowed
  because there are two lines only; `Sell price **115g** · 20,367 units`, then
  `Buy order **56g** · 1,302 units`, then the trade averages on their own `-#` line; footer =
  provenance. A side with no order prints as a sentence (`No sell order right now.`) instead of a
  zero; both sides empty turns the card muted with `No sell order and no buy order right now.`
  Unknown depth prints the price alone rather than `0 units`.
- **graph item** — brand colour; author line; title `<item> — average traded price, last 24 hours`
  (the other ranges read `last 7 days` / `last 30 days` / `last 1 year`); the trend is an
  **attached PNG** (`chart.png`, 900×260) drawn in-process. The picture carries **no text at
  all**: an amber line `#f0b429` 2 px over a 12% wash of itself, slate volume bars
  `rgba(174,191,200,0.35)` below, no grid and no y axis — the same information design as the
  game's own market page, where every label lives in the HTML around the SVG. Geometry is
  measured from that page, not invented: first and last point 8 px in from the edges, price band
  10–190, volume band 231–260, bars 60% of the point spacing. The reader gets the numbers from
  the card: one subtext names the bucket (`per 30 minutes` / `6 hours` / `1 day` / `1 week`) and
  says the bars are units traded; a bold meta line states `**+9.0%** over 1 year · traded 99g to
  190g`; one **fenced block** carries `last` / `low` / `high` / `volume`; a second subtext states
  how many buckets were drawn and the span they cover (`53 buckets of 1 week · 2025-11-20 →
  2026-11-19 UTC`). The fence stays because it is the only monospaced surface Discord gives us,
  and it is safe here and only here: plain text, no custom emoji and no bold. Footer = `Traded
  prices · 1 week buckets · last 2026-11-19 UTC`. A window with nothing traded turns the card
  muted; a single bucket draws no image and says so in words. The span and the footer date carry
  a year whenever the window is longer than a day: the vendor page prints day-and-month only, so
  its one-year axis reads "20 Nov … 19 Nov", which this card does not copy. No thumbnail: at a
  309px message the avatar column took 80px of roughly 300, and the fence broke to one word per
  line — measured, not feared.
- **digest post** — author line; title `Market Watch — HH:MM UTC`; no fenced table. Each item is
  `<icon> **name**  avg → now  (+x.x%)` followed by two `-#` lines: `at 24h low · volume` (the
  average already appears in the row, so the second line does not repeat it), and
  `trade avg 1d · 7d · 30d` when the game published them; footer = provenance. The title prints
  the snapshot minute, the same source as the footer, so the two never disagree. The fence was
  removed on purpose: inside one, `<:name:id>` prints as raw markup and `**bold**` as asterisks,
  so the aligned columns cost the icons and the emphasis. The rows are allowed to sit ragged.
- **alert DM** — title carries direction and item: `Price Alert — <item>` with the icon set in the
  description; the crossing price is the first line in bold; average, range and volume as the
  evidence line; trade averages on their own line; re-arm rule last in muted italics. Footer =
  snapshot time.
- **watch confirmation** — success colour; title `Alert armed — <item>`; the threshold in bold
  as the first field; `Sell price now` and `What happens next` inline; no alert id.
- **watchlist** — success colour when every row is healthy, warning when a row is blocked or
  unfollowed; one line per item: `**Name** — above **1,194g** · sell price 3,395g` plus an
  indented state line only when something is wrong; empty state is a muted embed with the next
  step, not a bare string.
- **unwatch** — success or warning embed, same shape as watch, so the pair reads as one flow.
- **digest confirmation** — success colour; title `Digest on — #channel`; "what happens next"
  in the description; the ops note stays but moves to the description, out of the footer.
- **help** — brand colour, author line, thumbnail = bot avatar; one field per group, commands in
  inline code, the modifier list on its own line; the last field is `Links`, holding the invite,
  the community server as `Horde server` and one italic line `*Made by HRDDee*`; no timestamp, no intro
  paragraph -- a reader opened this to find a command. The credit is italic, not subtext: `-#`
  renders in embed descriptions (where the chart and price cards use it) and not reliably in field
  values, so the muted device does not apply here.

## Interaction — as built

Every command replies **ephemeral** except `/digest` and `/vault`, which post publicly by design.

**The range is a command option, and a menu.** `/graph item` takes `range` (`24h`, `7d`, `30d`,
`1y`, default `24h`), so the same answer is reachable from the palette, in a channel where the
message is never seen again, and with no component state. The card also carries a range select menu
(4 options, the current one marked default), so a reader already looking at a chart switches window
without retyping the command.

**`Post to channel`** sits on every public market surface: `/graph item` and `/price`. Never on `/watchlist`, `/watch`, `/unwatch` or `/help`: those hold personal state or
settings.

Constraints, all of them load-bearing:

- `customId` carries the item id (and the range on `/graph`), never the rendered card: the message
  outlives the process, so a restart must not leave a dead button.
- The menu acknowledges with `deferUpdate()` and edits with the new `files` **and** `attachments: []`;
  without the empty array Discord appends a second chart under the first instead of replacing it.
- The post is the same embed and PNG, prefixed by a muted `-# requested by @user`, and the ephemeral
  reply is edited to `Posted in #channel`.
- `SEND_MESSAGES` is checked before anything is rendered and the refusal names the permission.
- One post per user per card per minute (`src/ui/share.ts`). A muted `/price` card carries no button:
  it holds nothing to quote.
- No second rate limit: both controls spend the command's own 5-per-minute bucket, because the work
  is a DB read plus a render, not an upstream call.

Shared code: `src/ui/share.ts` (`shareButton`, `postToChannel`, `selfAvatar`); routes in
`src/index.ts` (`graph:range:`, `graph:share:`, `price:share:`).

**`/help` identity block** — built. `/help` ends with one `Links` field: the invite, the community
server as `Horde server` (the server's name, not the in-game clan's -- the clan is due a rename), and
one italic `*Made by HRDDee*` (italic because `-#` does not render in field values). No product
paragraph: `/help` is read to find a command, and `docs/VOICE.md` forbids pitching where information
belongs. The author line already carries the bot name and avatar, so the credit is a person, not a
second brand.

## /vault — the clan vault feed

- One embed per tick per subscribed channel; `/vault` accepts up to 5 channels per guild, and the
  clan log is fetched once per clan per tick and shared by every channel that follows it.
- Title `Clan vault — <clan>`, one line per new entry, footer `clan log · last 14 days`.
- No ping, no DM, no backfill: `vault_channels.created_at` is the line, so a channel added today
  starts at the next entry, not at the history.
- An empty tick posts nothing. A channel the bot can no longer post in (left the guild, lost the
  permission) is removed from the table instead of being retried every tick.
- A failed fetch logs and keeps the stored events; nothing is posted into the channel about it.

## What this deliberately does not do

- No thumbnails on the digest embeds — they would squeeze the evidence columns.
- No per-row colours in the digest: an embed has one accent, so direction is carried by `📈/📉`
  and the sign, which survives colour-blind readers and light/dark clients.
- No new copy claims: every label still describes a market fact. The assumptions block keeps its
  full text; it is only visually quieter.
- No chart library and no chart renderer. `/graph` used to POST a Chart.js config to QuickChart;
  since 2026-11-22 the picture is a 900×260 raster drawn by `src/ui/chartHistory.ts` at 2× and
  averaged back down. The vendor's own chart contains no text, so a font engine bought nothing:
  every label lives in the embed. Dropping the renderer removed a network dependency, its rate
  limit and its failure mode — the card can no longer lose its picture to a third party.
- No block-character plot. Tried first and dropped the same day: stacked `█` rows leave a gap at
  Discord's line height, so a multi-row plot reads as floating bars, and a 48-column line wraps on
  a phone, which is exactly what a fence cannot survive.
- No order-book ladder. Idle Clans Tools (`/price`) pages through ten sell and seven buy levels; the
  public API exposes one level per side, so DIH would have to invent the rest. It prints the level it
  has, with its volume, and says nothing about depth it cannot see.
- No multi-item graph, and no intraday history past 24 hours. The 7d and 30d ranges read the daily
  rollup instead — one row per UTC day, drawn as a close line with a low/high bar per day, and
  `Priced days: N of the last D` under it, so a thin week reads as thin instead of as a trend.
- No "post to channel" button on an ephemeral reply. Alerts are DMs and the digest is opt-in; a button
  that turns a private answer public is a footgun, not a feature.
