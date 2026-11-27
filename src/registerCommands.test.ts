import { describe, it, expect, vi, beforeEach } from 'vitest';

const { put, logger } = vi.hoisted(() => {
  process.env.DISCORD_TOKEN = 'token';
  process.env.DISCORD_CLIENT_ID = 'client-1';
  return {
    put: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('./utils/logger.js', () => ({ createLogger: () => logger }));

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  class FakeREST {
    setToken(): this {
      return this;
    }
    put(route: string, options: unknown): Promise<unknown> {
      return put(route, options);
    }
  }
  return { ...actual, REST: FakeREST };
});

import { Routes } from 'discord.js';
import { registerCommands } from './registerCommands.js';

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue([]);
});

describe('registerCommands', () => {
  it('registers the nine commands globally and clears every joined guild', async () => {
    await registerCommands(['guild-1', 'guild-2']);

    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[0][0]).toBe(Routes.applicationCommands('client-1'));

    const globalBody = put.mock.calls[0][1].body as Array<{ name: string }>;
    expect(globalBody.map((command) => command.name)).toEqual([
      'watch',
      'unwatch',
      'watchlist',
      'graph',
      'price',
      'digest',
      'insight',
      'vault',
      'help',
    ]);
    expect(put.mock.calls[1][0]).toBe(Routes.applicationGuildCommands('client-1', 'guild-1'));
    expect(put.mock.calls[2][0]).toBe(Routes.applicationGuildCommands('client-1', 'guild-2'));
    expect(put.mock.calls[1][1].body).toEqual([]);
    expect(put.mock.calls[2][1].body).toEqual([]);
  });

  it('logs both registrations', async () => {
    await registerCommands(['guild-1']);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Registered 9 commands'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 guild'), { guildIds: ['guild-1'] });
  });
});
