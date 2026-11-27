import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));

import { InsightStore } from './InsightStore.js';

const NOW = new Date('2026-11-27T07:42:00Z');
const NEWEST = new Date('2026-11-27T06:00:00Z');
const HOUR_MS = 3_600_000;

/** The private guard that keeps a 5-minute tick from rescanning one hour. */
function resetScanGuard(): void {
  (InsightStore as unknown as { scannedHour: string | null }).scannedHour = null;
}

/** A `book_hourly` row as Postgres returns it: numbers as strings. */
function hour(
  itemId: number,
  value: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    item_id: String(itemId),
    hour: new Date(value),
    ask: '500',
    ask_low: '500',
    ask_high: '500',
    bid: '450',
    ask_volume: '1000',
    bid_volume: '500',
    samples: 30,
    ...overrides,
  };
}

/** `count` hourly rows ending at NEWEST, shaped by `askVolume(hoursFromEnd)`. */
function span(
  itemId: number,
  count: number,
  askVolume: (hoursFromEnd: number) => string,
  ask = '500'
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const hoursFromEnd = count - 1 - index;
    return hour(itemId, NEWEST.getTime() - hoursFromEnd * HOUR_MS, {
      ask,
      ask_volume: askVolume(hoursFromEnd),
    });
  });
}

/** 24 hourly rows ending at NEWEST: one day. */
function day(itemId: number, askVolume: (hoursFromEnd: number) => string, ask = '500'): Array<Record<string, unknown>> {
  return span(itemId, 24, askVolume, ask);
}

/**
 * Route the store's queries by their SQL.
 *
 * The store issues them concurrently, so a per-call sequence would be fragile;
 * matching on the statement keeps the fake readable.
 */
function route(options: {
  newest?: Date | null;
  rows?: Array<Record<string, unknown>>;
  names?: Array<{ item_id: number; name: string }>;
  inserted?: number;
  queued?: Array<Record<string, unknown>>;
  claimed?: number;
  expired?: number;
} = {}): void {
  const {
    newest = NEWEST,
    rows = [],
    names = [],
    inserted = 1,
    queued = [],
    claimed = 1,
    expired = 0,
  } = options;

  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT max(hour)')) return Promise.resolve({ rows: [{ hour: newest }], rowCount: 1 });
    if (sql.includes('FROM book_hourly WHERE hour >=')) return Promise.resolve({ rows, rowCount: rows.length });
    if (sql.includes('FROM items WHERE tradeable')) return Promise.resolve({ rows: names, rowCount: names.length });
    if (sql.includes('INSERT INTO insights')) return Promise.resolve({ rows: [], rowCount: inserted });
    if (sql.includes('FROM insights') && sql.includes("status = 'queued'") && sql.includes('ORDER BY score')) {
      return Promise.resolve({ rows: queued, rowCount: queued.length });
    }
    if (sql.includes('UPDATE insights')) return Promise.resolve({ rows: [], rowCount: claimed });
    if (sql.includes('DELETE FROM insights')) return Promise.resolve({ rows: [], rowCount: expired });
    if (sql.includes('SELECT count(*)')) return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

/** The `INSERT INTO insights` calls, as `[sql, params]`. */
function inserts(): Array<[string, unknown[]]> {
  return queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO insights')) as Array<
    [string, unknown[]]
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetScanGuard();
});

describe('InsightStore.produce', () => {
  it('does nothing before the first rollup', async () => {
    route({ newest: null });

    await expect(InsightStore.produce(NOW)).resolves.toEqual({ scanned: false, queued: 0 });
    expect(inserts()).toHaveLength(0);
  });

  it('queues a dry sell side with the impact rank of its volume', async () => {
    route({
      rows: [
        // The high-volume item, dry for the last 13 hours.
        ...span(1, 48, (i) => (i < 25 ? '0' : '5000')),
        // A steady item: no pattern, but it sets the volume floor.
        ...day(2, () => '1000'),
        // Not tradeable: never scored.
        ...day(3, () => '1000'),
      ],
      names: [
        { item_id: 1, name: 'Elite hammer' },
        { item_id: 2, name: 'Grapes' },
      ],
    });

    await expect(InsightStore.produce(NOW)).resolves.toEqual({ scanned: true, queued: 1 });

    const [[sql, params]] = inserts();
    expect(sql).toContain("status = 'sent'");
    expect(sql).toContain('ON CONFLICT (pattern, item_id) WHERE status = \'queued\' DO NOTHING');
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('dry_sell_side');
    expect(params[2]).toBe('off_board');
    // Highest volume of the two eligible items, so impact is 1 and the score is not zero.
    expect(params[3] as number).toBeGreaterThan(0);
    expect(params[3] as number).toBeLessThanOrEqual(1);
    expect(JSON.parse(params[4] as string)).toMatchObject({ name: 'Elite hammer', hours: 25 });

    // `items` is keyed `item_id`; `SELECT id` would throw at runtime and the mock cannot see it.
    const namesQuery = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM items'));
    expect(namesQuery?.[0]).toContain('SELECT item_id, name FROM items');
    expect(params[7]).toBe(72 * HOUR_MS);
  });

  it('skips an item without a day of coverage', async () => {
    route({
      rows: day(1, () => '0').slice(0, 5),
      names: [{ item_id: 1, name: 'Elite hammer' }],
    });

    await expect(InsightStore.produce(NOW)).resolves.toEqual({ scanned: true, queued: 0 });
    expect(inserts()).toHaveLength(0);
  });

  it('skips an item with too few snapshots', async () => {
    const rows = day(1, (i) => (i < 13 ? '0' : '5000')).map((row) => ({ ...row, samples: 1 }));

    route({ rows, names: [{ item_id: 1, name: 'Elite hammer' }] });

    await expect(InsightStore.produce(NOW)).resolves.toEqual({ scanned: true, queued: 0 });
    expect(inserts()).toHaveLength(0);
  });

  it('does not rescan an hour it already scanned', async () => {
    route({ rows: span(1, 48, (i) => (i < 25 ? '0' : '5000')), names: [{ item_id: 1, name: 'Elite hammer' }] });

    await InsightStore.produce(NOW);
    const insertsBefore = inserts().length;

    await expect(InsightStore.produce(NOW)).resolves.toEqual({ scanned: false, queued: 0 });
    expect(inserts()).toHaveLength(insertsBefore);
  });

  it('counts only the findings the queue accepted', async () => {
    route({
      rows: span(1, 48, (i) => (i < 25 ? '0' : '5000')),
      names: [{ item_id: 1, name: 'Elite hammer' }],
      inserted: 0,
    });

    await expect(InsightStore.produce(NOW)).resolves.toEqual({ scanned: true, queued: 0 });
  });
});

describe('InsightStore.claim', () => {
  const queuedRow = (id: string, itemId: number, pattern: string, score: string) => ({
    id,
    item_id: String(itemId),
    pattern,
    state: 'off_board',
    score,
    body: JSON.stringify({ name: 'Item', ask: 100 }),
    fired_at: NOW.toISOString(),
    window_end: NEWEST.toISOString(),
  });

  it('marks the picked rows sent before the post and parses their bodies', async () => {
    route({ queued: [queuedRow('1', 11, 'dry_sell_side', '0.9'), queuedRow('2', 12, 'dry_sell_side', '0.5')] });

    const claimed = await InsightStore.claim('20', 3);

    expect(claimed.map((row) => row.pattern)).toEqual(['dry_sell_side', 'dry_sell_side']);
    expect(claimed[0].body.name).toBe('Item');
    expect(claimed[0].itemId).toBe(11);

    const update = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE insights'));
    expect(update?.[1]).toEqual(['20', ['1', '2']]);
  });

  it('returns nothing and does not mark anything when the queue is empty', async () => {
    route({ queued: [] });

    await expect(InsightStore.claim('20', 3)).resolves.toEqual([]);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE insights'))).toBe(false);
  });

  it('never claims the same item twice', async () => {
    route({
      queued: [queuedRow('1', 11, 'dry_sell_side', '0.9'), queuedRow('2', 11, 'dry_sell_side', '0.8')],
    });

    const claimed = await InsightStore.claim('20', 3);

    expect(claimed.map((row) => row.id)).toEqual(['1']);
  });
});

describe('InsightStore housekeeping', () => {
  it('reports how many rows it expired', async () => {
    route({ expired: 4 });

    await expect(InsightStore.expire()).resolves.toBe(4);
  });

  it('counts the queue for the diagnostic log', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '7' }], rowCount: 1 });

    await expect(InsightStore.queuedCount()).resolves.toBe(7);
  });
});
