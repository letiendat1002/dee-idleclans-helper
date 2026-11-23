/**
 * Session-scoped Postgres advisory locks.
 *
 * A session lock lives on the connection that took it, so the caller must keep
 * that one connection open for as long as the lock should hold — `pool.query()`
 * may hand out a different connection and would silently not own the lock.
 */
export interface LockConn {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** One collector at a time: a second writer would double every quote. */
export const COLLECTOR_LOCK_KEY = 7_412_001;

/** Serialises migrations, so two processes starting together cannot diverge. */
export const MIGRATION_LOCK_KEY = 7_412_002;

/** Take the lock, or report that someone else holds it. */
export async function tryAdvisoryLock(conn: LockConn, key: number): Promise<boolean> {
  const res = await conn.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
  const rows = res.rows as Array<{ locked?: boolean }>;
  return rows[0]?.locked === true;
}

/** Wait for the lock; used where waiting is cheaper than failing. */
export async function advisoryLock(conn: LockConn, key: number): Promise<void> {
  await conn.query('SELECT pg_advisory_lock($1)', [key]);
}

/** Release a lock this connection holds. */
export async function advisoryUnlock(conn: LockConn, key: number): Promise<void> {
  await conn.query('SELECT pg_advisory_unlock($1)', [key]);
}
