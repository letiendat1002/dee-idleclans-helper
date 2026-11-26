-- When a channel last accepted a vault post.
--
-- A quiet clan and a broken feed look the same from Discord, so the stamp is
-- written after Discord accepts a post (the same idea as
-- `digest_channels.last_sent_at`), and `/vault list` shows it to prove a
-- subscription is alive without reading the log.
ALTER TABLE vault_channels ADD COLUMN IF NOT EXISTS last_post_at TIMESTAMPTZ;
