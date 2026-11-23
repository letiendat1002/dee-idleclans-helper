import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./logger.js', () => ({ createLogger: () => logger }));

import {
  DeeError,
  ErrCodes,
  fatalError,
  formatUnexpectedError,
  generateErrorId,
  userError,
} from './errors.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateErrorId', () => {
  it('returns six characters from the unambiguous alphabet', () => {
    for (let index = 0; index < 50; index++) {
      expect(generateErrorId()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

describe('formatUnexpectedError', () => {
  it('logs the context and the error and returns the same reference to the user', () => {
    const message = formatUnexpectedError('/watch', new Error('db down'));

    const reference = /Reference: \*\*([A-Z2-9]{6})\*\*/.exec(message)?.[1];
    expect(reference).toBeDefined();
    expect(message).toContain('Try again');
    expect(logger.error).toHaveBeenCalledWith(`[/watch] Error ${reference}`, {
      error: expect.stringContaining('db down'),
    });
  });

  it('handles a non-Error value', () => {
    const message = formatUnexpectedError('/help', 'a string');

    expect(message).toContain('🚨');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('/help'), { error: 'a string' });
  });
});

describe('DeeError', () => {
  it('defaults to ephemeral with the given tier and code', () => {
    const error = new DeeError('bad input', 'E1', ErrCodes.INVALID_INPUT);

    expect(error.name).toBe('DeeError');
    expect(error.tier).toBe('E1');
    expect(error.code).toBe('E1_002');
    expect(error.ephemeral).toBe(true);
  });

  it('builds the two helper tiers', () => {
    expect(userError('u', ErrCodes.USER_NOT_FOUND).tier).toBe('E1');
    expect(userError('u', ErrCodes.USER_NOT_FOUND).ephemeral).toBe(true);
    expect(fatalError('f', ErrCodes.CONFIG_MISSING).tier).toBe('E3');
    expect(fatalError('f', ErrCodes.CONFIG_MISSING).ephemeral).toBe(false);
  });
});
