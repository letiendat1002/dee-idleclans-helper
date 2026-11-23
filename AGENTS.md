# Dee IdleClans Helper — Agent Guide

**Read `docs/CONVENTIONS.md` before implementing anything in this repo.** It is the binding
convention: the product invariants, the live-data invariants, the Discord platform rules, the
code rules, the testing rules and the git rules. This file is the short version and a map — the
conventions win over anything written here.

## What this repo is

A Discord bot that reports Idle Clans market facts. It reports a live sell price, buy order and a 24h/7d/30d/1y
chart per item, sends opt-in DM price alerts, posts a market digest or a clan vault log to a
channel, and answers @mentions with a public showcase embed. Published commands: `/price`,
`/graph`, `/watch`, `/unwatch`, `/watchlist`, `/digest`, `/vault`, `/help`.

It ships **no profit advice**. v1 shipped `/profit`, it was wrong by a factor of 720,000, and
the owner killed it. Every number this bot prints is a market fact or arithmetic over market
facts. Do not reintroduce profit output, and do not reintroduce a game formula.

## Docs map — read what the task touches, not everything

Docs are **agent-facing** and written in Vietnamese; user-facing copy (embeds, footers, README,
the Discord application description) is **English**. Every doc below is reachable from here, so a
new agent never has to guess a filename.

| File | Read when | Holds |
| --- | --- | --- |
| `docs/CONVENTIONS.md` | before any code | binding rules: units, live data, Discord, code, tests, git |
| `docs/ROADMAP.md` | start of a session | decisions D1-D6, tracks T1-T9, measured facts, resume contract |
| `docs/ARCHITECTURE.md` | changing a flow, poller, table or budget | topology, boot order, command flow, data tiers, rate limits, capacity |
| `docs/VOICE.md` | writing any user-facing string | tone rules and the banned phrasings |
| `PRODUCT.md` | deciding what the bot is for, or writing listing copy | users, positioning, invariants, brand commitments (from `/impeccable init`) |
| `docs/UI-DESIGN.md` | touching an embed, chart or DM | **design system of record**: embed anatomy, colours, icons, chart rules, interaction |
| `docs/CHART.md` | a chart element looks wrong or unreadable | what each series and caption means, the data tiers behind it, why coverage reads "6 of the last 30 days priced", why the line is stepped, and the decision log (bid line dropped, window pinned, no candles) |
| `docs/ENVIRONMENTS.md` | production vs dev, token rotation, running a second stack | two Discord applications, guild mapping, `STACK_PREFIX` + `IMAGE_TAG`, dev database, command propagation |
| `docs/GITHUB-SETUP.md` | changing a repo setting, a workflow, or a dependency policy | visibility, branch protection, secret scanning, Dependabot targets and why majors are read first |
| `docs/DEFERRED.md` | deciding whether something can wait | the parked ledger: owner blockers, verification gaps, tech debt, resume triggers |
| `docs/SETUP.md` | first run on a new machine | token, database, migrations |
| `docs/DISCORD-TESTING.md` | verifying on the real surface | MCP driver, intents, command walkthrough |
| `docs/DATA-PROVENANCE.md` | an upstream field looks wrong | endpoint map, field meanings, limits |
| `docs/GAME-MECHANICS.md` | a number needs a game formula | sourced mechanics, what is modelled |
| `docs/DIGEST-CONFIG-DESIGN.md` | changing digest rules | the one-channel cap and why |
| `docs/MARKETING-COPY.md` | the top.gg or portal listing | surfaces, limits, recommended strings, evidence |

Deploy, release, operations, legal, competitor research, the vendor API spec and the
marketing assets are **not in this repository**: they live in the maintainer's private notes
(`docs-private/`, `assets/`, `evidence/` beside the clone). A doc that needs one of them names
what it needs instead of linking a path that does not exist here.

**A skill's body is not memory.** A skill loads as a tool result, so a compaction drops it while
the skill's *index* (name + description) stays in the prompt. Never assume a skill is still loaded
— call `skill` again when a trigger matches. For anything drawn (embed, chart, colour, type scale,
spacing) read `docs/VOICE.md` + `docs/UI-DESIGN.md` first; they win over any skill. Call
`skill ui-ux-pro-max` only when choosing a *new* style, palette, font pairing or chart type.

## Knowledge graph (graphify)

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

## Source-of-truth order

1. `docs/CONVENTIONS.md` — the binding convention for *how* to build here (§8 git, §12 deviations).
2. `docs/ARCHITECTURE.md` — how a flow is wired: topology, boot order, tables, budgets.
3. `docs/ROADMAP.md` — scope: decisions D1–D6 and the track list.
4. **Task memory**, outside this repository at `<private notes>/tasks/<slug>/`:
   `IMPLEMENTATION_PLAN.md` (task table with commit hashes) and `CONTEXT_FOR_COMPACT.md`
   (the resumable context — objective, gotchas, locked decisions, verify recipe, blockers). Read
   the `CONTEXT_FOR_COMPACT.md` of the active task before touching anything; it survives compaction
   when a session does not. Write it **before** a compaction, never after.
5. `<private notes>/CONVENTION.md` — which document wins, and the reload prompt after a compaction.

The v2 design spec, the build plan and the session ledger are **private** ticket artifacts; they
live in the notes folder beside the clone, not in this repository. When a doc needs one, it says
what it needs rather than linking a path that does not resolve here.

## The five rules that break the product if violated

1. **Like-for-like units.** Never compare an ask against a trade average. Ask = `lowestSellPrice`
   (what you pay), bid = `highestBuyPrice` (what you receive).
2. **No unmodelled, undisclosed formulas.** The v1 `/profit` command applied a mechanic it did not
   understand and missed another, and was wrong by 720,000×. The rule is no longer "no formulas":
   research the game's mechanics first (`docs/GAME-MECHANICS.md`), then model a modifier behind an
   explicit user input (spoon, delicate, arrow_crafter, smelting, forgery) or state it in the
   assumptions line. Never silently assume "no boosts", never hard-code a bonus you cannot source.
   Gear, enchantment, housing, clan upgrades, toolbelt and yield procs may not appear *without*
   disclosure. The only permitted derived rate that is unconditional is
   `3,600,000 / (baseTimeMs × itemAmount)`, labelled **"base task time"**. The word "bars" must
   never appear in the UI.
3. **A price of `0` means "no offer"**, never "free". 27 of the 627 quoted items have no sell
   order and 43 have no buy order. Filter zeros out before any average. Item id `0` is a real
   item — never guard with `id <= 0`.
4. **Tradeable comes from the catalogue** (`items.tradeable`), not from "the item has a quote":
   676 catalogue items are tradeable but only 627 are quoted, so deriving it from quotes
   misreports up to 49 real tradeables.
5. **A blocked DM is never made public.** Mark `delivered = false`, surface it in `/alerts`, and
   never post a public fallback.

## Hard rules beyond code style

1. **No write SQL against a live database from an agent shell.** `SELECT` only on dev and prod;
   schema changes go through `src/db/migrations/` and `npm run migrate`.
2. **No rewrite of pushed history.** No force-push, no amend of a pushed commit, no rebase of a
   shared branch. Fix forward with a new commit.
3. **No generated artifacts in git.** `dist/`, `node_modules/`, `graphify-out/`, `*.log` and every
   `.env*` stay ignored; a committed build output is a bug, not a convenience.
4. **Push and release are separate decisions.** Pushing a branch is normal work; merging into
   `production`, deploying, tagging and enabling a timer each need the owner's word in that turn.

## Hard code rules

- Comments in **English only**; `/** */` docblock for anything describing a function, method,
  class or module-level constant. No comment that restates the line below it.
- **Never `as any`.** `tsconfig.json` excludes `**/*.test.ts`, so `npm run typecheck` does not
  check test files — check them by hand:
  `npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --types node src/<file>.test.ts`
- Runtime stays **CommonJS** (`"type": "commonjs"`) — `src/db/migrate.ts` uses `__dirname`.
- Relative imports carry the `.js` extension. No new dependencies.
- Discord API is **discord.js v14**: `client.users.createDM(userId)`, `client.users.fetch(id)`,
  `user.createDM()`. `client.users.create` does not exist (removed in v13).
- The bot keeps the **MessageContent** and **ServerMembers** privileged intents **OFF**. Anything
  that connects as this bot must not request them either — Discord closes the gateway with 4014
  "Used disallowed intents".

## Git

**This repo overrides the global commit rule.** The global `~/.config/opencode/AGENTS.md` says
"không commit tự động"; here the agent **commits proactively** at the end of each finished unit
of work — one commit per coherent change, message in the repo's imperative style. No permission
prompt per commit.

Bounded by four things: never force-push or rewrite pushed history, never commit secrets or
`.env`, run `npm run typecheck && npm test` before committing, and a push does **not** deploy —
deployment goes through `scripts/deploy.sh`.

Format and flow are in `docs/CONVENTIONS.md` §8: branch `<type>/<short-desc>` off `develop`,
commit `type: subject` on one line, land it through a PR merged with a **merge commit** (squash and
rebase-merge are disabled), and a release is the five-step procedure in §8.3 — PR into
`production`, manual deploy, tag, merge-back.

**Releases are manual and deliberate.** `dee-idleclans-deploy.timer` stays **disabled**; a deploy
runs only when the owner asks for a release, and then only through the §8.3 sequence. Never enable
that timer, never move production back onto a laptop, and never start a later phase a doc marks as
future work unless the owner asks for it in that turn.

**Production runs on the always-on host server**, installed on 2026-11-23: the bot and collector
there serve the real guild, the laptop keeps only the dev stack and an outside watcher that
reports a dead host over Telegram. Tracked files name no host path (the scan workflow rejects
absolute host paths); exact paths, units and the rollback laptop stack live in the private
`docs-private/DEPLOYMENT.md`.

## Workflow

One implementer per task → a task review (spec compliance **and** code quality) → a fix round →
the ledger. Never dispatch two implementers for the same task at once, and never dispatch a
second implementer while the first might still be alive — check the session and the file mtimes
first. Review the fix diff; a task is not done until its review is clean.

## Testing

`npx vitest run <file>` for the focused test, `npm test` for the suite, `npm run typecheck` for
the compiler. Tests must fail when the implementation is reverted — prove it on a scratch copy
under `/tmp`, never by breaking the real file. No test may depend on wall-clock timing: no fixed
sleeps, no polling waits. Use fake timers or an injected delay.

Live testing against the real Discord is described in `docs/DISCORD-TESTING.md`.
