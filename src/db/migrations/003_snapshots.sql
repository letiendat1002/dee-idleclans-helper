CREATE TABLE IF NOT EXISTS price_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  ask         BIGINT,
  bid         BIGINT,
  ask_volume  BIGINT,
  bid_volume  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON price_snapshots (item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_time      ON price_snapshots (captured_at);

CREATE TABLE IF NOT EXISTS alert_cooldowns (
  guild_id        BIGINT NOT NULL,
  item_id         INTEGER NOT NULL,
  direction       TEXT    NOT NULL,
  last_signal_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, item_id, direction)
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id            BIGINT PRIMARY KEY,
  digest_channel_id   BIGINT,
  digest_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  digest_interval_min INTEGER NOT NULL DEFAULT 60,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
