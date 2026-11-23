import Redis from 'ioredis';
import dotenv from 'dotenv';
import { createLogger } from '../utils/logger.js';

dotenv.config();

const logger = createLogger('CACHE');

/** The reconnect delay stops doubling here, so a long outage is retried every 10 s. */
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * The sliding-window rate limit as one atomic script.
 *
 * Five separate round trips let two overlapping callers both read
 * `count = max - 1` and both be admitted, so a burst could exceed the limit by
 * the number of callers that raced. Doing the prune, the count, the decision
 * and the write inside one script makes the check atomic; Redis runs a script
 * to completion before it serves the next command.
 *
 * Returns `{ allowed, remaining, retryAfterMs }`. The clock is the caller's, so
 * this assumes one bot process — true today, and the reason the window is not
 * derived server-side.
 */
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = tonumber(redis.call('ZCARD', key))

if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = window
  if oldest[2] then
    retry_after = tonumber(oldest[2]) + window - now
    if retry_after < 0 then retry_after = 0 end
  end
  return { 0, 0, retry_after }
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return { 1, max - count - 1, 0 }
`;

/**
 * The delay before the next reconnect attempt.
 *
 * A Redis restart must not end the connection for good: without a strategy,
 * ioredis gives up after the first failure and every later call fails silently
 * (this module is fail-open by design). Commands still fail fast while the
 * connection is down, because `maxRetriesPerRequest` is 0.
 */
export function reconnectDelay(times: number): number {
  return Math.min(times * 500, MAX_RETRY_DELAY_MS);
}

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 0,
  retryStrategy: reconnectDelay,
  connectTimeout: 2000,
});

redis.on('error', (err) => logger.warn('Redis unavailable (fail-open)', { message: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

/**
 * How long a cached entry lives, in seconds.
 *
 * The catalogue sync already deletes this key, so the TTL is only a safety
 * net; a short one would reload the 1009-row index more often than the data
 * changes.
 */
export const TTL = {
  catalogueIndex: 40 * 60,
} as const;

export class CacheService {
  async get<T>(key: string): Promise<T | null> {
    try {
      const val = await redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch (err) {
      logger.warn(`Failed to set cache key ${key}`, { error: (err as Error).message });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (err) {
      logger.warn(`Failed to delete cache key ${key}`, { error: (err as Error).message });
    }
  }

  async checkRateLimit(
    userId: string,
    command: string,
    maxRequests = 10,
    windowMs = 60_000
  ): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
    const key = `dee:ratelimit:${command}:${userId}`;
    const now = Date.now();

    try {
      const result = (await redis.eval(
        RATE_LIMIT_SCRIPT,
        1,
        key,
        now,
        windowMs,
        maxRequests,
        // A unique member per call: String(now) collides within one millisecond.
        `${now}:${Math.random().toString(36).slice(2)}`
      )) as [number, number, number];

      const [allowed, remaining, retryAfterMs] = result;
      if (allowed !== 1) return { allowed: false, remaining: 0, retryAfterMs };

      return { allowed: true, remaining };
    } catch (err) {
      logger.warn('Rate limit check failed, allowing request', { error: (err as Error).message });
      return { allowed: true, remaining: maxRequests };
    }
  }
}

export const cacheService = new CacheService();

export const CacheKeys = {
  catalogueIndex: 'dee:catalogue:index',
} as const;
