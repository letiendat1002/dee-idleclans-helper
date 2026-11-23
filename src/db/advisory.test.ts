import { describe, it, expect } from 'vitest';
import {
  tryAdvisoryLock,
  advisoryLock,
  advisoryUnlock,
  COLLECTOR_LOCK_KEY,
  type LockConn,
} from './advisory.js';

/** Records the SQL it was asked to run and answers with a scripted result. */
function fakeConn(locked: boolean): LockConn & { calls: Array<{ sql: string; values?: unknown[] }> } {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: sql.includes('pg_try_advisory_lock') ? [{ locked }] : [] };
    },
  };
}

describe('advisory locks', () => {
  it('reports whether the collector lock was taken, with the key bound as a parameter', async () => {
    const free = fakeConn(true);
    expect(await tryAdvisoryLock(free, COLLECTOR_LOCK_KEY)).toBe(true);
    expect(free.calls[0]?.values).toEqual([COLLECTOR_LOCK_KEY]);

    const taken = fakeConn(false);
    expect(await tryAdvisoryLock(taken, COLLECTOR_LOCK_KEY)).toBe(false);
  });

  it('waits on the blocking variant and releases with the same key', async () => {
    const conn = fakeConn(true);
    await advisoryLock(conn, COLLECTOR_LOCK_KEY);
    await advisoryUnlock(conn, COLLECTOR_LOCK_KEY);

    expect(conn.calls.map((c) => c.sql)).toEqual([
      'SELECT pg_advisory_lock($1)',
      'SELECT pg_advisory_unlock($1)',
    ]);
    expect(conn.calls[1]?.values).toEqual([COLLECTOR_LOCK_KEY]);
  });
});
