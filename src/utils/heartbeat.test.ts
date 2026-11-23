import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beat } from './heartbeat.js';

const dir = mkdtempSync(join(tmpdir(), 'dee-heartbeat-'));

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('beat', () => {
  it('stamps the file with the moment the cycle finished', () => {
    const file = join(dir, 'alive');

    beat(file, new Date('2026-11-15T12:00:00Z'));

    expect(readFileSync(file, 'utf8').trim()).toBe('2026-11-15T12:00:00.000Z');
  });

  it('does not throw when the file cannot be written, so a bad path is only a health signal', () => {
    expect(() => beat(join(dir, 'missing', 'alive'))).not.toThrow();
  });
});
