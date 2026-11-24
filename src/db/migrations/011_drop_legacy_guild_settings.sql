-- Legacy single-channel digest columns, superseded by digest_channels in 005 and
-- read by nothing since. 005 said a later migration would remove them.
ALTER TABLE guild_settings
  DROP COLUMN IF EXISTS digest_channel_id,
  DROP COLUMN IF EXISTS digest_enabled;
