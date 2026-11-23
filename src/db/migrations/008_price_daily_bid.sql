-- Archive the buy side of the day, and let a day hold one side only.
--
-- price_daily kept the ask (what you pay) because that is the side every reader
-- uses. The bid (what you receive) matters just as much and is just as
-- unrecoverable once the raw window closes: the upstream serves no history, so a
-- day that is not archived here is gone for good.
--
-- The ask columns become nullable because the two sides are independent: on
-- 2026-11-16, 31 of the quoted items had a buy order and no sell order, and
-- another 56 the reverse. A row that required an ask dropped those 31 items
-- entirely, which is exactly the "nobody sells it but someone buys it" case.
-- NULL means "no offer on that side all day"; 0 never appears, because a price
-- of 0 means no offer and averaging it in would poison every later analysis.
ALTER TABLE price_daily
  ALTER COLUMN open  DROP NOT NULL,
  ALTER COLUMN close DROP NOT NULL,
  ALTER COLUMN low   DROP NOT NULL,
  ALTER COLUMN high  DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS bid_open    BIGINT,
  ADD COLUMN IF NOT EXISTS bid_close   BIGINT,
  ADD COLUMN IF NOT EXISTS bid_low     BIGINT,
  ADD COLUMN IF NOT EXISTS bid_high    BIGINT,
  ADD COLUMN IF NOT EXISTS bid_samples INTEGER NOT NULL DEFAULT 0;

-- samples keeps its old meaning: how many snapshots carried a usable ask.
COMMENT ON COLUMN price_daily.samples IS 'snapshots with a usable ask (ask > 0)';
COMMENT ON COLUMN price_daily.bid_samples IS 'snapshots with a usable bid (bid > 0)';
