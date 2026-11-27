/**
 * The `insights` queue: produce findings from the hourly book, then hand the
 * best ones to a channel.
 *
 * The producer never posts and the consumer never computes, so a Discord outage
 * cannot lose a finding and a vendor outage cannot break a post. Everything the
 * formatter prints was scored here and stored in `body`.
 */
import { query } from '../db/pool.js';
import {
  detectBookFlipped,
  detectDrySellSide,
  detectPinnedAtEdge,
  pickDiverse,
  toFinding,
  type BookHour,
  type Finding,
  type InsightBody,
} from './InsightEngine.js';

/** The hourly history every book detector may read: today plus six baseline days. */
const WINDOW_MS = 7 * 24 * 3_600_000;

/** One hour, in milliseconds. */
const HOUR_MS = 3_600_000;

/** How long an item stays quiet after being reported for one pattern. */
const COOLDOWN_MS = 72 * 3_600_000;

/** A queued finding that never earned a slot in a day is not news any more. */
const QUEUE_TTL = '24 hours';

/** How many queued rows one claim considers before the diversity pick. */
const MAX_CANDIDATES = 30;

/** The fewest snapshots an item needs in 24h to be eligible. */
const MIN_SAMPLES = 30;

/** The fewest hours with data an item needs in 24h to be eligible. */
const MIN_HOURS = 12;

/** A row of `book_hourly` as Postgres returns it. */
interface HourRow {
  item_id: number;
  hour: Date | string;
  ask: string | number | null;
  ask_low: string | number | null;
  ask_high: string | number | null;
  bid: string | number | null;
  ask_volume: string | number;
  bid_volume: string | number;
  samples: number;
}

/** A queued row as Postgres returns it. */
interface QueuedRow {
  id: string | number;
  item_id: string | number;
  pattern: string;
  state: string | null;
  score: string | number;
  body: InsightBody | string;
  fired_at: Date | string;
  window_end: Date | string;
}

/** A queued finding with its row id. */
export interface Insight extends Finding {
  id: string;
}

/** Numbers arrive as strings from pg for numeric/bigint columns. */
function num(value: string | number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Turn a queued row into the finding the formatter reads. */
function toInsight(row: QueuedRow): Insight {
  const body = typeof row.body === 'string' ? (JSON.parse(row.body) as InsightBody) : row.body;
  return {
    id: String(row.id),
    itemId: Number(row.item_id),
    pattern: row.pattern as Insight['pattern'],
    state: row.state,
    score: Number(row.score),
    body,
    firedAt: new Date(row.fired_at as string | Date),
    windowEnd: new Date(row.window_end as string | Date),
  };
}

export class InsightStore {
  /** The newest hour already scanned by this process, so a 5-minute tick does not rescan an hour. */
  private static scannedHour: string | null = null;

  /**
   * Run the book detectors over the newest closed hour and queue what fired.
   *
   * Returns `{ scanned: false }` when this process already scanned that hour:
   * the book only changes when an hour closes, so rescanning it would rewrite
   * the same findings twelve times.
   */
  static async produce(now = new Date()): Promise<{ scanned: boolean; queued: number }> {
    const newest = (await query<{ hour: Date | null }>('SELECT max(hour) AS hour FROM book_hourly')).rows[0]
      ?.hour ?? null;
    if (newest === null) return { scanned: false, queued: 0 };

    const newestKey = new Date(newest).toISOString();
    if (InsightStore.scannedHour === newestKey) return { scanned: false, queued: 0 };
    InsightStore.scannedHour = newestKey;

    const from = new Date(now.getTime() - WINDOW_MS);
    const [hours, names] = await Promise.all([
      query<HourRow>(
        `SELECT item_id, hour, ask, ask_low, ask_high, bid, ask_volume, bid_volume, samples
         FROM book_hourly WHERE hour >= $1 ORDER BY item_id, hour`,
        [from]
      ),
      query<{ id: number; name: string }>('SELECT id, name FROM items WHERE tradeable'),
    ]);

    const nameById = new Map(names.rows.map((row) => [Number(row.id), row.name]));
    const seriesById = new Map<number, BookHour[]>();
    for (const row of hours.rows) {
      const itemId = Number(row.item_id);
      const hour: BookHour = {
        hour: new Date(row.hour as string | Date),
        ask: num(row.ask),
        askLow: num(row.ask_low),
        askHigh: num(row.ask_high),
        bid: num(row.bid),
        askVolume: Number(row.ask_volume),
        bidVolume: Number(row.bid_volume),
        samples: Number(row.samples),
      };
      const series = seriesById.get(itemId);
      if (series) series.push(hour);
      else seriesById.set(itemId, [hour]);
    }

    // Eligibility and impact share one pass: an item is eligible when it has
    // enough coverage in 24h, and its impact is its volume rank among peers.
    const dayAgo = now.getTime() - 24 * HOUR_MS;
    const eligible: Array<{ itemId: number; series: BookHour[]; volume: number; impact: number }> = [];
    for (const [itemId, series] of seriesById) {
      if (!nameById.has(itemId)) continue;
      const recent = series.filter((hour) => hour.hour.getTime() >= dayAgo);
      if (recent.length < MIN_HOURS) continue;
      const samples = recent.reduce((sum, hour) => sum + hour.samples, 0);
      if (samples < MIN_SAMPLES) continue;
      const volume = recent.reduce((sum, hour) => sum + hour.askVolume, 0);
      eligible.push({ itemId, series, volume, impact: 0 });
    }

    const ranked = [...eligible].sort((a, b) => b.volume - a.volume);
    const denominator = Math.max(1, ranked.length - 1);
    ranked.forEach((entry, index) => {
      entry.impact = (denominator - index) / denominator;
    });

    let queued = 0;
    for (const entry of eligible) {
      const name = nameById.get(entry.itemId) ?? '';
      const matches = [
        detectDrySellSide(entry.series),
        detectBookFlipped(entry.series),
        detectPinnedAtEdge(entry.series),
      ].filter((match) => match !== null);

      for (const match of matches) {
        const finding = toFinding(match, entry.itemId, entry.impact, name, now);
        const inserted = await InsightStore.insert(finding);
        if (inserted) queued += 1;
      }
    }

    return { scanned: true, queued };
  }

  /**
   * Queue one finding unless the item is still cooling down for this pattern.
   *
   * The partial unique index keeps one pending row per item and pattern; the
   * cooldown keeps a reported item out of the feed for three days.
   */
  private static async insert(finding: Finding): Promise<boolean> {
    const res = await query(
      `INSERT INTO insights (item_id, pattern, state, score, body, fired_at, window_end)
       SELECT $1, $2, $3, $4, $5::jsonb, $6, $7
       WHERE NOT EXISTS (
         SELECT 1 FROM insights
         WHERE item_id = $1 AND pattern = $2 AND status = 'sent'
           AND sent_at > NOW() - make_interval(secs => $8::double precision / 1000)
       )
       ON CONFLICT (pattern, item_id) WHERE status = 'queued' DO NOTHING`,
      [
        finding.itemId,
        finding.pattern,
        finding.state,
        finding.score,
        JSON.stringify(finding.body),
        finding.firedAt,
        finding.windowEnd,
        COOLDOWN_MS,
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Claim the best few queued findings for one channel.
   *
   * The rows are marked sent before the post, so two channels can never post
   * the same finding; a failed post loses it, which is better than a duplicate.
   */
  static async claim(channelId: string, limit = 3): Promise<Insight[]> {
    const res = await query<QueuedRow>(
      `SELECT id, item_id, pattern, state, score, body, fired_at, window_end
       FROM insights
       WHERE status = 'queued' AND fired_at > NOW() - INTERVAL '${QUEUE_TTL}'
       ORDER BY score DESC, fired_at
       LIMIT ${MAX_CANDIDATES}`
    );

    const picked = pickDiverse(res.rows.map(toInsight), limit);
    if (picked.length === 0) return [];

    await query(
      `UPDATE insights SET status = 'sent', sent_at = NOW(), channel_id = $1
       WHERE id = ANY($2::bigint[]) AND status = 'queued'`,
      [channelId, picked.map((row) => row.id)]
    );

    return picked;
  }

  /** Drop queued findings that did not earn a slot within a day. */
  static async expire(): Promise<number> {
    const res = (await query(
      `DELETE FROM insights WHERE status = 'queued' AND fired_at < NOW() - INTERVAL '${QUEUE_TTL}'`
    )) as { rowCount: number | null };
    return res.rowCount ?? 0;
  }

  /** Queued findings still waiting, for the diagnostic log line. */
  static async queuedCount(): Promise<number> {
    const res = await query<{ count: string }>(
      "SELECT count(*) AS count FROM insights WHERE status = 'queued'"
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
