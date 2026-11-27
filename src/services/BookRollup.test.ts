import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));

import { BookRollup } from './BookRollup.js';

/** 2026-11-27 07:42 UTC: the last closed hour starts at 07:00. */
const NOW = new Date('2026-11-27T07:42:00Z');
const LAST_CLOSED = new Date('2026-11-27T07:00:00Z');
const HOUR_MS = 3_600_000;

/** Answer the `max(hour)` probe, then the upsert. */
function respond(newest: Date | null, written = 12): void {
  queryMock
    .mockResolvedValueOnce({ rows: [{ hour: newest }] })
    .mockResolvedValueOnce({ rowCount: written, rows: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BookRollup.run', () => {
  it('backfills the whole raw window on the first run', async () => {
    respond(null);

    const result = await BookRollup.run(NOW);

    expect(result).toEqual({ done: true, hours: 30 * 24 });
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toContain('INSERT INTO book_hourly');
    expect(sql).toContain('ON CONFLICT (item_id, hour) DO UPDATE');
    expect(params[0]).toEqual(new Date(LAST_CLOSED.getTime() - 30 * 24 * HOUR_MS));
    expect(params[1]).toEqual(LAST_CLOSED);
  });

  it('recomputes only the recent hours once the table has memory', async () => {
    respond(new Date(LAST_CLOSED.getTime() - 6 * HOUR_MS));

    const result = await BookRollup.run(NOW);

    expect(result).toEqual({ done: true, hours: 48 });
    expect(queryMock.mock.calls[1][1][0]).toEqual(new Date(LAST_CLOSED.getTime() - 48 * HOUR_MS));
  });

  it('does nothing when the last closed hour is already rolled up', async () => {
    respond(new Date(LAST_CLOSED.getTime() - HOUR_MS));

    const result = await BookRollup.run(NOW);

    expect(result).toEqual({ done: false, hours: 0 });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('treats a null rowCount as zero rows written', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ hour: null }] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] });

    await expect(BookRollup.run(NOW)).resolves.toEqual({ done: true, hours: 720 });
  });
});
