import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, logger } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  pool: { connect: vi.fn() },
}));

vi.mock('./IdleClansApi.js', () => ({
  getPricesLatest: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => logger,
}));

import { getPricesLatest } from './IdleClansApi.js';
import { MarketService, normalizePricesLatest } from './MarketService.js';
import { SnapshotStore } from './SnapshotStore.js';

/**
 * The payload the mocked API resolves with.
 *
 * The real `getPricesLatest()` returns a keyed record of `PriceEntry`, but the
 * normalizer also accepts the raw array the public API sends, and the tests
 * need the `null` prices that `PriceEntry` cannot hold, so the mock is fed
 * the raw shape through one documented cast.
 */
type PricesPayload = Awaited<ReturnType<typeof getPricesLatest>>;

/**
 * The raw `/PlayerMarket/items/prices/latest` payload: an array of entries
 * using the same field names the public API uses.
 */
const RAW_ARRAY = [
  {
    itemId: 258,
    lowestSellPrice: 100,
    lowestPriceVolume: 2537,
    highestBuyPrice: 62,
    highestPriceVolume: 147565,
  },
  {
    itemId: 46,
    lowestSellPrice: null,
    lowestPriceVolume: null,
    highestBuyPrice: 419,
    highestPriceVolume: 12,
  },
  {
    itemId: 42,
    lowestSellPrice: 0,
    lowestPriceVolume: 0,
    highestBuyPrice: null,
    highestPriceVolume: null,
  },
];

/** The raw array the mocked API hands to the service. */
const RAW_PAYLOAD = RAW_ARRAY as unknown as PricesPayload;

/** A payload whose price field is not a number: a schema break. */
const INVALID_PAYLOAD = { '46': { itemId: 46, lowestSellPrice: 'cheap' } } as unknown as PricesPayload;

/** A stored snapshot row: the bigint columns come back as strings. */
const PREVIOUS_ROW = {
  item_id: 46,
  captured_at: new Date('2026-11-11T10:00:00Z'),
  ask: '900',
  bid: '800',
  ask_volume: '12',
  bid_volume: '3',
};

/** The quote the stored snapshot row above stands for. */
const PREVIOUS_QUOTE = {
  itemId: 46,
  ask: 900,
  bid: 800,
  askVolume: 12,
  bidVolume: 3,
};

/**
 * Answer the pool mock per statement: the batch INSERT, the ask-history
 * SELECT, the newest-row SELECT and the retention DELETE each get their own
 * rows.
 */
function stubPool(
  rows: {
    history?: unknown[];
    latest?: unknown[];
    deleted?: number;
    rolledUp?: number;
    pollSize?: number;
  } = {}
): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)::int AS size')) {
      return { rows: [{ size: rows.pollSize ?? 0 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO price_daily')) {
      return { rows: [], rowCount: rows.rolledUp ?? 0 };
    }
    if (sql.includes('INSERT INTO price_snapshots')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM price_snapshots')) {
      return { rows: [], rowCount: rows.deleted ?? 0 };
    }
    if (sql.includes('DISTINCT ON')) {
      return { rows: rows.latest ?? [], rowCount: (rows.latest ?? []).length };
    }
    if (sql.includes('FROM price_snapshots') && sql.includes('ask')) {
      return { rows: rows.history ?? [], rowCount: (rows.history ?? []).length };
    }
    return { rows: [], rowCount: 0 };
  });
}

/** The statements the pool mock received, in order. */
function sqlCalls(): Array<{ sql: string; params: unknown[] }> {
  return (queryMock.mock.calls as Array<[string, unknown[]]>).map(([sql, params]) => ({
    sql,
    params,
  }));
}

describe('normalizePricesLatest', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('maps every entry of the raw payload to a quote', () => {
    const quotes = normalizePricesLatest(RAW_ARRAY);

    expect(quotes).toHaveLength(3);
    expect(quotes[0]).toEqual({
      itemId: 258,
      ask: 100,
      bid: 62,
      askVolume: 2537,
      bidVolume: 147565,
    });
  });

  it('keeps a null ask as null instead of 0 or undefined', () => {
    const quotes = normalizePricesLatest(RAW_ARRAY);

    expect(quotes[1].ask).toBeNull();
    expect(quotes[1].askVolume).toBeNull();
  });

  it('keeps a zero ask as 0 instead of null', () => {
    const quotes = normalizePricesLatest(RAW_ARRAY);

    expect(quotes[2].ask).toBe(0);
    expect(quotes[2].askVolume).toBe(0);
  });

  it('maps an absent highestPriceVolume to a null bid volume', () => {
    const quotes = normalizePricesLatest([{ itemId: 46, lowestSellPrice: 100, highestBuyPrice: 90 }]);

    expect(quotes[0].bidVolume).toBeNull();
  });

  it('preserves the item ids and the length of the payload', () => {
    const quotes = normalizePricesLatest(RAW_ARRAY);

    expect(quotes.map((q) => q.itemId)).toEqual([258, 46, 42]);
    expect(quotes).toHaveLength(RAW_ARRAY.length);
  });

  it('accepts the keyed record the API client returns', () => {
    const quotes = normalizePricesLatest({
      '258': RAW_ARRAY[0],
      '46': RAW_ARRAY[1],
    });

    expect(quotes).toHaveLength(2);
    const byId = new Map(quotes.map((q) => [q.itemId, q]));
    expect(byId.get(258)?.ask).toBe(100);
    expect(byId.get(258)?.bidVolume).toBe(147565);
    expect(byId.get(46)?.ask).toBeNull();
  });

  it('rejects a payload that is not a list of prices', () => {
    expect(() => normalizePricesLatest('nonsense')).toThrow(/neither an array nor a record/);
  });

  it('rejects a payload without any market entry', () => {
    expect(() => normalizePricesLatest([])).toThrow(/no market entries/);
  });

  it('rejects an entry with a price that is not a number', () => {
    expect(() => normalizePricesLatest([{ itemId: 46, lowestSellPrice: 'cheap' }])).toThrow(
      /non-numeric lowestSellPrice/
    );
  });

  it('rejects an entry without a usable item id', () => {
    expect(() => normalizePricesLatest([{ lowestSellPrice: 100 }])).toThrow(/invalid item id/);
  });

  it('keeps the item id 0 that the live market sends', () => {
    const quotes = normalizePricesLatest([{ itemId: 0, lowestSellPrice: 15, highestBuyPrice: 11 }]);

    expect(quotes[0].itemId).toBe(0);
    expect(quotes[0].ask).toBe(15);
  });

  it('rejects a negative item id', () => {
    expect(() => normalizePricesLatest([{ itemId: -1, lowestSellPrice: 100 }])).toThrow(/invalid item id/);
  });
});

describe('MarketService.pollOnce', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
  });

  it('writes one row per quote with a single capture timestamp', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    const result = await MarketService.pollOnce();

    expect(result.quotes).toHaveLength(3);
    const insert = sqlCalls().find((c) => c.sql.includes('INSERT INTO price_snapshots'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toEqual([258, 46, 42]);
    expect(insert!.params[2]).toEqual([100, null, 0]);
    expect(insert!.params[3]).toEqual([62, 419, null]);
    expect(insert!.params[4]).toEqual([2537, null, 0]);
    expect(insert!.params[5]).toEqual([147565, 12, null]);
  });

  it('captures the whole batch at the same instant', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    const result = await MarketService.pollOnce();

    const insert = sqlCalls().find((c) => c.sql.includes('INSERT INTO price_snapshots'));
    expect(insert!.params[1]).toBeInstanceOf(Date);
    expect(insert!.params[1]).toEqual(result.capturedAt);
  });

  it('writes nothing when the payload fails validation and keeps the previous quotes', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(INVALID_PAYLOAD);
    stubPool({ latest: [PREVIOUS_ROW] });

    const result = await MarketService.pollOnce();

    expect(sqlCalls().filter((c) => c.sql.includes('INSERT INTO price_snapshots'))).toHaveLength(0);
    expect(result.quotes).toEqual([PREVIOUS_QUOTE]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('keeps the previous snapshot queryable after a rejected payload', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue({});
    stubPool({ latest: [PREVIOUS_ROW] });

    await MarketService.pollOnce();

    expect(sqlCalls().filter((c) => c.sql.includes('DELETE'))).toHaveLength(0);
    const latest = await SnapshotStore.latestQuotes();
    expect(latest.get(46)).toEqual(PREVIOUS_QUOTE);
  });

  it('tells an API failure apart from a rejected payload in the log', async () => {
    vi.mocked(getPricesLatest).mockRejectedValue(new Error('the market API is down'));
    stubPool({ latest: [PREVIOUS_ROW] });

    await MarketService.pollOnce();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('API request failed'),
      expect.anything()
    );
  });

  it('keeps the previous snapshot when the payload lost a fifth of the market', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);
    stubPool({ pollSize: 600, latest: [PREVIOUS_ROW] });

    const result = await MarketService.pollOnce();

    expect(sqlCalls().filter((c) => c.sql.includes('INSERT INTO price_snapshots'))).toHaveLength(0);
    expect(result.quotes).toEqual([PREVIOUS_QUOTE]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('lost items'),
      expect.anything()
    );
  });

  it('stores a payload that keeps most of the previous market', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);
    stubPool({ pollSize: 3 });

    await MarketService.pollOnce();

    expect(sqlCalls().filter((c) => c.sql.includes('INSERT INTO price_snapshots'))).toHaveLength(1);
  });

  it('reports a rejected payload as a validation failure', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(INVALID_PAYLOAD);
    stubPool({ latest: [PREVIOUS_ROW] });

    await MarketService.pollOnce();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed validation'),
      expect.anything()
    );
  });
});

describe('SnapshotStore.askHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
  });

  it('returns the asks of the window in order, each with its capture time', async () => {
    stubPool({
      history: [
        { ask: '100', captured_at: new Date('2026-11-10T00:00:00Z') },
        { ask: '150', captured_at: new Date('2026-11-10T00:05:00Z') },
        { ask: '120', captured_at: new Date('2026-11-10T00:10:00Z') },
      ],
    });
    const since = new Date('2026-11-10T00:00:00Z');

    const history = await SnapshotStore.askHistory(46, since);

    expect(history).toEqual([
      { at: Date.parse('2026-11-10T00:00:00Z'), price: 100 },
      { at: Date.parse('2026-11-10T00:05:00Z'), price: 150 },
      { at: Date.parse('2026-11-10T00:10:00Z'), price: 120 },
    ]);
    const { sql, params } = sqlCalls()[0];
    expect(sql).toContain('ask IS NOT NULL');
    expect(sql).toContain('ORDER BY captured_at ASC');
    expect(sql).toContain('captured_at >= $2');
    expect(params).toEqual([46, since]);
  });

  it('returns an empty history for an item without snapshots', async () => {
    stubPool({ history: [] });

    expect(await SnapshotStore.askHistory(46, new Date())).toEqual([]);
  });

  it('carries the units on sale, and none when the snapshot has no ask volume', async () => {
    stubPool({
      history: [
        { ask: '100', ask_volume: '2500', captured_at: new Date('2026-11-10T00:00:00Z') },
        { ask: '150', ask_volume: null, captured_at: new Date('2026-11-10T00:05:00Z') },
      ],
    });

    expect(await SnapshotStore.askHistory(46, new Date('2026-11-10T00:00:00Z'))).toEqual([
      { at: Date.parse('2026-11-10T00:00:00Z'), price: 100, volume: 2500 },
      { at: Date.parse('2026-11-10T00:05:00Z'), price: 150, volume: undefined },
    ]);
  });
});

describe('SnapshotStore.latestQuotes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
  });

  it('returns the newest quote of every item', async () => {
    stubPool({
      latest: [
        PREVIOUS_ROW,
        { item_id: 42, ask: '10', bid: null, ask_volume: '0', bid_volume: null },
      ],
    });

    const quotes = await SnapshotStore.latestQuotes();

    expect(quotes.get(46)).toEqual(PREVIOUS_QUOTE);
    expect(quotes.get(42)).toEqual({
      itemId: 42,
      ask: 10,
      bid: null,
      askVolume: 0,
      bidVolume: null,
    });
    expect(sqlCalls()[0].sql).toContain('DISTINCT ON (item_id)');
  });
});

describe('SnapshotStore.latestQuotesFor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads only the items it is handed', async () => {
    queryMock.mockResolvedValue({
      rows: [{ item_id: 46, ask: '66', bid: '55', ask_volume: '21450', bid_volume: '610630' }],
      rowCount: 1,
    });

    const quotes = await SnapshotStore.latestQuotesFor([46, 12]);

    expect(quotes.get(46)).toEqual({
      itemId: 46,
      ask: 66,
      bid: 55,
      askVolume: 21_450,
      bidVolume: 610_630,
    });
    const call = sqlCalls()[0];
    // one index lookup per id: the `DISTINCT ON` form sorted 86 ms worth of rows
    expect(call.sql).toContain('unnest($1::int[])');
    expect(call.sql).toContain('ORDER BY captured_at DESC');
    expect(call.params).toEqual([[46, 12]]);
  });

  it('asks the database nothing when no item is watched', async () => {
    const quotes = await SnapshotStore.latestQuotesFor([]);

    expect(quotes.size).toBe(0);
    expect(sqlCalls()).toHaveLength(0);
  });
});

describe('SnapshotStore.pruneOlderThan', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
  });

  it('deletes the rows older than the cutoff and returns the deleted count', async () => {
    stubPool({ deleted: 42 });
    const cutoff = new Date('2026-11-04T00:00:00Z');

    const deleted = await SnapshotStore.pruneOlderThan(cutoff);

    expect(deleted).toBe(42);
    const { sql, params } = sqlCalls()[0];
    expect(sql).toContain('DELETE FROM price_snapshots');
    expect(sql).toContain('captured_at < $1');
    expect(params).toEqual([cutoff]);
  });

  it('only deletes a raw row once its day has reached the archive', async () => {
    // A raw row is the only copy of its day until the rollup writes it. Deleting
    // on the cutoff alone made a failed rollup lose that day for good.
    stubPool({ deleted: 0 });

    await SnapshotStore.pruneOlderThan(new Date('2026-11-04T00:00:00Z'));

    const { sql } = sqlCalls()[0];
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('FROM price_daily');
  });

  it('archives the buy side of the day beside the sell side', async () => {
    stubPool({ deleted: 0 });

    await SnapshotStore.rollupCompleteDays(30);

    const rollup = sqlCalls().find((call) => call.sql.includes('INSERT INTO price_daily'));
    expect(rollup?.sql).toContain('bid_open');
    expect(rollup?.sql).toContain('FILTER (WHERE s.bid > 0)');
    // A row with a buy order and no sell order still has history worth keeping.
    expect(rollup?.sql).toContain('(s.ask > 0 OR s.bid > 0)');
  });
});

/** One day in milliseconds, the retention cadence the poller schedules. */
const DAY_MS = 24 * 60 * 60 * 1000;

describe('MarketService.start', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await MarketService.stop();
    vi.useRealTimers();
  });

  it('polls immediately and then on the interval', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // let the poll that was fired settle

    await vi.advanceTimersByTimeAsync(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(3);
  });

  it('does not stack a slow poll on top of a running one', async () => {
    const resolvers: Array<(payload: PricesPayload) => void> = [];
    vi.mocked(getPricesLatest).mockImplementation(
      () => new Promise<PricesPayload>((resolve) => { resolvers.push(resolve); })
    );

    await MarketService.start(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    resolvers[0](RAW_PAYLOAD);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(2);

    resolvers[1](RAW_PAYLOAD);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('stops polling once the timer is cleared', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(1000);
    expect(getPricesLatest).toHaveBeenCalledTimes(1);

    await MarketService.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(getPricesLatest).toHaveBeenCalledTimes(1);
  });

  it('prunes the snapshots past the thirty-day retention on start', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(DAY_MS);
    await vi.advanceTimersByTimeAsync(0);

    const deletes = sqlCalls().filter((call) => call.sql.includes('DELETE FROM price_snapshots'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params).toEqual([new Date(Date.now() - 30 * DAY_MS)]);
  });

  it('prunes again a day later', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(DAY_MS);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DAY_MS);

    const deletes = sqlCalls().filter((call) => call.sql.includes('DELETE FROM price_snapshots'));
    expect(deletes).toHaveLength(2);
  });

  it('keeps polling when the prune fails', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(DAY_MS);
    const prune = vi.mocked(queryMock);
    const failing = prune.getMockImplementation();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM price_snapshots')) throw new Error('prune blew up');
      return failing ? failing(sql) : { rows: [], rowCount: 0 };
    });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(logger.warn).toHaveBeenCalledWith(
      'snapshot prune failed',
      expect.objectContaining({ error: 'prune blew up' })
    );
    expect(vi.mocked(getPricesLatest).mock.calls.length).toBeGreaterThan(1);
  });

  it('rolls the finished days up before it prunes the raw window', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(DAY_MS);
    await vi.advanceTimersByTimeAsync(0);

    const statements = sqlCalls().map((call) => call.sql);
    const rollup = statements.findIndex((sql) => sql.includes('INSERT INTO price_daily'));
    const prune = statements.findIndex((sql) => sql.includes('DELETE FROM price_snapshots'));

    expect(rollup).toBeGreaterThanOrEqual(0);
    expect(prune).toBeGreaterThan(rollup);
  });

  it('still prunes when the rollup fails', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);
    const working = queryMock.getMockImplementation();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO price_daily')) throw new Error('rollup blew up');
      return working ? working(sql) : { rows: [], rowCount: 0 };
    });

    await MarketService.start(DAY_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith(
      'price rollup failed',
      expect.objectContaining({ error: 'rollup blew up' })
    );
    const deletes = sqlCalls().filter((call) => call.sql.includes('DELETE FROM price_snapshots'));
    expect(deletes).toHaveLength(1);
  });

  it('logs the stored snapshot after a successful poll', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(RAW_PAYLOAD);

    await MarketService.start(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.info).toHaveBeenCalledWith(
      'market snapshot stored',
      expect.objectContaining({ quotes: 3 })
    );
  });

  it('does not log a stored snapshot when the poll failed', async () => {
    vi.mocked(getPricesLatest).mockResolvedValue(INVALID_PAYLOAD);
    stubPool({ latest: [PREVIOUS_ROW] });

    await MarketService.start(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.info.mock.calls.map((call) => call[0])).not.toContain('market snapshot stored');
  });
});
