/**
 * The hourly rollup of the order book.
 *
 * Raw snapshots are pruned at `RETENTION_DAYS` (30), so without this table the
 * book patterns would have no memory longer than a month. Every run recomputes
 * the last 48 closed hours and upserts: a process that was down across `:59`
 * must be able to rebuild the hour it missed, and a recomputed hour must not
 * double-count.
 *
 * The first run backfills the whole raw window, so the detector has the hours
 * before a dry spell instead of only the spell itself.
 */
import { query } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('BOOK-ROLLUP');

/** Hours recomputed on every run: enough to repair a restart that crossed an hour boundary. */
const RECENT_HOURS = 48;

/** Days of raw snapshots the first run converts, matching `RETENTION_DAYS`. */
const BACKFILL_DAYS = 30;

/** A price side may be zero in the feed; zero means "no offer", never a price. */
const POSITIVE = 'FILTER (WHERE ask > 0)';

export class BookRollup {
  /**
   * Roll the closed hours up into `book_hourly` and report the span written.
   *
   * `done` is false when the caller may skip: the newest rolled hour is already
   * the last closed one, so the job does not rewrite 48 hours every five
   * minutes.
   */
  static async run(now = new Date()): Promise<{ done: boolean; hours: number }> {
    const lastClosed = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
    );
    const newest = (await query<{ hour: Date | null }>(
      'SELECT max(hour) AS hour FROM book_hourly'
    )).rows[0]?.hour ?? null;

    if (newest !== null && new Date(newest).getTime() >= lastClosed.getTime() - 3_600_000) {
      return { done: false, hours: 0 };
    }

    const hours = newest === null ? BACKFILL_DAYS * 24 : RECENT_HOURS;
    const from = new Date(lastClosed.getTime() - hours * 3_600_000);

    const res = await query(
      `INSERT INTO book_hourly
         (item_id, hour, ask, ask_low, ask_high, bid, ask_volume, bid_volume, samples)
       SELECT item_id,
              date_trunc('hour', captured_at)                                      AS hour,
              (array_agg(ask ORDER BY captured_at DESC) ${POSITIVE})[1]            AS ask,
              min(ask) ${POSITIVE}                                                 AS ask_low,
              max(ask) ${POSITIVE}                                                 AS ask_high,
              (array_agg(bid ORDER BY captured_at DESC) FILTER (WHERE bid > 0))[1] AS bid,
              COALESCE(max(ask_volume) FILTER (WHERE ask > 0), 0)                  AS ask_volume,
              COALESCE(max(bid_volume) FILTER (WHERE bid > 0), 0)                  AS bid_volume,
              count(*)                                                             AS samples
       FROM price_snapshots
       WHERE captured_at >= $1 AND captured_at < $2
       GROUP BY item_id, date_trunc('hour', captured_at)
       ON CONFLICT (item_id, hour) DO UPDATE SET
         ask = EXCLUDED.ask,
         ask_low = EXCLUDED.ask_low,
         ask_high = EXCLUDED.ask_high,
         bid = EXCLUDED.bid,
         ask_volume = EXCLUDED.ask_volume,
         bid_volume = EXCLUDED.bid_volume,
         samples = EXCLUDED.samples`,
      [from, lastClosed]
    );

    const rows = (res as { rowCount: number | null }).rowCount ?? 0;
    logger.info('book rollup written', { hours, rows });
    return { done: true, hours };
  }
}
