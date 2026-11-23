import fs from 'fs';
import path from 'path';
import { pool } from './pool.js';
import { advisoryLock, advisoryUnlock, MIGRATION_LOCK_KEY } from './advisory.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MIGRATE');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations(): Promise<void> {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  logger.info(`Found ${files.length} migration file(s)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const version = file.replace('.sql', '');
    try {
      const result = await pool.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );
      if (result.rows.length > 0) {
        logger.info(`Skipping ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      logger.info(`Applying ${file}...`);
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );
      logger.info(`Applied ${file} ✓`);
    } catch (err) {
      logger.error(`FAILED ${file}`, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  logger.info('All migrations complete');
}

export async function migrate(): Promise<void> {
  const conn = await pool.connect();
  try {
    // The bot and the collector both migrate at boot. The session lock makes the
    // second one wait for the first instead of applying the same files twice.
    await advisoryLock(conn, MIGRATION_LOCK_KEY);
    await runMigrations();
  } finally {
    try {
      await advisoryUnlock(conn, MIGRATION_LOCK_KEY);
    } finally {
      conn.release();
    }
  }
}

// Run only when this file is the entry point; `src/index.ts` imports and calls `migrate()` itself.
if (require.main === module) {
  migrate()
    .catch((err: unknown) => {
      logger.error('Migration failed', { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    })
    .finally(() => pool.end())
    .catch((err: unknown) => {
      logger.error('Failed to close the database pool', { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    });
}
