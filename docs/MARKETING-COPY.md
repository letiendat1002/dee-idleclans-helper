# Marketing copy — the listing, surface by surface

Who reads this: whoever writes or edits a listing surface (top.gg, Developer Portal) — when: before publishing copy, and before re-researching anything here.
Neighbours: [VOICE.md](VOICE.md) · [PRODUCT.md](../PRODUCT.md) · [DEFERRED.md](DEFERRED.md) · [ROADMAP.md](ROADMAP.md).

Status: **DECIDED** (owner, 2026-11-16). The recommended strings in §3 are the ones to paste; what
is left is owner-side work in the listing UI (§7). Everything a future session needs is here: the
surfaces and their limits, the chosen strings, the alternatives with character counts, the evidence
the pattern came from, and the drafts that were rejected with the reason.

Do not re-research top.gg before reading §4; do not re-litigate §6.

## 1. Surfaces and their limits

| Surface | Where it renders | Limit | Links? | Emoji? |
| --- | --- | --- | --- | --- |
| Short description | top.gg card and detail header | 200 chars | no, renders as raw text | no |
| Tagline | our own docs, server nickname, `/help` | ~60 | no | no |
| Portal description | Discord Developer Portal → Bot → Description | 400 chars | no, raw text | no |
| Long description | top.gg detail body | no limit, markdown | yes, clickable | no |

Two links never belong in the short description: top.gg already renders an **Invite** button and
reads the **Support Server** field under Socials. Put the invite in the long description and the
community URL in that field.

## 2. Locked facts (copy these, do not retype)

- Support server: `https://discord.gg/fepAZKG2Ss` -- **the Horde server**, an Idle Clans clan
  server, not a bot support server. The in-game clan is `DeeCorp` today and is due a rename, so no
  user-facing string names the clan: the showcase button says `Community server` and `/help` says
  `Horde server`. There is no dedicated DIH server yet; the bot gets a category inside that server.
  Rendered in three places, all from this one fact: the top.gg Support Server field, the
  `Community server` button on the `@mention` showcase (`src/events/MessageHandler.ts`), and the
  `/help` links field (`src/commands/help.ts`)
- Invite: built by the bot itself in `src/commands/help.ts` and `src/events/MessageHandler.ts`:

  ```
  https://discord.com/oauth2/authorize?client_id=1569644838012325968&scope=bot+applications.commands&permissions=2147535872
  ```

  `2147535872` = `USE_APPLICATION_COMMANDS` + `VIEW_CHANNEL` + `SEND_MESSAGES` + `EMBED_LINKS` +
  `ATTACH_FILES`. `ATTACH_FILES` is load-bearing: `/graph` uploads its PNG, and without the bit the
  card answers with a missing-permission line instead of an image. An earlier copy of this note
  decoded the old `2147502080` as including `ATTACH_FILES`; it was `EMBED_LINKS` instead. The one bit a pasted link must never lose is `applications.commands` in
  `scope`: without it the slash commands do not register in the server a player just added the bot to.

## 3. Recommended strings

Refined 2026-11-16 against `PRODUCT.md` (positioning: facts, not forecasts; the database is the
only long-term price record) and `docs/VOICE.md`. Every line below is measured, not estimated.

**top.gg short description (133/200):**

```
Idle Clans market data in Discord: sell price, buy order, 24h/7d/30d/1y charts and DM price alerts, all from the same 2-minute snapshot.
```

**Tagline (44):**

```
Idle Clans prices, one snapshot, in Discord.
```

**Portal description (261/400):**

```
Idle Clans market data in Discord: sell price, buy order, 24h/7d/30d/1y charts and DM price alerts, all from the same 2-minute snapshot. Two players comparing notes in the same minute see the same number, and every snapshot is stored, so past prices stay readable.
```

**Setup note (README section / top.gg long-description tail, 366):**

```
Permissions are managed by Discord, not the bot. Keep View Channel, Send Messages and Embed
Links checked on the authorize screen. Server Settings > Integrations decides which roles and
channels may use each command; Server Settings > Roles (or a channel overwrite) decides where
the bot may post.
```

Why this note and not an "assume owners know": the authorize screen is the one place a user can
silently uncheck the permissions the bot needs, and that step is Discord's UI, not ours. The
Integrations step is genuinely optional, so it is phrased as optional. Discord documents no
prescribed missing-permission UX for apps (checked 2026-11-17), so the bot's own "names the
missing permission" reply is a house choice, not a Discord requirement.

**Showcase line (Discord, `@mention`):** `Every answer comes from the same 2-minute snapshot, so
two players quoting a price in the same minute see the same number.`
-- `Free ·` was dropped on 2026-11-21: the model is donations without perks, so price is not the
claim, and opening with it invites "why is it free" instead of answering it. The line now carries
the differentiator §4 shows no competitor description can claim. The earlier `never stores your
game data` was replaced for the same reason it fails here: the database stores every snapshot, so
the line contradicted both the product and this page.

**top.gg long description:**

```markdown
# Dee IdleClans Helper

Market intel for Idle Clans. Ask for any quoted item and get the sell price, the buy order
and the trend over 24 hours, 7 days, 30 days or a year. Every answer comes from the same 2-minute
snapshot, so two players comparing notes see the same number. Each snapshot is stored, so a
price stays readable after it scrolls out of the live market.

## Commands

`/price <item>` sell price, buy order and the game's trade averages
`/graph item <item> [range]` a price chart over 24h, 7d, 30d or 1y
`/watch <item>` a DM when a price crosses your line
`/watchlist` the items you watch and their current sell price
`/digest add #channel` a market digest on a schedule; `/digest interval` sets it
`/vault add <clan> #channel` follow a clan's public log
`/help` every command, in one message

Facts, not forecasts.

## Links

- Community server: https://discord.gg/fepAZKG2Ss
- Invite: https://discord.com/oauth2/authorize?client_id=1569644838012325968&scope=bot+applications.commands&permissions=2147502080
```

## 4. The evidence the pattern came from

Real top.gg descriptions, captured 2026-11-15 (top.gg blocks direct fetches with 403; these came
through search snippets and the listing pages):

| Bot | Description on top.gg | Chars |
| --- | --- | --- |
| Flopper (OSRS market) | "Oldschool runescape market utilities / Get the live prices of items, generate graphs of the price history and view the top margins!" | ~140 |
| Tarkov Market | "Prices of items at the flea market with the calculation of the commission in the game Escape from Tarkov" | 107 |
| Game Deals | "Get the best price on any game with custom alerts and historical price data for any game, dlc, or bundle." | 111 |
| JJI Value (Jujutsu Infinite) | "Stop taking bad trades in Jujutsu Infinite. This bot shows real values, demand, and trade comparisons so you never lose or overpay." | ~135 |
| UnbelievaBoat (2.6M servers) | "Discord economy bot in 2.6M+ servers: custom currency, role shops, salaries, blackjack, roulette, slots, leaderboards and moderation." | 155 |
| Lootium | "Customizable Economy \| Store \| Gacha \| Gambling \| Trading \| Custom Currencies \| Items \| Minigames" | pipe list |
| Conquest | "The #1 RPG game bot. Explore, gamble - blackjack slots, craft crazy gear, enter dungeons, rob players for their money" | ~112 |

What they have in common, in the order it matters:

1. **The game name opens the line.** top.gg search matches the description text, so "Oldschool
   runescape", "Jujutsu Infinite", "Escape from Tarkov" are the keywords players type.
2. **One sentence, 100-160 characters.** None of the market or economy bots above write three or
   four sentences in the short description.
3. **Shape:** `game + the data you get + concrete verbs` (Flopper, Tarkov, UnbelievaBoat), or
   `pain + outcome` (JJI Value's "Stop taking bad trades").
4. **A number as proof** when it is impressive: "2.6M+ servers", "180,000 anime cards".
5. **No emoji on utility and market bots.** Flopper, Tarkov Market, Game Deals and JJI Value use
   none; emoji is the register of gacha and anime bots (Karuta, Lumina, Suicaptor).
6. A pipe list reads fast when the features do not connect into a sentence (Lootium).

## 5. Alternatives that were weighed

Short description:

| | Chars | Line |
| --- | --- | --- |
| **A (recommended)** | 112 | Idle Clans market intel. Live sell price, buy order, 24h/7d/30d/1y charts, and a DM when a price crosses your line. |
| B (pain) | 111 | Know the price before you trade. Idle Clans sell prices, buy orders, trend charts and price alerts, in Discord. |
| C (pipe list) | 100 | Idle Clans market data \| sell price \| buy order \| 24h/7d/30d/1y charts \| DM price alerts \| craft or buy |
| D (number) | 112 | All 628 Idle Clans items, priced. Sell price, buy order, trend charts and DM alerts, from one 2-minute snapshot. |

A wins on the shape of the two best bots in this niche. B fails the swap test: any market bot can
write "Know the price before you trade". D spends its punch on `628`, which drifts with every game
patch, and "All ... items, priced" overclaims: only items with a live quote are priced.

Tagline:

| | Chars | Line |
| --- | --- | --- |
| **T5 (recommended)** | 44 | Idle Clans prices, one snapshot, in Discord. |
| T2 (was recommended) | 53 | Sell price, buy order, trend. Idle Clans, in Discord. |
| T1 | 47 | Idle Clans prices, charts and alerts in Discord |
| T3 | 40 | Idle Clans market data, one command away |
| T4 | 26 | The price before you trade |

T4 is the punchiest and the weakest: no product noun, so search cannot match it. T2 was the first
pick and is now demoted: `Sell price, buy order, trend.` is a three-part fragment list, which
`docs/VOICE.md` §Banned shapes names as a tell, and the line spends its characters on nouns a
player already knows. T5 keeps the game keyword first and carries the differentiator (one
snapshot) that no competitor description in §4 can claim.

## 6. Rejected drafts, with the reason

- **The 344-char v1 description** (bullets "628 quoted items ... Facts, not forecasts: the market
  is yours to read"): three sentences for a 200-char box, and its best line sat last, below the
  fold of every card. "Facts, not forecasts" survives as the closing line of a long description,
  not as the opening of a short one.
- **Owner draft, 2026-11-15** (228 chars, three lines: name line, `👉 Community server:`, `👉 Bot
  invitation:`): over the 200-char limit, links in text that top.gg already renders as buttons,
  emoji against the register of every market bot in the niche, and the only product words left are
  "market intel". Its first line was kept for the portal description.
  **Re-read 2026-11-17, for the Developer Portal field instead of top.gg.** The rejection does not
  transfer: the Portal box is 400 chars, its links are not clickable and there is no Support Server
  field beside it, so a raw URL there is the only way to carry the server (`VOICE.md` §Attribution
  now records that exception). Two `👉` markers still say nothing the words do not, and the second
  link duplicates the install button the profile already shows. Advice, owner's call: keep line 1,
  keep one link line, drop the second marker and the invite line --
  `Idle Clans market intel -- sell price, buy order, 24h/7d/30d/1y charts, DM price alerts from one
  2-minute snapshot.` + `Horde server: discord.gg/fepAZKG2Ss`.
- **"Start making profit like a bandit!"**: promises earnings the bot never computes.
- **"Welcome to the Intel Continental"**: a slogan with no product noun is invisible to search.
  Keep it as server-nickname branding, where it costs nothing.

## 7. Open questions for the next phase

1. ~~Pick the short description and tagline~~ -- decided 2026-11-16: the strings in §3, with T5 as
   the tagline (T2 was replaced on a voice rule, see §5).
2. ~~Rename the Discord application~~ -- done 2026-11-17, owner side: name `Dee IdleClans Helper`,
   description `Idle Clans market intel` + `👉 Community server:` + `👉 Bot invitation:`, tags
   `IdleClans | Market | Trend | Chart | Intel`. Advice on trimming that description: §6.
   The tags given are the Portal's; the top.gg set (`economy`, `game`, `utility`, `idle`) is filled
   in step 3, when top.gg is written.
3. Fill top.gg: short description, long description, Support Server field, and the tags
   (`economy`, `game`, `utility`, `idle`). **Deferred 2026-11-17 by the owner** until after the
   first release of the PRD and the bot is hosted in the Horde server: an empty listing behind a
   server with no bot category is a worse first impression than none.
4. The health of the invite link: `scope` must keep `applications.commands`; test it once in a
   clean server with no roles, and confirm the six commands register within a few minutes.
5. ~~Confirm the community server name~~ -- answered 2026-11-17: it is the **Horde** clan server,
   the clan is `DeeCorp` today and will be renamed. Nothing user-facing names the clan any more
   (`/help` says `Horde server`, the showcase button says `Community server`), so the rename costs
   no code change. Open instead: the bot category (announcements, feedback) does not exist yet.

## 8. Phase archive -- resume trigger

The listing copy work is **paused 2026-11-17 by the owner**, not finished. Everything decided so
far is in §1-§6 and needs no re-research: the surfaces and their limits, the locked facts, the
recommended long description, the Portal description advice, the rejected drafts with reasons, and
the top.gg tag set (`economy`, `game`, `utility`, `idle`).

What is **not** done, in the order it becomes possible:

| # | Item | Blocked on |
|---|---|---|
| 1 | top.gg listing (short + long description, Support Server field, tags) | first production release, bot hosted in the Horde server |
| 2 | Invite-link health test in a clean server (`scope` keeps `applications.commands`, six commands register) | nothing -- can run any time |
| 3 | Portal description trim to the 400-char, no-clickable-link shape advised in §6 | owner edit in the Developer Portal |
| 4 | Showcase screenshot retake (current capture shows a raw OAuth URL twice and a "kick then re-invite" line) | the hosted bot in a clean channel |
| 5 | Bot category in the Horde server (announcements, feedback) before the listing goes live | owner creates the channels |

**Trigger prompt for the next session** (paste as-is, in this repo):

```
Resume the marketing phase for Dee IdleClans Helper.

Read docs/MARKETING-COPY.md in full (it is the record: §1 surfaces, §2 locked facts, §3 the
decided strings, §6 rejected drafts + Portal trim advice, §7 open questions, §8 this trigger),
then docs/VOICE.md and PRODUCT.md for tone and positioning. Do not re-research the listing copy
that is already decided.

Check the §8 table first and tell me which rows are unblocked now (release shipped? bot in the
Horde server? bot category created?). Then do only the unblocked rows, in that order, and stop
before publishing anything -- I fill the Portal and top.gg fields myself. Report what you wrote,
where it goes, and what is still blocked and why.
```
