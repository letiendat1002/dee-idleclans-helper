import { describe, it, expect } from 'vitest';
import { detectDrySellSide, pickDiverse, toFinding, type BookHour } from './InsightEngine.js';

/** The newest hour of every fixture: 2026-11-27 23:00 UTC, a closed hour. */
const END = new Date('2026-11-27T23:00:00Z');

const HOUR_MS = 3_600_000;

/** One hour of the book, with the fixture's neutral values. */
function hour(value: number, overrides: Partial<BookHour> = {}): BookHour {
  return {
    hour: new Date(value),
    ask: 100,
    askLow: 100,
    askHigh: 100,
    bid: 90,
    askVolume: 1_000,
    bidVolume: 500,
    samples: 30,
    ...overrides,
  };
}

/**
 * An ascending hourly series of `count` hours ending at `END`.
 *
 * `shape` receives the distance from the end in hours: 0 is the newest hour,
 * 23 is the first hour of today, 24 is the last hour of yesterday.
 */
function series(count: number, shape: (hoursFromEnd: number) => Partial<BookHour> = () => ({})): BookHour[] {
  const out: BookHour[] = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(hour(END.getTime() - i * HOUR_MS, shape(i)));
  return out;
}

describe('detectDrySellSide', () => {
  it('fires once the sell side has been empty for a day, and says since when', () => {
    const match = detectDrySellSide(series(48, (i) => ({ askVolume: i < 25 ? 0 : 500 })));

    expect(match?.pattern).toBe('dry_sell_side');
    expect(match?.state).toBe('off_board');
    expect(match?.body.hours).toBe(25);
    expect(match?.body.lastOfferAt).toBe(new Date(END.getTime() - 25 * HOUR_MS).toISOString());
    expect(match?.body.lastOfferVolume).toBe(500);
    // 25 of the 48 hours that make a spell maximally significant.
    expect(match?.significance).toBeCloseTo(25 / 48, 5);
  });

  it('stays silent below a day', () => {
    expect(detectDrySellSide(series(36, (i) => ({ askVolume: i < 23 ? 0 : 500 })))).toBeNull();
  });

  it('stays silent when the item was already empty before the window', () => {
    expect(detectDrySellSide(series(36, () => ({ askVolume: 0 })))).toBeNull();
  });

  it('never reads a collector gap as an empty book', () => {
    const gapped = series(48, (i) => ({ askVolume: i < 40 ? 0 : 500 })).filter(
      (row) => row.hour.getTime() !== END.getTime() - 10 * HOUR_MS
    );

    expect(detectDrySellSide(gapped)).toBeNull();
  });

  it('still fires when the feed had no sell price to remember', () => {
    const match = detectDrySellSide(
      series(48, (i) => ({ askVolume: i < 25 ? 0 : 500, ask: null, askLow: null, askHigh: null }))
    );

    expect(match?.body.ask).toBeNull();
    expect(match?.body.hours).toBe(25);
  });

  it('never counts an hour with no snapshot', () => {
    const match = detectDrySellSide(series(48, (i) => ({ askVolume: i < 5 ? 0 : 500, samples: i < 5 ? 0 : 30 })));

    expect(match).toBeNull();
  });
});

describe('toFinding', () => {
  it('names the item, keeps the score inside [0,1] and weights it by rarity', () => {
    const match = {
      pattern: 'dry_sell_side' as const,
      state: 'off_board',
      significance: 0.5,
      body: { name: '', ask: 1 },
    };
    const finding = toFinding(match, 7, 0.8, 'Grapes', END);

    expect(finding.itemId).toBe(7);
    expect(finding.body.name).toBe('Grapes');
    expect(finding.score).toBeCloseTo(0.4, 5);
  });

  it('clamps an out-of-range impact and significance', () => {
    const match = {
      pattern: 'dry_sell_side' as const,
      state: 'off_board',
      significance: 2,
      body: { name: '', ask: 1 },
    };

    expect(toFinding(match, 7, 3, 'Grapes', END).score).toBe(1);
  });
});

describe('pickDiverse', () => {
  const row = (itemId: number) => ({ itemId });

  it('takes the top rows for distinct items', () => {
    expect(pickDiverse([row(1), row(2), row(3)], 2).map((entry) => entry.itemId)).toEqual([1, 2]);
  });

  it('never prints the same item twice', () => {
    expect(pickDiverse([row(1), row(1), row(2), row(3)], 3).map((entry) => entry.itemId)).toEqual([1, 2, 3]);
  });

  it('returns what exists when the queue is shorter than the limit', () => {
    expect(pickDiverse([row(4)], 3)).toHaveLength(1);
  });
});
