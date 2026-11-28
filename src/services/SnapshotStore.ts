import { query } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';
import type { MarketQuote } from './MarketService.js';

const logger = createLogger('SNAPSHOT');

/** A stored snapshot row; the bigint columns come back from Postgres as strings. */
interface SnapshotRow {
  item_id: number;
  ask: string | number | null;
  bid: string | number | null;
  ask_volume: string | number | null;
  bid_volume: string | number | null;
}

/** Convert a stored bigint to a number, keeping a missing value null. */
function toNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/**
 * The UTC calendar day of a `price_daily` row, as `YYYY-MM-DD`.
 *
 * Postgres sends a DATE as a Date at local midnight, so the local getters read
 * the stored day back; a driver that sends the raw text is already in that form.
 */
function toUtcDay(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/**
 * One day of the daily rollup: the sell side of one item on one UTC day.
 *
 * Each field is null when that day carried no usable ask, which happens for an
 * item that had buy orders and no sell order all day. The buy side of the same
 * row is archived in the table but has no reader yet, so it is not selected here.
 */
export interface DailyPrice {
  day: string;
  open: number | null;
  close: number | null;
  low: number | null;
  high: number | null;
  bidClose: number | null;
  samples: number;
}

/**
 * Store and read the market price snapshots.
 *
 * A snapshot batch is one row per item, all captured at the same instant, so
 * the rows of a batch are comparable with each other and never mix prices of
 * two different polls.
 */
export class SnapshotStore {
  /**
   * Write one row per quote, all captured at the same instant.
   */
  static async append(quotes: MarketQuote[], capturedAt: Date): Promise<void> {
    if (quotes.length === 0) return;

    await query(
      `INSERT INTO price_snapshots (item_id, captured_at, ask, bid, ask_volume, bid_volume)
       SELECT item_id, $2::timestamptz, ask, bid, ask_volume, bid_volume
       FROM unnest($1::int[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[])
         AS t(item_id, ask, bid, ask_volume, bid_volume)`,
      [
        quotes.map((q) => q.itemId),
        capturedAt,
        quotes.map((q) => q.ask),
        quotes.map((q) => q.bid),
        quotes.map((q) => q.askVolume),
        quotes.map((q) => q.bidVolume),
      ]
    );
  }

  /**
   * Return an item's ask prices in the window, oldest first, with their time.
   *
   * The time is part of the observation: a chart that spaces samples evenly
   * across the width asserts a duration the data may not have, and a window with
   * no sell order is invisible if only the prices survive. A snapshot without an
   * ask carries no price and is left out. The units on sale at that ask ride
   * along, because the chart draws them on its second axis.
   */
  static async askHistory(
    itemId: number,
    since: Date
  ): Promise<Array<{ at: number; price: number; bid?: number; volume?: number }>> {
    const res = await query<{ ask: string | number; bid: string | number | null; ask_volume: string | number | null; captured_at: Date }>(
      `SELECT ask, bid, ask_volume, captured_at FROM price_snapshots
       WHERE item_id = $1 AND captured_at >= $2 AND ask IS NOT NULL
       ORDER BY captured_at ASC`,
      [itemId, since]
    );

    return (res.rows ?? []).map((row) => ({
      at: new Date(row.captured_at).getTime(),
      price: Number(row.ask),
      bid: row.bid === null || row.bid === undefined ? undefined : Number(row.bid),
      volume: row.ask_volume === null || row.ask_volume === undefined ? undefined : Number(row.ask_volume),
    }));
  }

  /**
   * Return the ask prices of several items in the window, oldest first.
   *
   * The bulk sibling of `askHistory`: one query for every item, so a digest
   * over hundreds of items does not cost hundreds of round-trips. The prices
   * of an item come back ascending, an item without a row in the window is
   * left out of the map.
   */
  static async askHistories(itemIds: number[], since: Date): Promise<Map<number, number[]>> {
    const histories = new Map<number, number[]>();
    if (itemIds.length === 0) return histories;

    const res = await query<{ item_id: number; ask: string | number }>(
      `SELECT item_id, ask FROM price_snapshots
       WHERE item_id = ANY($1) AND captured_at >= $2 AND ask IS NOT NULL
       ORDER BY item_id, captured_at ASC`,
      [itemIds, since]
    );

    for (const row of res.rows) {
      const prices = histories.get(row.item_id);
      if (prices) prices.push(Number(row.ask));
      else histories.set(row.item_id, [Number(row.ask)]);
    }

    return histories;
  }

  /**
   * Return the ids of the items seen in one of the last two polls.
   *
   * A snapshot row stays in the table forever, so an item that left the
   * market would keep its last price. An item that was not seen in the last
   * two polls is therefore not seen here either and is dropped instead of
   * being reported with a stale price.
   */
  static async recentlySeenItemIds(): Promise<Set<number>> {
    const res = await query<{ item_id: number }>(
      `WITH recent_polls AS (
         SELECT DISTINCT captured_at FROM price_snapshots ORDER BY captured_at DESC LIMIT 2
       )
       SELECT DISTINCT item_id FROM price_snapshots
       WHERE captured_at >= (SELECT MIN(captured_at) FROM recent_polls)`
    );

    return new Set(res.rows.map((row) => row.item_id));
  }

  /**
   * Return the newest quote of every item that has a snapshot.
   */
  static async latestQuotes(): Promise<Map<number, MarketQuote>> {
    const res = await query<SnapshotRow>(
      `SELECT DISTINCT ON (item_id) item_id, ask, bid, ask_volume, bid_volume
       FROM price_snapshots
       ORDER BY item_id, captured_at DESC`
    );

    const quotes = new Map<number, MarketQuote>();
    for (const row of res.rows) {
      quotes.set(row.item_id, {
        itemId: row.item_id,
        ask: toNumber(row.ask),
        bid: toNumber(row.bid),
        askVolume: toNumber(row.ask_volume),
        bidVolume: toNumber(row.bid_volume),
      });
    }
    return quotes;
  }

  /**
   * Return the newest quote of one item, or null when it has no snapshot.
   *
   * The single-item sibling of `latestQuotes`: it reads one row through the
   * `(item_id, captured_at)` index instead of walking every item in the table,
   * which is the whole cost a command that names one item should pay.
   */
  static async latestQuote(itemId: number): Promise<MarketQuote | null> {
    const res = await query<SnapshotRow>(
      `SELECT item_id, ask, bid, ask_volume, bid_volume
       FROM price_snapshots
       WHERE item_id = $1
       ORDER BY captured_at DESC
       LIMIT 1`,
      [itemId]
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      itemId: row.item_id,
      ask: toNumber(row.ask),
      bid: toNumber(row.bid),
      askVolume: toNumber(row.ask_volume),
      bidVolume: toNumber(row.bid_volume),
    };
  }

  /**
   * Return when the newest snapshot row of one item was captured.
   *
   * The card's stamp must describe the price it prints, not the newest poll in
   * the table: an item that dropped out of the market for a poll would
   * otherwise claim a capture time up to two polls fresher than its price.
   */
  static async latestQuoteAt(itemId: number): Promise<Date | null> {
    const res = await query<{ captured_at: Date | null }>(
      `SELECT MAX(captured_at) AS captured_at FROM price_snapshots WHERE item_id = $1`,
      [itemId]
    );

    const at = res.rows[0]?.captured_at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * Return how many items the newest poll holds.
   *
   * The poller compares its next payload against this, so a truncated upstream
   * answer cannot replace a full snapshot with a partial one.
   */
  static async latestPollSize(): Promise<number> {
    const res = await query<{ size: number }>(
      `SELECT count(*)::int AS size FROM price_snapshots
       WHERE captured_at = (SELECT MAX(captured_at) FROM price_snapshots)`
    );

    return res.rows[0]?.size ?? 0;
  }

  /**
   * Return when the newest snapshot carrying a usable ask was captured.
   *
   * A chart footer must stamp the series it drew, not the newest poll in the
   * table: an item whose sell order vanished three hours ago would otherwise
   * present an old price as the current one.
   */
  static async latestAskAt(itemId: number): Promise<Date | null> {
    const res = await query<{ captured_at: Date | null }>(
      `SELECT MAX(captured_at) AS captured_at
       FROM price_snapshots
       WHERE item_id = $1 AND ask IS NOT NULL AND ask > 0`,
      [itemId]
    );

    const at = res.rows[0]?.captured_at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * Return the capture time of the newest snapshot, or null when none exists.
   *
   * A consumer that fires an unsolicited message (an alert) must not act on a
   * feed that stopped hours ago.
   */
  static async latestSnapshotAt(): Promise<Date | null> {
    const res = await query<{ captured_at: Date | null }>(
      'SELECT MAX(captured_at) AS captured_at FROM price_snapshots'
    );

    const at = res.rows[0]?.captured_at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * Roll the completed days of the raw window up into one row per item per day.
   *
   * This is the only step that makes a price outlive the raw retention window.
   * A day that is already in `price_daily` is left alone, so re-running over the
   * whole window costs a scan and changes nothing.
   *
   * Open and close come from the ask, the side every other reader uses; a
   * snapshot without a usable ask is not a price and is not a sample. `ask_volume`
   * is order-book depth, not trade volume, so it is not summed into the day.
   */
  static async rollupCompleteDays(days: number): Promise<number> {
    const res = await query(
      `INSERT INTO price_daily (item_id, day, open, close, low, high, samples,
                               bid_open, bid_close, bid_low, bid_high, bid_samples)
       SELECT s.item_id,
              (s.captured_at AT TIME ZONE 'UTC')::date,
              (array_agg(s.ask ORDER BY s.captured_at ASC) FILTER (WHERE s.ask > 0))[1],
              (array_agg(s.ask ORDER BY s.captured_at DESC) FILTER (WHERE s.ask > 0))[1],
              MIN(s.ask) FILTER (WHERE s.ask > 0),
              MAX(s.ask) FILTER (WHERE s.ask > 0),
              COUNT(*) FILTER (WHERE s.ask > 0),
              (array_agg(s.bid ORDER BY s.captured_at ASC) FILTER (WHERE s.bid > 0))[1],
              (array_agg(s.bid ORDER BY s.captured_at DESC) FILTER (WHERE s.bid > 0))[1],
              MIN(s.bid) FILTER (WHERE s.bid > 0),
              MAX(s.bid) FILTER (WHERE s.bid > 0),
              COUNT(*) FILTER (WHERE s.bid > 0)
       FROM price_snapshots s
       WHERE s.captured_at >= now() - interval '1 day' * $1::int
         AND s.captured_at < (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         AND (s.ask > 0 OR s.bid > 0)
         AND NOT EXISTS (
               SELECT 1 FROM price_daily d
               WHERE d.item_id = s.item_id
                 AND d.day = (s.captured_at AT TIME ZONE 'UTC')::date
             )
       GROUP BY 1, 2
       ON CONFLICT (item_id, day) DO NOTHING`,
      [days]
    );

    const rolled = res.rowCount ?? 0;
    if (rolled > 0) logger.info('price days rolled up', { rows: rolled, windowDays: days });

    return rolled;
  }

  /**
   * Return the daily rollup of an item, oldest day first.
   *
   * The daily tier holds one row per item per UTC day, so a span longer than
   * the raw retention window is read from here. The window is the last `days`
   * completed days: today is left out, because a day only reaches the table
   * once it has closed.
   */
  static async dailyHistory(itemId: number, days: number): Promise<DailyPrice[]> {
    const res = await query<{
      day: Date | string;
      open: string | number | null;
      close: string | number | null;
      low: string | number | null;
      high: string | number | null;
      bid_close: string | number | null;
      samples: number;
    }>(
      `SELECT day, open, close, low, high, bid_close, samples
       FROM price_daily
       WHERE item_id = $1
         AND day >= (now() AT TIME ZONE 'UTC')::date - $2::int
         AND day < (now() AT TIME ZONE 'UTC')::date
       ORDER BY day ASC`,
      [itemId, days]
    );

    return res.rows.map((row) => ({
      day: toUtcDay(row.day),
      open: toNumber(row.open),
      close: toNumber(row.close),
      low: toNumber(row.low),
      high: toNumber(row.high),
      bidClose: toNumber(row.bid_close),
      samples: Number(row.samples),
    }));
  }

  /**
   * Delete the snapshots older than the cutoff and return how many were
   * removed.
   */
  static async pruneOlderThan(cutoff: Date): Promise<number> {
    const res = await query(
      `DELETE FROM price_snapshots s
       WHERE s.captured_at < $1
         AND EXISTS (
               SELECT 1 FROM price_daily d
               WHERE d.day = (s.captured_at AT TIME ZONE 'UTC')::date
             )`,
      [cutoff]
    );

    const deleted = res.rowCount ?? 0;
    logger.info('price snapshots pruned', { deleted, cutoff: cutoff.toISOString() });

    return deleted;
  }
}
