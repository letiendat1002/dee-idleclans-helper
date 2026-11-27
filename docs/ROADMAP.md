# Roadmap — decisions, tracks, and what is left

Who reads this: an agent starting or resuming a session — when: at the start of work, and after every compaction.
Neighbours: [ARCHITECTURE.md](ARCHITECTURE.md) · [CONVENTIONS.md](CONVENTIONS.md) · [DEFERRED.md](DEFERRED.md) · [AGENTS.md](../AGENTS.md).

The durable ledger for this project. If a session is compacted, this file plus `ARCHITECTURE.md`
is the resume contract: read those two first, then only the docs a track names.

Last updated: 2026-11-25.

## 0. Decisions locked by the owner

| # | Decision | Where it lives |
| --- | --- | --- |
| 2026-11-25 | **Release 1.3.0: note tự đăng khi tag, deploy fail tự báo, resolver công cộng** | `develop` → PR #45 → `production` `8ca86cd` → deploy `dee` OK (4/4 healthy, restarts 0, log error 0, snapshot 38 s, 8 command, `.deployed-sha` = `8ca86cd3`); tag `v1.3.0` (tag object `8d860ae`) từ máy dev; `version-guard` + `release notify` success, note trong `dih-updates` `1574969309720219781` có ping `Release [DIH]`; merge-back PR #46 `f260e44`. Container giờ có `dns: [1.1.1.1, 8.8.8.8]` (host stub timeout AAAA `discord.com` 2026-11-24) và `ipv4first` giữ nguyên. Deploy lần này suýt chặn ở bước `git fetch`: chính stub của host treo 8 s rồi trả `Temporary failure in name resolution` — đã trỏ tạm `resolvectl dns enp2s0 192.168.100.1` (xem `docs-private/OPERATIONS.md`) |
| 2026-11-23 | **Audit sau chart v3: tách image dev/prod, sửa `/help`, archive prompt cũ** | Phát hiện: hai stack dùng chung tag `dee-idleclans-helper:local` nên lần build dev 00:47Z đã ghi đè tag production tham chiếu, và image production (prune mất, container vẫn chạy) không còn để tạo lại → `docker-compose.yml` đổi sang `${STACK_PREFIX:-dee-idleclans-helper}:local` (prod resolve y nguyên), build lại tag prod từ `5349b75` (commit HEAD lúc prod start 08:51:42Z), dev chuyển sang `dih-dev:local`; `/help` còn ghi "sell-price trend over 24h, 7d or 30d" → "average traded price over 24h, 7d, 30d or 1y" + assertion; `RESTART-PROMPT.md` (2026-11-14) đang tự nhận authoritative và trỏ `src/ui/chart.ts` đã xoá → archive. 398/398 test, typecheck 0, build OK; prod container không bị restart (vẫn Up 18 h, image ID cũ) |
| 2026-11-23 | **`/graph` chart v3 committed và live-verified trên DIH Dev** (`0f9bed4`): bốn range 24h/7d/30d/1y đổi tại chỗ, ảnh 900×260 (512×148 trong Discord) | Coal ore: 24h `49 buckets of 30 minutes` `144g–150g` `14.42m units`; 1y `53 buckets of 1 week` `99g–190g` `4.78b units` `+9.0%`; 7d `29 buckets of 6 hours`; 30d `31 buckets of 1 day` — khớp site từng số ở 1y và 24h; 398/398 test, typecheck 0, build OK, ảnh lưu tại `personal/idle-clans/chart-2026-11-23-live-graph-{1y,7d,30d}-coal.webp`; evidence `docs/DISCORD-TESTING.md` §7.8 |
| D1 | Digest is capped at **1 channel per server** (abuse surface beats convenience) | `DIGEST-CONFIG-DESIGN.md` |
| D2 | Vault feed: up to **5 channels per server**, 14-day window, no backfill, no notifications | private ops notes §1 |
| D3 | The bot reports facts only: **no advice, no profit estimate, no undisclosed formula** | `CONVENTIONS.md` §2.1 |
| D4 | The agent **commits proactively in this repo**; the global "no auto-commit" stays the default elsewhere | `AGENTS.md`, `CONVENTIONS.md` §8 |
| D5 | Marketing never frames a limitation as the pitch ("no notifications", "no advice" are banned in copy) | this file, `VOICE.md` |
| D6 | Price history is **irreplaceable**: the upstream only serves a short window, so the DB is the long-term record. Two guarantees hold it up: a raw row is deleted only after its UTC day is in `price_daily`, and both sides (ask and bid) are archived, since a side not archived is gone for good | this file, track T7 |
| D7 | Monetization: **free 100%, donations without perks**. No premium tier, no rate-limit top-up, no paid feature; a donation may not unlock anything, because that turns it into a paid capability (Discord requires selling those through Premium Apps, which does not pay out to VN) and turns the money into business income | `docs/legal/LEGAL_DONATION_VN.md` |
| D8 | Code is **MIT and public**; GitHub Sponsors is one of the two donation rails | `LICENSE`, `README.md` §License, `.github/FUNDING.yml` |
| D9 | **Released and hosted** (2026-11-23): `v1.0.0`–`v1.0.2` tagged, `production` merged forward, and the stack runs 24/7 on the host server. The deploy timer stays disabled and a release is still the owner's call, made through `CONVENTIONS.md` §8.3; anything a doc marks as a later phase needs the owner's word in that turn | this file, `DEFERRED.md` D16, private ledger |

## 1. Tracks

Status: `done` / `active` / `queued` / `blocked`.

### T1 — Audit and corrections · done

Full audit (architecture, real-surface Discord testing, code-vs-docs alignment). Fixed the alert
DM title (custom emoji rendered as raw markup) and 15 false statements across the docs.
Evidence: `ARCHITECTURE.md`, the architecture audit, 400 tests.

### T2 — Flow diagrams · done

Produce three diagrams with the `archify` skill, checked against code, not against prose:
1. **Runtime flow** — gateway → interaction → rate limit → permission → service → Postgres/Redis.
2. **Data lifecycle** — one poll → `price_snapshots` → prune/rollup → digest/alert reads.
3. **Deploy flow** — push → `deploy.sh` → build → migrate → health gate → rollback.
Output: `docs/diagrams/*.html`. `ARCHITECTURE.md` links them instead of the ASCII sketch.

### T3 — Marketing copy · done (copy ready, portal edit is the owner's)

Research done by a librarian pass over `github.com/coreyhaines31/marketingskills` plus Discord
discovery guidance. Deliverables to land:
1. Portal description (<= 60 chars tagline + <= 400 chars body) that says what the bot does.
2. `README.md` rewritten around facts, with the run/test/deploy commands.
3. Digest footer: replace `digest only, no notifications` with provenance, not a limitation.
Constraint (D5): no negative framing, no profit language.

### T4 — Docs consolidation · done (2026-11-25, PR #68 + #70)

Sixteen docs, all written for an agent to act on. Goal: each file has one job, a header that says
who reads it, and links to its neighbours; `AGENTS.md` becomes the map + the five rules that break
the product, not a duplicate of `CONVENTIONS.md`.

### T5 — Known debt · done

1. Rate limiter is five Redis round trips; make it one Lua script (currently documented as a
   bounded overshoot).
2. `commands/*` import `safeReply` from `../index.js` — a circular-import shape; move it to
   `src/ui/reply.ts`.
3. A wedged container only shows `unhealthy`; add automatic recovery (autoheal or a supervisor)
   only if it can be done without another paid dependency.

### T6 — Deploy pipeline · done

Free, private-repo, single-host automation: build → migrate → restart → health gate → rollback,
plus the nightly backup. Research favours a host-side mechanism (self-hosted runner or a
pull/webhook trigger) because GitHub-hosted runners are not available for this repo. Must be in
the private deploy notes and in the T2 deploy diagram.

### T7 — Price history tiers · done (architectural)

The upstream serves a short window (averages up to 30 days, raw prices only live), so **what the
DB keeps is the only long-term record**. Today: raw 2-minute snapshots, pruned at **7 days** —
that is a 7-day memory for a market product.

Plan: two tiers.
1. `price_snapshots` — raw, kept 30 days (the cheap window; ~452 k rows/day, ~70 MB/day).
2. `price_daily` — one row per item per UTC day: open, close, low, high, volume, mean; **kept
   forever**. ~628 rows/day, ~230 k rows/year, a few MB a year. This is the dataset long-span
   analysis and any future model training reads.
3. Optional backfill: the API publishes `averagePrice1Day/7Days/30Days` per item, so a
   `price_daily` seed can be reconstructed for the last 30 days **as averages only** — label them
   as such, never as observed open/close.

Acceptance: a `/graph` range query and a documented retention policy; a test that a rollup row is
written once per item per day and that pruning never touches `price_daily`.

### T8 — Spam and rate-limit hardening · done

The Idle Clans API allows 50 req/min per IP globally; the bot currently uses ~0.6/min (no clan)
to ~5/min (20 clans). Confirm the failure modes under burst: one user cannot amplify API calls
(answers are shared/cached), autocomplete is debounced, and a 429 or a timeout degrades to a
stated "data unavailable" instead of a retry storm. Research the game's documented limits and
write the conclusion into `ARCHITECTURE.md` §6.

### T9 — Ship · done (2026-11-23 → 2026-11-25)

Shipped `v1.0.0` → `v1.3.1` through the §8.3 sequence: gates, PR into `production`, manual deploy,
health gate, tag, merge-back. The real-surface gate was exercised more than once (digest post,
`/help`, `/watch` DM, vault post).

### T10 — Live test 100% + data audit · done (2026-11-21)

Owner asked 2026-11-21 to re-exercise **every** shipped command on real Discord and audit the
numbers against upstream. Steps, in order:

1. Read `docs/DISCORD-TESTING.md`; confirm container health, DB reachable, Redis reachable.
2. Compare 10 items in `price_snapshots` against the live API — the same field, the same item.
3. Check the invariants: `0` filtered before any average, tradeable read from `items.tradeable`,
   covered-span disclosure, `price_daily.samples` matching the raw day.
4. `/price` — normal item, off-market item, autocomplete.
5. `/price-list` and `/graph` — ranges, span note, `Post to channel`.
6. `/watch` → `/watchlist` → `/unwatch`; no phantom rows left.
7. `/digest add/list/remove/interval`, `/vault`, `/help` in `#digest`.
8. @mention the bot — showcase embed must repeat the same numbers as `/price`.
9. Report a pass/fail table with the observed string for each step. "Should work" is not a result.

**Result 2026-11-21:** 8/8 commands driven, every observed string in `DISCORD-TESTING.md` §7. The
audit compared the newest poll field by field with upstream (`631/631`, zero mismatch on ask, bid
and both volumes), confirmed the `0` rows (22 ask / 45 bid), the 676-vs-631 tradeable split, and
`price_daily.samples` equal to the raw ask rows on both archived days. Both guards fired for real
(stale digest refused, failed fetch kept the snapshot). `/price-list` in step 5 is not this bot's
command: it belongs to the `Phoenix` bot in the test guild, and `AGENTS.md` named it wrongly.

### T11 — Market Insights · active (design settled, no code yet)

Goal: a pattern engine over our own database. It ingests, cleans and rolls up what we already
store, then posts the strongest patterns on an interval — a separate job with separate state,
posting to a separate channel, with the existing `idle-market` channel renamed to
`idle-market-watch`.

Decisions locked: analysis is DB-only, so the job makes zero HTTP calls and every printed number
is reproducible in SQL; the cadence is per channel in a new `insight_channels` table, because the
digest's cadence is per guild and cannot drive two channels at different rates; each pattern
declares a baseline and a sample count and is ranked by surprise rather than by size
(QuickInsights); seasonality stays silent until two years of history exist; no model ever produces
a number.

Copy is part of the contract (`VOICE.md`): sell price and buy order, two raw counts instead of a
ratio, no column names, no scores in the body, the method in one footer line.

The spec is `docs/superpowers/specs/2026-11-26-market-insights-design.md` — **gitignored**, so the
tracked copy and the full ledger live in the maintainer's private notes repo
(`tasks/market-insights/`).

Open before any code: interval default and floor, retention, the seasonality gate, and whether the
existing channel is renamed (it keeps its id) or replaced.

## 2. Measured facts (do not re-measure by guessing)

| Fact | Value | Source |
| --- | --- | --- |
| quoted items per poll | 632 (2026-11-21) | `SELECT ... GROUP BY captured_at` |
| snapshot write rate | ~455 k rows/day (632 × 720); **453 458 rows in the 24 h to 2026-11-25 03:08Z** on the host | 1 085 777 rows / 1 718 polls; live query on `dee` |
| database size | **337 MB** (`price_snapshots` 328 MB, 2.25 M rows; `price_daily` 6 310; `items` 1 009) | `pg_database_size`, 2026-11-25 |
| bytes per snapshot row | ~153 B (heap + indexes) | 328 MB / 2.25 M rows, 2026-11-25 |
| upstream limits | 50 req/min/IP, 500 max limit on clan log | `DATA-PROVENANCE.md` |
| guilds, commands | **1 guild (HORDE), 8 global slash commands**; the dev app is a separate application | Discord API 2026-11-25 |
| tests | **404 across 32 files** | `npm test`, 2026-11-25 |
| trade-average cache | 5 min TTL; miss 2 942 ms, hit 1 ms; 20/min budget, 21st = `null` in 1 ms | in-container probe 2026-11-21 |
| 24 h window coverage | **453 458 rows over 24.0 h; 0 gaps > 20 min, largest gap 6 min (the 1.3.0 deploy)** | live query on `dee`, 2026-11-25 |
| staleness caps | alerts and digest both refuse a snapshot older than 10 min | `AlertDispatcher.ts`, `MarketDigest.ts` |

## 3. Verified host and repo facts

Checked on the machine and in git, not inferred from docs. Re-check only if reality looks wrong.

| Fact | Value |
| --- | --- |
| branches | `master` (origin HEAD), `develop` (working), `production` (deploy) |
| divergence | `develop` is **51 commits ahead** of `origin/production` |
| `dist/` and `node_modules/` | gitignored, so a deploy host **must** run `npm ci && npm run build` before the image build |
| migrations | each `.sql` is applied by one `pool.query(file)` — a multi-statement file is one implicit Postgres transaction, but the `schema_migrations` insert is a separate statement, so a crash between the two replays the file and must stay idempotent |
| test DB | none — tests mock `db/pool.js`; SQL correctness is checked against the live container |
| GitHub Actions on a private repo | hosted runners are billed; **self-hosted runners are free** (do not consume included minutes) |
| deploy target | single host, Docker Desktop (Linux), compose stack `postgres + redis + bot` |

## 4. Resume contract

After a compaction, read in this order: this file → `docs/ARCHITECTURE.md` → the doc the active
track names → the files the active track touches. The todo list is restored by the harness; if it
disagrees with this file, **this file wins** and the todo list is rebuilt from it.

Anything deliberately parked — owner blockers, verification gaps, tech debt, marketing — lives in
`docs/DEFERRED.md`, with the trigger prompt to pick it up again. Do not reconstruct that list from
memory.

Monetization and licensing are settled (D7, D8): the bot stays free, a donation carries no perk,
the code is MIT. Read the private legal note on donations before touching anything user-facing about
money — it holds the only **verified** list of rails a Vietnamese individual can actually withdraw
from, and the wording that keeps a tip a gift instead of a charity campaign.

Every track T1–T10 is closed. **T11 (Market Insights) is the one open track**: PR1 (the book side,
`/insight`) is on `develop` and unreleased; only the dry sell side cleared the design's calibration
gate, and the flip and the range edge are parked in `docs/DEFERRED.md` (D21) until their
persistence clears 90%. The queued work is otherwise the trigger list in `docs/DEFERRED.md`
(D15 at 1 GB, the host maintenance window, the scheduled drill). If a restored todo list disagrees
with this file, this file wins.

## 5. Progress log

| Date | What landed | Evidence |
| --- | --- | --- |
| 2026-11-27 | **T11 PR1 — `/insight` và book rollup lên `develop`, chưa release**: 3 detector (dry sell side, book flipped, pinned at edge), queue `insights` claim-trước-khi-post + cooldown 72h, `book_hourly` rollup từ `price_history`, `/insight add\|remove\|list\|interval` (rate cap 240 phút, floor 60), migration `015` | PR #102 (`2db9104` → `develop`), `check`+`scan`+CodeQL+GitGuardian xanh, 500/500 test; coverage 87,33 / 75,25 / 89,51 / 88,49 |
| 2026-11-27 | **Calibration gate loại 2/3 pattern**: replay 8 ngày production (638 item, 125 853 giờ) đo persistence +6h — dry 94% (0,88 accepted/ngày) pass, flip 81% và pinned 78% fail dù đã siết ngưỡng, thêm cửa sổ xác nhận 6h và đo lại đúng statistic của card. Dry nâng 12h → 24h; flip + pinned gỡ khỏi engine (D21); sửa `SELECT item_id` và impact tính theo cả window (item dry có 0 ask volume trong 24h, nếu tính 24h thì mọi finding score 0) | gate log `npx tsx scripts/insight-replay.ts <export> --days 8`; 496/496 test |
| 2026-11-26 | **Release `v1.6.0` — vault feed đọc như sổ cái, và mọi surface vẽ bằng icon của app**: post vault nhóm theo chiều (`In`/`Out`/`Moved`), mỗi dòng mang ngày giờ UTC và item in đậm, footer `clan log · last 14 days`; card mở bằng net-change từng tier (chỉ cộng delta đã ghi, không giả làm số dư); `/vault list` có stamp `last_post_at` (migration `014`, nullable nên hiện `never` tới post đầu) để phân biệt clan im với feed chết; `/vault recent` cap 30 với nhãn `Newest N entries`; `/vault remove` dùng chung card với `/vault add`; tick >30 entry chỉ mark phần đã đăng; error reply dùng icon app thay emoji Unicode; item có giá mà catalogue chưa có vẫn hiện và search escape `%`/`_`; bộ icon còn 9 token, guard thứ 8 chặn token không surface nào vẽ | PR #98 (bump), #99 → `production`, deploy `46f93b7d` 4/4 healthy bot `1.6.0`, tag `v1.6.0`, merge-back #100; 426/426 test |
| 2026-11-26 | **Track T11 Market Insights mở — design v4, chưa có code**: engine insight đọc thẳng DB (ingest → clean → detect → post), **0 HTTP call** lúc phân tích nên mọi số truy lại được bằng SQL; tách channel `idle-market-insight` + rename `idle-market` → `idle-market-watch`; cadence theo channel trong bảng mới `insight_channels` (digest cadence đang per guild, không dùng được cho 2 channel khác nhịp); pattern khai báo baseline + sample count, rank theo surprise (QuickInsights); seasonality gate 2 năm; copy theo `VOICE.md` (hai con số thay tỷ lệ, không tên cột, method ở footer) | Spec `docs/superpowers/specs/2026-11-26-market-insights-design.md` (**gitignored** — bản track nằm ở notes repo của maintainer, `tasks/market-insights/`); detector chạy thật trên production: dry sell side 1, off the board 2, book flipped 5+, pinned 2 (631 item/24h, 184 item có volume ≥100) |
| 2026-11-26 | **Release `v1.5.2` — mention cooldown 60 s → 10 s, và lần bị bỏ qua có log**: owner báo ping lần đầu có card, lần sau im. Không phải crash: cooldown tính theo user id **xuyên channel** và nhánh skip `return` không log. Dựng timeline từ API Discord: mention `17:50:41.003Z` → reply `17:50:41.662Z`; mention `17:51:01.372Z` (channel khác, cách 19.4 s) → không reply; mention `17:56:28Z` → reply | PR #83 `c9a7dd5` (hằng số + `logger.debug` + test pin mốc 10 s và kịch bản 20 s), #84 (bump), #85 → `production`, deploy `d082d349` 4/4 healthy bot `1.5.2`, tag `v1.5.2` (Release object tự tạo), merge-back #86 `309f38a`; 410/410 test |
| 2026-11-25 | **Release `v1.5.1` và hai đường ủng hộ**: `/help` trỏ Ko-fi (`ko-fi.com/letiendat1002`, thẻ/PayPal — người chơi không cần tài khoản GitHub), GitHub Sponsors ở README, mention card thêm `Source on GitHub`; footer `/help` hết `[Privacy](…)` literal (Discord vẽ footer là plain text) nên policy vào field `Links`; `FUNDING.yml` khai cả hai rail; B4 đóng | PR #78 `9efad14`, #79 `c2db959`, #80 → deploy `34315152` (4/4, schema `013`), tag `v1.5.1`, merge-back #81 `83b704a`, #82 `0f31f80`; `ko-fi.com/letiendat1002` trả 200, title `Support HRDDee`; 410/410 test |
| 2026-11-25 | **Release `v1.5.0` — deploy không còn chết im lặng, và lockfile không lệch manifest**: `deploy.sh` gom `build_at()` dùng chung cho deploy và rollback, `build_at "$target" || rollback "the build failed"` (trước đó build fail chỉ làm unit exit, không DM); harness `scripts/deploy.failure.test.sh` (build/health/schema, stub docker+curl+npm) chạy trong CI; `version-guard` thêm bước so `package-lock.json` với manifest | PR #76 `454d7b8`, #77 `55606f5`, #73 `50dc545`, #74 `948f219` → deploy `948f219e`; trước fix harness báo `FAIL build: the webhook never said 'the build failed'`, sau fix 3/3 ok; host có `build_at` ×3 + `the build failed` ×1 |
| 2026-11-24 | **Release `v1.2.0` — quyền command do Discord sở hữu**: handler `/digest` và `/vault` thôi tự kiểm `Manage Server` (một role được server cho phép không còn bị từ chối sau gate); `/help` trỏ `Server Settings > Integrations` thay vì nêu tên quyền; `ENVIRONMENTS.md` ghi bot production ở Horde | PR #36 `8eb0684` + #37 `f549828` → `c3e937a` trên `develop`; release PR #38 (bump 1.2.0) + #39 → merge `19f9fe7`, `deploy.sh` ghi `.deployed-sha=19f9fe7b`, tag `v1.2.0` = `19f9fe7` (version-guard `success`), merge-back #40 → `a6fba8a`; 399/399 test, typecheck 0, lint 0, scan clean; prod 4/4 healthy, `image=sha-19f9fe7b` restarts 0, 8 commands, snapshot cách 82 s, `/digest list` trên Horde trả lời ephemeral (0 channel) — lần bấm đầu fail `EAI_AGAIN discord.com` (DNS blip của host lúc 16:16Z), lần hai OK |
| 2026-11-24 | **Live-test đủ 8/8 command trên production, rồi bot rời mọi guild**: `/watch` arm → fired → DM delivered (`delivered=t`, `00:40:09Z`), `/unwatch` xoá row; `/digest` add (cap 1 kênh) / list / interval / remove + đăng digest thật 00:51, 01:52, 02:53; `/vault` add → list → remove (DB 1→0 row); `/help`, `/price`, `/graph 7d`, `/watchlist`, `@mention` | DB kiểm chéo từng bước trên `dee`; `DELETE /users/@me/guilds/<id>` trả 204 cho cả hai guild, `GET /users/@me/guilds` rỗng; DIH Dev giữ guild test (bảng digest/vault/watch không có cột bot nên 1 bot/guild là ràng buộc) |
| 2026-11-24 | **RPO backup 24h → 1h + cổng chất lượng**: `backup-db.sh` dump lại mỗi lượt (bỏ `SKIP_IF_PRESENT`/`FRESH`), watchdog 26h/30h → **3h/3h**, unit host bỏ env chết; `npm run lint` (oxlint, deny warnings) và coverage thresholds 84/71/85/85 vào CI; migration `011` drop `guild_settings.digest_channel_id` + `digest_enabled` | dump `idleclans-2026-11-24.sql.gz` viết lại `03:52:32Z` (trước `00:00:06Z`), log `uploaded to b2` + `healthcheck pinged`, watchdog im lặng; `schema_migrations` có 011, `guild_settings` còn 3 cột; 399/399 test, coverage 84.89/71.74/86.47/85.92 |
| 2026-11-24 | **Release `v1.0.3` và `v1.1.0`; `/digest interval` thành lưới 15 phút**: `hours` 0–24 + `minutes` 15/30/45 (bỏ `0 minutes` vì optional), reply nói "1 hour 45 minutes"; drill restore **máy trắng** từ B2; luật release viết vào `AGENTS.md` hard rule 4 + `CONVENTIONS.md` §8.3 + checklist §0 | `1d0f4daa` rồi `d40679d0` deployed, 4/4 healthy, `Registered 8 commands globally`, payload Discord có `hours` 25 choices / `minutes` 3; drill: tải 5 s, postgres 3 s, restore 9 s, 1 832 176 snapshot, migrate skip 11; `develop` = `47d1cd3` |
| 2026-11-23 | **Alert chứng minh được và không còn mù phía off-site; reboot tự phục hồi sau đăng nhập**: `watchdog.sh` tách hàm `send_alert` (cooldown 12h dùng chung), thêm check tuổi file mới nhất trên `RCLONE_REMOTE/daily` (30h, đọc qua `rclone lsjson` để khỏi lệch múi giờ); `docker-desktop.service` (user) được enable | DM thật tới owner lúc 14:26 (`stale-backup alert sent`), stamp cập nhật; 3 nhánh của check mới chạy đúng: healthy = im lặng, remote 7h > ngưỡng 1h = `OFF-SITE BACKUP STALE`, path rỗng = `OFF-SITE BACKUP EMPTY`; `systemctl --user restart docker-desktop.service` → 4/4 healthy sau 29 s; shellcheck 0 finding |
| 2026-11-23 | **TypeScript 7.0.2** (bản port native) thay 5.9.3, chỉ đổi `package.json`/lock | build TS7 chạy được và **0 file `.js` khác** so với build TS5 (so `diff -rq` trên 36 file); 24 `.d.ts` khác chỉ ở dấu nháy (`"` → `'`), `.map` khác; sau merge `develop`: typecheck + build OK, 398/398 test với TS 7.0.2 cài thật |
| 2026-11-23 | **Release `v1.0.0` đầu tiên, có tag và có merge-back; lớp quy trình được viết xuống**: `CONVENTIONS.md` §8 (branch `type/scope`, commit `type: subject`, merge commit, release 5 bước) + §12 ADR (4 deviation), task memory ngoài repo, `CONTRIBUTING.md`/`GITHUB-SETUP.md`/`AGENTS.md` theo cùng luật; CI thêm `shellcheck`, ruleset chặn tạo/di chuyển/xoá tag `v*`; `deploy.sh` thêm smoke `GET /users/@me`, `backup-db.sh` retry rclone, `scripts/restore-drill.sh` mới; volume mồ côi và nhánh Dependabot rác đã xoá | merge commit thật: PR #10 `7e6db38` (2 parent), #11, #12 `d853c69`, merge-back #14 `49a574a`; `production` = tag `v1.0.0` = `.deployed-sha` = `d853c69`; 4/4 healthy, app 1.0.0; drill PASS (1009 / 1 464 072 / 10); shellcheck 0 finding; CI xanh `check`+`scan`+`build`+`version-guard` |
| 2026-11-22 | **Deploy tự động đã bật nhưng chưa deploy gì**: `deploy.timer` enabled, checkout riêng ngoài workspace (clone độc lập, `.env` 600); `deploy.sh` thêm guard "nhánh không có application" và "thiếu .env" | Tick 20:51:59 ghi `nothing to deploy: production has no application at c457bf8c`, exit 0; không có dump mới (file backup cuối vẫn 07:07), không có `.deployed-sha`, stack prod vẫn Up 5 h với ảnh cũ; `bash -n` sạch. Lý do guard: `production` = initial commit nên bản `deploy.sh` cũ sẽ gọi `backup-db.sh` mỗi 5 phút (≈4,6 GB/ngày lên B2) rồi chết ở `npm ci` |
| 2026-11-22 | **Chart restyled theo reference ICT**: panel navy `#0B1622`, grid chấm indigo, legend lên trên và tên kèm đơn vị (`Sell price (g)` / `Day low–high (g)` / `On sale (units)`), `On sale` đổi từ cột mờ sang **đường nét đứt màu amber** trên trục phải, bỏ viền trục, ngày xoay 35° | Hai series một panel cần hai hue: đường `#CBD5E1` thử trước nằm quá gần đường indigo nên không phân biệt được ở 512 px. Live trên DIH Dev: 24h `snapshot 10:53 UTC · 24h, 269 snapshots` + 30d `Priced days: 7 of the last 30` đổi tại chỗ, ảnh `chart-2026-11-22-live-{24h,30d}-restyle.{webp,-discord.png}`; 458/458 test, typecheck 0 |
| 2026-11-22 | **Chart không vẽ mẫu ngoài thang ở mép nữa**: mẫu nằm hoàn toàn ngoài domain bị bỏ khỏi đường (đường đứt), mẫu chỉ lấn một phần vẫn vẽ và clamp; dot "giá mới nhất" biến mất khi chính nó ngoài thang. Card 30d tick đúng ngày có bar và giới hạn 5 nhãn nên không đè chữ | Chestnut log 24h trước fix: 93 mẫu dưới `100g` vẽ phẳng ở `100g` suốt 9 AM–1 PM; sau fix đường chỉ còn đoạn trong thang, caption giữ `scale cut at 100g — 93 below`. Pine log 30d: nhãn `Nov 12 / 15 / 17 / 21`, nhãn cuối trùng bar cuối; synthetic 30 ngày ra `Oct 24 … Nov 17`, không đè. 458/458 test, typecheck 0, 5 test mới fail khi revert code cũ (worktree `/tmp`) |
| 2026-11-22 | **Chart không còn cắt mất mức giá mới nhất**: nếu giá cuối lặp lại ≥2 lần liền nhau thì domain nới tới mức đó (một mẫu lạc vẫn bị cắt); test render bằng interaction giả trong container dev | 37 mẫu `20g` + last `20g` trước đây bị domain `24g` cắt, hình không thấy cú giảm trong khi card ghi `sell 20g`; sau fix domain `20–25g`, chú thích `scale cut at 24g — 34 below` biến mất, 24h PNG 70 520 B / 30d 64 747 B, 452/452 test, typecheck 0 |
| 2026-11-22 | **Stack dev chạy thật**: `dih-dev` project với 4 container riêng, DB `idleclans_dev` restore từ dump (1 238 533 snapshot / 3 778 daily / 1 009 items), bot `DIH Dev#5813` chỉ ở server test, 8 lệnh global, collector poll vào DB dev | `docker compose -p dih-dev ps` cả 4 healthy; `/users/@me/guilds` chỉ có guild test; guard: token prod/dev khác prefix, `env_file` chọn theo `ENV_FILE`; prod không bị restart |
| 2026-11-22 | **`/graph` vẽ như trang market của game, và có 1 năm**: series đổi từ snapshot của mình sang trade history của vendor (`history/{id}?period=1d|7d|30d|1y`), thêm range `1y` (1 điểm/tuần), ảnh 900×260 vẽ tại chỗ bằng encoder nội bộ — bỏ hẳn QuickChart | đo trên trang thật: 49/29/31/53 điểm khớp 1:1 với payload API; `traded 99 to 190` = min/max trade price, `+9.0%` = avg cuối/đầu; chart 1 năm của ta có 53 điểm, ảnh 4–6 KB; 398/398 test, typecheck 0 |
| 2026-11-22 | **Dev/prod tách bằng hai Discord application**: DIH Dev (`1573952148209795072`) mời vào DeeLY's test server với quyền 2147535872; DIH bị gỡ khỏi server đó; compose thêm `STACK_PREFIX` để hai stack cùng máy không chung container/network/volume | `/users/@me/guilds` của DIH chỉ còn Clint's Polygon Abilities; DIH Dev `joined_at` 2026-11-22T06:55:13Z; `docker compose config` với `STACK_PREFIX=dih-dev` ra `dih-dev-*` |
| 2026-11-22 | **Collector tách khỏi Discord bot** (D16 bước 1): `src/collector.ts` chạy cùng image, service `collector` riêng, advisory lock chống hai writer, migration serialize bằng lock, heartbeat riêng cho từng process | stop `bot` 150 s → `price_snapshots` 1 272 661 → 1 273 293 (**+632**, một poll vẫn chạy), cả hai container healthy, heartbeat bot 10 s / collector 36 s, 450/450 test, typecheck 0 |
| 2026-11-21 | Monetization decided: **free 100%, donations without perks**; Premium Apps ruled out | Discord payout is US/UK/EU only and any paid app feature must be sold through it, so a VN operator cannot comply → `LEGAL_DONATION_VN.md` §2. Tax: cash gifts are outside the taxable gift list (TT 111/2013 khoản 10 Điều 2; Luật TNCN 2025 Điều 3), business-income risk stays and the exemption threshold is 1 tỷ/năm from 01/01/2026 (NĐ 141/2026). Rails checked against vendor pages: Ko-fi+PayPal ✅, VietQR ✅, GitHub Sponsors ✅ (VN in the supported list), Patreon ⚠️ membership-shaped, Buy Me a Coffee ❌ (no VN in the payout list), Stripe direct ❌ (VN = cross-border payouts only). NĐ 93/2021 wording trap recorded (never call it "quyên góp/từ thiện") |
| 2026-11-21 | Repo prepared to go public under MIT | `package.json` declared **ISC** while `LICENSE` said MIT → fixed + author filled; README gained §License and carves out `docs/reference/idleclans-swagger.json` (Idle Clans' API doc, not ours); `.github/FUNDING.yml` adds the Sponsor button; full-history secret scan clean — no bot token, no B2/AWS key, no private key, no real IP/email, only the compose default `idleclans:idleclans`; `.env`, `.superpowers/`, `docs/superpowers/`, `graphify-out/` never tracked; no `pull_request_target` in either workflow; 440/440 |
| 2026-11-21 | Data-reliability pass: trade averages cached 5 min behind a 20/min budget and never throw; digest refuses a stale snapshot; a poll losing >20% of the items is rejected; the 24 h card prints its covered span; `/price` stamps the item's own row; renderer body capped at 4 MB and must be a PNG | in-container: miss 2 942 ms / hit 1 ms / TTL 300 / 21st `null` in 1 ms; SQL: 52 polls, 1.65 h, 609/609 short windows; 438 tests; 9 reverted guards failed the new tests on a `/tmp` copy |
| 2026-11-21 | Chart drawn in the house palette: one labelled axis, units on sale as bars behind the line, bottom legend, clip note as a smaller muted subtitle | 22 chartQuick tests, 3 rendered PNGs inspected |
| 2026-11-15 | T7 two-tier price history | `007_price_daily.sql`; startup rollup wrote **1 209 rows / 2 days**, `samples` matched the raw row count per item-day, a restart wrote **0** (idempotent); prune cutoff moved to 2026-10-16 (30 days) |
| 2026-11-15 | T5.1 atomic rate limit | live Redis probe, same 20 concurrent calls at a cap of 5: round-trip version **20/20 admitted**, Lua version **5/20** with `retryAfterMs` 59 999 |
| 2026-11-15 | T5.2 `safeReply` moved | `src/ui/reply.ts`; 9 commands and their 9 tests now mock the new module, `index.ts` no longer imported by any command |
| 2026-11-15 | T5.3 unhealthy recovery | `scripts/watchdog.sh` + `deploy/dee-idleclans-watchdog.timer`, quiet on a healthy stack (verified) |
| 2026-11-15 | T6 deploy pipeline | `scripts/deploy.sh` (idempotent no-op verified), `deploy/*.service|*.timer`, `.github/workflows/deploy.yml`, `DEPLOYMENT.md` §8 |
| 2026-11-15 | T8 upstream budget | documented in `ARCHITECTURE.md` §6: no command calls the market API at request time; autocomplete is local |
| 2026-11-16 | migration 009 bid backfill | `009_price_daily_bid_backfill.sql`, idempotent `UPDATE … FROM` over raw rows; 11-12/11-14/11-15 now hold 588/586/588 items with a bid (was 26/22/20), re-run wrote 0 rows |
| 2026-11-16 | off-host backup on B2 | rclone 1.76.0 → private `discord-bot-dih`, 04:00 cron with `RCLONE_REMOTE`; restore drill from the remote copies: `price_daily` 1 889 rows / 1 762 with bid, full dump 584 194 raw / 1 889 daily / 1 009 items, 0 errors |
| 2026-11-16 | stale-backup alert | `scripts/watchdog.sh` ages the newest dump (limit 26h) → WARN + DM, 12h rate limit; proven by a stale dir (DM sent) and a re-run (suppressed) |
| 2026-11-16 | design pass: product context and listing copy | `PRODUCT.md` written (`/impeccable init`, now in the `AGENTS.md` doc map); `MARKETING-COPY.md` flips OPEN → **DECIDED** with strings measured (short 133/200, tagline 44, portal 261/400); the old recommended tagline was replaced because its first clause is a three-part fragment list, which `VOICE.md` bans |
| 2026-11-16 | showcase link and `/help` identity | showcase button `Website` → `Community server` (`idleclans.wiki` is third-party); `/help` last field is now `Links` (invite, DeeCorp, italic `HRDDee` credit -- italic because `-#` does not render in field values); the showcase closing line stopped claiming "never stores your game data", which the database contradicts; 425/425 tests |
| 2026-11-17 | release path works without a runner | `deploy.yml` trigger `push` bỏ (0 runner → run treo pending), host có checkout `~/deploy/dee-idleclans-helper` + cron 5 phút gọi `deploy.sh` với guard `[ -x ]` cho tới release đầu, `.deployed-sha` seed sẵn; release checklist (private notes) viết đủ quy trình gồm rotate credential |
| 2026-11-17 | CI gate on develop | `.github/workflows/tests.yml` chạy `npm ci` + migrate + seed + typecheck + test trên hosted runner với Postgres/Redis service; lần đầu fail vì Node 20 thiếu `Map.groupBy` (vitest 4) → Dockerfile, `engines`, CI cùng lên Node 22; container chạy `v22.23.5`, 441 test |
| 2026-11-17 | debt pass (code) | migration `010_drop_v1_tables.sql` (5 bảng v1, đã chứng minh trống + không tham chiếu, áp cả hai DB); `as any` trong `ItemCatalogue.test.ts` → `vi.mocked`; wiki URL percent-encode + test; `/buy-or-craft` có `Post to channel` với modifiers trong custom id |
| 2026-11-17 | backup missed a day, schedule made sleep-proof | 04:00 cron never fired: the laptop was suspended (`journalctl` gap 03:30-04:30) and cron does not run a missed job, so `daily/` stopped at 11-16. Ran the script by hand (8.5 MB, uploaded) and moved the entry to hourly with `SKIP_IF_PRESENT=1`: the first tick of an awake day dumps, later ticks reuse it and still do the monthly archive and the 30-day remote purge; both paths verified (skip path uploaded nothing new, empty dir path wrote the dump) |
| 2026-11-17 | docs consolidated into the repo | the five unversioned files in the sibling `../docs/` (phase-zero plan, competitor research, three legal notes) moved to `docs/research/` and `docs/legal/` with origin/status headers; vendor API spec → `docs/reference/idleclans-swagger.json`, `marketing.png` → `docs/assets/`; the refs that pointed at the old paths fixed (`PRODUCT.md`, `OPERATIONS.md` §10, the v2 design spec, inside the moved files); outer `docs/`, `requirement/` and the stale `graphify-out/` removed; graph rebuilt **1115 nodes / 2336 edges / 78 communities** |
| 2026-11-17 | `/graph` drawn honestly | `src/ui/chart.ts` rewritten around a pure `chartPlan()`: domain = 5th–95th percentile above 100 snapshots, trimmed to ±25% of the median and snapped to quoted prices, so item 1 draws 76–84g (its 55 thin-book samples at 229g and one at 254g are counted: `Scale cut at 84g — 56 samples above`), while item 387 draws 12,000–15,000g with 143 samples disclosed; a polling hole longer than twice the median interval breaks the line (`No sell price 03:40–07:14 UTC`), and the daily card draws one low/high bar per UTC day with `Priced days: 4 of the last 7`; 455/455, render 16ms, PNG 480×110 |
| 2026-11-17 | chart controls and channel posts | `/graph item` carries a range select menu (in-place re-render, `attachments: []` replaces the PNG) and `Post to channel`; the button also ships on `/price` and is deliberately absent on a muted card and on `/buy-or-craft` (recomputing a craft result per click). Shared `src/ui/share.ts`, one bucket with the command, one post per user per card per minute on fake timers in tests; 436/436 |
| 2026-11-17 | community server named correctly | the URL is the **Horde** clan server (clan `DeeCorp`, rename pending), so `/help` says `Horde server` and nothing user-facing names the clan; `PRODUCT.md`, `MARKETING-COPY.md` §2/§6/§7, `UI-DESIGN.md` and `VOICE.md` (§Attribution exception for the Discord application description) updated |
| 2026-11-17 | graph doc layer refreshed | 918 nodes / 2033 edges / 54 communities, `built_at_commit` = HEAD, 0 dangling edges; the merge pitfalls (edges keyed by their own `source_file`, never re-cluster, labels dropped by `update`) recorded in `AGENTS.md` |
| 2026-11-18 | `/graph` renders through a real chart engine | the in-process encoder has no font engine, so the picture carried no tick, axis label or title; `src/ui/chartQuick.ts` now POSTs the same `chartPlan()` decisions to QuickChart (Chart.js 4) and posts a 760×300 PNG with a `Price (g)` axis, an `On sale` axis from `ask_volume`, hour/day ticks, a legend and an in-image `scale cut at …` subtitle. Free-tier limits shaped it: 220-point buckets keep the config far under QuickChart's 200,000-character cap, and `x.min/x.max` are pinned to the observations (Chart.js otherwise drops the tail when y clips). `priceChartPng` stays as the fallback: the renderer answers `{ png, reason }`, and a failure logs its status or error message before the card uses the local encoder (probe with a dead endpoint: `null` in 179 ms, PNG still attached). Measured: 45 KB, 350–1000 ms per render, egress OK from the container, 463/463 |
| 2026-11-21 | T10 live pass + data audit closed | 8/8 commands on real Discord, every observed string in `DISCORD-TESTING.md` §7; poll vs upstream `631/631` with zero mismatch on ask, bid and both volumes; `0` on 22 asks / 45 bids, 676 tradeable vs 631 quoted, `price_daily.samples` equal to the raw ask rows (255 875 and 157 224); both guards seen firing. Four findings: the daily card called a close `now` (**fixed**, now `close`), a never-traded item printed `trade avg 0g` (**fixed**, the window is omitted), a "double space" that was the `down` icon dropped by `innerText` (**not a bug**), `AGENTS.md` listing `/price-list` (**fixed**) |
| 2026-11-21 | Chart readable at the size Discord shows | type is sized for the 512 px a reader sees (17 px ticks and legend, 22 px title) instead of for the 760 px it is drawn at; the units-on-sale bars finally have the `On sale` axis they were missing (hidden scale drew bars against nothing); the fence carries `sell / buy / spread / low / high / change`, with `buy` and `spread` omitted when the book has no buy order. The buy order was drawn as a dashed line over the sell line first and dropped: one scale turns a 3% day into four pixels at a 23% spread, measured on a real render |
| 2026-11-21 | Marketing dropped the "Free" lead | `VOICE.md` §Claims now says price is not a claim; the showcase closes with `Every answer comes from the same 2-minute snapshot, so two players quoting a price in the same minute see the same number.`; ruling repeated in `MARKETING-COPY.md` §3 and `UI-DESIGN.md` |
| 2026-11-21 | Rate limits: one table, logged refusals | `LIMITS` in `RateLimiter.ts` replaced eight copies of `5` / `60_000`; call sites are `check(userId, 'price')`, typed `LimitName`. A refusal logs `[RATE] rate limited` with user, command and `retryAfterMs`, because the cap had no evidence behind it. Probe in the rebuilt container: five passes, the sixth refused, Redis key `ttl = 47 s` |
| 2026-11-21 | Image compiles its own dist | the Dockerfile was `COPY dist ./dist`, so `docker compose build` after a source edit shipped the **previous** build and still reported success — a probe ran the old cap (`max = 10`) and passed 6/6. Now a multi-stage build compiles in the image, `.dockerignore` keeps the context small, and the build was verified with a deliberately stale host `dist` |
| 2026-11-21 | `/buy-or-craft` removed on owner request | the command, `src/services/CraftAdvisor.ts` and both of their test files are gone; `/help`, the @mention showcase, the registration list and every current-state doc stopped naming it. The shipped invite now asks for `VIEW_CHANNEL` + `SEND_MESSAGES` + `EMBED_LINKS` + `ATTACH_FILES` + `USE_APPLICATION_COMMANDS` (`2147535872`): the old `2147502080` never had `ATTACH_FILES`, so `/graph` could not upload its PNG in a freshly invited server (and `MARKETING-COPY.md` had decoded the old bits wrongly). Boot now clears the stale guild-scoped command copy in every joined guild, not only the test guild, because a duplicate can shadow the global one; 414/414 |
| 2026-11-22 | Chart draws the days that exist; the vendor history endpoint classified | the axis was pinned to the requested window on 2026-11-21 and reverted within hours: thirty days of empty canvas read worse than `6 of the last 30 days priced`. Captions stay. `GET /PlayerMarket/items/prices/history/{id}?period=1y` reaches a year, but a bucket checked against our own row (23:00: vendor 57/68/63 vs `ask 68 · bid 57`) proves it summarises **trades**, so it may not backfill `price_daily`; parked as D14. Candles rejected: our `open` is a wake-up artifact and the vendor has no open/close. Knowledge in `docs/CHART.md`; 448/448 |
| 2026-11-15 | T3 digest/vault footers, README | footer `refreshed every 2 minutes`, vault footer keeps only the 14-day scope; README rewritten |
| 2026-11-15 | T2 diagrams | `docs/diagrams/{runtime,data-lifecycle,deploy}-html` pass `archify check`; the ASCII sketch stays in `ARCHITECTURE.md` §1 for terminal readers, with links beside it |

| 2026-11-15 | Deploy automation installed on this machine | `deploy/*.service` read `DEPLOY_DIR` from the unit's `EnvironmentFile`; `watchdog.timer` **enabled** (last run green, stack healthy), `deploy.timer` **disabled by design** (its default `DEPLOY_DIR` pointed at a deploy checkout that does not exist here, so it can never detach the dev tree); host steps in the private ops notes |
| 2026-11-15 | Dev-dependency audit closed | `vitest` + `@vitest/coverage-v8` raised 2.1.9 → 5.1.0 (the 10 advisories were all dev-only; `npm audit --omit=dev` was already 0). Two mocks used arrow implementations as constructors, which vitest 5 rejects — changed to `function`; 401 tests and coverage 87.65% green, `npm audit` now **0** |
| 2026-11-15 | `.github/workflows/deploy.yml` validated | `js-yaml` parses it: one job `deploy`, `runs-on: [self-hosted, linux, dee-idleclans]`, triggers `push` + `workflow_dispatch` |
| 2026-11-15 | Marketing skills adopted globally | `~/.agents/skills/{copywriting,copy-editing}` (MIT, licence kept at `~/.agents/skills/MARKETINGSKILLS-LICENSE`); the binding override is recorded in `docs/VOICE.md` ("Skills defer to this file") |

| 2026-11-15 | Deploy gate defect, found by the diagram pass | the bot tolerates a failed migration, so `up --wait` alone proved nothing; `deploy.sh` now compares the newest migration on disk with `schema_migrations` before recording the release, and a failed query falls through to the same mismatch path (`|| applied=""`) |

| 2026-11-15 | Marketing copy reopened and parked | surfaces, options with counts, top.gg evidence (7 real listings) and the rejected drafts recorded in `docs/MARKETING-COPY.md`; a pasted invite link was found missing `applications.commands`; the permission bits the bot itself ships are `2147502080`, and the earlier "embeds need EMBED_LINKS" claim was wrong (the bot sends embeds without it) |

| 2026-11-16 | Digest cadence became a preset list | `/digest interval` is 7 choices (15/30/60/180/360/720/1440) instead of a free integer; live payload confirmed, `min_value`/`max_value` gone. 425 tests. Commit `3a18991` |
| 2026-11-16 | Slash commands are global, and that is not why a server saw none | `registerCommands()` writes `PUT /applications/{id}/commands` and clears the guild copy; the live app had 9 global commands, 0 guild-scoped in either guild, the newest registered 17.8 h earlier, so propagation was ruled out. The guild that showed nothing was invited with `scope=bot`, which never grants `applications.commands` |
| 2026-11-16 | Price archive hardened (D6) | migration `008_price_daily_bid.sql`: ask columns nullable, `bid_open/close/low/high`, `bid_samples`; rollup aggregates each side with `FILTER (... > 0)` and inserts a row when **either** side exists; prune now deletes a raw row only when its UTC day is in `price_daily`. Measured on the first rollup after the change: **68 rows** that the old ask-only filter had dropped (26/22/20 bid-only items on 11-12/14/15). Gate proof: 630/233 433/180 580 raw rows of the three archived days are deletable, all 124 751 rows of the un-archived day 11-16 are protected |

**Deviation from the T7 plan, recorded deliberately:** `price_daily` has no `volume` and no
`mean`. `ask_volume` is order-book depth, and summing depth into a daily "volume" would print a
number that means nothing; `mean` was not requested by any reader. Both can be added later, but
the daily tier is append-only, so an added column only has values from its own migration date on.

## 6. Marketing copy and design

**Decided 2026-11-16** (owner). The strings in `docs/MARKETING-COPY.md` §3 are the ones to paste:
short description 133/200, tagline `Idle Clans prices, one snapshot, in Discord.` (44), portal
261/400, long description. The tagline changed from the earlier recommendation because its first
clause was a three-part fragment list, which `docs/VOICE.md` bans.

Owner-side state, 2026-11-17 (`MARKETING-COPY.md` §7): the Discord application is renamed
`Dee IdleClans Helper` with the Portal description and the five tags -- done. top.gg is **deferred**
until after the first PRD release and the bot is hosted in the Horde server. Still open: trimming
the Portal description (advice in §6 there), creating the bot category in the Horde server
(announcements, feedback), and retaking the showcase screenshot in a clean channel -- the current
capture has a raw OAuth URL and an admin "kick and re-invite" line in frame.

The server behind `https://discord.gg/fepAZKG2Ss` is the **Horde** clan server, not a bot support
server; the clan is `DeeCorp` today and due a rename, which is why no user-facing string names the
clan (`Community server` on the showcase, `Horde server` in `/help`).

Design decisions, the credit rule and what is deliberately not done: `docs/UI-DESIGN.md`
(§Interaction) and `docs/VOICE.md` (§Attribution). Product context: `PRODUCT.md`.

**Design work, built 2026-11-17:** the `range` select menu on `/graph item` (re-renders in place,
`attachments: []` so the old PNG is replaced) and `Post to channel` on `/graph item` and `/price`
(same card, muted `requested by @user` line, `SEND_MESSAGES` checked, one post per user per card per
minute). Shared code `src/ui/share.ts`; both controls spend the command's own 5-per-minute bucket.
The removed `/buy-or-craft` carried the button too (built 2026-11-17, dropped with the command on
2026-11-18): the modifiers and the player's input travelled in the custom id, so a click re-rendered
the same expectation instead of silently rebasing it.

The dev container still ran the image built before the `/help` and showcase copy changes: a push is
not a deploy. Verified with `npm run build && docker compose up -d --build bot`; the disk and the
container now carry the same strings.

**Capacity and data ceilings after the 2026-11-16 review:**

**Closed on 2026-11-16** (kept here so they are not re-opened as open items):

- ~~Bid history only from the next rollup onwards~~ → migration `009_price_daily_bid_backfill.sql`
  backfilled the three archived ask-only days from raw rows (588 / 586 / 588 items with a bid);
  `samples` matched the raw count per side and a re-run changed nothing.
- ~~The monthly dump sits on the same disk as the database~~ → both files are now copied to a
  private B2 bucket daily at 04:00, 30 days of dailies kept remotely, restore verified from the
  remote copies.

## 2026-11-23 — the host can now be noticed dead, and the backup is proven on a schedule

- A successful backup pings `HEALTHCHECK_URL`; the absence of pings is the one signal a dead host
  can still send, so an external checker covers what the watchdog structurally cannot.
- `dee-idleclans-drill.timer` restores the newest dump on the first of each month, stamps
  `$BACKUP_DIR/.last-drill`, and the watchdog DMs when the stamp is older than 45 days.
- Ops units read `/opt` instead of the dev tree (D14), so switching branches no longer changes the
  code that watches production.

Still open:

- Days the bot was down have no rows at all (2026-11-13 is one). The upstream serves no history
  endpoint to backfill from, so a gap is permanent by design.
- Intraday raw rows older than 30 days are gone. If a longer intraday window is ever needed the
  lever is `RETENTION_DAYS` 30 → 90 (~3× the raw tier), not an hourly downsampling tier: measured
  286 B/row and no reader for it.
