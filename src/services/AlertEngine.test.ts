import { describe, it, expect } from 'vitest';

import { detectSignals, SIGNAL_CONFIG, type PriceSignal, type SignalInput } from './AlertEngine.js';

/** The ask history the matrix cases share: 24 points around 100. */
const HISTORY: number[] = [
  95, 100, 105, 100, 95, 100, 105, 100,
  95, 100, 105, 100, 95, 100, 105, 100,
  95, 100, 105, 100, 95, 100, 105, 100,
];

/**
 * Case (k)'s history: nineteen observations at 100 and one at 200.
 *
 * The skewed mean (105) inflates the deviation while the current ask stays
 * inside the range, so the position gate has to suppress the signal.
 */
const SKEWED_HISTORY: number[] = [...new Array<number>(19).fill(100), 200];

/**
 * The expected signal of case (f).
 *
 * Case (n) asserts against these values instead of a second hand-written set.
 */
const EXPECTED_UP_SIGNAL: PriceSignal = {
  itemId: 1,
  direction: 'up',
  dev: 0.08,
  currentAsk: 108,
  avgAsk: 100,
  lo: 95,
  hi: 105,
  position: 1.3,
  askVolume: 5000,
};

/**
 * A matrix input built from the shared ask history.
 *
 * The cases differ only in the fields the matrix names, so the baseline
 * lives here instead of in every fixture.
 */
function makeInput(
  currentAsk: number | null,
  askVolume: number | null = 5000,
  askHistory: number[] = HISTORY,
  itemId = 1
): SignalInput {
  return { itemId, currentAsk, askVolume, askHistory };
}

describe('detectSignals', () => {
  it('(a) ignores an item without a current ask', () => {
    const signals = detectSignals([makeInput(null)]);

    expect(signals).toHaveLength(0);
  });

  it('(b) ignores an ask volume below the minimum', () => {
    const signals = detectSignals([makeInput(108, SIGNAL_CONFIG.minAskVolume - 1)]);

    expect(signals).toHaveLength(0);
  });

  it('(c) ignores an item without an ask volume', () => {
    const signals = detectSignals([makeInput(108, null)]);

    expect(signals).toHaveLength(0);
  });

  it('(d) ignores a history shorter than the minimum number of points', () => {
    const tooShort = HISTORY.slice(0, SIGNAL_CONFIG.minHistoryPoints - 1);

    const signals = detectSignals([makeInput(108, 5000, tooShort)]);

    expect(signals).toHaveLength(0);
  });

  it('(e) ignores a flat history whose low equals its high', () => {
    // A deviating current ask passes the 8% gate, so this case reaches the
    // `lo === hi` guard instead of stopping at the deviation gate.
    const flat = new Array<number>(SIGNAL_CONFIG.minHistoryPoints).fill(100);

    const signals = detectSignals([makeInput(108, 5000, flat)]);

    expect(signals).toHaveLength(0);
  });

  it('(f) signals an ask that rose above the mean', () => {
    const signals = detectSignals([makeInput(108)]);

    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.itemId).toBe(EXPECTED_UP_SIGNAL.itemId);
    expect(signal.direction).toBe(EXPECTED_UP_SIGNAL.direction);
    expect(signal.dev).toBeCloseTo(EXPECTED_UP_SIGNAL.dev, 10);
    expect(signal.currentAsk).toBe(EXPECTED_UP_SIGNAL.currentAsk);
    expect(signal.avgAsk).toBe(EXPECTED_UP_SIGNAL.avgAsk);
    expect(signal.lo).toBe(EXPECTED_UP_SIGNAL.lo);
    expect(signal.hi).toBe(EXPECTED_UP_SIGNAL.hi);
    expect(signal.position).toBe(EXPECTED_UP_SIGNAL.position);
    expect(signal.askVolume).toBe(EXPECTED_UP_SIGNAL.askVolume);
  });

  it('(g) signals an ask that fell below the mean', () => {
    const signals = detectSignals([makeInput(92)]);

    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.direction).toBe('down');
    expect(signal.dev).toBeCloseTo(-0.08, 10);
    expect(signal.position).toBe(-0.3);
  });

  it('(h) ignores an ask that barely moved inside the range', () => {
    const signals = detectSignals([makeInput(101)]);

    expect(signals).toHaveLength(0);
  });

  it('(i) signals an ask that broke below the 24h low', () => {
    const signals = detectSignals([makeInput(88)]);

    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.direction).toBe('down');
    expect(signal.dev).toBeCloseTo(-0.12, 10);
    expect(signal.position).toBe(-0.7);
  });

  it('(j) signals an ask that broke above the 24h high', () => {
    const signals = detectSignals([makeInput(112)]);

    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.direction).toBe('up');
    expect(signal.dev).toBeCloseTo(0.12, 10);
    expect(signal.position).toBe(1.7);
  });

  it('(k) suppresses a skewed mean whose ask sits inside the 24h range', () => {
    const signals = detectSignals([makeInput(190, 5000, SKEWED_HISTORY)]);

    expect(signals).toHaveLength(0);

    // The deviation gate alone must not be what suppressed it: the same
    // skewed history signals once the ask leaves the range.
    const outside = detectSignals([makeInput(205, 5000, SKEWED_HISTORY)]);

    expect(outside).toHaveLength(1);
    expect(outside[0].direction).toBe('up');
  });

  it('(l) returns a signal only for the qualifying input', () => {
    const signals = detectSignals([
      makeInput(100, 5000, HISTORY, 41),
      makeInput(108, 5000, HISTORY, 42),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0].itemId).toBe(42);

    // Signals keep the input order; the caller sorts them by deviation.
    const ordered = detectSignals([
      makeInput(92, 5000, HISTORY, 61),
      makeInput(112, 5000, HISTORY, 62),
    ]);

    expect(ordered.map((signal) => signal.itemId)).toEqual([61, 62]);
  });

  it('(m) treats a zero ask as no sell order', () => {
    const signals = detectSignals([makeInput(0)]);

    expect(signals).toHaveLength(0);
  });

  it('(n) keeps a zero in the history out of the average', () => {
    const signals = detectSignals([makeInput(108, 5000, [0, ...HISTORY])]);

    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.direction).toBe(EXPECTED_UP_SIGNAL.direction);
    expect(signal.dev).toBeCloseTo(EXPECTED_UP_SIGNAL.dev, 10);
    expect(signal.avgAsk).toBe(EXPECTED_UP_SIGNAL.avgAsk);
    expect(signal.lo).toBe(EXPECTED_UP_SIGNAL.lo);
    expect(signal.hi).toBe(EXPECTED_UP_SIGNAL.hi);
    expect(signal.position).toBe(EXPECTED_UP_SIGNAL.position);
  });
});
