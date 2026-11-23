import { describe, it, expect, vi, beforeEach } from 'vitest';

const { client, pool } = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  pool: { connect: vi.fn(), end: vi.fn(), on: vi.fn() },
}));

// `function`, not an arrow: vitest 5 refuses to use an arrow mock as a constructor.
vi.mock('pg', () => ({ Pool: vi.fn(function () { return pool; }) }));

import { closePool, query } from './pool.js';

beforeEach(() => {
  vi.clearAllMocks();
  pool.connect.mockResolvedValue(client);
  client.query.mockResolvedValue({ rows: [1] });
});

describe('pool.query', () => {
  it('runs on a checked-out client and releases it', async () => {
    const result = await query('SELECT 1', [1]);

    expect(result).toEqual({ rows: [1] });
    expect(client.query).toHaveBeenCalledWith('SELECT 1', [1]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client when the query throws', async () => {
    client.query.mockRejectedValueOnce(new Error('boom'));

    await expect(query('SELECT 1')).rejects.toThrow('boom');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('closePool', () => {
  it('ends the pool', async () => {
    await closePool();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
