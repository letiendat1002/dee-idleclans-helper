-- Clan vault subscriptions and the clan-log entries already posted.
--
-- `vault_channels` is one row per (guild, channel, clan) that asked for the
-- vault of a clan. The primary key dedupes the rows, so a second subscription
-- of the same channel for the same clan is a no-op. `created_at` is also the
-- no-backfill boundary: a channel never receives the entries that happened
-- before it subscribed.
--
-- `vault_events` is the dedupe table of the clan log. `event_key` is a hash of
-- the member, the message and the moment, so the same entry the game publishes
-- again on the next poll never posts twice. The table is per clan and not per
-- channel: one fetch of a clan log serves every channel that follows that clan.
CREATE TABLE IF NOT EXISTS vault_channels (
  guild_id   BIGINT      NOT NULL,
  channel_id BIGINT      NOT NULL,
  clan_name  TEXT        NOT NULL,
  created_by BIGINT      NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id, clan_name)
);

CREATE INDEX IF NOT EXISTS idx_vault_channels_channel ON vault_channels (channel_id);
CREATE INDEX IF NOT EXISTS idx_vault_channels_clan    ON vault_channels (clan_name);

CREATE TABLE IF NOT EXISTS vault_events (
  clan_name       TEXT        NOT NULL,
  event_key       TEXT        NOT NULL,
  member_username TEXT        NOT NULL,
  message         TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  item_name       TEXT,
  quantity        INTEGER,
  happened_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (clan_name, event_key),
  CONSTRAINT vault_events_kind CHECK (kind IN ('deposit', 'withdraw', 'move', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_vault_events_time ON vault_events (happened_at);
