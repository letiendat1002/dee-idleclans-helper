import { getPricesLatest } from './IdleClansApi.js';
import { SnapshotStore } from './SnapshotStore.js';
import { createLogger } from '../utils/logger.js';
import { beat } from '../utils/heartbeat.js';

const logger = createLogger('MARKET');

/** Default cadence of the market snapshot: one poll every two minutes. */
const DEFAULT_INTERVAL_MS = 120_000;

/**
 * How long a raw snapshot row is kept.
 *
 * 30 days matches the longest window the upstream market still serves, so a day
 * the process missed can always be rebuilt. Anything older lives in
 * `price_daily`, which is never pruned.
 */
const RETENTION_DAYS = 30;

/** One day in milliseconds, the unit the retention cutoff is expressed in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the retention prune runs. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The share of the previous poll a payload must keep to be stored.
 *
 * A truncated upstream answer still parses, and storing it would make the next
 * poll report every missing item as "not on the market". The market has held
 * 625-632 items for a week, so a fifth missing is a broken answer, not a
 * market that shrank.
 */
const MIN_QUOTE_RATIO = 0.8;

/** Below this many items the newest poll is not a baseline worth trusting. */
const MIN_BASELINE_ITEMS = 100;

/**
 * One market quote for a single item.
 *
 * `ask` is the lowest sell price (what a buyer pays) and `bid` the highest buy
 * price (what a seller receives). The two sides are never derived from each
 * other: an ask and a bid are different quantities of the same market.
 *
 * Both `null` and `0` mean "no offer on this side" — the live market writes
 * `0` with volume `0` when there is no order — and neither is a price. The
 * normaliser keeps the raw value, but every consumer treats both as "no offer".
 */
export interface MarketQuote {
  itemId: number;
  ask: number | null;
  bid: number | null;
  askVolume: number | null;
  bidVolume: number | null;
}

/**
 * Read one price field of a market entry.
 *
 * `null` and a missing field both mean "no offer on this side"; a live `0` means
 * the same thing and is stored raw, so every consumer has to treat `0` as
 * missing rather than as a price (CONVENTIONS §3.1).
 */
function readPrice(value: unknown, field: string, itemId: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`market payload has a non-numeric ${field} for item ${itemId}`);
  }
  return value;
}

/**
 * Read the item id of an entry, falling back to the key of the keyed record.
 *
 * The market sends the id 0 for one of its rows, so only a negative id is
 * rejected.
 */
function readItemId(fields: Record<string, unknown>, key: string | undefined): number {
  const candidate = fields.itemId ?? (key === undefined ? undefined : Number(key));
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    throw new Error(`market payload has an invalid item id: ${String(candidate)}`);
  }
  return candidate;
}

/** Reject an entry that is not an object of price fields. */
function readEntry(entry: unknown, label: string): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`market payload entry ${label} is not an object`);
  }
  return entry as Record<string, unknown>;
}

/** Tell a plain object apart from an array and from a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Map the market entries to quotes, rejecting a payload that does not match
 * the schema.
 */
function normalizeEntries(entries: Array<{ key: string | undefined; entry: unknown }>): MarketQuote[] {
  if (entries.length === 0) {
    throw new Error('market payload has no market entries');
  }

  return entries.map(({ key, entry }, index) => {
    const fields = readEntry(entry, key ?? `#${index}`);
    const itemId = readItemId(fields, key);

    return {
      itemId,
      ask: readPrice(fields.lowestSellPrice, 'lowestSellPrice', itemId),
      bid: readPrice(fields.highestBuyPrice, 'highestBuyPrice', itemId),
      askVolume: readPrice(fields.lowestPriceVolume, 'lowestPriceVolume', itemId),
      bidVolume: readPrice(fields.highestPriceVolume, 'highestPriceVolume', itemId),
    };
  });
}

/**
 * Normalise a `/PlayerMarket/items/prices/latest` payload into quotes.
 *
 * Accepts the raw array the public API returns and the keyed record
 * `getPricesLatest()` builds from it. Throws when the payload does not match
 * the schema: a malformed payload must never reach the snapshot store, it
 * would replace good prices with zeroes.
 */
export function normalizePricesLatest(raw: unknown): MarketQuote[] {
  if (Array.isArray(raw)) {
    return normalizeEntries(raw.map((entry) => ({ key: undefined, entry })));
  }
  if (isRecord(raw)) {
    return normalizeEntries(Object.entries(raw).map(([key, entry]) => ({ key, entry })));
  }
  throw new Error('market payload is neither an array nor a record of prices');
}

/**
 * Poll the market and keep the price snapshots.
 */
export class MarketService {
  private static timer: NodeJS.Timeout | null = null;
  private static pruneTimer: NodeJS.Timeout | null = null;
  private static polling = false;
  private static lastCapturedAt: Date | null = null;

  /**
   * Poll the market once and store the result.
   *
   * A payload that fails validation is discarded: the previous snapshot stays
   * in place and is returned instead, because a malformed payload must not
   * zero out the prices the alert engine compares against. The returned
   * timestamp is then the capture time of that previous snapshot, so the
   * quotes and the timestamp describe the same poll.
   *
   * After a process restart no capture time is remembered yet, so the first
   * failed poll returns the previous quotes with the attempt time.
   */
  static async pollOnce(): Promise<{ quotes: MarketQuote[]; capturedAt: Date }> {
    const capturedAt = new Date();

    let raw: unknown;
    try {
      raw = await getPricesLatest();
    } catch (err) {
      logger.error('market poll failed: the market API request failed, keeping the previous snapshot', {
        error: err instanceof Error ? err.message : String(err),
      });
      return MarketService.previousSnapshot(capturedAt);
    }

    let quotes: MarketQuote[];
    try {
      quotes = normalizePricesLatest(raw);
    } catch (err) {
      logger.error('market poll failed: the market payload failed validation, keeping the previous snapshot', {
        error: err instanceof Error ? err.message : String(err),
      });
      return MarketService.previousSnapshot(capturedAt);
    }

    const previousSize = await SnapshotStore.latestPollSize();
    if (previousSize >= MIN_BASELINE_ITEMS && quotes.length < previousSize * MIN_QUOTE_RATIO) {
      logger.error('market poll failed: the payload lost items, keeping the previous snapshot', {
        got: quotes.length,
        previous: previousSize,
      });
      return MarketService.previousSnapshot(capturedAt);
    }

    await SnapshotStore.append(quotes, capturedAt);
    MarketService.lastCapturedAt = capturedAt;
    logger.info('market snapshot stored', {
      quotes: quotes.length,
      capturedAt: capturedAt.toISOString(),
    });

    return { quotes, capturedAt };
  }

  /**
   * Return the quotes of the last stored snapshot.
   *
   * The capture time is the one of the last successful poll; after a process
   * restart there is none yet, so the attempt time is used instead.
   */
  private static async previousSnapshot(capturedAt: Date): Promise<{ quotes: MarketQuote[]; capturedAt: Date }> {
    const previous = await SnapshotStore.latestQuotes();
    return {
      quotes: [...previous.values()],
      capturedAt: MarketService.lastCapturedAt ?? capturedAt,
    };
  }

  /**
   * Start the market poll: one poll now, then one per interval.
   *
   * The first poll is fired without being awaited, so the caller never blocks
   * on a slow API round-trip. A poll that is still running when the next one
   * is due is skipped, so the polls cannot stack up.
   */
  static async start(intervalMs = DEFAULT_INTERVAL_MS): Promise<void> {
    MarketService.clearTimer();
    MarketService.timer = setInterval(() => {
      void MarketService.runPoll().finally(beat);
    }, intervalMs);
    void MarketService.runPoll().finally(beat);
    beat();

    MarketService.pruneTimer = setInterval(() => {
      void MarketService.housekeeping();
    }, PRUNE_INTERVAL_MS);
    void MarketService.housekeeping();

    logger.info(`market poller started, interval ${intervalMs / 1000}s`);
  }

  /** Stop the market poll. */
  static async stop(): Promise<void> {
    MarketService.clearTimer();
  }

  /** Run one poll, unless the previous one is still running. */
  private static async runPoll(): Promise<void> {
    if (MarketService.polling) {
      logger.warn('market poll skipped, the previous poll is still running');
      return;
    }

    MarketService.polling = true;
    try {
      await MarketService.pollOnce();
    } catch (err) {
      logger.error('market poll failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      MarketService.polling = false;
    }
  }

  /** Clear the interval timer, if one is running. */
  private static clearTimer(): void {
    if (MarketService.timer) {
      clearInterval(MarketService.timer);
      MarketService.timer = null;
    }
    if (MarketService.pruneTimer) {
      clearInterval(MarketService.pruneTimer);
      MarketService.pruneTimer = null;
    }
  }

  /**
   * Preserve the finished days, then trim the raw window.
   *
   * The rollup runs first: a day that is about to leave the retention window
   * must reach `price_daily` before its raw rows are deleted. Each step is
   * guarded on its own, so a failed rollup never skips the prune and neither
   * one can take the poller down with it.
   */
  private static async housekeeping(): Promise<void> {
    try {
      await SnapshotStore.rollupCompleteDays(RETENTION_DAYS);
    } catch (err) {
      logger.warn('price rollup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await SnapshotStore.pruneOlderThan(new Date(Date.now() - RETENTION_DAYS * DAY_MS));
    } catch (err) {
      logger.warn('snapshot prune failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
