import { createLogger } from '../utils/logger.js';
import { cacheService } from '../cache/CacheService.js';

const BASE = process.env.IDLECLANS_API_BASE ?? 'https://query.idleclans.com/api';
const CLIENT_ID = process.env.IDLECLANS_CLIENT_ID;

const logger = createLogger('API');

/**
 * Abort a request that hangs, so the poll loop can never wedge.
 *
 * shortcut: one budget for every endpoint; give an endpoint its own timeout only if one really
 * needs more than 30 s.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The per-item averages answer in about a second; a slow one must not hold a
 * slash command open, because the card is already complete without it.
 */
const AVERAGES_TIMEOUT_MS = 8_000;

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

export interface PriceEntry {
  itemId: number;
  lowestSellPrice?: number;
  lowestPriceVolume?: number;
  highestBuyPrice?: number;
  highestPriceVolume?: number;
}

export class IdleClansApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly rateLimit?: RateLimitInfo | null
  ) {
    super(message);
    this.name = 'IdleClansApiError';
  }
}

function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = headers.get('X-RateLimit-Limit');
  const remaining = headers.get('X-RateLimit-Remaining');
  const reset = headers.get('X-RateLimit-Reset');
  if (!limit || !remaining || !reset) return null;
  return {
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    reset: parseInt(reset, 10),
  };
}

export async function get<T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const headers: HeadersInit = {
    Accept: 'application/json',
  };
  if (CLIENT_ID) {
    (headers as Record<string, string>)['ClientId'] = CLIENT_ID;
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rateLimit = parseRateLimit(res.headers);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(`API ${res.status} for ${path}`, { body, rateLimit });
    throw new IdleClansApiError(
      `Idle Clans API ${res.status} for ${path}: ${body}`,
      res.status,
      rateLimit
    );
  }

  return (await res.json()) as T;
}

/** One row of the `/Items/metadata` payload. */
export interface ItemMetadata {
  id: number | string;
  name?: string;
  tradeable?: boolean;
}

export async function getItemsMetadata(): Promise<ItemMetadata[]> {
  return get<ItemMetadata[]>('/Items/metadata');
}

export async function getPricesLatest(): Promise<Record<string, PriceEntry>> {
  const arr = await get<PriceEntry[]>('/PlayerMarket/items/prices/latest');
  const map: Record<string, PriceEntry> = {};
  for (const entry of arr) {
    map[String(entry.itemId)] = entry;
  }
  return map;
}

export async function getMarketSettings(): Promise<unknown> {
  return get<unknown>('/Configuration/market-settings');
}

/** One entry of the public clan log of a clan. */
export interface ClanLogEntry {
  clanName: string;
  memberUsername: string;
  message: string;
  timestamp: string;
}

/** The most entries one clan-log request may ask for. */
const MAX_CLAN_LOG_LIMIT = 500;

/**
 * Read the public clan log of a clan.
 *
 * The endpoint needs no authentication and the game keeps fourteen days of
 * entries in it, batched: an entry can appear up to half an hour after it
 * happened. A clan that does not exist answers 404, which is an empty log and
 * not an error — the caller polls a clan name a player typed.
 */
export async function getClanLogs(clanName: string, limit = 100): Promise<ClanLogEntry[]> {
  const asked = Math.min(Math.max(1, Math.floor(limit)), MAX_CLAN_LOG_LIMIT);
  const path = `/Clan/logs/clan/${encodeURIComponent(clanName)}?limit=${asked}&skip=0`;

  try {
    const payload = await get<ClanLogEntry[]>(path);
    return Array.isArray(payload) ? payload : [];
  } catch (err) {
    if (err instanceof IdleClansApiError && err.status === 404) {
      logger.info('clan log not found', { clanName });
      return [];
    }
    throw err;
  }
}

export async function getGameData(): Promise<unknown> {
  return get<unknown>('/Configuration/game-data?minVersion=0');
}

export async function getBuildVersions(): Promise<{
  requiredBuildVersion: string;
  latestBuildVersion: string;
  configVersion: number;
}> {
  return get('/Configuration/build-versions');
}

/** The game's own trade-price averages for one item, over its own windows. */
export interface PriceAverages {
  avg1d: number | null;
  avg7d: number | null;
  avg30d: number | null;
  tradeVolume1d: number | null;
}

/** Read a numeric field, treating anything else as absent. */
function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The trade-price averages the game publishes for one item (1, 7 and 30 days).
 *
 * A trade average is not an ask: it is the mean of prices that actually traded,
 * so a surface must label it as a trade average and never compare it with an
 * ask. Returns `null` when the payload carries none of the three windows.
 */
export async function getPriceAverages(
  itemId: number,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<PriceAverages | null> {
  const payload = await get<Record<string, unknown>>(
    `/PlayerMarket/items/prices/latest/comprehensive/${itemId}`,
    timeoutMs
  );

  const averages: PriceAverages = {
    avg1d: readOptionalNumber(payload.averagePrice1Day),
    avg7d: readOptionalNumber(payload.averagePrice7Days),
    avg30d: readOptionalNumber(payload.averagePrice30Days),
    tradeVolume1d: readOptionalNumber(payload.tradeVolume1Day),
  };

  if (averages.avg1d === null && averages.avg7d === null && averages.avg30d === null) return null;
  return averages;
}

/** The four windows the game publishes trade history for. */
export type HistoryPeriod = '1d' | '7d' | '30d' | '1y';

/** One bucket of the game's published trade history. */
export interface TradeHistoryRow {
  /** Bucket start, epoch ms. */
  at: number;
  /** Average traded price in the bucket. */
  avg: number | null;
  /** Lowest trade price in the bucket; the vendor spells the field `lowesSellPrice`. */
  low: number | null;
  /** Highest trade price in the bucket. */
  high: number | null;
  /** Units traded in the bucket. */
  volume: number | null;
}

/**
 * The game's own trade history for one item, bucketed by window.
 *
 * The bucket size is the endpoint's, not ours: 30 minutes over a day, 6 hours
 * over a week, a day over a month, a week over a year. It is also the only
 * window that reaches back past a month, which is why the year view is weekly.
 * A bucket in which nothing traded is absent from the payload rather than zero.
 */
export async function getTradeHistory(
  itemId: number,
  period: HistoryPeriod,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<TradeHistoryRow[] | null> {
  const payload = await get<unknown>(`/PlayerMarket/items/prices/history/${itemId}?period=${period}`, timeoutMs);
  if (!Array.isArray(payload)) return null;

  const rows: TradeHistoryRow[] = [];
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    rows.push({
      at,
      avg: readOptionalNumber(row.averagePrice),
      low: readOptionalNumber(row.lowesSellPrice),
      high: readOptionalNumber(row.highestSellPrice),
      volume: readOptionalNumber(row.tradeVolume),
    });
  }

  return rows;
}

/**
 * How long one item's history is reused, in seconds.
 *
 * The window itself sets the pace: a 30-minute bucket changes every half hour,
 * a weekly bucket does not change within an evening. Caching to the bucket
 * keeps a burst of `/graph` from spending the poller's upstream budget.
 */
const HISTORY_TTL_S: Record<HistoryPeriod, number> = {
  '1d': 120,
  '7d': 600,
  '30d': 1800,
  '1y': 7200,
};

/** Upstream history calls one minute may spend, kept apart from the averages budget. */
const HISTORY_CALLS_PER_MINUTE = 10;

let historyWindowStart = 0;
let historyWindowCalls = 0;

/**
 * The trade history of one item, from the cache or upstream.
 *
 * Never throws: a chart that cannot be drawn is one line of text, not a failed
 * command. A spent budget answers `null` instead of waiting, so `/graph` cannot
 * starve the snapshot feed.
 */
export async function getTradeHistoryCached(
  itemId: number,
  period: HistoryPeriod
): Promise<TradeHistoryRow[] | null> {
  const key = `dee:history:${itemId}:${period}`;
  const cached = await cacheService.get<TradeHistoryRow[]>(key);
  if (cached !== null) return cached;

  const now = Date.now();
  if (now - historyWindowStart >= 60_000) {
    historyWindowStart = now;
    historyWindowCalls = 0;
  }
  if (historyWindowCalls >= HISTORY_CALLS_PER_MINUTE) {
    logger.warn('trade history skipped: the minute budget is spent', { itemId, period });
    return null;
  }
  historyWindowCalls += 1;

  try {
    const rows = await getTradeHistory(itemId, period);
    if (rows !== null) await cacheService.set(key, rows, HISTORY_TTL_S[period]);
    return rows;
  } catch (err) {
    logger.warn('trade history unavailable', {
      itemId,
      period,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** How long one item's trade averages are reused, in seconds. */
const AVERAGES_TTL_S = 300;

/**
 * Upstream calls the averages may spend in one minute.
 *
 * The game allows 50 requests/min per IP, and the poller needs its share: a
 * burst of `/price` must never take the snapshot feed's budget, because every
 * other surface reads that feed. The budget is process-local, which is sound
 * while exactly one bot process exists.
 */
const AVERAGES_CALLS_PER_MINUTE = 20;

let averagesWindowStart = 0;
let averagesWindowCalls = 0;

/**
 * The trade averages of one item, from the five-minute cache or upstream.
 *
 * Never throws: a missing average is one line the card leaves out, not a card
 * that fails. A spent budget answers `null` instead of waiting, so the poller's
 * share of the upstream limit is safe.
 */
export async function getPriceAveragesCached(itemId: number): Promise<PriceAverages | null> {
  const key = `dee:averages:${itemId}`;

  const cached = await cacheService.get<PriceAverages>(key);
  if (cached !== null) return cached;

  const now = Date.now();
  if (now - averagesWindowStart >= 60_000) {
    averagesWindowStart = now;
    averagesWindowCalls = 0;
  }
  if (averagesWindowCalls >= AVERAGES_CALLS_PER_MINUTE) {
    logger.warn('trade averages skipped: the minute budget is spent', { itemId });
    return null;
  }
  averagesWindowCalls += 1;

  try {
    const averages = await getPriceAverages(itemId, AVERAGES_TIMEOUT_MS);
    if (averages !== null) await cacheService.set(key, averages, AVERAGES_TTL_S);
    return averages;
  } catch (err) {
    logger.warn('trade averages unavailable: the card shows the snapshot alone', {
      itemId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
