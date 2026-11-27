/**
 * Replay the retained book through the shipped detector and print the numbers
 * the calibration gate asks for (`tasks/market-insights/SPEC.md`): firings per
 * day, and the share of firings whose reported state still holds six hours
 * later. Anything below 90% persistence is tuned or not shipped.
 *
 * Two patterns were measured here and removed: the flip held 80% and the range
 * edge 84% of the time, so neither ships (`docs/DEFERRED.md`).
 *
 * Read-only by construction: it reads a JSONL export and opens no connection.
 * Produce the export from a host that owns the database (no write, no port):
 *
 *   ssh <host> "docker exec -i <postgres> psql -U idleclans -d idleclans -At -f -" \
 *     < export.sql > book-hourly.jsonl
 *   npx tsx scripts/insight-replay.ts book-hourly.jsonl [--days 8]
 *
 * The export is one JSON object per line: item_id, name, hour, ask, ask_low,
 * ask_high, bid, ask_volume, bid_volume, samples -- the same aggregate
 * `BookRollup` writes into `book_hourly`, grouped per hour.
 *
 * "Persistence" is the honest measure the spec chose over prediction: did the
 * state the card claimed still hold six hours later? A dry sell side must still
 * have no offers. A firing with too little data at +6h is counted as unverified,
 * never as a pass.
 */
import fs from 'node:fs';

import {
  PATTERN_RARITY,
  detectDrySellSide,
  type BookHour,
  type Match,
  type PatternKey,
} from '../src/services/InsightEngine.js';

const HOUR_MS = 3_600_000;

/** The trailing window the detector is handed, matching `InsightStore.WINDOW_MS`. */
const WINDOW_MS = 7 * 24 * HOUR_MS;

/** Eligibility, matching `InsightStore.MIN_HOURS` and `MIN_SAMPLES`. */
const MIN_HOURS = 12;
const MIN_SAMPLES = 30;

/** How long one item stays quiet for one pattern, matching `InsightStore.COLDOWN_MS`. */
const COOLDOWN_MS = 72 * HOUR_MS;

/** The spec's persistence horizon. */
const PERSIST_MS = 6 * HOUR_MS;

/** The spec's gate. */
const TARGET_PERSISTENCE = 0.9;

/** One line of the export. */
interface ExportRow {
  item_id: number;
  name: string;
  hour: string;
  ask: number | null;
  ask_low: number | null;
  ask_high: number | null;
  bid: number | null;
  ask_volume: number;
  bid_volume: number;
  samples: number;
}

/** What the pattern did over the replayed window. */
interface Stat {
  raw: number;
  accepted: number;
  held: number;
  missed: number;
  unverified: number;
  /** The same three counters, only for firings that earn a slot after the cooldown. */
  acceptedHeld: number;
  acceptedMissed: number;
  acceptedUnverified: number;
}

/** A finding's outcome six hours later. */
type Outcome = 'held' | 'missed' | 'unverified';

/** Read the export into one ascending hourly series per item. */
function load(file: string): Map<number, BookHour[]> {
  const byItem = new Map<number, BookHour[]>();
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  for (const line of lines) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as ExportRow;
    const hour: BookHour = {
      hour: new Date(row.hour),
      ask: row.ask === null ? null : Number(row.ask),
      askLow: row.ask_low === null ? null : Number(row.ask_low),
      askHigh: row.ask_high === null ? null : Number(row.ask_high),
      bid: row.bid === null ? null : Number(row.bid),
      askVolume: Number(row.ask_volume),
      bidVolume: Number(row.bid_volume),
      samples: Number(row.samples),
    };
    const series = byItem.get(row.item_id);
    if (series) series.push(hour);
    else byItem.set(row.item_id, [hour]);
  }

  for (const series of byItem.values()) series.sort((a, b) => a.hour.getTime() - b.hour.getTime());
  return byItem;
}

/** Whether the state the card claimed still held six hours later. */
function outcome(match: Match, series: BookHour[], firingAt: Date): Outcome {
  if (match.pattern !== 'dry_sell_side') return 'unverified';

  // Every hour between the firing and +6h must have no sell offer, and at least
  // five of the six must exist: a gap is not a confirmation.
  const later = firingAt.getTime() + PERSIST_MS;
  const between = series.filter(
    (hour) => hour.hour.getTime() > firingAt.getTime() && hour.hour.getTime() <= later
  );
  if (between.length < 5) return 'unverified';
  return between.every((hour) => hour.askVolume === 0) ? 'held' : 'missed';
}

/** A zeroed counter set. */
function blank(): Stat {
  return {
    raw: 0,
    accepted: 0,
    held: 0,
    missed: 0,
    unverified: 0,
    acceptedHeld: 0,
    acceptedMissed: 0,
    acceptedUnverified: 0,
  };
}

/** Replay every closed hour of the measured window. */
function replay(byItem: Map<number, BookHour[]>, hours: number[], measuredFrom: number): Map<PatternKey, Stat> {
  const stats = new Map<PatternKey, Stat>([['dry_sell_side', blank()]]);

  /** Last hour each item was reported, so the 72h cooldown is honoured. */
  const reportedAt = new Map<number, number>();
  /** Per-item cursors, advanced as the clock moves. */
  const cursors = new Map<number, { end: number; window: number; day: number }>();

  for (const at of hours) {
    if (at < measuredFrom) continue;

    for (const [itemId, series] of byItem) {
      const cursor = cursors.get(itemId) ?? { end: -1, window: -1, day: -1 };

      while (cursor.end + 1 < series.length && series[cursor.end + 1].hour.getTime() <= at) cursor.end += 1;
      if (cursor.end < 0) continue;

      while (cursor.window + 1 < series.length && series[cursor.window + 1].hour.getTime() <= at - WINDOW_MS) {
        cursor.window += 1;
      }
      while (cursor.day + 1 < series.length && series[cursor.day + 1].hour.getTime() <= at - 24 * HOUR_MS) {
        cursor.day += 1;
      }

      const windowSeries = series.slice(cursor.window + 1, cursor.end + 1);
      const recent = series.slice(cursor.day + 1, cursor.end + 1);
      if (recent.length < MIN_HOURS) continue;
      if (recent.reduce((sum, hour) => sum + hour.samples, 0) < MIN_SAMPLES) continue;

      const match = detectDrySellSide(windowSeries);
      if (match === null) continue;

      const stat = stats.get(match.pattern);
      if (!stat) continue;
      stat.raw += 1;

      const last = reportedAt.get(itemId);
      const accepted = last === undefined || at - last >= COOLDOWN_MS;
      if (accepted) {
        stat.accepted += 1;
        reportedAt.set(itemId, at);
      }

      const result = outcome(match, series, new Date(at));
      if (result === 'held') stat.held += 1;
      else if (result === 'missed') stat.missed += 1;
      else stat.unverified += 1;

      if (accepted) {
        if (result === 'held') stat.acceptedHeld += 1;
        else if (result === 'missed') stat.acceptedMissed += 1;
        else stat.acceptedUnverified += 1;
      }

      cursors.set(itemId, cursor);
    }
  }

  return stats;
}

/** The window the script replays and its argument. */
function parseArgs(arguments_: string[]): { file: string; days: number } {
  const file = arguments_[0];
  if (!file) {
    console.error('usage: tsx scripts/insight-replay.ts <book-hourly.jsonl> [--days 8]');
    process.exit(2);
  }
  const flag = arguments_.indexOf('--days');
  const days = flag === -1 ? 8 : Number(arguments_[flag + 1]);
  return { file, days };
}

const { file, days } = parseArgs(process.argv.slice(2));
const byItem = load(file);
const allHours = [
  ...new Set([...byItem.values()].flatMap((series) => series.map((hour) => hour.hour.getTime()))),
].sort((a, b) => a - b);

if (allHours.length === 0) {
  console.error('the export has no rows');
  process.exit(2);
}

const newest = allHours[allHours.length - 1];
const measuredFrom = newest - days * 24 * HOUR_MS;
const stats = replay(byItem, allHours, measuredFrom);

const measuredDays = (newest - Math.max(measuredFrom, allHours[0])) / (24 * HOUR_MS);
console.log(
  `window ${new Date(Math.max(measuredFrom, allHours[0])).toISOString().slice(0, 16)}Z .. ` +
    `${new Date(newest).toISOString().slice(0, 16)}Z · ${measuredDays.toFixed(1)} days · ` +
    `${byItem.size} items · ${allHours.length} closed hours`
);
console.log('');
console.log('pattern            firings/day  accepted/day   all firings  posted   gate   rarity now → measured');
console.log('-'.repeat(112));

let failed = false;
for (const pattern of Object.keys(PATTERN_RARITY) as PatternKey[]) {
  const stat = stats.get(pattern) ?? blank();
  const firingsPerDay = stat.raw / measuredDays;
  const acceptedPerDay = stat.accepted / measuredDays;
  const checked = stat.held + stat.missed;
  const persistence = checked === 0 ? null : stat.held / checked;
  const postedChecked = stat.acceptedHeld + stat.acceptedMissed;
  const posted = postedChecked === 0 ? null : stat.acceptedHeld / postedChecked;
  const measured = acceptedPerDay === 0 ? 1 : Math.min(1, 3 / acceptedPerDay);
  const pass = persistence !== null && persistence >= TARGET_PERSISTENCE;
  if (!pass) failed = true;

  console.log(
    pattern.padEnd(18) +
      firingsPerDay.toFixed(2).padStart(11) +
      acceptedPerDay.toFixed(2).padStart(14) +
      '   ' +
      (persistence === null ? 'n/a' : `${(persistence * 100).toFixed(0)}%`).padStart(5) +
      ` (${checked}/${stat.unverified})`.padEnd(15) +
      (posted === null ? '   n/a' : `   ${(posted * 100).toFixed(0)}%`.padStart(6)) +
      ` (${postedChecked})`.padEnd(9) +
      (pass ? 'ok' : 'FAIL').padEnd(7) +
      `${PATTERN_RARITY[pattern].toFixed(2)} → ${measured.toFixed(2)}`
  );
}

console.log('');
console.log(
  failed
    ? 'GATE FAILED: a pattern is under 90% persistence — tune it or do not ship it.'
    : 'GATE PASSED: every pattern holds at least 90% of the time.'
);
process.exitCode = failed ? 1 : 0;
