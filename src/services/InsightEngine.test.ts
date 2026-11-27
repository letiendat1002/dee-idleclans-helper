import { describe, it, expect } from 'vitest';
import {
  detectBookFlipped,
  detectDrySellSide,
  detectPinnedAtEdge,
  pickDiverse,
  toFinding,
  type BookHour,
} from './InsightEngine.js';

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
  it('fires after 12 hours without a sell offer, and says how long', () => {
    const match = detectDrySellSide(series(48, (i) => ({ askVolume: i < 13 ? 0 : 500 })));

    expect(match).not.toBeNull();
    expect(match?.pattern).toBe('dry_sell_side');
    expect(match?.state).toBe('dry');
    expect(match?.body.hours).toBe(13);
    expect(match?.body.lastOfferAt).toBe(new Date(END.getTime() - 13 * HOUR_MS).toISOString());
  });

  it('upgrades the same finding past 24 hours instead of firing a second one', () => {
    const match = detectDrySellSide(series(48, (i) => ({ askVolume: i < 25 ? 0 : 500 })));

    expect(match?.state).toBe('off_board');
    expect(match?.body.hours).toBe(25);
  });

  it('stays silent below 12 hours', () => {
    expect(detectDrySellSide(series(36, (i) => ({ askVolume: i < 11 ? 0 : 500 })))).toBeNull();
  });

  it('stays silent when the item was already empty before the window', () => {
    expect(detectDrySellSide(series(36, () => ({ askVolume: 0 })))).toBeNull();
  });

  it('never reads a collector gap as an empty book', () => {
    const gapped = series(48, (i) => ({ askVolume: i < 20 ? 0 : 500 })).filter(
      (row) => row.hour.getTime() !== END.getTime() - 10 * HOUR_MS
    );

    expect(detectDrySellSide(gapped)).toBeNull();
  });

  it('still fires when the feed had no sell price to remember', () => {
    const match = detectDrySellSide(
      series(48, (i) => ({ askVolume: i < 13 ? 0 : 500, ask: null, askLow: null, askHigh: null }))
    );

    expect(match?.body.ask).toBeNull();
    expect(match?.body.hours).toBe(13);
  });

  it('never counts an hour with no snapshot', () => {
    const match = detectDrySellSide(series(48, (i) => ({ askVolume: i < 5 ? 0 : 500, samples: i < 5 ? 0 : 30 })));

    expect(match).toBeNull();
  });
});

describe('detectBookFlipped', () => {
  /** Six bid-heavy days and an ask-heavy today. */
  const flipped = (todayAsk: number, todayBid: number): BookHour[] =>
    series(7 * 24, (i) => {
      const day = Math.floor(i / 24);
      return day === 0 ? { askVolume: todayAsk, bidVolume: todayBid } : { askVolume: 100, bidVolume: 900 };
    });

  it('fires when the sides swap against the six-day median', () => {
    const match = detectBookFlipped(flipped(10_000, 1_000));

    expect(match?.pattern).toBe('book_flipped');
    expect(match?.state).toBe('ask_heavy');
    // The daily volume is the sum of the 24 hourly maxima, as the probe measured it.
    expect(match?.body.askWanted).toBe(240_000);
    expect(match?.body.bidWanted).toBe(24_000);
    expect(match?.body.ratio).toBe(10);
    expect(match?.body.prevAsk).toBe(14_400);
    expect(match?.body.prevBid).toBe(129_600);
  });

  it('scales significance by the baseline spread when the baseline moved', () => {
    // A three-step cycle: the hourly imbalance takes three magnitudes, so the
    // baseline's MAD is not zero and significance uses the division, not the constant.
    const cycle = [0.2, 0.6, 0.9];
    const wobbling = series(7 * 24, (hoursFromEnd) => {
      if (Math.floor(hoursFromEnd / 24) === 0) return { askVolume: 10_000, bidVolume: 1_000 };
      const imbalance = cycle[hoursFromEnd % cycle.length];
      return { askVolume: Math.round((1 - imbalance) * 500), bidVolume: Math.round((1 + imbalance) * 500) };
    });

    const match = detectBookFlipped(wobbling);

    expect(match).not.toBeNull();
    // A flat baseline would clamp at 0.25; a wobbling one is far more surprising.
    expect(match?.significance).toBeGreaterThan(0.3);
    expect(match?.significance).toBeLessThanOrEqual(1);
  });

  it('does not fire on a mild imbalance', () => {
    expect(detectBookFlipped(flipped(2_000, 1_800))).toBeNull();
  });

  it('does not fire when the baseline was balanced', () => {
    const balanced = series(7 * 24, (i) => {
      const day = Math.floor(i / 24);
      return day === 0 ? { askVolume: 10_000, bidVolume: 1_000 } : { askVolume: 1_000, bidVolume: 1_000 };
    });

    expect(detectBookFlipped(balanced)).toBeNull();
  });

  it('does not fire when the side did not change', () => {
    const sameSide = series(7 * 24, () => ({ askVolume: 1_000, bidVolume: 5_000 }));

    expect(detectBookFlipped(sameSide)).toBeNull();
  });

  it('needs four baseline days', () => {
    const short = series(4 * 24, (i) => {
      const day = Math.floor(i / 24);
      return day === 0 ? { askVolume: 10_000, bidVolume: 1_000 } : { askVolume: 100, bidVolume: 900 };
    });

    expect(detectBookFlipped(short)).toBeNull();
  });
});

describe('detectPinnedAtEdge', () => {
  /** Six days inside 80..120, then a close of `close`. */
  const pinned = (close: number): BookHour[] =>
    series(7 * 24, (i) => {
      const day = Math.floor(i / 24);
      return day === 0
        ? { ask: close, askLow: Math.min(80, close), askHigh: Math.max(close, 120) }
        : { ask: 100, askLow: 80, askHigh: 120 };
    });

  it('fires on a 25% move that ends above the previous range', () => {
    const match = detectPinnedAtEdge(pinned(160));

    expect(match?.pattern).toBe('pinned_at_edge');
    expect(match?.state).toBe('high');
    expect(match?.body.ask).toBe(160);
  });

  it('fires downward too', () => {
    const match = detectPinnedAtEdge(pinned(60));

    expect(match?.state).toBe('low');
  });

  it('ignores a move that stays inside a wide range', () => {
    const wide = series(7 * 24, (i) => {
      const day = Math.floor(i / 24);
      return day === 0 ? { ask: 130, askLow: 20, askHigh: 200 } : { ask: 100, askLow: 20, askHigh: 200 };
    });

    expect(detectPinnedAtEdge(wide)).toBeNull();
  });

  it('ignores a flat item whose range is a tick', () => {
    const flat = series(7 * 24, (i) => {
      const day = Math.floor(i / 24);
      return day === 0 ? { ask: 130, askLow: 99, askHigh: 130 } : { ask: 100, askLow: 99, askHigh: 101 };
    });

    expect(detectPinnedAtEdge(flat)).toBeNull();
  });

  it('stays silent when the previous six days had no sell price', () => {
    const empty = series(7 * 24, (i) =>
      Math.floor(i / 24) === 0
        ? { ask: 160, askLow: 150, askHigh: 160 }
        : { ask: null, askLow: null, askHigh: null, askVolume: 0, bidVolume: 0 }
    );

    expect(detectPinnedAtEdge(empty)).toBeNull();
  });

  it('ignores a move below 25%', () => {
    expect(detectPinnedAtEdge(pinned(120))).toBeNull();
  });
});

describe('toFinding', () => {
  it('keeps the score inside [0,1] and names the item', () => {
    const match = { pattern: 'book_flipped' as const, state: 'ask_heavy', significance: 2, body: { name: '', ask: 1 } };
    const finding = toFinding(match, 7, 3, 'Grapes', END);

    expect(finding.itemId).toBe(7);
    expect(finding.body.name).toBe('Grapes');
    expect(finding.score).toBeLessThanOrEqual(1);
    expect(finding.score).toBeGreaterThan(0);
  });
});

describe('pickDiverse', () => {
  const row = (pattern: string, itemId: number) => ({ pattern, itemId });

  it('takes one leader per pattern before any runner-up', () => {
    const picked = pickDiverse([row('a', 1), row('a', 2), row('b', 3), row('c', 4)], 3);

    expect(picked.map((entry) => entry.itemId)).toEqual([1, 3, 4]);
  });

  it('fills the remaining slots with runners-up when only one pattern fired', () => {
    const picked = pickDiverse([row('a', 1), row('a', 2), row('a', 3)], 3);

    expect(picked.map((entry) => entry.itemId)).toEqual([1, 2, 3]);
  });

  it('never prints the same item twice', () => {
    const picked = pickDiverse([row('a', 1), row('a', 1), row('b', 1), row('a', 2)], 3);

    expect(picked.map((entry) => entry.itemId)).toEqual([1, 2]);
  });
});
