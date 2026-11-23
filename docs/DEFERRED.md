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
| B3 | Discord/Horde: tạo category bot (announcements, feedback) | chờ B1 và quyết định cấu trúc server | sau B1 |
| B4 | Donation rails: handle Ko-fi (VietQR **đã chốt bỏ** 2026-11-21) | owner loại kênh nội địa vì tệp người dùng là quốc tế; `LEGAL_DONATION_VN.md` §6 đã ghi lại | owner gửi handle ⇒ gắn `ko_fi:` vào `.github/FUNDING.yml` + link ở `/help` footer và README. Đánh đổi đã chấp nhận: người chơi VN không còn đường nội địa (PayPal VN không giao dịch nội địa từ 2016) |
| B5 | Bật GitHub Sponsors (hồ sơ + thuế + ngân hàng) | cần KYC; nên public repo trước để hồ sơ "open source" dễ duyệt | sau khi repo public; nút Sponsor đã có trong `.github/FUNDING.yml` |
| B6 | Rotate token của **DIH Dev** | token dev đã xuất hiện trong chat lúc setup 2026-11-22 (owner đã nói sẽ reset); app chỉ ở server test nên rủi ro thấp, nhưng token phải đổi trước khi mở rộng quyền | Portal → DIH Dev → Bot → Reset Token → sửa `DISCORD_TOKEN` trong `.env.dev` → `docker compose --env-file .env.dev -p dih-dev up -d bot collector` |

Rotate credential **không** nằm trong bảng này: nó là bước §2 của checklist release riêng của operator, chạy
ngay trong lần release kế tiếp. Không tạo mục riêng cho nó ở đây.

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
| G8 | Chưa có 24 h phủ đủ nhịp poll | **đo 2026-11-22:** 324 poll / 23.75 h = 45% nhịp 2 phút, 5 khoảng trống > 20 phút (suspend ban đêm + restart/deploy). Card đã in span thật nên người đọc không bị lừa, nhưng dữ liệu vẫn thủng | chỉ đóng được khi collector chạy trên máy không ngủ (D16 bước 2). Sau đó chạy lại cùng truy vấn và ghi số vào `ROADMAP.md` §2 |

| G9 | Dev stack đã được bấm thử lệnh thật | **đóng 2026-11-22**: `/help` trả embed Commands (Market `/price`, `/graph`), `/price Spruce log` trả `27g · 27,334 units` / buy `25g · 4,182 units` / `snapshot 13:41 UTC`, `/graph` 24h → menu 7 days → về 24h đổi tại chỗ | — |

## 3. Tech debt

| # | Debt | Mức | Ghi chú |
|---|---|---|---|
| D1 | Rate window (Redis) + cooldown share (RAM) giả định **một process** | trung bình | lên multi-instance thì chuyển cả hai sang Redis; luật đã ghi `CONVENTIONS.md` §6.5 |
| D2 | 131 chỗ `as` còn lại (đã bỏ 3 ở `ItemCatalogue`) | thấp | bỏ dần ở biên query bằng `query<Row>`; không làm một đợt riêng |
| D3 | `statement_timeout` 15s chưa đo với backfill lớn | thấp | theo dõi log `canceling statement due to statement timeout` |
| D4 | CI không chạy `npm run coverage` | thấp | thêm một dòng vào `.github/workflows/tests.yml` khi muốn; đừng đặt ngưỡng vội |
| D5 | `.env` nằm ở nhiều chỗ: checkout workspace (stack đang chạy), checkout deploy riêng (chép tay mode 600), và `.env.dev` cho app dev | thấp, dễ sai | mỗi lần rotate phải sửa đúng file của stack đang chạy; `.env.dev` là app khác nên token khác. Kiểm bằng token prefix khi nghi ngờ (không chép prefix vào repo) |
| D6 | T4 "docs consolidation" queued (11 docs; `AGENTS.md` còn lặp `CONVENTIONS.md`) | trung bình | không chặn release |
| D7 | `systemError` là export không dùng | trivial | xoá 3 dòng khi tiện tay |
| D8 | Depth strip cho chart 24h (dải low/high mỗi cột) | thấp | **Lý do cũ hết hiệu lực 2026-11-23**: bucket history của vendor có sẵn `low`/`high`/`avg`/`volume`, không cần `price_snapshots`. Chart v3 chỉ vẽ avg + volume; thêm dải là vẽ thêm hai polyline trong `chartHistory.ts`. Mở lại khi owner muốn thấy độ rộng giá trong một bucket |
| D9 | `vault_events` ghi **trước** khi post: một batch lỗi Discord là mất luôn, không retry (không có ledger giao cho từng channel) | trung bình | bảng trạng thái giao (`event_id, channel_id, delivered_at`) hoặc chỉ ghi sau khi post thành công; cần migration, không làm chung đợt |
| D10 | `price_daily` có ngày dựng từ **một** poll (2026-11-12: 604 samples / 630 item); card daily không in `samples` | thấp | thêm `samples` vào footer hoặc ẩn ngày có < 5% số poll; đợi dữ liệu 1 ngày đủ trước khi quyết |
| D11 | Catalogue trễ tối đa 30 phút (sync) nhưng không surface nào nói "catalogue lúc mấy giờ" | thấp | thêm `last_synced_at` vào `/help` hoặc footer `/price` khi rename item gây nhầm |
| D12 | Budget 5/phút dùng chung cho lệnh lệch chi phí | thấp | **Đã bớt lệch 2026-11-23**: `/graph` không còn gọi renderer ngoài, chi phí giờ là một lần đọc history (cache riêng 10/phút, TTL 2–120 phút), nên lần đổi range thứ hai vào cùng period là 0 request. Vẫn đọc log `[RATE]` vài tuần trước khi tách dòng `graph: { max: 3 }` |
| D13 | `autocomplete` của `/digest` và `/vault` không kiểm tra quyền | thấp, chấp nhận | chúng chỉ liệt kê kênh/clan của chính server, mà mọi member đã thấy trong danh sách kênh; thêm một lần gọi quyền mỗi lần gõ không bảo vệ thêm gì |
| ~~D14~~ | ~~Chart daily chỉ có 6–7 ngày~~ | **đóng 2026-11-23** | Panel traded riêng đã có: `/graph` v3 vẽ đúng series history (avg traded price + volume), 4 range 24h/7d/30d/1y, nhãn `traded` — không trộn trục ask. Luật cũ vẫn giữ: **không backfill `price_daily`** từ endpoint này (giá khớp ≠ ask); `price_daily` chỉ phục vụ alert/digest. Chi tiết bucket + giới hạn ở `CHART.md` |
| D15 | `price_snapshots` giữ **30 ngày** (`RETENTION_DAYS=30`, housekeeping chạy lúc boot + mỗi 24 h) rồi prune, nhưng **không archive** | thấp | steady state ≈ 30 × 120k ≈ 3,6 M dòng ≈ **570 MB** (hôm nay 196 MB / 10 ngày); dump hourly đang 16 MB gz và sẽ lớn dần. Chọn một: (a) chấp nhận 570 MB, (b) archive ngày cũ sang B2 rồi prune, (c) hạ retention còn 14 ngày — 24h card chỉ cần 1. Đo lại khi DB vượt 1 GB hoặc dump vượt 50 MB. Lưu ý: prune chỉ xoá ngày **đã có** dòng trong `price_daily`, nên không bao giờ mất dữ liệu chưa rollup |
| D16 | **Collector tách khỏi Discord bot** (poller + rollup + housekeeping chạy 24/7) | **Bước 1 xong 2026-11-22** — `src/collector.ts` + service `collector`, cả hai healthy, chứng minh thật: stop bot 150 s, `price_snapshots` +632 dòng, 450/450 test | **Bước 2 = dời stack production lên host server riêng** (owner có sẵn, không thuê VPS): clone repo, restore dump, hai service bot+collector, cài lại 3 timer, rclone B2. Chỉ bước này đóng G8; chi tiết lệnh trong `docs/ENVIRONMENTS.md` §7 + `docs/DEPLOYMENT.md` |
| ~~D17~~ | ~~Mẫu giá ngoài domain bị vẽ dính mép~~ | **đóng 2026-11-22** | Chọn (a): mẫu nằm **hoàn toàn** ngoài domain không vẽ nữa (đường đứt tại đó, caption giữ số mẫu bị cắt), mẫu lấn một phần vẫn vẽ + clamp, dot "giá mới nhất" mất khi chính nó ngoài thang. Chestnut log 24h kiểm lại: 93 mẫu dưới `100g` không còn vẽ thành đường phẳng ở `100g`. Luật ghi ở `CHART.md` §Reading the line + `UI-DESIGN.md` |
| D11 | ~~Reboot không tự lên~~ — **đóng một nửa 2026-11-23** | — | Đã `systemctl --user enable docker-desktop.service` (symlink vào `graphical-session.target.wants`, tức lên **sau khi đăng nhập**, không phải headless) và chứng minh: `systemctl --user restart docker-desktop.service` → 4/4 container tự trở lại healthy sau **29 s** nhờ `restart: unless-stopped`. Phần headless còn lại ở D13 |
| D13 | Chỉ tự lên **không cần đăng nhập** thì cần native Docker engine | trung bình | Stack đang ở VM của Docker Desktop; unit của Desktop là user unit gắn `graphical-session.target`. Muốn bot sống lại ngay sau reboot mà không ai login thì phải chuyển stack sang native engine (`docker.service` đã enabled, context `default`): dump → `docker context use default` → `up -d --wait` → restore vào volume mới → verify. Làm cùng lúc move host (Phase D) |
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
