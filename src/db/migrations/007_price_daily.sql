-- The long-term price record: one row per item per UTC day.
--
-- price_snapshots is pruned after the raw retention window; this table is never
-- pruned. The upstream market only serves a short history, so a day that is not
-- rolled up here is lost for good, which is why the rollup runs before every prune
-- and re-running it is a no-op for a day that is already present.
CREATE TABLE IF NOT EXISTS price_daily (
  item_id  INTEGER NOT NULL,
  day      DATE    NOT NULL,
  open     BIGINT  NOT NULL,
  close    BIGINT  NOT NULL,
  low      BIGINT  NOT NULL,
  high     BIGINT  NOT NULL,
  samples  INTEGER NOT NULL,
  PRIMARY KEY (item_id, day)
);
CREATE INDEX IF NOT EXISTS idx_price_daily_day ON price_daily (day DESC);
