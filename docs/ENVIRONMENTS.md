# Môi trường: một codebase, hai ứng dụng Discord

Bot production và bot dev là **hai ứng dụng Discord khác nhau**, không phải hai lần chạy của một
token. Đó là lý do chúng có thể online cùng lúc mà không trả lời đôi: Discord route interaction theo
application, nên app dev không bao giờ nhận lệnh ở guild của app prod.

## 1. Bảng

| | Production | Dev |
|---|---|---|
| Application | Dee IdleClans Helper `1569644838012325968` | DIH Dev `1573952148209795072` |
| Bot user | `DIH#7997` | `DIH Dev#5813` |
| Guild | Clint's Polygon Abilities `1283509005477609562` | Test server riêng `<dev-guild-id>` |
| Env file | `.env` | `.env.dev` |
| Stack | host server, 24/7 | laptop, `STACK_PREFIX=dih-dev` |
| Database | `idleclans` | `idleclans_dev` |

Lịch sử: ngày 2026-11-22 DIH bị gỡ khỏi server test, DIH Dev được mời vào thay. Từ đó production
và dev không còn chung guild nào.

## 2. Quy tắc

- **Không mời app dev vào guild production**, kể cả để test nhanh: hai bot sẽ cùng trả lời những
  lệnh trùng tên. Cần thêm người thử thì mời họ vào server test.
- **Không copy `.env.dev` sang `.env`** hoặc ngược lại. Dấu hiệu sai: dòng boot log
  `Logged in as DIH Dev#5813` xuất hiện trên stack production.
- Token chỉ nằm trong `.env` / `.env.dev` (đã gitignore). Portal chỉ hiện token một lần; reset là
  rotate.
- App Testers trong portal chỉ dùng cho Activity chưa verify (tối đa 50 người), không liên quan
  slash command và không thay được việc tách application.

## 3. Chạy dev trên laptop

```bash
docker compose --env-file .env.dev -p dih-dev up -d --build
docker compose -p dih-dev ps
docker compose -p dih-dev logs -f bot collector
```

`STACK_PREFIX=dih-dev` (đặt trong `.env.dev`) đổi tên container, network và volume, nên stack dev
không đụng stack production nếu cả hai cùng chạy trên một máy. Mặc định không đặt biến này thì tên
giữ nguyên như production.

Image tách bằng biến riêng: `IMAGE_TAG`. `deploy.sh` export `IMAGE_TAG=sha-<commit>`, `.env.dev` đặt
`IMAGE_TAG=dih-dev`, mặc định là `local`. Lý do: hai stack dùng chung một tag thì lần `build` của dev
ghi đè đúng cái tag mà production tham chiếu, và lần restart kế tiếp của production sẽ chạy code chưa
release. Đo được 2026-11-23: image của production bị prune mất trong lúc dev rebuild, container vẫn
chạy nhưng không còn image để tạo lại.

Ba biến trong `.env.dev` làm việc tách stack, đừng bỏ cái nào:

| Biến | Tác dụng | Thiếu thì sao |
|---|---|---|
| `STACK_PREFIX=dih-dev` | tên container/network/volume | trùng tên với production, `up` báo conflict |
| `IMAGE_TAG=dih-dev` | tag image của stack dev | dev build ghi đè image mà production tham chiếu |
| `ENV_FILE=.env.dev` | container nạp env của app dev | container nạp `.env` → **chạy token production**, trả lời đôi |
| `POSTGRES_DB=idleclans_dev` | tên DB trong container dev | dev ghi vào DB `idleclans` của stack dev (rỗng), dump restore lệch chỗ |

Nạp dữ liệu thật vào DB dev từ dump mới nhất:

```bash
docker compose -p dih-dev exec -T postgres createdb -U idleclans idleclans_dev
gunzip -c ~/backups/idleclans/idleclans-YYYY-MM-DD.sql.gz \
  | docker compose -p dih-dev exec -T postgres psql -U idleclans -d idleclans_dev
```

## 4. Đăng ký lệnh

`registerCommands()` đăng ký **global** cho cả hai app và xoá bản guild-scoped ở mọi guild bot đang
ở. Hệ quả khi dev: lệnh mới hoặc đổi tên hiện ra trong tối đa một giờ; button, modal, autocomplete
thì test được ngay. Đổi schema lệnh thường xuyên thì chấp nhận chờ, hoặc PUT tay vào
`/applications/{dev_app_id}/guilds/<dev-guild-id>/commands`.

## 5. Timer

`dee-idleclans-backup`, `-watchdog`, `-deploy` là của **host production**. Không bật trên laptop:
chúng trỏ vào một checkout và một stack cụ thể, bật ở hai nơi là hai lần backup/watchdog chồng nhau.

## 6. Rotate token

Portal → application → Bot → Reset Token → dán token mới vào env file tương ứng → restart stack.
Rotate production phải làm **liền một mạch** với restart: token cũ chết ngay khi reset, bot không
login được sẽ exit 1 và `restart: unless-stopped` sẽ lặp.
