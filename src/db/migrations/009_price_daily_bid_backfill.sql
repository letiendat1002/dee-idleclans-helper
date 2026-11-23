-- Fill the buy side of the days that were archived before migration 008.
--
-- Those rows were rolled by the ask-only rollup, so their bid columns are NULL
-- while their raw rows still sit inside the retention window. Re-derive them the
-- way the rollup does now. The guard makes this a no-op for any day that already
-- carries a bid, so it is safe on a database rolled after 008 and on a fresh one.
UPDATE price_daily d
SET bid_open    = side.bid_open,
    bid_close   = side.bid_close,
    bid_low     = side.bid_low,
    bid_high    = side.bid_high,
    bid_samples = side.bid_samples
FROM (
  SELECT item_id,
         (captured_at AT TIME ZONE 'UTC')::date AS day,
         (array_agg(bid ORDER BY captured_at ASC) FILTER (WHERE bid > 0))[1]  AS bid_open,
         (array_agg(bid ORDER BY captured_at DESC) FILTER (WHERE bid > 0))[1] AS bid_close,
         MIN(bid) FILTER (WHERE bid > 0) AS bid_low,
         MAX(bid) FILTER (WHERE bid > 0) AS bid_high,
         COUNT(*) FILTER (WHERE bid > 0) AS bid_samples
  FROM price_snapshots
  GROUP BY 1, 2
) side
WHERE side.item_id = d.item_id
  AND side.day = d.day
  AND d.bid_samples = 0
  AND side.bid_samples > 0;
