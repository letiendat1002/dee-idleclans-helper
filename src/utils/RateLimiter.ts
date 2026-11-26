/**
 * Discord-aware rate limiter using a Redis sliding window.
 * Applies per-user, per-command rate limits with graceful degradation.
 */
import { cacheService } from '../cache/CacheService.js';
import { createLogger } from './logger.js';
import { DeeError, ErrCodes } from '../utils/errors.js';
import { ICONS } from '../ui/theme.js';

const logger = createLogger('RATE');

/**
 * The per-user budget of every limited surface, in one table.
 *
 * Five a minute is one player comparing a handful of items: high enough that a
 * normal session never meets it, low enough that a script cannot spend the
 * upstream budget. `share` spends its row on the channel post, not on a query.
 *
 * A name missing from this table cannot be limited, so add the row before
 * wiring `check()` into a surface.
 */
export const LIMITS = {
  price: { max: 5, windowMs: 60_000 },
  graph: { max: 5, windowMs: 60_000 },
  watch: { max: 5, windowMs: 60_000 },
  unwatch: { max: 5, windowMs: 60_000 },
  watchlist: { max: 5, windowMs: 60_000 },
  digest: { max: 5, windowMs: 60_000 },
  vault: { max: 5, windowMs: 60_000 },
  share: { max: 5, windowMs: 60_000 },
} as const;

/** A surface with a budget in `LIMITS`. */
export type LimitName = keyof typeof LIMITS;

export class RateLimiter {
  /**
   * Check if a user is within the budget of a surface.
   *
   * Throws DeeError (E1, ephemeral) when refused, and logs the refusal: it is
   * the only measurement of whether the cap is right for real usage.
   * Allows the request if Redis is unavailable (fail-open).
   */
  async check(userId: string, command: LimitName): Promise<void> {
    const { max, windowMs } = LIMITS[command];
    const { allowed, retryAfterMs } = await cacheService.checkRateLimit(
      userId,
      command,
      max,
      windowMs
    );

    if (!allowed) {
      const seconds = Math.ceil((retryAfterMs ?? windowMs) / 1000);
      logger.warn('rate limited', { userId, command, retryAfterMs });
      throw new DeeError(
        `${ICONS.clock} Slow down. Try again in **${seconds}s**.`,
        'E1',
        ErrCodes.RATE_LIMIT,
        true // ephemeral
      );
    }
  }
}

export const rateLimiter = new RateLimiter();
