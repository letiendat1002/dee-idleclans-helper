import { describe, it, expect, vi, beforeEach } from 'vitest';

const { checkRateLimit, warn } = vi.hoisted(() => ({ checkRateLimit: vi.fn(), warn: vi.fn() }));

vi.mock('../cache/CacheService.js', () => ({
  cacheService: { checkRateLimit },
}));

vi.mock('./logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { DeeError } from './errors.js';
import { RateLimiter } from './RateLimiter.js';

const limiter = new RateLimiter();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RateLimiter', () => {
  it('spends the surface budget from the one limits table', async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

    await expect(limiter.check('user-1', 'watch')).resolves.toBeUndefined();

    expect(checkRateLimit).toHaveBeenCalledWith('user-1', 'watch', 5, 60_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws an ephemeral E1 error with the remaining time', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 2_500 });

    const error = await limiter.check('user-1', 'watch').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DeeError);
    const dee = error as DeeError;
    expect(dee.tier).toBe('E1');
    expect(dee.code).toBe('E1_004');
    expect(dee.ephemeral).toBe(true);
    expect(dee.message).toContain('3s');
    expect(dee.message).not.toContain('remaining');
  });

  it('logs the refusal, which is the only measure of the cap', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 2_500 });

    await limiter.check('user-1', 'watch').catch(() => undefined);

    expect(warn).toHaveBeenCalledWith('rate limited', {
      userId: 'user-1',
      command: 'watch',
      retryAfterMs: 2_500,
    });
  });

  it('uses the window as the retry delay when none is reported', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const error = (await limiter.check('user-1', 'watch').catch((err: unknown) => err)) as DeeError;

    expect(error.message).toContain('60s');
  });
});
