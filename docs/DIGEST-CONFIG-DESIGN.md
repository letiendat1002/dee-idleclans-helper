# Digest config & quyền — thiết kế có dẫn nguồn

**Trạng thái:** đã implement — `/digest` thành 4 subcommand (`add` / `remove` / `list` / `interval`), bảng `digest_channels` + migration `005_digest_channels.sql`, nhịp lấy từ `last_sent_at` trong DB, dọn subscription 3 lớp.
**Phạm vi:** cấu hình digest (nhiều channel / guild, interval), mô hình quyền, dọn dẹp channel bị xoá.
**Chốt sau review:** giới hạn hạ xuống **1 channel / guild** (`MAX_CHANNELS_PER_GUILD = 1`) — schema vẫn nhiều dòng để sau này mở lại, nhưng mỗi channel thêm là thêm bề mặt bị lạm dụng và thêm lượng gửi. Phần phân tích nhiều channel bên dưới giữ nguyên làm nguồn.

## 1. Kết luận trước

1. **Nhiều channel / guild** là đúng hướng; schema `guild_settings.digest_channel_id` (1 channel) phải tách thành bảng `digest_channels` — một dòng mỗi `(guild_id, channel_id)`.
2. **Quyền cấu hình = `ManageGuild`**, không phải `ManageChannels` như code hiện tại. `ManageChannels` là quyền *quản lý channel* (đổi tên, di chuyển, xoá) — dùng nó làm cổng cho "được đổi cấu hình bot của cả server" là sai phạm vi.
3. **`default_member_permissions` chỉ là mặc định**, admin server override được và `Administrator` **luôn** dùng được. Nên **bắt buộc** có kiểm tra quyền lúc chạy — không thể chỉ ẩn command.
4. **`setContexts(Guild)`** phải bật cho `/digest`: command global mặc định hiện cả trong DM, nơi `interaction.guild === null` và `memberPermissions === null` → code hiện tại sẽ nổ `TypeError`.
5. **Trạng thái "lần gửi cuối" phải lưu DB theo channel**, không dùng `Map` trong RAM như `MarketDigest.isDue()` hiện tại (restart là gửi lại ngay; nhiều channel cùng guild thì một key/guild là sai).
6. **Dọn subscription khi channel bị xoá phải làm cả 3 lớp**: event `channelDelete` + kiểm tra lúc gửi + quét đối soát định kỳ. Chỉ event là không đủ.

## 2. Nguồn

| Chủ đề | Nguồn |
|---|---|
| `default_member_permissions` là mặc định, override được | [Discord Docs — Application Commands # permissions](https://docs.discord.com/developers/interactions/application-commands#permissions), [Command Permissions (Support)](https://support-apps.discord.com/hc/en-us/articles/26501869403159-Command-Permissions) |
| Admin override ở Server Settings → Integrations | [Discord Docs — Syncing and Unsyncing Permissions](https://docs.discord.com/developers/interactions/application-commands#syncing-and-unsyncing-permissions) |
| `contexts` / `setContexts` / `setDMPermission` deprecated | [Discord Docs — Contexts](https://docs.discord.com/developers/interactions/application-commands#contexts), [discord-api-types applicationCommands.d.ts](https://github.com/discordjs/discord-api-types/blob/main/payloads/v10/_interactions/applicationCommands.d.ts) |
| `memberPermissions` = quyền **trong channel gọi command**; `appPermissions` = quyền của bot trong channel đó | [discord.js `BaseInteraction.js`](https://github.com/discordjs/discord.js/blob/e47a4548046bbc57e0e7dd3bf7ec8d29de6f19ac/packages/discord.js/src/structures/BaseInteraction.js#L81) |
| `GuildMember#permissions` = quyền cấp guild (không có overwrite); `permissionsIn()` = có overwrite, và **throw** nếu channel không có trong cache | [GuildMember.js](https://github.com/discordjs/discord.js/blob/e47a4548046bbc57e0e7dd3bf7ec8d29de6f19ac/packages/discord.js/src/structures/GuildMember.js#L333), [GuildChannel.js](https://github.com/discordjs/discord.js/blob/e47a4548046bbc57e0e7dd3bf7ec8d29de6f19ac/packages/discord.js/src/structures/GuildChannel.js#L218) |
| `has(perm)` mặc định `checkAdmin=true` → Administrator luôn true; guild owner nhận `All` | [PermissionsBitField.js](https://github.com/discordjs/discord.js/blob/e47a4548046bbc57e0e7dd3bf7ec8d29de6f19ac/packages/discord.js/src/util/PermissionsBitField.js#L91) |
| `CHANNEL_DELETE` chỉ gửi cho "channel relevant to the current user" | [Discord Docs — Gateway Events # channel-delete](https://docs.discord.com/developers/events/gateway-events#channel-delete) |
| Command visibility: thiếu quyền thì command **biến mất**, không báo lỗi | [Application Commands # permissions](https://docs.discord.com/developers/interactions/application-commands#permissions) |
| Bot token **không** sửa được command permissions (cần Bearer token) | [Application Commands # permissions](https://docs.discord.com/developers/interactions/application-commands#permissions) |
| 200 command *creates*/ngày/guild | [Registering a Command](https://docs.discord.com/developers/interactions/application-commands#registering-a-command) |

## 3. Các bot lớn gate cấu hình thế nào

| Bot | Cổng quyền | Ghi chú |
|---|---|---|
| Carl-bot | `Manage Server` cho `/automod`; thêm tầng role riêng (`!modrole`, `!modonly`) | `!disable` không ai bypass được |
| MEE6 | Dashboard cần **Administrator** hoặc owner (Manage Server chỉ đủ để invite); Premium có "Bot Master roles" | allow/deny theo role + channel |
| Dyno | Slash command quản trị mặc định ẩn sau **Administrator** + role "Dyno Manager" | "Allowing a role to see a command does not give permission to use it" |
| Sesh | "admins" (dashboard) + hệ role riêng của bot | |
| YAGPDB | `/rolemenu` hard-code **`MANAGE_GUILD`**, override của Discord **không** ảnh hưởng | tài liệu hoá rõ: thấy command ≠ được chạy |

**Quy luật chung (convention, không phải docs):** một quyền Discord làm **sàn** (`ManageGuild` / `Manage Server` / `Administrator`), và **tuỳ chọn** một role riêng của bot làm tầng mở rộng. Không bot lớn nào dùng role riêng *thay* cho quyền Discord.

**Mâu thuẫn cần biết:** [discord.js guide](https://github.com/discordjs/guide/blob/main/guide/slash-commands/permissions.md) khuyên *"Your code should not try to enforce its own permission management"* — nhưng đó là nói về việc **đừng dựng lại hệ thống visibility** của Discord. Kiểm tra quyền cho **hành động** (được đổi cấu hình guild này hay không) là tầng khác, và mọi bot lớn đều làm. Ta làm đúng tầng hành động.

## 4. Lỗi trong `/digest` hiện tại (đọc code, không phải phỏng đoán)

1. `src/commands/digest.ts:65-77` — điều kiện `botCanManage !== true && userCanManage !== true`: bot có `ManageChannels` là **user không có quyền vẫn cấu hình được**. Quyền cấu hình phải là của user; quyền của bot chỉ dùng để kiểm tra *post được không*.
2. `ManageChannels` là sàn sai (mục 1.2).
3. Không có `setDefaultMemberPermissions` → mọi member thấy `/digest` trong picker.
4. Không có `setContexts(Guild)` → `/digest` hiện trong DM; ở DM `interaction.guild` là `null` → `interaction.guild.members.me` ném `TypeError`.
5. `interaction.memberPermissions` là quyền **ở channel gọi**, không phải channel đích. Muốn kiểm tra channel đích phải dùng `member.permissionsIn(targetId)` (và `permissionsIn` throw nếu channel không có trong cache → dùng `guild.channels.cache.get(id)?.permissionsFor(member)`).
6. `MarketDigest.isDue()` (`src/jobs/MarketDigest.ts:250`) dùng `Map` trong RAM theo guild → restart (giờ là container, restart thường xuyên) là gửi lại ngay; nhiều channel/guild thì sai.
7. Chỉ có 1 channel/guild (`guild_settings.digest_channel_id`), không có cách tắt riêng một channel.

## 5. Thiết kế

### 5.1 Bề mặt command

`/digest` chuyển sang **subcommand**. Đây là **breaking change** có dẫn chứng: *"Using subcommands or subcommand groups will make your base command unusable. You can't send the base `/permissions` command as a valid command if you also have `/permissions add | remove` as subcommands"* — [Discord Docs, Subcommands and Subcommand Groups](https://docs.discord.com/developers/interactions/application-commands#subcommands-and-subcommand-groups). Tức là `/digest channel:#x` hiện tại sẽ **không còn dùng được** sau khi thêm subcommand, phải ghi vào release note cho tester.

| Subcommand | Option | Việc |
|---|---|---|
| `/digest add` | `channel` (bắt buộc) | subscribe channel; idempotent |
| `/digest remove` | `channel` (bắt buộc, autocomplete từ subscription hiện có) | unsubscribe |
| `/digest list` | — | bảng các channel đang nhận + interval + lần gửi cuối; ephemeral |
| `/digest interval` | `hours` (0–24, bắt buộc) + `minutes` (15 / 30 / 45, không bắt buộc — bỏ trống là tròn giờ) | đổi nhịp của guild; phủ mọi mốc 15 phút từ 15 phút tới 24 giờ |

Tất cả: `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)` + `setContexts(InteractionContextType.Guild)`.
Giữ rate limit 5/phút/user như hiện tại.

### 5.2 Kiểm tra quyền lúc chạy

```ts
if (!interaction.inCachedGuild()) return;                      // không có guild → không cấu hình
const canConfig = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
if (!canConfig) { ephemeral: "Cần Manage Server." ; return; }
```

Không tự sửa command permissions bằng bot token (Discord chặn, cần Bearer token) — bỏ hẳn ý định đó.

### 5.3 Schema (migration `005_digest_channels.sql`)

```sql
CREATE TABLE IF NOT EXISTS digest_channels (
  guild_id    BIGINT NOT NULL,
  channel_id  BIGINT NOT NULL,
  created_by  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id, channel_id)
);
INSERT INTO digest_channels (guild_id, channel_id, created_by)
  SELECT guild_id, digest_channel_id, guild_id FROM guild_settings
  WHERE digest_channel_id IS NOT NULL AND digest_enabled
  ON CONFLICT DO NOTHING;
```

- `PRIMARY KEY (guild_id, channel_id)` = dedupe bằng `ON CONFLICT DO NOTHING`, không race.
- `last_sent_at` = trạng thái nhịp, sống qua restart.
- `guild_settings.digest_interval_min` **giữ nguyên** làm nhịp cấp guild (đã có sẵn, default 60).
- `guild_settings.digest_channel_id` / `digest_enabled` thành legacy: ngừng đọc sau migration, xoá cột ở migration sau.
- Trần **1 channel/guild** (`MAX_CHANNELS_PER_GUILD = 1`, xem "Chốt sau review") — **quy ước của ta**, không phải giới hạn Discord; `/help` ghi rõ "one channel per server".

### 5.4 Scheduler

- Tick 1 phút như cũ; với mỗi dòng `digest_channels`, gửi nếu `now - coalesce(last_sent_at, '-infinity') >= interval_min`.
- Gửi xong → `UPDATE ... SET last_sent_at = NOW()`.
- Mỗi channel là **một message riêng** (không gộp), giữ `SUPPRESS_NOTIFICATIONS`.
- Lỗi gửi 1 channel không được làm dừng các channel khác (bọc riêng từng dòng, log).
- `COOLDOWN_MS = 6h` theo `(guild, item, direction)`, lưu ở bảng `alert_cooldowns` (`MarketDigest.ts:405-432`) — sống qua restart, và vì trần là 1 channel/guild nên khoá theo guild là đủ.

### 5.5 Dọn dẹp — 3 lớp

1. `client.on(Events.ChannelDelete, ch => DELETE FROM digest_channels WHERE channel_id = ...)`.
2. Lúc gửi: `guild.channels.cache.get(id)` + `permissionsFor(guild.members.me).has(ViewChannel|SendMessages)`; thiếu → xoá dòng, bỏ qua (không log lỗi ồn ào).
3. Quét đối soát mỗi giờ: xoá dòng có channel không còn trong cache của guild.

Lý do lớp 2 và 3: event chỉ bắn khi channel "relevant to the current user" — bot mất `ViewChannel` hoặc offline lúc xoá thì **không nhận được**.

## 6. Thứ tự implement

1. Migration `005_digest_channels.sql` (+ migrate dữ liệu cũ).
2. `src/services/DigestSettings.ts`: `addChannel`, `removeChannel`, `listChannels`, `setInterval` — tất cả `ON CONFLICT`.
3. `src/commands/digest.ts` → 4 subcommand, siết quyền như 5.2.
4. `src/jobs/MarketDigest.ts`: đọc `digest_channels`, `last_sent_at`, gửi từng channel, 3 lớp dọn dẹp.
5. Test: dedupe (add 2 lần → 1 dòng), remove, cap 1 (add lần 2 → từ chối), interval due/not-due, channel xoá → dòng mất, thiếu quyền → không ghi DB, DM → từ chối êm.
6. Cập nhật `/help`.

## 7. Không kiểm chứng

- Không xác minh Discord đánh giá `default_member_permissions` theo quyền **cấp guild** hay **theo channel** (docs không nói) — nên thiết kế không dựa vào chi tiết đó; ta luôn kiểm tra lại bằng `memberPermissions`/`permissionsIn`.
- Không đọc source của MEE6/Dyno/Sesh/Carl-bot (closed source hoặc chỉ có docs) — phần runtime-check của họ lấy từ tài liệu vendor.
- "Trần 1 channel" là quy ước của ta, không phải giới hạn nền tảng.
