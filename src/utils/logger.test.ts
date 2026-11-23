import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createLogger } from './logger.js';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  delete process.env.LOG_LEVEL;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('formats level, tag, message and JSON metadata', () => {
    createLogger('TAG').info('hello', { a: 1 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
    expect(line).toContain('[INFO] [TAG] hello {"a":1}');
  });

  it('omits the metadata suffix when there is none', () => {
    createLogger('TAG').info('hello');

    expect(String(logSpy.mock.calls[0][0])).toMatch(/\[INFO\] \[TAG\] hello$/);
  });

  it('suppresses debug at the default info level', () => {
    createLogger('TAG').debug('hidden');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('routes warn and error to their console streams', () => {
    const logger = createLogger('TAG');
    logger.warn('w');
    logger.error('e');

    expect(String(warnSpy.mock.calls[0][0])).toContain('[WARN] [TAG] w');
    expect(String(errorSpy.mock.calls[0][0])).toContain('[ERROR] [TAG] e');
  });

  it('emits debug when LOG_LEVEL is debug', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { createLogger: freshFactory } = await import('./logger.js');

    freshFactory('TAG').debug('visible');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('[DEBUG] [TAG] visible');
  });
});
