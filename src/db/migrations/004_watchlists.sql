CREATE TABLE IF NOT EXISTS watchlists (
  id              SERIAL PRIMARY KEY,
  discord_user_id BIGINT NOT NULL,
  guild_id        BIGINT,
  item_id         INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  direction       TEXT    NOT NULL CHECK (direction IN ('below','above')),
  threshold       BIGINT NOT NULL,
  armed           BOOLEAN NOT NULL DEFAULT TRUE,
  delivered       BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (discord_user_id, item_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_watch_user ON watchlists (discord_user_id);
