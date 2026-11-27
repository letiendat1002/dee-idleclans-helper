-- Market insights: one subscription per channel, a queue of findings, and the
-- hourly book that gives the book patterns a longer memory than raw snapshots.
--
-- `insight_channels` is deliberately not `digest_channels`: the two surfaces
-- answer different questions and keep separate state (`docs/CONVENTIONS.md`).
-- `interval_min` is a rate cap, not a schedule -- 240 by default, 60 floor.
CREATE TABLE IF NOT EXISTS insight_channels (
  guild_id     BIGINT      NOT NULL,
  channel_id   BIGINT      NOT NULL,
  created_by   BIGINT      NOT NULL,
  interval_min INTEGER     NOT NULL DEFAULT 240 CHECK (interval_min BETWEEN 60 AND 1440),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_insight_channels_channel ON insight_channels (channel_id);

-- One finding. `body` holds the numbers the detector used, so the formatter
-- prints the scored figure instead of recomputing it.
--
-- `status` has two values only: a queued finding either earns a slot or expires.
CREATE TABLE IF NOT EXISTS insights (
  id         BIGSERIAL PRIMARY KEY,
  item_id    INTEGER     NOT NULL,
  pattern    TEXT        NOT NULL,
  state      TEXT,
  score      DOUBLE PRECISION NOT NULL CHECK (score >= 0 AND score <= 1),
  body       JSONB       NOT NULL,
  fired_at   TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent')),
  sent_at    TIMESTAMPTZ,
  channel_id BIGINT
);

-- One pending finding per item and pattern: a state that lasts for hours is not
-- re-inserted on every scan.
CREATE UNIQUE INDEX IF NOT EXISTS insights_pending
  ON insights (pattern, item_id) WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS insights_pick
  ON insights (score DESC, fired_at) WHERE status = 'queued';

-- The cooldown lookup: has this item already been reported for this pattern?
CREATE INDEX IF NOT EXISTS insights_cooldown
  ON insights (pattern, item_id, sent_at DESC) WHERE status = 'sent';

-- One row per item per closed hour. `ask`/`bid` are the last known non-zero
-- price of the hour, `*_low`/`*_high` the extremes, and `*_volume` the most that
-- was listed at once. A dry side is `ask_volume = 0`: the collector keeps the
-- last price, so `ask IS NULL` never happens in practice.
CREATE TABLE IF NOT EXISTS book_hourly (
  item_id     INTEGER     NOT NULL,
  hour        TIMESTAMPTZ NOT NULL,
  ask         NUMERIC,
  ask_low     NUMERIC,
  ask_high    NUMERIC,
  bid         NUMERIC,
  ask_volume  BIGINT      NOT NULL DEFAULT 0,
  bid_volume  BIGINT      NOT NULL DEFAULT 0,
  samples     INTEGER     NOT NULL,
  PRIMARY KEY (item_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_book_hourly_hour ON book_hourly (hour);
