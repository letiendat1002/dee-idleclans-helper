import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, redis, redisOptions } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redisOptions: {} as Record<string, unknown>,
  redis: {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    keys: vi.fn(),
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    zrange: vi.fn(),
    zadd: vi.fn(),
    expire: vi.fn(),
    eval: vi.fn(),
    on: vi.fn(),
  },
}));

// `function`, not an arrow: vitest 5 refuses to use an arrow mock as a constructor.
vi.mock('ioredis', () => ({
  default: vi.fn(function (_url: string, options: Record<string, unknown>) {
    Object.assign(redisOptions, options);
    return redis;
  }),
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));

import { CacheService, reconnectDelay } from './CacheService.js';

const cache = new CacheService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CacheService.get / set / del', () => {
  it('returns the parsed value', async () => {
    redis.get.mockResolvedValue('{"a":1}');

    await expect(cache.get('k')).resolves.toEqual({ a: 1 });
  });

  it('returns null for a missing key', async () => {
    redis.get.mockResolvedValue(null);

    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('fails open when Redis throws', async () => {
    redis.get.mockRejectedValue(new Error('down'));

    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('stores JSON with a TTL', async () => {
    await cache.set('k', { a: 1 }, 60);

    expect(redis.setex).toHaveBeenCalledWith('k', 60, '{"a":1}');
  });

  it('swallows a write failure', async () => {
    redis.setex.mockRejectedValue(new Error('down'));

    await expect(cache.set('k', 1, 60)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('deletes a key and swallows a failure', async () => {
    await cache.del('k');
    expect(redis.del).toHaveBeenCalledWith('k');

    redis.del.mockRejectedValue(new Error('down'));
    await expect(cache.del('k')).resolves.toBeUndefined();
  });
});

describe('CacheService.checkRateLimit', () => {
  it('decides in one atomic round trip and returns the remaining count', async () => {
    redis.eval.mockResolvedValue([1, 2, 0]);

    const result = await cache.checkRateLimit('user-1', 'watch', 5, 60_000);

    expect(result).toEqual({ allowed: true, remaining: 2 });
    expect(redis.eval).toHaveBeenCalledTimes(1);

    const [script, numKeys, key, _now, windowMs, maxRequests] = redis.eval.mock.calls[0];
    expect(String(script)).toContain('ZREMRANGEBYSCORE');
    expect(numKeys).toBe(1);
    expect(key).toBe('dee:ratelimit:watch:user-1');
    expect(windowMs).toBe(60_000);
    expect(maxRequests).toBe(5);
  });

  it('records each call with a unique member, even in the same millisecond', async () => {
    redis.eval.mockResolvedValue([1, 1, 0]);

    await cache.checkRateLimit('user-1', 'watch', 5, 60_000);
    await cache.checkRateLimit('user-1', 'watch', 5, 60_000);

    const members = redis.eval.mock.calls.map((call) => String(call[6]));
    expect(members[0]).not.toBe(members[1]);
    expect(members[0]).toMatch(/^\d+:[a-z0-9]+$/);
  });

  it('reports the retry delay the script computed when it refuses', async () => {
    redis.eval.mockResolvedValue([0, 0, 4321]);

    const result = await cache.checkRateLimit('user-1', 'watch', 5, 60_000);

    expect(result).toEqual({ allowed: false, remaining: 0, retryAfterMs: 4321 });
  });

  it('fails open when Redis throws', async () => {
    redis.eval.mockRejectedValue(new Error('down'));

    const result = await cache.checkRateLimit('user-1', 'watch', 5, 60_000);

    expect(result).toEqual({ allowed: true, remaining: 5 });
  });
});

describe('reconnectDelay', () => {
  it('keeps retrying after a Redis restart instead of giving up', () => {
    expect(reconnectDelay(1)).toBe(500);
    expect(reconnectDelay(3)).toBe(1500);
  });

  it('caps the wait so a long outage is retried every ten seconds', () => {
    expect(reconnectDelay(50)).toBe(10_000);
    expect(reconnectDelay(10_000)).toBe(10_000);
  });

  it('is the strategy the client is built with', () => {
    expect(redisOptions.retryStrategy).toBe(reconnectDelay);
  });
});
