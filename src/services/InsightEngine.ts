/**
 * The book detector and its scoring, as pure functions.
 *
 * Nothing here touches the database, Discord or the network: the detector takes
 * the hourly series of one item and returns what fired. That is what makes the
 * feature testable with fixture rows, and what keeps a vendor outage out of the
 * posting path.
 *
 * Scoring is bounded so one finding can be ranked against another:
 * `score = impact * significance * rarity`, all three in `[0,1]`. Only the dry
 * sell side ships: the replay measured the flip and the range edge below the
 * SPEC's 90% persistence gate (`docs/DEFERRED.md` D21).
 */
/** A scored finding, ready to be queued. */
export type PatternKey = 'dry_sell_side';

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
 * because its findings are just as "significant" as a rare one. The rate comes
 * from the 2026-11-27 replay over 8 days of production data: 0.88 accepted
 * findings a day, which saturates the weight at 1.
 */
export const PATTERN_RARITY: Record<PatternKey, number> = {
  dry_sell_side: 1,
};

/** The body a formatter prints: the numbers the detector used, stored verbatim. */
export interface InsightBody {
  name: string;
  ask: number | null;
  hours?: number;
  lastOfferAt?: string;
}

/** What the detector returns, before the cross-item impact is known. */
export interface Match {
  pattern: PatternKey;
  state: string | null;
  significance: number;
  body: InsightBody;
}

/**
 * The shortest dry spell that counts.
 *
 * 12h was the first threshold, and the replay put it at 88% persistence: half the
 * misses were spells where an offer reappeared within six hours. A day is the
 * point where "nobody is selling" survives a reaction, so the finding is the
 * confirmed absence -- the card phrases it as off the board, never as a blink.
 */
const DRY_MIN_HOURS = 24;

/** One hour, in milliseconds. */
const HOUR_MS = 3_600_000;

/** Keep a value inside `[0,1]`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The newest non-zero sell price of the series, or null. */
function lastAsk(series: BookHour[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].ask !== null) return series[i].ask;
  }
  return null;
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
    state: 'off_board',
    significance: clamp01(hours / 48),
    body: { name: '', ask: lastAsk(series), hours, lastOfferAt: lastOfferAt.toISOString() },
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

/** The top `limit` rows, never twice for one item: a card repeats nothing. */
export function pickDiverse<T extends { itemId: number }>(rows: T[], limit: number): T[] {
  const picked: T[] = [];
  const items = new Set<number>();

  for (const row of rows) {
    if (picked.length >= limit) break;
    if (items.has(row.itemId)) continue;
    picked.push(row);
    items.add(row.itemId);
  }

  return picked;
}
