/**
 * The book detectors and their scoring, as pure functions.
 *
 * Nothing here touches the database, Discord or the network: a detector takes
 * the hourly series of one item and returns what fired. That is what makes the
 * whole feature testable with fixture rows, and what keeps a vendor outage out
 * of the posting path.
 *
 * Scoring is bounded so findings of different patterns are comparable:
 * `score = impact * significance * rarity`, all three in `[0,1]`.
 */
/** A scored finding, ready to be queued. */
/** The patterns this release ships. The trade side adds its own in a later release. */
export type PatternKey = 'dry_sell_side' | 'book_flipped' | 'pinned_at_edge';

export interface Finding {
  itemId: number;
  pattern: PatternKey;
  state: string | null;
  score: number;
  body: InsightBody;
  firedAt: Date;
  windowEnd: Date;
}

/** One closed hour of one item's book. */
export interface BookHour {
  hour: Date;
  ask: number | null;
  askLow: number | null;
  askHigh: number | null;
  bid: number | null;
  askVolume: number;
  bidVolume: number;
  samples: number;
}


/**
 * How much one firing of a pattern is worth, from its measured base rate:
 * `min(1, 3 / firings_per_day)`.
 *
 * Without this a background pattern that fires 50 times a day takes every slot,
 * because its findings are just as "significant" as a rare one. The rates come
 * from the 2026-11-27 measurement over 7 days of production data.
 */
export const PATTERN_RARITY: Record<PatternKey, number> = {
  dry_sell_side: 0.6,
  book_flipped: 0.29,
  pinned_at_edge: 0.06,
};

/** The body a formatter prints: the numbers the detector used, stored verbatim. */
export interface InsightBody {
  name: string;
  ask: number | null;
  hours?: number;
  lastOfferAt?: string;
  askWanted?: number;
  bidWanted?: number;
  prevAsk?: number;
  prevBid?: number;
  ratio?: number;
  weekChangePct?: number | null;
  direction?: 'ask_heavy' | 'bid_heavy' | 'high' | 'low';
  typical?: number | null;
  units?: number;
}

/** What a detector returns, before the cross-item impact is known. */
export interface Match {
  pattern: PatternKey;
  state: string | null;
  significance: number;
  body: InsightBody;
}

/** The shortest dry spell that counts: below it the feed blinks, it is not news. */
const DRY_MIN_HOURS = 12;

/** Hours of baseline every multi-day pattern needs before it may fire. */
const MIN_BASELINE_DAYS = 4;

/** A 24h move must reach this to be a candidate. */
const PINNED_MIN_MOVE = 0.25;

/** The previous six days must span at least this much, or "edge" is a flat line. */
const PINNED_MIN_WIDTH = 1.2;

/** The outer tenth of the previous range counts as the edge. */
const PINNED_EDGE = 0.1;

/** One hour, in milliseconds. */
const HOUR_MS = 3_600_000;

/** Keep a value inside `[0,1]`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The median of a non-empty list. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The median absolute deviation: the robust spread every significance uses. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}

/**
 * `|delta| / (1.4826 * MAD)`, or 1 when the baseline never moved.
 *
 * A series that has not changed in six days makes any move infinitely
 * surprising; the honest bounded answer is "maximally significant", not a
 * division by an epsilon.
 */
function robustZ(delta: number, baseline: number[]): number {
  const spread = mad(baseline);
  if (spread === 0) return 1;
  return Math.abs(delta) / (1.4826 * spread);
}

/** The UTC day of an hour, as `YYYY-MM-DD`. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** One calendar day of the book, summed from its hours. */
interface DayAgg {
  key: string;
  askVolume: number;
  bidVolume: number;
  askClose: number | null;
  askLow: number | null;
  askHigh: number | null;
}

/** Fold an ascending hourly series into UTC days. */
function aggregateDays(series: BookHour[]): DayAgg[] {
  const days = new Map<string, DayAgg>();
  for (const hour of series) {
    const key = dayKey(hour.hour);
    const day =
      days.get(key) ??
      { key, askVolume: 0, bidVolume: 0, askClose: null, askLow: null, askHigh: null };
    day.askVolume += hour.askVolume;
    day.bidVolume += hour.bidVolume;
    if (hour.ask !== null) day.askClose = hour.ask;
    if (hour.askLow !== null) day.askLow = day.askLow === null ? hour.askLow : Math.min(day.askLow, hour.askLow);
    if (hour.askHigh !== null) day.askHigh = day.askHigh === null ? hour.askHigh : Math.max(day.askHigh, hour.askHigh);
    days.set(key, day);
  }
  return [...days.values()];
}

/** The newest non-zero sell price of the series, or null. */
function lastAsk(series: BookHour[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].ask !== null) return series[i].ask;
  }
  return null;
}

/** `(bid - ask) / (bid + ask)`, or null when nothing is listed. */
function imbalance(day: DayAgg): number | null {
  const total = day.askVolume + day.bidVolume;
  return total === 0 ? null : (day.bidVolume - day.askVolume) / total;
}

/**
 * No sell offers: a run of `ask_volume = 0` hours that started after offers.
 *
 * The run must be contiguous in the series, so a collector gap can never be
 * read as "nobody is selling"; and it must have a last-offer hour, so an item
 * that has been empty since before the window is not a transition.
 */
export function detectDrySellSide(series: BookHour[]): Match | null {
  let hours = 0;
  let lastOfferAt: Date | null = null;

  for (let i = series.length - 1; i >= 0; i -= 1) {
    const hour = series[i];
    const next = series[i + 1];
    if (next && next.hour.getTime() - hour.hour.getTime() > HOUR_MS + 1) break;
    if (hour.samples === 0) break;
    if (hour.askVolume > 0) {
      lastOfferAt = hour.hour;
      break;
    }
    hours += 1;
  }

  if (hours < DRY_MIN_HOURS || lastOfferAt === null) return null;

  return {
    pattern: 'dry_sell_side',
    // "Off the board" is the same finding, phrased for a longer spell.
    state: hours >= 24 ? 'off_board' : 'dry',
    significance: clamp01(hours / 48),
    body: { name: '', ask: lastAsk(series), hours, lastOfferAt: lastOfferAt.toISOString() },
  };
}

/**
 * The two sides swapped against the item's own six-day median.
 *
 * Both today and the baseline must be clearly one-sided (`|I| >= 0.5`) and the
 * sign must flip; a mild swing inside the same side is noise.
 */
export function detectBookFlipped(series: BookHour[]): Match | null {
  const days = aggregateDays(series);
  if (days.length < MIN_BASELINE_DAYS + 1) return null;

  const today = days[days.length - 1];
  const previous = days.slice(0, -1).slice(-6);
  if (previous.length < MIN_BASELINE_DAYS) return null;

  const todayImbalance = imbalance(today);
  if (todayImbalance === null || Math.abs(todayImbalance) < 0.5) return null;

  const baseline = previous
    .map(imbalance)
    .filter((value): value is number => value !== null);
  if (baseline.length < MIN_BASELINE_DAYS) return null;

  const medPrev = median(baseline);
  if (Math.abs(medPrev) < 0.5) return null;
  if (Math.sign(todayImbalance) === Math.sign(medPrev)) return null;

  const prevAsk = previous.reduce((sum, day) => sum + day.askVolume, 0);
  const prevBid = previous.reduce((sum, day) => sum + day.bidVolume, 0);

  const todayKey = today.key;
  const hourly = series
    .filter((hour) => dayKey(hour.hour) !== todayKey)
    .map((hour) => {
      const total = hour.askVolume + hour.bidVolume;
      return total === 0 ? null : (hour.bidVolume - hour.askVolume) / total;
    })
    .filter((value): value is number => value !== null);
  const deltas = hourly.slice(1).map((value, index) => value - hourly[index]);

  const first = series[0]?.ask ?? null;
  const last = lastAsk(series);
  const weekChangePct =
    first !== null && last !== null && series.length >= 24 * 6 ? (last / first - 1) * 100 : null;

  return {
    pattern: 'book_flipped',
    state: todayImbalance > 0 ? 'bid_heavy' : 'ask_heavy',
    significance: clamp01(robustZ(todayImbalance - medPrev, deltas) / 4),
    body: {
      name: '',
      ask: lastAsk(series),
      askWanted: today.askVolume,
      bidWanted: today.bidVolume,
      prevAsk,
      prevBid,
      ratio: Math.round(
        Math.max(today.askVolume, today.bidVolume) / Math.max(1, Math.min(today.askVolume, today.bidVolume))
      ),
      weekChangePct,
      direction: todayImbalance > 0 ? 'bid_heavy' : 'ask_heavy',
    },
  };
}

/**
 * A move of 25% or more that ends in the outer tenth of the previous range.
 *
 * The width gate is what keeps a flat item with one tick from reading as a
 * seven-day high; the position gate keeps "it went up" out of the feed.
 */
export function detectPinnedAtEdge(series: BookHour[]): Match | null {
  const days = aggregateDays(series);
  if (days.length < MIN_BASELINE_DAYS + 1) return null;

  const today = days[days.length - 1];
  const previous = days.slice(0, -1).slice(-6);
  if (previous.length < MIN_BASELINE_DAYS) return null;

  const close = today.askClose;
  const prevClose = previous[previous.length - 1].askClose;
  const lows = previous.map((day) => day.askLow).filter((value): value is number => value !== null);
  const highs = previous.map((day) => day.askHigh).filter((value): value is number => value !== null);
  if (close === null || prevClose === null || lows.length < MIN_BASELINE_DAYS || highs.length < MIN_BASELINE_DAYS) {
    return null;
  }

  const low = Math.min(...lows);
  const high = Math.max(...highs);
  if (low <= 0 || high <= low) return null;

  const move = close / prevClose - 1;
  const width = high / low;
  const position = (close - low) / (high - low);
  if (Math.abs(move) < PINNED_MIN_MOVE) return null;
  if (width < PINNED_MIN_WIDTH) return null;
  if (position > PINNED_EDGE && position < 1 - PINNED_EDGE) return null;

  const todayKey = today.key;
  const asks = series
    .filter((hour) => dayKey(hour.hour) !== todayKey && hour.ask !== null)
    .map((hour) => hour.ask as number);
  const deltas = asks.slice(1).map((value, index) => value - asks[index]);
  const newest = series[series.length - 1]?.hour.getTime() ?? 0;
  const recent = series.filter((hour) => hour.hour.getTime() >= newest - 24 * HOUR_MS);
  const typical = recent.length > 0 ? median(recent.map((hour) => hour.ask).filter((v): v is number => v !== null)) : null;

  return {
    pattern: 'pinned_at_edge',
    state: position >= 1 - PINNED_EDGE ? 'high' : 'low',
    significance: clamp01(robustZ(close - prevClose, deltas) / 4),
    body: {
      name: '',
      ask: close,
      typical,
      units: series[series.length - 1]?.askVolume ?? 0,
      direction: position >= 1 - PINNED_EDGE ? 'high' : 'low',
    },
  };
}

/** Turn a match and its cross-item impact into a scored finding. */
export function toFinding(
  match: Match,
  itemId: number,
  impact: number,
  name: string,
  now: Date
): Finding {
  return {
    itemId,
    pattern: match.pattern,
    state: match.state,
    score: clamp01(impact) * clamp01(match.significance) * PATTERN_RARITY[match.pattern],
    body: { ...match.body, name },
    firedAt: now,
    windowEnd: now,
  };
}

/**
 * The top `limit` rows with at most one per pattern, then the runners-up.
 *
 * A post of three findings about one pattern reads like a broken bot, so the
 * first pass takes one leader per pattern; the second fills the remaining slots
 * from everything left, never twice for one item.
 */
export function pickDiverse<T extends { pattern: string; itemId: number }>(rows: T[], limit: number): T[] {
  const picked: T[] = [];
  const patterns = new Set<string>();
  const items = new Set<number>();

  for (const row of rows) {
    if (picked.length >= limit) return picked;
    if (patterns.has(row.pattern) || items.has(row.itemId)) continue;
    picked.push(row);
    patterns.add(row.pattern);
    items.add(row.itemId);
  }

  for (const row of rows) {
    if (picked.length >= limit) return picked;
    if (items.has(row.itemId)) continue;
    picked.push(row);
    items.add(row.itemId);
  }

  return picked;
}
