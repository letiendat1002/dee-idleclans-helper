# Setup — Dee IdleClans Helper

Who reads this: an operator or contributor running the bot on a new machine — when: first run, a fresh host, or a restore from a backup.
Neighbours: [ENVIRONMENTS.md](ENVIRONMENTS.md) · [DISCORD-TESTING.md](DISCORD-TESTING.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [GUIDE.md](GUIDE.md).

**Dự án:** thư mục chứa repo này (clone về máy, mọi đường dẫn dưới đây tính từ gốc repo)

## 1. Chuẩn bị Discord Application

1. Vào [Discord Developer Portal](https://discord.com/developers/applications).
2. Tạo ứng dụng mới (New Application).
3. Vào mục **Bot**, tạo bot, lấy **Token** (ghi vào `DISCORD_TOKEN` trong `.env`).
4. Vào mục **OAuth2 → URL Generator**, chọn scopes `bot` và `applications.commands`, tạo link invites bot vào server.
5. Lấy **Application ID** (ghi vào `DISCORD_CLIENT_ID` trong `.env`).

## 2. Cài đặt local (không dùng Docker)

```bash
cd dee-idleclans-helper

# Cài dependencies
npm ci

# Copy env
cp .env.example .env
# Chỉnh DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL, REDIS_URL

# Build TypeScript
npx tsc

# Chạy bot
node dist/index.js
```

## 3. Cài đặt với Docker (khuyên dùng)

```bash
cd dee-idleclans-helper

cp .env.example .env
# Chỉnh DISCORD_TOKEN, DISCORD_CLIENT_ID

docker compose up -d --build
```

### Không có Docker daemon (rootless host)

Docker cần root privileges. Nếu không start được, chạy trực tiếp với Node — bot hoạt động đầy đủ, chỉ cần Redis và PostgreSQL chạy riêng (hoặc bỏ qua, bot vẫn chạy với fail-open).

```bash
npm ci
npx tsc
setsid node dist/index.js > bot.log 2>&1 < /dev/null &
```

## 4. Đăng ký slash commands

Bot tự đăng ký commands **global** mỗi khi khởi động và **xoá** bản guild-scoped, để picker không hiện trùng lệnh (xem `src/index.ts` → `registerCommands()` trong `ready` event). Không cần chạy script riêng.

Đăng ký thủ công nếu cần:
```bash
npx tsx src/registerCommands.ts
```

Kết quả mong đợi trong log:
```
[INFO] [REGISTER] Registered 8 commands globally
```

Lệnh global có thể mất tới **1 giờ** mới hiện trên client đã cache. Muốn test ngay: đăng ký tạm guild-scoped rồi xoá lại (`docs/DISCORD-TESTING.md` §1).

**Invite bot vào server phải có scope `applications.commands`**, nếu không thì dù commands đã đăng ký global, server đó cũng không thấy lệnh nào:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=2147535872
```

Triệu chứng khi thiếu scope: server test (invite đúng từ đầu) có lệnh, server khác thì trống; không phải lỗi đăng ký, và chờ bao lâu cũng không hiện. Sửa bằng cách mở lại link trên, hoặc kick bot rồi invite lại.

## 5. Kiểm tra chạy thành công

```bash
# Container status
docker compose ps

# Hoặc nếu chạy local
ps aux | grep "node dist/index" | grep -v grep
tail -f bot.log
```

Log kỳ vọng:
```
[INFO] [BOT] Logged in as DIH#7997
[INFO] [BOT] Synced guild: DeeLY's test server (<dev-guild-id>)
[INFO] [REGISTER] Registered 8 commands globally
```

Trong Discord: gõ `/help`, `/price` (chọn "Teak log"), `/graph item` (chọn "Teak log"), `/watch` (chọn "Titanium bar" rồi đặt ngưỡng).

> **v2 đã hoàn tất.** `/profit` đã bị gỡ (so giá ask với trung bình giao dịch và bỏ qua thanh khoản).
> Thay bằng `/price`, `/graph item`, `/watch`, `/unwatch`, `/watchlist`, `/digest`.
> `/profile` đã bị gỡ ngày 2026-11-14 (owner request: bot chỉ lo thị trường; hồ sơ người chơi đã có trên site Idle Clans).
> Thiết kế chi tiết là artifact private (spec v2) trong notes folder cạnh clone; bản public của
> contract là `docs/CONVENTIONS.md` + `docs/ARCHITECTURE.md`.

## 6. Lưu ý bảo mật

- **Không commit file `.env`** (chứa token và DB credentials).
- Token Discord đã từng bị lộ trong chat → nếu nghi ngờ thì **Reset Token** trên Discord Developer Portal. Không bao giờ paste token vào chat, code, hoặc commit.
- Tailscale-only: không mở port nào ra WAN.
- **Bật backup trước khi coi là xong**: DB không tái tạo được từ upstream. `scripts/backup-db.sh` +
  cron 04:00 + `RCLONE_REMOTE` (B2) theo hướng dẫn vận hành riêng của operator; không có bước này thì mọi thứ khác
  trên máy mới vẫn chỉ là một bản duy nhất.
