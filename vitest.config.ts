/**
 * Test and coverage configuration.
 *
 * `src/index.ts` (process entry: creates the client, logs in, installs signal
 * handlers) and `src/db/migrate.ts` (runs on import) are excluded because they
 * cannot be exercised without starting the real process or a real database.
 * Everything else under `src/` counts.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/db/migrate.ts'],
    },
  },
});
