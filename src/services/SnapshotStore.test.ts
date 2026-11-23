import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));

import { SnapshotStore } from './SnapshotStore.js';

/**
 * The rows of the fake `price_daily` table, oldest day first.
 *
 * Postgres sends a DATE as a Date at local midnight and the bigint columns as
 * strings, so the fixture carries both shapes.
 */
const DAILY_ROWS = [
  {
    day: new Date(2026, 10, 12),
    open: '3390',
    close: '3390',
    low: '3390',
    high: '3390',
    bid_close: '3350',
    samples: 1,
  },
  {
    day: '2026-11-14',
    open: '3395',
    close: '3389',
    low: '3386',
    high: '3395',
    bid_close: '3340',
    samples: 373,
  },
];

/** Answer the pool mock with the fake daily table, in the order the table holds it. */
function stubPool(rows: unknown[] = DAILY_ROWS): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM price_daily')) {
      return { rows, rowCount: rows.length };
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

beforeEach(() => {
  vi.clearAllMocks();
  stubPool();
});

describe('SnapshotStore.dailyHistory', () => {
  it('asks the daily table for the columns of one day', async () => {
    await SnapshotStore.dailyHistory(46, 7);

    const call = sqlCalls()[0];
    expect(call.sql).toContain('SELECT day, open, close, low, high, bid_close, samples');
    expect(call.sql).toContain('FROM price_daily');
  });

  it('keeps a bid-only day null instead of reading it as zero', async () => {
    // 31 of the quoted items had a buy order and no sell order on 2026-11-16.
    // Number(null) is 0, which would draw a sell price of zero.
    stubPool([
      { day: '2026-11-16', open: null, close: null, low: null, high: null, bid_close: '31', samples: 0 },
    ]);

    const history = await SnapshotStore.dailyHistory(46, 7);

    expect(history[0].close).toBeNull();
    expect(history[0].high).toBeNull();
  });

  it('asks for the days oldest first', async () => {
    await SnapshotStore.dailyHistory(46, 7);

    expect(sqlCalls()[0].sql).toContain('ORDER BY day ASC');
  });

  it('passes the item and the number of days as parameters', async () => {
    await SnapshotStore.dailyHistory(46, 30);

    const call = sqlCalls()[0];
    expect(call.params).toEqual([46, 30]);
    expect(call.sql).toContain('$1');
    expect(call.sql).toContain('$2::int');
    expect(call.sql).not.toContain('30');
  });

  it('reads the last completed days and leaves today out', async () => {
    await SnapshotStore.dailyHistory(46, 7);

    const call = sqlCalls()[0];
    expect(call.sql).toContain("day >= (now() AT TIME ZONE 'UTC')::date - $2::int");
    expect(call.sql).toContain("day < (now() AT TIME ZONE 'UTC')::date");
  });

  it('returns the days oldest first', async () => {
    const history = await SnapshotStore.dailyHistory(46, 30);

    expect(history.map((row) => row.day)).toEqual(['2026-11-12', '2026-11-14']);
  });

  it('reads the bigint columns as numbers', async () => {
    const history = await SnapshotStore.dailyHistory(46, 30);

    expect(history[1]).toEqual({
      day: '2026-11-14',
      open: 3395,
      close: 3389,
      low: 3386,
      high: 3395,
      bidClose: 3340,
      samples: 373,
    });
  });

  it('returns nothing when the table holds no day for the item', async () => {
    stubPool([]);

    expect(await SnapshotStore.dailyHistory(46, 30)).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('reads the table once per call', async () => {
    await SnapshotStore.dailyHistory(46, 7);

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
