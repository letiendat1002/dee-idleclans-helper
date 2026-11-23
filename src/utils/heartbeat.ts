import { writeFileSync } from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('HEARTBEAT');

/**
 * Where the bot records that it is alive.
 *
 * The container healthcheck reads the age of this file. `restart:
 * unless-stopped` restarts a process that exits, but it cannot see a process
 * that is still running and has stopped completing cycles.
 */
export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? '/tmp/dee-heartbeat';

/**
 * Stamp the heartbeat.
 *
 * Called when a poll cycle finishes, whatever its outcome: an upstream outage
 * must not look like a wedged process. A failed write is itself a health
 * signal, so it is logged instead of thrown.
 */
export function beat(file = HEARTBEAT_FILE, at = new Date()): void {
  try {
    writeFileSync(file, `${at.toISOString()}\n`);
  } catch (err) {
    logger.warn('heartbeat not written', { file, error: (err as Error).message });
  }
}
