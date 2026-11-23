import dotenv from 'dotenv';
dotenv.config();

import { pool, closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { COLLECTOR_LOCK_KEY, tryAdvisoryLock, advisoryUnlock } from './db/advisory.js';
import { MarketService } from './services/MarketService.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('COLLECTOR');

/** Poll cadence; override with `POLL_INTERVAL_MS` on a slow host. */
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 120_000);

/**
 * Collect market quotes without Discord.
 *
 * This used to start inside `clientReady`, so a failed login, a gateway outage
 * or an image rebuild stopped collection while the data kept aging. The bot no
 * longer polls; one collector owns the write path and holds a session lock so a
 * second one cannot double every quote.
 */
async function main(): Promise<void> {
  // Strict on purpose: polling against a schema older than the code writes
  // rows the readers cannot interpret, so a failed migration must stop us.
  await migrate();

  const conn = await pool.connect();
  if (!(await tryAdvisoryLock(conn, COLLECTOR_LOCK_KEY))) {
    conn.release();
    logger.error('another collector holds the market lock, exiting');
    process.exit(1);
  }

  await MarketService.start(POLL_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} — stopping the collector`);
    await MarketService.stop();
    try {
      await advisoryUnlock(conn, COLLECTOR_LOCK_KEY);
    } finally {
      conn.release();
      await closePool();
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled rejection', { error: reason });
  });
}

main().catch((err: unknown) => {
  logger.error('collector failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
