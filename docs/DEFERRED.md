# Deferred work — ledger và trigger để quay lại

Cập nhật 2026-11-23. Đây là **nơi duy nhất** liệt kê những việc đã cố ý hoãn, để một phase sau
không phải dựng lại lý do từ đầu. Không có việc nào ở đây là "quên": mỗi mục ghi rõ vì sao hoãn,
điều kiện mở, cách chạy, và một prompt dán-là-chạy ở §5.

Quy ước: khi một mục xong, xoá nó khỏi file này và thêm một dòng vào changelog
`docs/ROADMAP.md` §5. Không để hai nguồn sự thật.

## 1. Blocker — chỉ owner làm được

| # | Việc | Vì sao hoãn | Mở khi |
|---|---|---|---|
| B2 | ~~`deploy.timer` bật chờ release đầu~~ — **đóng 2026-11-23** | timer tự deploy `9b502dc` lúc 11:08 ngay sau khi publish, trước khi có tag: đúng cái ADR-2 loại bỏ | đã `disable --now`; release chạy tay theo `CONVENTIONS.md` §8.3. Không bật lại |
| B3 | ~~Discord/Horde: tạo category bot (announcements, feedback)~~ — **đóng 2026-11-25** | category `DIH` sống trên Horde: `dih-announcements`, `dih-updates` (webhook tự động), `dih-roles`, `dih-suggestion`, `dih-bug-reports` (forum), `bot-archive`; kênh dùng chung `idle-market` (digest), `idle-bots`, `idle-vault` (`/vault` clan `DeeCorp`) | đóng — bản đồ channel + quyền trong `docs-private/HORDE-SERVER.md` |
| B4 | Donation rails: handle Ko-fi (VietQR **đã chốt bỏ** 2026-11-21) | **Phase donation mở lại 2026-11-25**, 2 hướng chốt: Ko-fi + GitHub Sponsors; **không làm website** (quyết định cùng ngày: chưa có traffic để convert, `/help` footer + listing top.gg là bề mặt đủ) | owner gửi handle ⇒ gắn `ko_fi:` vào `.github/FUNDING.yml` + link `/help` footer + README |
| B5 | Bật GitHub Sponsors (hồ sơ + thuế + ngân hàng) | **Phase donation mở lại 2026-11-25**; điều kiện repo public **đã đạt**, và VN **nhận được payout** (GitHub thêm VN 2023-10, Stripe Connect trả VND) | owner bật profile + Stripe onboarding; nút Sponsor đã có trong `.github/FUNDING.yml` |
| B7 | Discord App Verification: ToS + Privacy | **Code xong 2026-11-25** (PR #55): `site/privacy.md`, `site/terms.md`, Pages build từ `production`, footer `/help` có 2 link | còn lại là việc owner: set 2 URL vào Developer Portal, bật Community cho support server, điền description/tags/install link cho App Directory. Ngưỡng thật: bot chưa verify bị chặn ở **100 server** |
| B6 | ~~Rotate token của **DIH Dev**~~ — **đóng 2026-11-25, không làm** | owner quyết bỏ: token chỉ nằm trong `.env.dev` (untracked) và app dev chỉ ở guild test; đổi token không mua thêm gì cho một app không phục vụ ai | đã xoá runbook riêng trong ops notes; nếu sau này app dev được mời vào server thật thì mở lại mục này |

Việc rotate credential đã bị owner bỏ (2026-11-25); checklist release riêng của operator không còn bước
rotate, và không tạo mục riêng cho nó ở đây.

## 2. Gap — đã kiểm nhưng chưa chứng minh trên đường thật

| # | Gap | Trạng thái 2026-11-17 | Cách đóng |
|---|---|---|---|
| G1 | ~~`deploy.sh` chưa từng deploy thật~~ — **đóng 2026-11-23** | hai lần chạy thật: 11:09 (timer, `9b502dc`) và 12:28 (tay, `d853c69`); health + schema + smoke Discord đều qua; backup trước deploy chạy; nhánh rollback vẫn chưa kích hoạt lần nào | đóng; lần đầu rollback xảy ra thì ghi vào đây |
| G2 | 2 nhánh live của control | **đã chạy xong 2026-11-17**: bucket 5/phút trả `Slow down. Try again in 37s.`; deny `Send Messages` trả `I need Send Messages in this channel to post there.` | đóng; chi tiết `DISCORD-TESTING.md` §6 |
| G3 | 6 invocation **hợp lệ** trong 1 phút (bucket) | **đóng 2026-11-21**: probe trong container gọi limiter 6 lần — 5 pass, lần 6 trả `Slow down` kèm log `[RATE]`; cùng nhánh được phủ trong `RateLimiter.test.ts` | — |
| G4 | CI ≠ docker image (alpine/Dockerfile drift) | **đóng 2026-11-21**: image tự compile từ `src` (multi-stage), không còn đường ship `dist` cũ của host | smoke sau G1 vẫn nên chạy `docker compose build bot` |
| G5 | Migration chạy trong bot lúc boot, lỗi chỉ ghi log | health gate không thấy migration fail | đã ghi trong checklist release riêng của operator §1 (review tay từng migration). **Quyết định 2026-11-21: giữ nguyên** — đây là lựa chọn có chủ đích (`ARCHITECTURE.md` §3: process sống để log/heartbeat thấy), `deploy.sh` đã có schema gate so `schema_migrations`; đổi sang `exit 1` là thay đổi thiết kế, không phải fix |
| G6 | Graphify labels thiếu (75 community, 23 nhãn đã lưu) | index dùng được, nhãn xấu; không có LLM key | `graphify label . --missing-only` khi có key — không đáng mua key chỉ vì việc này |
| G7 | Không có test tự động cho `scripts/deploy.sh`, `scripts/backup-db.sh` | hai script quyết định deploy/backup, chỉ chạy tay | dry-run có kiểm soát khi release; đừng viết test giả cho shell |
| G8 | ~~Chưa có 24 h phủ đủ nhịp poll~~ — **đóng 2026-11-25** | **đo lại trên host:** 453 458 dòng trong 24.0 h (11-24 03:10Z → 11-25 03:08Z), **0 khoảng trống > 20 phút**, gap lớn nhất **6 phút** (đúng cửa sổ deploy 1.3.0). Trước đó trên laptop: 45% nhịp 2 phút, 5 gap > 20 phút | số đã ghi `ROADMAP.md` §2; không cần mở lại trừ khi host ngủ/đổi lịch |

| G9 | Dev stack đã được bấm thử lệnh thật | **đóng 2026-11-22**: `/help` trả embed Commands (Market `/price`, `/graph`), `/price Spruce log` trả `27g · 27,334 units` / buy `25g · 4,182 units` / `snapshot 13:41 UTC`, `/graph` 24h → menu 7 days → về 24h đổi tại chỗ | — |

| G10 | Restore trên **máy trắng** (kịch bản mất host) | **đóng 2026-11-24**: drill trên laptop từ object B2 thật — tải 24 MB (5 s), postgres mới (3 s), `psql` restore 1,83 M snapshot + 5 677 `price_daily` + 1 009 item (9 s, 0 lỗi), `npm run migrate` báo skip đủ 11 migration, spot-check `Teak log` = 64g @ 04:59:37Z với 1 801 dòng 7 ngày. Không đăng nhập Discord (tránh đá session bot dev đang chạy). Tổng ~17 s + verify | đóng; stamp `.last-drill` trên host **không** đổi vì drill chạy trên máy khác — lần drill *trên host* kế tiếp vẫn theo lịch tuần |

## 3. Tech debt

| # | Debt | Mức | Ghi chú |
|---|---|---|---|
| D1 | Rate window (Redis) + cooldown share (RAM) giả định **một process** | trung bình | lên multi-instance thì chuyển cả hai sang Redis; luật đã ghi `CONVENTIONS.md` §6.5 |
| D2 | 131 chỗ `as` còn lại (đã bỏ 3 ở `ItemCatalogue`) | thấp | bỏ dần ở biên query bằng `query<Row>`; không làm một đợt riêng |
| D3 | `statement_timeout` 15s chưa đo với backfill lớn | thấp | theo dõi log `canceling statement due to statement timeout` |
| D4 | ~~CI không chạy `npm run coverage`~~ — **đóng 2026-11-24 (v1.0.3)** | thấp | CI chạy `npm run coverage` và `vitest.config.ts` giữ ngưỡng 84/71/85/85, đặt dưới mức thực tế để chặn tụt chứ không phải mục tiêu |
| D5 | `.env` nằm ở nhiều chỗ: checkout workspace (stack đang chạy), checkout deploy riêng (chép tay mode 600), và `.env.dev` cho app dev | thấp, dễ sai | mỗi lần rotate phải sửa đúng file của stack đang chạy; `.env.dev` là app khác nên token khác. Kiểm bằng token prefix khi nghi ngờ (không chép prefix vào repo) |
| D6 | T4 "docs consolidation" queued (11 docs; `AGENTS.md` còn lặp `CONVENTIONS.md`) | trung bình | không chặn release |
| D7 | ~~`systemError` là export không dùng~~ — **đóng 2026-11-24** | trivial | không còn trong `src/`; oxlint (`no-unused-vars`) giữ loại này khỏi quay lại |
| D8 | Depth strip cho chart 24h (dải low/high mỗi cột) | thấp | **Lý do cũ hết hiệu lực 2026-11-23**: bucket history của vendor có sẵn `low`/`high`/`avg`/`volume`, không cần `price_snapshots`. Chart v3 chỉ vẽ avg + volume; thêm dải là vẽ thêm hai polyline trong `chartHistory.ts`. Mở lại khi owner muốn thấy độ rộng giá trong một bucket |

| D17 | Prettier chưa áp dụng (repo chỉ có oxlint + `tsc`) | thấp | cây code hiện không được Prettier format; thêm vào sẽ tạo diff reformat toàn repo. Mở khi muốn khoá style: commit riêng chỉ chứa `npx prettier --write .` + `format:check` trong CI, không trộn với thay đổi logic |
| D18 | Bảng `digest_channels`/`vault_channels`/`watchlists` không có cột phân biệt bot (`app_id`) | thấp, có điều kiện | hai bot trong cùng guild sẽ cùng đọc một subscription và cùng đăng bài (đã gặp 2026-11-24 với prod + dev). Ràng buộc "1 bot / guild" đã ghi ở `DISCORD-TESTING.md`; chỉ thêm cột khi thật sự muốn chạy nhiều bot một guild |
| D19 | ~~`docs-private/` nằm ngoài git (không versioned)~~ **đóng 2026-11-24** | — | đã tạo repo private `letiendat1002/dee-idleclans-private` chứa `docs-private/`, `tasks/`, `ops/`; có hook chặn token/mật khẩu trước commit. Host path/ID vẫn chỉ sống ở đó |
| ~~D9~~ | ~~`vault_events` ghi **trước** khi post: một batch lỗi Discord là mất luôn~~ — **đóng 2026-11-25** | — | Bảng `vault_deliveries` (migration 012) ghi `(clan, event_key, channel_id)` **sau** khi channel nhận message; tick sau đọc `undeliveredFor` nên post bị từ chối được thử lại, không mất. Prune dọn delivery khi event bị prune. Test: `retries an event the channel refused instead of losing it` |
| D10 | `price_daily` có ngày dựng từ **một** poll (2026-11-12: 604 samples / 630 item); card daily không in `samples` | thấp | thêm `samples` vào footer hoặc ẩn ngày có < 5% số poll; đợi dữ liệu 1 ngày đủ trước khi quyết |
| D11 | Catalogue trễ tối đa 30 phút (sync) nhưng không surface nào nói "catalogue lúc mấy giờ" | thấp | thêm `last_synced_at` vào `/help` hoặc footer `/price` khi rename item gây nhầm |
| D12 | Budget 5/phút dùng chung cho lệnh lệch chi phí | thấp | **Đã bớt lệch 2026-11-23**: `/graph` không còn gọi renderer ngoài, chi phí giờ là một lần đọc history (cache riêng 10/phút, TTL 2–120 phút), nên lần đổi range thứ hai vào cùng period là 0 request. Vẫn đọc log `[RATE]` vài tuần trước khi tách dòng `graph: { max: 3 }` |
| D13 | `autocomplete` của `/digest` và `/vault` không kiểm tra quyền | thấp, chấp nhận | chúng chỉ liệt kê kênh/clan của chính server, mà mọi member đã thấy trong danh sách kênh; thêm một lần gọi quyền mỗi lần gõ không bảo vệ thêm gì |
| ~~D14~~ | ~~Chart daily chỉ có 6–7 ngày~~ | **đóng 2026-11-23** | Panel traded riêng đã có: `/graph` v3 vẽ đúng series history (avg traded price + volume), 4 range 24h/7d/30d/1y, nhãn `traded` — không trộn trục ask. Luật cũ vẫn giữ: **không backfill `price_daily`** từ endpoint này (giá khớp ≠ ask); `price_daily` chỉ phục vụ alert/digest. Chi tiết bucket + giới hạn ở `CHART.md` |
| D15 | `price_snapshots` giữ **30 ngày** (`RETENTION_DAYS=30`, housekeeping chạy lúc boot + mỗi 24 h) rồi prune, nhưng **không archive** | thấp | **đo 2026-11-25 trên host:** DB `358 MB`, `price_snapshots` 2 355 308 dòng, `price_daily` 6 310; 452 458 dòng/ngày ⇒ trần 30 ngày ≈ 13,6 M dòng ≈ **2,1 GB** (`ARCHITECTURE.md` §8), dump nén hôm nay **31 MB** (22/11: 16 MB). Chọn một: (a) chấp nhận 2,1 GB, (b) archive ngày cũ sang B2 rồi prune, (c) hạ retention còn 14 ngày — 24h card chỉ cần 1. Đo lại khi DB vượt 1 GB hoặc dump vượt 64 MB. Lưu ý: prune chỉ xoá ngày **đã có** dòng trong `price_daily`, nên không bao giờ mất dữ liệu chưa rollup |
| D16 | ~~Collector tách khỏi Discord bot~~ — **đóng 2026-11-25** | Bước 1 xong 2026-11-22 (`src/collector.ts` + service `collector`). **Bước 2 xong 2026-11-23**: stack production chạy trên host (bot + collector + postgres + redis, `restart: unless-stopped`), 3 timer ops, rclone B2; deploy theo §8.3, `.deployed-sha` làm bằng chứng. G8 đóng bằng số đo 24 h trên host | — |
| ~~D17~~ | ~~Mẫu giá ngoài domain bị vẽ dính mép~~ | **đóng 2026-11-22** | Chọn (a): mẫu nằm **hoàn toàn** ngoài domain không vẽ nữa (đường đứt tại đó, caption giữ số mẫu bị cắt), mẫu lấn một phần vẫn vẽ + clamp, dot "giá mới nhất" mất khi chính nó ngoài thang. Chestnut log 24h kiểm lại: 93 mẫu dưới `100g` không còn vẽ thành đường phẳng ở `100g`. Luật ghi ở `CHART.md` §Reading the line + `UI-DESIGN.md` |
| ~~D11~~ | ~~Reboot không tự lên~~ — **đóng 2026-11-25** | — | Không còn áp dụng: stack rời laptop sang host 2026-11-23. Host chạy native Docker (`systemctl is-enabled docker` → `enabled`) và cả 4 container khai `restart: unless-stopped`. **Chưa reboot-test trên host** — hạng mục này chỉ đóng hẳn khi có một lần reboot thật |
| ~~D13~~ | ~~Chỉ tự lên không cần đăng nhập thì cần native Docker engine~~ — **đóng 2026-11-25** | — | Đã xảy ra cùng lúc với việc dời host: production chạy Docker engine native trên server (`docker.service` enabled), không còn Docker Desktop/`graphical-session.target` |
| ~~D14~~ | ~~Ops script chạy từ **dev tree**, deploy chạy từ checkout deploy~~ | **đóng 2026-11-23** | `DEPLOY_DIR` của các unit ops đã trỏ vào checkout deploy thay vì cây dev, nên `git switch` ở cây dev không còn đổi script mà backup/watchdog/drill chạy; code đổi chỉ có hiệu lực từ release kế tiếp. Chứng minh: `dee-idleclans-backup.service` chạy 22:07:39 upload OK từ checkout đó, `dee-idleclans-drill.service` chạy 22:08:51 ghi marker `items=1009 price_snapshots=1568238` |
| ~~D12~~ | ~~Restore drill chưa có lịch~~ | **đóng 2026-11-23** | `deploy/dee-idleclans-drill.{service,timer}` chạy `restore-drill.sh` ngày 1 mỗi tháng (`Persistent=true`); lượt pass ghi `$BACKUP_DIR/.last-drill`, và `watchdog.sh` DM khi marker cũ hơn 45 ngày — drill ngừng chạy cũng bị bắt. Lượt chạy thật qua systemd 2026-11-23 22:08:51: `items=1009 price_snapshots=1568238 schema_migrations=10` |

Đã đóng trong đợt 2026-11-17 (giữ lại để không mở lại): v1 tables (migration 010, cả hai DB),
`dist` cũ ship nhầm (build xoá `dist` trước), 4 bản copy permission check → `canPost`, pool thiếu
timeout/listener, 2 bản shutdown, copy slow-down sai `0/5`, `AGENTS.md` mô tả thiếu `/price`,
`/graph`, `/vault`, `ROADMAP` nói sai `/buy-or-craft` chưa có nút.

Đã đóng 2026-11-21: **`dist` cũ ship nhầm theo đường `docker compose build`** (image tự compile —
mục 2026-11-17 chỉ xoá `dist` trước `tsc` của host, không chạm đường Docker; đo được bằng probe chạy
`max = 10` cũ và pass 6/6), thẻ daily gọi close là `now`, `trade avg 0g` cho item chưa giao dịch,
`AGENTS.md` liệt kê `/price-list`. Rà lại 6 finding bảo mật cũ: threshold `/watch` đã chặn bằng
`/^\d+$/` (sửa trước đó), cap `VaultLog` đếm đúng `Set(channelId)`, `VaultNotifier` gửi
`SUPPRESS_NOTIFICATIONS` và nội dung nằm trong embed (Discord không parse mention trong embed) —
không còn lỗi; autocomplete thiếu gate ghi thành D13.

## 4. Marketing / owner-side (đã archive chi tiết)

Nguồn: `docs/MARKETING-COPY.md` §7 (câu hỏi mở) và §8 (bảng việc + prompt). Tóm tắt: top.gg
listing (chờ B1 + bot trong Horde), test invite link trong server sạch, trim Portal description,
retake ảnh showcase (giữ ngoài repo), tạo category bot.

**Monetisation** cũng nằm đây, không phải việc code: ba ghi chú pháp lý (giữ ngoài repo; thanh toán,
thuế, go/no-go) kết luận **không thu phí ở Phase 1**; mở lại khi có quyết định kinh doanh, và đọc lại
điều khoản trước khi dựa vào (ghi chú ngày 2026-11-10).

**Đã chốt 2026-11-21:** bỏ hẳn mô hình premium/rate-limit — bot **miễn phí 100%** + donation **không kèm
quyền lợi**. Phân tích và điều kiện mở lại: ghi chú pháp lý riêng (§2 lý do, §3 thuế, §7 chính
sách Discord, §8 điều kiện mở lại). Không còn việc code nào cho monetisation; chỉ còn đặt link ủng hộ ở
`/help`/README khi quyết định công khai.

## 5. Trigger prompts

Dán nguyên khối, chạy trong repo này.

**Release (mở G1, G4; đóng B1):**

```
Run the release checklist kept outside this repository, in order. Start at §0 and read it fully.
Stop and report before §3 if any gate in §1 fails. §2 is mine to execute: walk me through each
row and wait for me before moving on. After the merge, watch ~/deploy/deploy.log on its first
run, then do §4 and report each smoke step as pass/fail with the observed string.
```

**Kiểm chứng lại sau release (đóng G2/G3 nếu cần số liệu mới):**

```
Re-run docs/DISCORD-TESTING.md §6 checks against DeeLY's test server and report pass/fail
with the exact strings. Undo (channel sync, test messages) afterwards and say what is left.
```

**Tech debt đợt sau (mở D1-D7):**

```
Work the tech-debt table in docs/DEFERRED.md §3 top to bottom, one item per commit, tests
before/after, and move each finished row into the ROADMAP changelog. Start with D1 if we are
planning more than one bot instance, otherwise D2 at the query boundary.
```

**Marketing (mở §4):**

```
Resume the marketing phase: read docs/MARKETING-COPY.md in full, check the §8 table for what is
unblocked now, then do only the unblocked rows and stop before publishing. I fill the Portal and
top.gg fields myself.
```
