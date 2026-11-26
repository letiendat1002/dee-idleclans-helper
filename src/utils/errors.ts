import { createLogger } from './logger.js';
import { ICONS } from '../ui/theme.js';

// Error Tiers
// E1: User Error (invalid input, permissions, business rules) — ephemeral reply
// E2: System Error (DB failure, cache miss, external timeout) — log + notify
// E3: Fatal Error (data corruption, uncaught, config missing) — log + graceful shutdown

const ERROR_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const logger = createLogger('ERRORS');

/**
 * Generate a short unique error ID for support reference.
 * Format: 6 uppercase alphanumeric characters (e.g. "A3F7K9")
 */
export function generateErrorId(): string {
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += ERROR_ID_CHARS[Math.floor(Math.random() * ERROR_ID_CHARS.length)];
  }
  return result;
}

/**
 * Format an unexpected error for user-facing display.
 * Always call this in catch blocks so errors are logged with an ID
 * and the user gets a reference they can report.
 */
export function formatUnexpectedError(context: string, err: unknown): string {
  const id = generateErrorId();
  logger.error(`[${context}] Error ${id}`, {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  return `${ICONS.warning} An unexpected error occurred. Reference: **${id}**. Try again; if it keeps failing, send this reference to an admin.`;
}

export class DeeError extends Error {
  constructor(
    message: string,
    public tier: 'E1' | 'E2' | 'E3',
    public code: string,
    public ephemeral = true
  ) {
    super(message);
    this.name = 'DeeError';
  }
}

// Common error codes
export const ErrCodes = {
  // E1 — User errors
  USER_NOT_FOUND:   'E1_001',
  INVALID_INPUT:    'E1_002',
  PERMISSION_DENIED:'E1_003',
  RATE_LIMIT:       'E1_004',

  // E2 — System errors
  DB_CONNECTION_FAILED:   'E2_001',
  REDIS_CONNECTION_FAILED:'E2_002',
  CACHE_WRITE_FAILED:     'E2_003',
  API_REQUEST_FAILED:     'E2_004',

  // E3 — Fatal errors
  UNHANDLED_EXCEPTION:    'E3_001',
  CONFIG_MISSING:         'E3_002',
} as const;

// Helper constructors
export function userError(msg: string, code: string): DeeError {
  return new DeeError(msg, 'E1', code, true);
}

export function fatalError(msg: string, code: string): DeeError {
  return new DeeError(msg, 'E3', code, false);
}
