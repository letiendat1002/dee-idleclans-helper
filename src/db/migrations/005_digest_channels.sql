-- Multi-channel digest subscriptions.
--
-- One row per (guild, channel) that receives the market digest. The primary key
-- dedupes the rows, so a second subscription of the same channel is a no-op.
-- `last_sent_at` is the cadence state and survives a restart, unlike the
-- in-memory map the scheduler used before.
--
-- `guild_settings.digest_channel_id` and `guild_settings.digest_enabled` stay
-- in place as legacy columns; a later migration removes them. Nothing reads
-- them after this migration.
CREATE TABLE IF NOT EXISTS digest_channels (
  guild_id     BIGINT      NOT NULL,
  channel_id   BIGINT      NOT NULL,
  created_by   BIGINT      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_digest_channels_channel ON digest_channels (channel_id);

-- Carry the single-channel subscriptions over to the new table.
INSERT INTO digest_channels (guild_id, channel_id, created_by)
  SELECT guild_id, digest_channel_id, guild_id
  FROM guild_settings
  WHERE digest_channel_id IS NOT NULL AND digest_enabled
  ON CONFLICT DO NOTHING;
