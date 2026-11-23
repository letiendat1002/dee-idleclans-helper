import dotenv from 'dotenv';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { createLogger } from '../utils/logger.js';

dotenv.config();

const logger = createLogger('DB');

/**
 * The connection pool, with the guards a single-process bot needs.
 *
 * - `max` caps connections so a slow query burst cannot exhaust the server's slots.
 * - `statement_timeout` makes the server abandon a stuck query instead of pinning
 *   a connection until the next restart.
 * - `query_timeout` is the client-side twin: if the socket hangs, the promise still
 *   rejects and the command answers instead of waiting forever.
 * - `idleTimeoutMillis` closes idle connections so the database can restart under us.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'dee-idleclans-helper',
  max: Number(process.env.PG_POOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  query_timeout: 20_000,
});

/**
 * An idle client can error after a database restart or a network blip. Without a
 * listener, pg emits `error` on the pool and Node treats it as an unhandled
 * emitter error, which ends the process. Logging it keeps the bot alive: the next
 * query checks out a fresh connection.
 */
pool.on('error', (err) => {
  logger.error('Idle database client failed', { message: err.message });
});

/**
 * Run one statement on a checked-out client.
 *
 * Typed by the caller (`query<Row>(...)`) so a row shape is declared once, at the
 * query, instead of being cast onto the result at every call site.
 */
export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    return await client.query<Row>(text, params);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
