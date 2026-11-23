/**
 * One item's current ask price, its ask volume and the ask prices of the
 * 24h window.
 */
export interface SignalInput {
  itemId: number;
  currentAsk: number | null;
  askVolume: number | null;
  askHistory: number[]; // ascending ask prices, same unit as currentAsk
}

/** A price move worth telling someone about. */
export interface PriceSignal {
  itemId: number;
  direction: 'up' | 'down';
  dev: number; // (currentAsk - avgAsk) / avgAsk
  currentAsk: number;
  avgAsk: number;
  lo: number;
  hi: number;
  position: number; // 0 = at the 24h low, 1 = at the 24h high
  askVolume: number;
}

/** The thresholds the signal function works with. */
export const SIGNAL_CONFIG = {
  windowMs: 24 * 60 * 60 * 1000,
  devThreshold: 0.08,
  minAskVolume: 1000,
  minHistoryPoints: 8,
  positionEdge: 0.05,
};

/**
 * Turn market snapshots into price signals.
 *
 * The gates are ordered on purpose, each one suppresses a different class of
 * nonsense. The live market writes the price `0` (with volume `0`) for "no
 * sell order", so a zero is a missing observation and never a price: neither
 * in the current ask nor in the history, where averaging it in would drag the
 * mean down and manufacture the spikes this function exists to suppress.
 *
 * The signals keep the order of the inputs; the caller sorts them.
 */
export function detectSignals(inputs: SignalInput[]): PriceSignal[] {
  const signals: PriceSignal[] = [];

  for (const input of inputs) {
    const history = input.askHistory.filter((ask) => ask > 0);

    if (input.currentAsk === null || input.currentAsk === 0) continue;
    if (input.askVolume === null || input.askVolume < SIGNAL_CONFIG.minAskVolume) continue;
    if (history.length < SIGNAL_CONFIG.minHistoryPoints) continue;

    const avgAsk = history.reduce((sum, ask) => sum + ask, 0) / history.length;
    const dev = (input.currentAsk - avgAsk) / avgAsk;

    if (Math.abs(dev) < SIGNAL_CONFIG.devThreshold) continue;

    const lo = Math.min(...history);
    const hi = Math.max(...history);

    if (lo === hi) continue;

    const position = (input.currentAsk - lo) / (hi - lo);

    if (!(position <= SIGNAL_CONFIG.positionEdge || position >= 1 - SIGNAL_CONFIG.positionEdge)) continue;

    signals.push({
      itemId: input.itemId,
      direction: dev < 0 ? 'down' : 'up',
      dev,
      currentAsk: input.currentAsk,
      avgAsk,
      lo,
      hi,
      position,
      askVolume: input.askVolume,
    });
  }

  return signals;
}
