# Idle Clans — Game Mechanics That Change The Cost Of A Craft

Who reads this: an agent modelling a game formula, a modifier or a derived rate — when: before adding or changing any derived number.
Neighbours: [DATA-PROVENANCE.md](DATA-PROVENANCE.md) · [CONVENTIONS.md](CONVENTIONS.md) · [DEFERRED.md](DEFERRED.md).

**Research date:** 2026-11-14
**Status:** Research deliverable. No code was touched.
**Serves the rule:** *no unmodelled, undisclosed formulas.* Every number below carries its source. Where a
source could not be established, the fact is in §7 "What we still do not know" instead of the table.

This document exists because the v1 `/profit` command applied a mechanic it did not understand and missed
another one (`upgrade_smelting_cost`), and was wrong by 720,000×. The `/buy-or-craft` command it later
grounded was **removed on 2026-11-18** (owner request); it priced every component at its ask and modelled
**none** of the mechanics below. This document is the input an implementation of the craft advisor can be
written from.

---

## 1. How to read the classification

Every mechanic gets exactly one class. The class is decided by **what the advisor must do to stay honest**,
not by how the game implements it:

| Class | Meaning | Advisor action |
|---|---|---|
| `deterministic` | True for every player, no choice at craft time | Apply unconditionally |
| `probabilistic` | A chance per craft or per unit | Apply an expected value **and say so**, or show a floor/ceiling |
| `player-dependent` | Magnitude or applicability only the player knows | Take as a user input, or state it in an assumptions line. **Never guess.** |

This matches the three examples the owner gave: a sell tax is deterministic, a 30% material-save is
probabilistic, and the player's gear / unlocked upgrades / house are player-dependent.

`Confidence` is one of:

- `verified-live` — fetched or queried in this session and the number was seen.
- `wiki-only` — the wiki states it; the game data could not confirm it.
- `uncertain` — sources disagree. The conflicting values are in the *Exact effect* cell.

**Sources used**

| Source | What it is authoritative for |
|---|---|
| `https://query.idleclans.com/api/Configuration/game-data?minVersion=0` | Items, tasks/recipes, upgrade tiers, houses, potions, clan upgrades. Fetched 2026-11-14, 2,795,455 bytes. **Note:** the response parsed as a single JSON object this session (no double-parse, no BSON wrappers present) — the spec's "JSON-encoded string" trap did not reproduce. |
| `https://query.idleclans.com/api/Items/metadata` | 1009 items: `id, name, baseValue, tradeable, associatedSkill, equipmentSlot`. Fetched 2026-11-14. |
| `https://query.idleclans.com/api/Configuration/market-settings` | `sellTaxPercentage`, offer slots. Fetched 2026-11-14. |
| `https://query.idleclans.com/api/PlayerMarket/items/prices/latest` | Live ask/bid + depth, 626 quoted items. Fetched 2026-11-14. |
| `https://idleclans.wiki/` | Effect wording, chance-vs-guarantee, exclusions, durations. |
| Local Postgres `items` table (SELECT only) | Cross-check of `item_id`, `base_value`, `tradeable`, `skill_id`, `recipes`. |

**Skill id map** (derived from `gameData.Items.Items[].LevelRequirement.Skill` and `AssociatedSkill`,
cross-checked against the wiki's per-skill pages): 7 = Crafting, 8 = Woodcutting, 9 = Carpentry,
10 = Fishing, 11 = Cooking, 12 = Mining, 13 = Smithing, 14 = Foraging, 15 = Farming, 16 = Agility,
17 = Plundering, 19 = Brewing, 21 = Invocation. 1–6 are combat/health.

---

## 2. The mechanic table

| ID | Mechanic | Source (URL or API field) | Class | Exact effect | How the advisor must treat it | Confidence |
|---|---|---|---|---|---|---|
| M01 | Player-market sell tax | `/Configuration/market-settings` → `sellTaxPercentage: 1.0`; wiki `Player_shops` | deterministic | 1% of proceeds, taken from the gold received. Applies only to **sell** offers whose total value is **≥ 100 gold**. Buy offers are never taxed. | Apply `× (1 − 0.01)` to every bid-side leg. Never to an ask-side leg. | verified-live |
| M02 | Buy offers untaxed | wiki `Player_shops` ("with buy offers the players are not subject to any player market tax") | deterministic | 0% on purchases | No adjustment on the craft-cost or buy-cost legs. | verified-live |
| M03 | Price `0` means "no offer" | `/PlayerMarket/items/prices/latest` (27 of 626 items have `lowestSellPrice: 0`, 43 have `highestBuyPrice: 0`) | deterministic | A zero is a missing observation, never a price of zero | Filter zeros before any sum or average. A component with no ask makes `craftCost` unknown, not free. | verified-live |
| M04 | **Guardian's brewing spoon** | wiki `Guardian's_brewing_spoon`, `Boosts`, `Brewing`; `gameData.Items.Items` id 741; `/Items/metadata` id 741; local `items` row 741 | player-dependent | **10% less ingredients when brewing potions.** Flat reduction, not a chance. Item id **741**, name `guardians_brewspoon`, `EquipmentSlot` **7** (`rightHand` / wiki "Main Hand"), `IsTool: true`, `BaseValue` **175,000**, `AssociatedSkill` 19 (Brewing), `LevelRequirement {Skill: 19, Level: 70}`, tradeable, 0.1% drop from Guardians of the Citadel. Live ask 29,710,712 / bid 25,000,000 (1 unit each side). | Input: boolean `ownsBrewingSpoon`. If true, multiply every Brewing recipe's component quantities by 0.9. State the assumption in the output when the input is absent. | wiki-only |
| M05 | Plank bargain (skill upgrade, 3 tiers) | wiki `Plank_bargain`, `Carpentry`; `gameData.Upgrades.Items` **Type 12** (`Tiers: 3`, `TierUnlocks: [30,60,100]`, `Costs: [500000,1000000,2000000]`) | player-dependent | Reduces the **gold** cost of all Carpentry tasks by 30% / 60% / 100%. Tiers do not stack; the newest overwrites. | Input: tier 0–3. Applies **only** to the gold component (item id 19), which is non-tradeable and already excluded from `craftCost` as `PARTIAL`. Disclose it; it does not move the tradeable margin. | verified-live |
| M06 | Delicate manufacturing (skill upgrade, 1 tier) | wiki `Delicate_manufacturing`, `Crafting` | player-dependent | **20% less flax** when crafting non-astronomical fabrics. Cost: 1 × Textile manufacturing techniques, Crafting 70. | Input: boolean. If true, flax (item 273/274/275) quantities × 0.8. Affects `enchanted_robe` (15 → 12 flax) and `enchanted_trousers` (10 → 8). | wiki-only |
| M07 | Arrow crafter (skill upgrade, 1 tier) | wiki `Arrow_crafter`, `Crafting` | player-dependent | **+10% to all crafted arrow quantities**, including astronomical arrows. Cost: 1 × Arrow crafting secrets, Crafting 90. | Input: boolean. If true, `ItemAmount` × 1.1 on arrow recipes (e.g. `bronze_arrow` 10 → 11, `astronomical_arrow` 1000 → 1100). | wiki-only |
| M08 | Tools, tiers 1–8 (one per skill) | wiki `Tools` + per-skill pages; `gameData.Items.Items` `IsTool: true` (109 items), all with `EquipmentSlot: 7` (`rightHand`); 200 items total occupy slot 7 | player-dependent | Skilling **speed** +4% (normal) → +6 / +8 / +10 / +12 / +15 / +20 / +25% (otherworldly). One tool per skill: hatchet, pickaxe, fishing rod, rake, secateurs, hammer, saw, cooking pan, crafting needle, philosopher's stone, lockpicks, jumping rope, brush. | Input: the player's tool tier per skill. Speed only — it changes tasks/hour, never material cost or output count. | verified-live |
| M09 | Mastery capes, tiers 1–4 | wiki `Boosts`, per-skill pages | player-dependent | Skilling **speed** +5 / +10 / +15 / +20% (tiers unlocked at skill 90/100/110/120). | Input: cape tier per skill. Speed only. | verified-live |
| M10 | Enchantment scrolls on jewelry | wiki `Enchanting`; `gameData.Items.Items` ids 417–428 (`EnchantmentBoost` 1.5 / 3 / 5, `UsableEnchantmentScroll` 1 / 2 / 3) | player-dependent | **+1.5% / +3% / +5% skilling speed per enchanted jewelry piece** (Common/Rare/Exceptional). Four pieces → 6% / 12% / 20% total. | Input: how many enchanted pieces the player wears. **Speed only — enchantments have no cost or output effect.** | verified-live |
| M11 | Skilling gear (hat/jacket/pants, cap/boots) | wiki `Boosts` → "Skilling gear" | player-dependent | **+2% skilling speed per piece**, up to 3 pieces per skill (6%). Sources: clan gathering/crafting events, or monster drops. | Input: pieces worn. Speed only. | wiki-only |
| M12 | Personal housing, 5 tiers | wiki `Housing`; `gameData.Upgrades.Items` **Type 0** (`TierUnlocks: [5,10,15,20,25]`, `Costs: [100000,500000,2500000,10000000,25000000]`) | player-dependent | **+5% / +10% / +15% / +20% / +25% skilling experience.** Cardboard box → House. Requires Carpentry 30–90 and Smithing 20–80. | Input: housing tier. **Experience only — no effect on craft cost, output or speed.** Disclose as "not modelled because it does not change the arithmetic". | verified-live |
| M13 | Clan property, 6 tiers | wiki `Clan` → "Clan property"; `gameData.Houses.Items` (`guild_house_1..6`, `GlobalSkillingBoost` 5/10/15/20/25/30) | player-dependent | **+5% → +30% skilling experience**, shared by all clan members. Tent (clan) → Castle. | Input: clan property tier. Experience only. | verified-live |
| M14 | Clan upgrade — Gatherers | wiki `Clan`, `Boosts`; `gameData.ClanUpgrades.Items` Type 23 (`TierUnlocks: [5]`, 22,500 credits) | player-dependent | **+5% speed for gathering skills** (Woodcutting, Fishing, Mining, Foraging). Does **not** cover the production skills. | Input: clan has it. Speed only, and only for four skills. | verified-live |
| M15 | Clan upgrade — An offer they can't refuse | wiki `Clan`, `Boosts`, per-skill pages; `gameData.ClanUpgrades.Items` Type 20 (`TierUnlocks: [10]`, 50,000 credits) | player-dependent | **+10% gold on all sales to non-players** (the game shop / vendoring). Requires Plundering 80, Foraging 80, Farming 70, Carpentry 75. | Input: clan has it. **Applies to game-shop sales only, never to the player market.** Do not apply it to any bid-side figure in a craft comparison. | verified-live |
| M16 | Local-market upgrade — Last negotiation | wiki `Brewing` → "Perks" | player-dependent | **Permanently receive the effect of the Potion of negotiation** (+5% gold on non-player sales). Cost: 1 × Negotiation techniques, Brewing 70. | Input: owned. Same scope limit as M15. | wiki-only |
| M17 | Local-market upgrade — Prestigious woodworking | wiki `Prestigious_woodworking` | player-dependent | **+10% gold when selling planks to the game.** Cost: 1 × Citadel's woodworking tips, Woodcutting 75 + Carpentry 75. | Input: owned. Game-shop sales only. | wiki-only |
| M18 | Clan upgrade — Potioneering | wiki `Clan`, `Boosts`; `gameData.ClanUpgrades.Items` Type 18 (`TierUnlocks: [25]`, 30,000 credits, Brewing 70) | player-dependent | **Potion effects last 25% longer.** | Input: clan has it. Extends the duration of M24/M35 only. | verified-live |
| M19 | Local-market upgrade — Responsible drinking | wiki `Brewing`, `Boosts` | player-dependent | **Potion effects last 10% longer.** Cost: 1 × Book of potions, Brewing 70. Multiplicative with M18 → total duration multiplier 1.375×. | Input: owned. Extends M24/M35 duration only. | wiki-only |
| M20 | Upgraded potion storage (Carpentry, level 115) | wiki `Carpentry` → "Upgrading storages" | player-dependent | **Potions drunk from the upgraded potion storage last 10% longer.** Cost: 5 × Medusa's blueprints, 135,000 Carpentry XP. | Input: storage built. Extends M24/M35 duration only. | wiki-only |
| M21 | Skilling-speed cap | wiki `Boosts` → "Maximum equipment skill boosts" | player-dependent | Skilling speed is **capped at 80%** (75% for Brewing, Carpentry, Smithing, Invocation; Enchanting is 55% and is an experience cap). Experience has no cap. | Input: none needed for the cap itself, but the advisor must clamp any summed speed bonus to the per-skill cap before dividing `BaseTime`. | wiki-only |
| M22 | Level requirement gate | `gameData.Tasks.<Skill>.Items[].LevelRequirement` | player-dependent | A recipe is unavailable below its level (Potion of resurrection: Brewing 30). | Input: the player's skill levels, or state the requirement in the output. Never imply a craft is available to everyone. | verified-live |
| M23 | **Smelting magic** (skill upgrade, 3 tiers) | wiki `Smelting_magic`, `Smithing`; `gameData.Upgrades.Items` **Type 10** (`Tiers: 3`, `TierUnlocks: [10,20,30]`, `Costs: [750000,2500000,10000000]`) | probabilistic | **10% / 20% / 30% chance to not consume ore** when smelting bars. Excludes Astronomical and Otherworldly ore. Tiers do not stack; the newest overwrites. | Input: tier 0–3. Expected ore cost = `amount × (1 − p)`. Label the result as an expectation, and show the floor (`amount`) and ceiling (`amount × (1 − p)`). | verified-live |
| M24 | Potion of forgery (consumable) | wiki `Potion_of_forgery`, `Boosts`; `gameData.PotionData.Items` PotionId 3 (`ChanceOfTriggeringEffect: 10`, `Duration: 180`) | probabilistic | **10% chance to save bars in Smithing** (excluding Astronomical & Otherworldly), for **180 seconds**. Brewing 45 to make. | Input: is it active. Expected bar cost = `amount × 0.9` while active. Label as an expectation. | verified-live |
| M25 | Skilling gloves (12 skills) | wiki `Boosts` → "Skilling gloves"; per-skill pages | probabilistic | **5% chance to double loot** in the associated skill: Crafting, Woodcutting, Carpentry, Fishing, Cooking, Mining, Smithing (excluding astro & OW), Foraging, Farming, Plundering, Brewing, Invocation. Source: skilling party. | Input: gloves worn. Expected output = `ItemAmount × 1.05`. Label as an expectation. | wiki-only |
| M26 | The fisherman (skill upgrade, 5 tiers) | wiki `The_fisherman`; `gameData.Upgrades.Items` **Type 2 or 3** (`TierUnlocks: [20,40,60,80,100]`, `Costs: [100000,250000,1000000,5000000,20000000]`) | probabilistic | **20 / 40 / 60 / 80 / 100% chance to double caught fish.** Tiers do not stack. | Input: tier. Expected output × (1 + p). Gathering skill — affects the raw-material side of a chain, not a production recipe. | verified-live |
| M27 | The lumberjack (skill upgrade, 5 tiers) | wiki `The_lumberjack`; `gameData.Upgrades.Items` **Type 2 or 3** (identical tier table to M26) | probabilistic | **20 / 40 / 60 / 80 / 100% chance to double chopped logs.** Tiers do not stack. | Input: tier. Gathering skill. | verified-live |
| M28 | Power forager (skill upgrade, 5 tiers) | wiki `Power_forager`; `gameData.Upgrades.Items` **Type 9** (`TierUnlocks: [10,20,30,40,50]`, `Costs: [200000,600000,1500000,5000000,10000000]`) | probabilistic | **10 / 20 / 30 / 40 / 50% chance to double foraged loot.** Tiers do not stack. | Input: tier. Gathering skill. | verified-live |
| M29 | Farming trickery (skill upgrade, 5 tiers) | wiki `Farming_trickery`; `gameData.Upgrades.Items` **Type 8** (`TierUnlocks: [10,20,30,40,50]`, `Costs: [250000,1000000,3000000,10000000,25000000]`) | probabilistic | **10 / 20 / 30 / 40 / 50% chance to save seeds** when farming. Tiers do not stack. | Input: tier. Gathering skill. | verified-live |
| M30 | Most efficient fisherman (skill upgrade, 5 tiers) | wiki `Most_efficient_fisherman`; `gameData.Upgrades.Items` **Type 11** (`TierUnlocks: [10,20,30,40,50]`, `Costs: [1000000,2000000,4000000,7500000,10000000]`) | probabilistic | **10 / 20 / 30 / 40 / 50% success rate to automatically cook** a caught fish. Toggleable. | Input: tier. Changes which item the player ends up holding (raw vs cooked) — a different output item, not a quantity. | verified-live |
| M31 | Guardian's mallet | wiki `Guardian's_mallet`, `Boosts`; `gameData.Items.Items` id 743 (`ProcChance: 10`, `EquipmentSlot: 7`, `BaseValue: 175000`, Woodcutting, level 75) | probabilistic | **10% chance to receive planks on top of the logs being cut** (3.33% for Ignis log). No Carpentry XP for the bonus plank. | Input: owned. Expected extra planks per log = 0.10. Gathering skill. | wiki-only |
| M32 | Guardian's lamp | wiki `Guardian's_lamp`, `Boosts`; `gameData.Items.Items` id 740 (`ProcChance: 20`, `EquipmentSlot: 7`, `BaseValue: 175000`, Mining, level 70) | probabilistic | **20% chance to receive Coal ore** when mining higher-quality ore (Gold, Platinum, Meteorite, Diamond, Titanium, Obsidian), with the matching Mining XP. | Input: owned. Gathering skill. | wiki-only |
| M33 | Upgraded material storage (Carpentry, level 100) | wiki `Carpentry` → "Upgrading storages" | probabilistic | **10% chance that ore and logs taken from this storage are not consumed** when smelting ore or making planks. **Bars and planks are never saved.** Cost: 5 × Hades' blueprints, 105,000 Carpentry XP. | Input: storage built. Expected ore/log cost × 0.90. This is the Smithing/Carpentry analogue of the spoon, but it is a **chance**, not a flat reduction, and it only covers materials drawn from that storage. | wiki-only |
| M34 | Upgraded farming storage (Carpentry, level 90) | wiki `Carpentry` → "Upgrading storages" | probabilistic | **10% chance that farmed seeds pulled from this storage are not used.** Cost: 5 × Devil's blueprints, 90,000 Carpentry XP. | Input: storage built. Gathering skill. | wiki-only |
| M35 | Potion of trickery (consumable) | wiki `Potion_of_trickery`, `Boosts`; `gameData.PotionData.Items` PotionId 5 (`ChanceOfTriggeringEffect: 25`, `Duration: 900`) | probabilistic | **25% chance to receive the sell price of a gathered item on top of the item.** Duration: **600 s** (item page) vs **900 s** (API) — see §7. Brewing 65 to make. Does **not** apply to items from the Guardian's mallet or lamp, and does **not** factor in vendor boosts (M15/M16). | Input: is it active. Expected extra gold = `0.25 × sellPrice` per gathered item. Gathering skill. | uncertain |
| M36 | Upgraded key storage (Carpentry, level 120) | wiki `Carpentry` → "Upgrading storages" | probabilistic | **10% chance to save a key** when entering a boss fight (rolls after the Yoink clan upgrade). Cost: 5 × Chimera's blueprints, 150,000 Carpentry XP. | Input: storage built. Not a crafting material. Listed for completeness of the "chance to not consume" set. | wiki-only |
| M37 | Clan upgrade — Yoink | wiki `Clan`, `Boosts`; `gameData.ClanUpgrades.Items` Type 21 (`TierUnlocks: [15]`, 17,500 credits, Agility 60) | probabilistic | **15% chance to not use up a key** when entering a boss lair. | Input: clan has it. Not a crafting material. Listed for completeness. | verified-live |

### 2.1 Negative findings (recorded, with evidence)

These are findings too. Each was searched for and **does not exist** as a cost/output mechanic.

| # | Claim checked | Finding | Evidence |
|---|---|---|---|
| N1 | A smithing / cooking / carpentry / enchanting equivalent of the Guardian's brewing spoon | **Does not exist.** The five Guardian tools are: lamp (Mining), mallet (Woodcutting), chisel (Crafting — **XP only**, no cost effect), trowel (Farming — speed only), brewing spoon (Brewing). Smithing, Cooking, Carpentry, Enchanting, Agility, Plundering, Foraging, Fishing and Invocation have **no** Guardian tool. | `gameData.Items.Items` filtered on `IsTool: true` and `Name LIKE 'guardians_%'` → exactly 5 items (740–744); wiki `Boosts` → "Other tools" table lists the same 5. |
| N2 | Enchantments that reduce crafting cost or raise output | **Do not exist.** Enchantment scrolls give skilling **speed** only (M10). | wiki `Enchanting` scroll tables; `gameData.Items.Items` `EnchantmentBoost` on ids 417–428 is 1.5/3/5 and the wiki labels every row "skill speed boost" / "skill training boost" / "skill xp boost". |
| N3 | Housing or house bonus that reduces crafting cost or raises output | **Does not exist.** Personal housing (M12) and clan property (M13) are **experience** boosts only. | wiki `Housing` ("The housing bonus applies to skilling experience"); wiki `Boosts` → "Personal houses" / "Clan properties" tables; `gameData.Houses.Items` has no cost or output field. |
| N4 | Clan upgrade that reduces crafting material cost | **Does not exist.** The clan upgrades touching anything adjacent are Potioneering (duration, M18), An offer they can't refuse (non-player sale gold, M15) and Gatherers (gathering speed, M14). None reduces a production recipe's material cost. | wiki `Clan` → "Clan upgrades" table (22 upgrades, all listed); `gameData.ClanUpgrades.Items` (22 entries). |
| N5 | Consumables (resin, bait, gem dust, flax essence, vial, compost, wax, smoke bomb, seasoning, thread, clay core, prehistoric elixir) that change cost or output | **Do not exist.** All are **+2% / +4% experience** for their skill. | wiki `Boosts` → "Consumables" table. |
| N6 | Potions that change crafting cost or output | Only two of eleven: Potion of forgery (M24, material save) and Potion of trickery (M35, gold). The other nine are combat effects. | wiki `Boosts` → "Potions" table; `gameData.PotionData.Items` (11 entries). |
| N7 | Daily boosts / holiday events / bonus experience that change cost or output | **Do not exist.** All are experience-only (30% for 8 h/day; 0–25% per event; 1%–∞ developer-triggered). | wiki `Boosts` → "Daily boosts", "Holiday events", "Bonus experience". |
| N8 | Clan quest reward "Storage Benefits (+100% benefits from upgraded storages)" | **Exists in the game data but is disabled** and is not obtainable. | wiki `Clan` line 132: "Storage Benefits (+100% benefits from upgraded storages) exists in the game data but is currently disabled and is not available as a clan quest reward." |
| N9 | A player-market tax on the buy side, or a tax below 100 gold | **Does not exist.** Tax is 1%, sell-side only, and only on offers totalling ≥ 100 gold. | wiki `Player_shops`; `/Configuration/market-settings`. |
| N10 | Any mechanic that changes the **ask** the advisor pays | **None found.** Every cost mechanic reduces the *quantity consumed* or the *gold component*; none changes a market price. | Full sweep of `gameData.Upgrades.Items` (49), `gameData.ClanUpgrades.Items` (22), `gameData.Houses.Items` (6), `gameData.PotionData.Items` (11), `gameData.Items.Items` (1009) plus the wiki pages listed in §1. |

---

## 3. What the advisor can apply unconditionally (deterministic)

Only three things, and they are all market rules rather than game boosts:

1. **M01 — the 1% sell tax**, on the bid side only, and only for offers totalling ≥ 100 gold.
2. **M02 — no tax on the buy side.**
3. **M03 — a price of `0` is "no offer".**

Everything else in the table is either a chance or a player asset. **The honest baseline for a craft comparison
is therefore that implementation's arithmetic** — `craftCost = Σ ask × amount`, `buyCost = ask × itemAmount`
— plus the 1% tax on the sell-raw leg. That baseline is not wrong; it is *incomplete*, and §6 is where the
incompleteness is disclosed rather than hidden.

---

## 4. What needs an expected value (probabilistic)

Fourteen mechanics are chances. Grouped by what they touch:

**Material cost (the ones that flip a verdict):**
- M23 Smelting magic — 10/20/30% ore save, Smithing only, excludes astro & OW ore.
- M24 Potion of forgery — 10% bar save, Smithing only, 180 s.
- M33 Upgraded material storage — 10% ore/log save, Smithing + Carpentry, storage-sourced materials only.

**Output quantity:**
- M25 Skilling gloves — 5% double loot, all 12 skills.
- M26/M27/M28/M29 — The fisherman / The lumberjack / Power forager / Farming trickery (gathering skills).
- M31 Guardian's mallet — 10% extra planks (3.33% Ignis log).
- M32 Guardian's lamp — 20% extra coal ore.

**Gold:**
- M35 Potion of trickery — 25% chance at the sell price of a gathered item.

**Not crafting materials, listed for completeness:** M30, M34, M36, M37.

**Rule for the advisor:** an expected value must be labelled as one. `E[cost] = amount × (1 − p)` is a
statement about the average over many crafts, not about the next craft. Where the verdict is close to TIE,
show the floor (`p = 0`, full cost) and the ceiling (`p = max`, reduced cost) alongside the expectation, so
the user can see that the sign of the answer is not stable.

---

## 5. What needs a user input (player-dependent)

The advisor must ask for, or assume and disclose, the following. Grouped by the question to put to the user:

| Input | Mechanics it selects | Effect on the arithmetic |
|---|---|---|
| Skill levels | M22 | Gates whether the recipe is available at all |
| Tool tier per skill | M08 | Tasks/hour (speed) |
| Mastery cape tier per skill | M09 | Tasks/hour (speed) |
| Enchanted jewelry count | M10 | Tasks/hour (speed) |
| Skilling gear pieces worn | M11 | Tasks/hour (speed) |
| Owns Guardian's brewing spoon | M04 | Brewing component quantities × 0.9 |
| Owns Delicate manufacturing | M06 | Flax quantities × 0.8 |
| Owns Arrow crafter | M07 | Arrow `ItemAmount` × 1.1 |
| Smelting magic tier | M23 | Expected ore cost × (1 − p) |
| Plank bargain tier | M05 | Carpentry **gold** component × (1 − 0.3/0.6/1.0) |
| The fisherman / lumberjack / forager / farming trickery tiers | M26–M29 | Expected gathered quantity |
| Wears skilling gloves | M25 | Expected output × 1.05 |
| Owns Guardian's mallet / lamp | M31, M32 | Expected extra gathered material |
| Built upgraded material / farming storage | M33, M34 | Expected material cost × 0.90 |
| Potion of forgery / trickery active | M24, M35 | Expected cost / expected gold, for the duration |
| Housing tier, clan property tier | M12, M13 | **Nothing** — experience only |
| Clan has Gatherers / Potioneering / An offer they can't refuse | M14, M18, M15 | Speed / duration / non-player sale gold |
| Owns Last negotiation / Prestigious woodworking / Responsible drinking | M16, M17, M19 | Non-player sale gold / potion duration |

**The advisor must never guess any of these.** Where an input is missing it must print an assumptions line
naming exactly which mechanics were not modelled, not silently assume "no boosts".

---

## 6. Worked example — the Potion of resurrection chain

This is the proof that the understanding changes the answer, and the fixture the advisor's tests should use.

**The recipe** (`gameData.Tasks.Brewing`, `TaskId: 2`, `Name: "potion_of_resurrection"`):

| Field | Value |
|---|---|
| Output item | `potion_of_resurrection`, id **410** |
| Skill | **Brewing** (id 19) |
| `LevelRequirement` | **30** |
| `BaseTime` | **72,500 ms** |
| `ItemReward` / `ItemAmount` | 410 / **1** |
| `Costs` | 15 × Cabbage (id 135), 10 × Enchanted flax (id 274), 2 × Chestnut log (id 2) |

**Live prices**, fetched 2026-11-14 from `https://query.idleclans.com/api/PlayerMarket/items/prices/latest`:

| Item | id | Ask (`lowestSellPrice`) | Ask depth | Bid (`highestBuyPrice`) | Bid depth |
|---|---|---|---|---|---|
| Cabbage | 135 | **496** | 1,001 | **385** | 73,654 |
| Enchanted flax | 274 | **141** | 120,194 | **87** | 989,729 |
| Chestnut log | 2 | **116** | 10,249 | **50** | 169,388 |
| Potion of resurrection | 410 | **11,454** | 19,965 | **9,555** | 12,886 |

Sell tax: 1% (`/Configuration/market-settings` → `sellTaxPercentage: 1.0`).

### (a) No modifiers — the removed `/buy-or-craft` answer

```
craftCost = 15 × 496  +  10 × 141  +  2 × 116
          = 7,440     +  1,410     +  232
          = 9,082

buyCost   = 11,454 × 1 = 11,454

margin    = buyCost − craftCost = 11,454 − 9,082 = +2,372
marginPct = 2,372 / 11,454 = 20.71%

verdict   = CRAFT   (crafting is cheaper by 2,372 gold per potion)
```

Second comparison (sell the raw materials vs craft-then-sell), both legs taxed at 1%:

```
sellRawValue    = (15 × 385 + 10 × 87 + 2 × 50) × 0.99
                = (5,775 + 870 + 100) × 0.99
                = 6,745 × 0.99 = 6,677.55

craftSellValue  = 9,555 × 1 × 0.99 = 9,459.45

rawVerdict      = CRAFT, by 9,459.45 − 6,677.55 = 2,781.90 gold
```

Base task time: `3,600,000 / (72,500 × 1)` = **49.66 → 50 tasks/hour** (the spec's formula rounds to 50).

### (b) With the Guardian's brewing spoon (M04)

The spoon reduces ingredient consumption by a flat 10% — not a 10% chance. Every component quantity is
multiplied by 0.9:

```
Cabbage        15 × 0.9 = 13.5  →  13.5 × 496 = 6,696.0
Enchanted flax 10 × 0.9 =  9.0  →   9.0 × 141 = 1,269.0
Chestnut log    2 × 0.9 =  1.8  →   1.8 × 116 =   208.8

craftCost = 6,696.0 + 1,269.0 + 208.8 = 8,173.8      (= 0.9 × 9,082)

buyCost   = 11,454 × 1 = 11,454

margin    = 11,454 − 8,173.8 = +3,280.2
marginPct = 3,280.2 / 11,454 = 28.64%

verdict   = CRAFT   (crafting is cheaper by 3,280.2 gold per potion)
```

**The headline:** the spoon moves the margin from **+2,372** to **+3,280.2** gold per potion — a **908.2 gold**
(38.3%) improvement in the craft case, and it moves `marginPct` from 20.71% to 28.64%. The verdict does not
flip here, but the *size of the edge* changes by more than a third, and at 50 tasks/hour that is
**45,410 gold/hour** of margin the current advisor does not know about.

The sell-raw leg is unchanged (the spoon reduces what you *consume*, not what you *own*), so `rawVerdict`
stays CRAFT by 2,781.90.

### (c) Why the rounding matters, and what to do about it

13.5 cabbages and 1.8 chestnut logs are not integers. The game must round somewhere, and the rounding rule
is not published (see §7, U1). The three candidate rules give:

| Rounding rule | craftCost | margin | marginPct |
|---|---|---|---|
| Exact fractional (expected value) | 8,173.8 | **+3,280.2** | 28.64% |
| `floor` per component (13, 9, 1) | 7,833 | +3,621 | 31.61% |
| `round` half-up per component (14, 9, 2) | 8,445 | +3,009 | 26.27% |

**The advisor should use the exact fractional value** and label it an expectation, because it is the only
rule that does not require guessing, and because it is the rule that is correct on average. The spread
between the best and worst rounding rule is 612 gold per potion — small relative to the 2,372 baseline
margin, but it must be disclosed rather than hidden.

### (d) The same chain with the probabilistic mechanics, for contrast

If the player also has **Smelting magic tier 3** (M23) it does nothing here — this is a Brewing recipe, and
Smelting magic is Smithing-only. If the player wears **Brewing gloves** (M25, 5% chance to double loot), the
expected output becomes `1 × 1.05 = 1.05` potions per craft, so the expected `buyCost` per craft stays
11,454 while the expected *revenue* per craft rises — a different question from buy-vs-craft, and one the
advisor must not silently blend into the margin.

---

## 7. What we still do not know

| # | Gap | What would settle it |
|---|---|---|
| U1 | **How the game rounds the Guardian's brewing spoon's 10%.** 15 × 0.9 = 13.5 and 2 × 0.9 = 1.8 are not integers. Floor, round, and ceil per component all give different margins (§6c). | One in-game observation: brew a Potion of resurrection with the spoon equipped and read the consumed quantity off the task log. Or the client's task-execution code. |
| U2 | **Whether the spoon's 10% is per cost line or on the total.** Immaterial for the fractional arithmetic (0.9 × Σ = Σ 0.9 ×), but it changes the rounded result. | Same as U1. |
| U3 | **Whether the spoon's 10% also applies to a gold cost component.** No Brewing task has a gold cost in `gameData` (only 17 Carpentry plank tasks carry item 19), so the question is untestable from data. | A Brewing task with a gold cost, or the client code. |
| U4 | **Potion of trickery duration: 600 s (wiki item page) vs 900 s (`gameData.PotionData.Items` PotionId 5).** The 25% chance is agreed by both. | One in-game observation of the buff timer, or a newer `game-data`. |
| U5 | **Potion of negotiation duration: 600 s (wiki item page + Boosts page) vs 300 s (`gameData.PotionData.Items` PotionId 1).** The 5% effect is agreed by both. | Same as U4. |
| U6 | **Whether clan property's `GlobalSkillingBoost` is speed or experience.** The API field is named `GlobalSkillingBoost` (5→30) while the wiki's `Clan` and `Boosts` pages both call it an experience boost. | The in-game profile "view breakdown" screen, which the wiki says shows the current percentages per skill. |
| U7 | **The exact per-tier mapping of `gameData.Upgrades.Items` `Type` to upgrade names.** The API entries carry no `Name`; only `TierNameLocKeys` for a few. The mappings in this document were established by matching `Tiers` + `TierUnlocks` + `Costs` against the wiki's published tables, and every one matched exactly — but the mapping is inferred, not labelled. | A `game-data` version that names the upgrades, or the client's localisation table. |
| U8 | **The fisherman and The lumberjack are indistinguishable in the API** (Types 2 and 3 have identical `Tiers`, `TierUnlocks` and `Costs`). Both are 20/40/60/80/100%, so the numbers are safe; only the name-to-Type assignment is ambiguous. | Same as U7. |
| U9 | **Whether the 5% skilling-gloves double-loot chance stacks with the per-skill double-loot upgrades** (The fisherman, The lumberjack, Power forager) or with the Guardian's mallet/lamp. The wiki does not say. | In-game observation, or the client's loot-roll code. |
| U10 | **Whether the Guardian's brewing spoon's 10% and the Brewing gloves' 5% double-loot are independent rolls.** | Same as U9. |
| U11 | **The live market depth of the spoon itself.** Ask 29,710,712 with volume 1 and bid 25,000,000 with volume 1 — a single unit on each side. Any "is the spoon worth it" arithmetic is unfalsifiable at that depth. | More listings. Not actionable for the advisor. |
| U12 | **Whether `gameData.Upgrades.Items` Type 14** (`Tiers: 4`, `TierUnlocks: [5,10,15,20]`, `Costs: [500000,1500000,5000000,10000000]`) is the mastery-cape upgrade. The wiki's Brewing cape costs are 500,000 / 1,000,000 / 5,000,000 for tiers 1–3, which does not match. | Same as U7. |
| U13 | **The wiki's search API is Cloudflare-blocked** (`/w/rest.php/v1/search/*` and `/w/index.php?search=` both return 403). All wiki content in this document was reached by following links from `Main_Page`, `Skills`, `Boosts`, `Local_market` and the per-skill pages. A page that exists but is not linked from those may have been missed. | A wiki search that works, or a full category dump. |

---

## 8. Recommendation to the owner

**Model now, unconditionally:** the 1% sell tax on the bid side only (M01), the untaxed buy side (M02), and
the zero-means-no-offer rule (M03). Those three are the only facts true for every player, and they are
already half-implemented.

**Model as an explicit, labelled expected value, with a user input selecting the tier:** Smelting magic
(M23) and the Brewing gloves' 5% double loot (M25). These two are the ones with a documented history of
flipping a verdict in this repo, and both are cheap to model honestly: `E[cost] = amount × (1 − p)`, printed
with the word "expected" and with the floor and ceiling beside it.

**Take as a user input, never guess:** the Guardian's brewing spoon (M04), Delicate manufacturing (M06),
Arrow crafter (M07), Plank bargain (M05), the tool / cape / enchantment / gear speed stack (M08–M11), and
the potion-active flags (M24, M35). Where the user gives no input, print an assumptions line naming exactly
which mechanics were left out — that line is the difference between this document and the v1 failure.

**Disclose only, do not model:** housing and clan property (M12, M13) — they are experience boosts and
change nothing in the arithmetic, so say so in one line rather than building a tier input for them; the
non-player-sale gold boosts (M15, M16, M17) — they never touch the player market; and the potion-duration
stack (M18, M19, M20) — it only extends M24/M35 and adds an input for no gain.

**Do not model at all:** everything in §2.1. Enchantments, housing, clan upgrades, consumables, daily
boosts and holiday events have **no** cost or output effect, and the single most valuable thing this
document can tell the implementer is that there is no smithing, cooking, carpentry or enchanting equivalent
of the brewing spoon — so the temptation to generalise M04 across skills must be resisted.
