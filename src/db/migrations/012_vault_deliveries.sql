-- Which channel has already been given which vault event.
--
-- `vault_events` de-duplicates the clan log; this table de-duplicates the post.
-- An event is written here only after a channel accepted it, so a refused post
-- is retried on the next tick instead of disappearing.
CREATE TABLE IF NOT EXISTS vault_deliveries (
  clan_name    TEXT        NOT NULL,
  event_key    TEXT        NOT NULL,
  channel_id   BIGINT      NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clan_name, event_key, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_vault_deliveries_event ON vault_deliveries (clan_name, event_key);
