import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIEmbed, MessageCreateOptions } from 'discord.js';

const { queryMock, logger, itemsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  itemsMock: vi.fn(),
}));

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  pool: { connect: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => logger,
}));

vi.mock('../services/ItemCatalogue.js', () => ({
  ItemCatalogue: { getByIds: itemsMock },
}));

// The trade averages are context: these tests model a game that published none.
vi.mock('../services/IdleClansApi.js', () => ({
  getPriceAverages: vi.fn(async () => null),
}));

import { AlertDispatcher, type AlertClient } from './AlertDispatcher.js';
import { ICONS } from '../ui/theme.js';

/** One row of the `watchlists` table, as Postgres returns it. */
interface WatchFixture {
  id?: number;
  itemId: number;
  direction: 'below' | 'above';
  threshold: number;
  armed: boolean;
  delivered?: boolean;
}

/** One row of the newest snapshot per item. */
interface QuoteFixture {
  itemId: number;
  ask: number | null;
  askVolume?: number | null;
}

/** One point of the 24h ask history. */
interface HistoryFixture {
  item_id: number;
  ask: number;
}

/** The UPDATE statements the dispatcher issued, in order. */
let updates: Array<{ sql: string; params: unknown[] }> = [];

/** Turn a fixture into the row WatchlistService reads back. */
function watch(fixture: WatchFixture): Record<string, unknown> {
  return {
    id: fixture.id ?? 1,
    discord_user_id: '111111111111111111',
    guild_id: null,
    item_id: fixture.itemId,
    direction: fixture.direction,
    threshold: fixture.threshold,
    armed: fixture.armed,
    delivered: fixture.delivered ?? true,
    last_fired_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

/** Route the queries the dispatcher and its readers make to the fixture. */
function install(scenario: {
  rows: Record<string, unknown>[];
  quotes: QuoteFixture[];
  history?: HistoryFixture[];
  snapshotAt?: Date | null;
}): void {
  updates = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE watchlists')) {
      updates.push({ sql, params: params ?? [] });
      return { rowCount: 1 };
    }
    if (/MAX\(captured_at\)/.test(sql)) {
      return { rows: [{ captured_at: scenario.snapshotAt === undefined ? new Date() : scenario.snapshotAt }] };
    }
    if (/FROM watchlists ORDER BY id/.test(sql)) return { rows: scenario.rows };
    if (/unnest\(\$1::int\[\]\)/.test(sql)) {
      return {
        rows: scenario.quotes.map((quote) => ({
          item_id: quote.itemId,
          ask: quote.ask,
          bid: null,
          ask_volume: quote.askVolume ?? null,
          bid_volume: null,
        })),
      };
    }
    if (/SELECT item_id, ask FROM price_snapshots/.test(sql)) return { rows: scenario.history ?? [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

/** A fake Discord client and the spies behind it. */
function fakeClient(): {
  client: AlertClient;
  createDM: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn<(payload: MessageCreateOptions) => Promise<void>>();
  send.mockResolvedValue(undefined);
  const createDM = vi.fn<(userId: string) => Promise<{ send: typeof send }>>();
  createDM.mockResolvedValue({ send });

  return { client: { users: { createDM } }, createDM, send };
}

/** The JSON of the first embed of a DM payload. */
function sentEmbed(payload: MessageCreateOptions | undefined): APIEmbed {
  const first = payload?.embeds?.[0];
  if (!first) throw new Error('no embed was sent');
  if ('toJSON' in first) return first.toJSON();
  return first;
}

beforeEach(() => {
  itemsMock.mockReset();
  itemsMock.mockResolvedValue(new Map([[46, { name: 'Titanium bar' }]]));
});

describe('AlertDispatcher.run', () => {
  it('fires once, disarms the row and records the delivery', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_199, askVolume: 9_243 }],
      history: [
        { item_id: 46, ask: 3_322 },
        { item_id: 46, ask: 3_400 },
      ],
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result).toEqual({ evaluated: 1, fired: 1, dmBlocked: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/armed = FALSE, last_fired_at = \$2, delivered = \$3/);
    expect(updates[0].params[1]).toBeInstanceOf(Date);
    expect(updates[0].params[2]).toBe(true);
  });

  it('reads the watched items, not every quoted item', async () => {
    install({
      rows: [
        watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
        watch({ itemId: 46, direction: 'above', threshold: 4_000, armed: true }),
        watch({ itemId: 12, direction: 'below', threshold: 90, armed: true }),
      ],
      quotes: [{ itemId: 46, ask: 3_300 }, { itemId: 12, ask: 95 }],
    });
    const { client } = fakeClient();

    await AlertDispatcher.run(client, { pacingMs: 0 });

    const call = queryMock.mock.calls.find(([sql]) => String(sql).includes('unnest($1::int[])'));
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual([[46, 12]]);
  });

  it('does not fire again while the price stays below the threshold', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: false })],
      quotes: [{ itemId: 46, ask: 3_199 }],
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result).toEqual({ evaluated: 1, fired: 0, dmBlocked: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('re-arms when the price returns above the threshold, and sends nothing', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: false })],
      quotes: [{ itemId: 46, ask: 3_300 }],
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result).toEqual({ evaluated: 1, fired: 0, dmBlocked: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/armed = TRUE/);
  });

  it('never fires a below alert while the price is above the threshold', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_300 }],
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result.fired).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('fires an above alert only on an upward crossing', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'above', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_300 }],
    });
    const up = fakeClient();
    expect((await AlertDispatcher.run(up.client, { pacingMs: 0 })).fired).toBe(1);

    install({
      rows: [watch({ itemId: 46, direction: 'above', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_100 }],
    });
    const down = fakeClient();
    expect((await AlertDispatcher.run(down.client, { pacingMs: 0 })).fired).toBe(0);
    expect(down.send).not.toHaveBeenCalled();
  });

  it('uses a strict comparison, so a threshold equal to the current ask does not fire', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_200 }],
    });
    const armed = fakeClient();
    expect((await AlertDispatcher.run(armed.client, { pacingMs: 0 })).fired).toBe(0);
    expect(armed.send).not.toHaveBeenCalled();

    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: false })],
      quotes: [{ itemId: 46, ask: 3_200 }],
    });
    const disarmed = fakeClient();
    await AlertDispatcher.run(disarmed.client, { pacingMs: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/armed = TRUE/);
  });

  it('ignores a row whose item has no ask, and a zero ask, without changing state', async () => {
    install({
      rows: [watch({ id: 1, itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: null }],
    });
    const missing = fakeClient();
    expect((await AlertDispatcher.run(missing.client, { pacingMs: 0 })).fired).toBe(0);

    install({
      rows: [watch({ id: 1, itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 0 }],
    });
    const zero = fakeClient();
    expect((await AlertDispatcher.run(zero.client, { pacingMs: 0 })).fired).toBe(0);

    expect(updates).toHaveLength(0);
  });

  it('marks a blocked DM as undelivered and never re-arms it', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_199 }],
    });
    const createDM = vi.fn<(userId: string) => Promise<{ send: (payload: MessageCreateOptions) => Promise<unknown> }>>();
    createDM.mockRejectedValue(new Error('50007 Cannot send messages to this user'));
    const client: AlertClient = { users: { createDM } };

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result).toEqual({ evaluated: 1, fired: 0, dmBlocked: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/armed = FALSE/);
    expect(updates[0].params[2]).toBe(false);

    // The price returns, but the row never delivered: it must wait for /watch.
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: false, delivered: false })],
      quotes: [{ itemId: 46, ask: 3_300 }],
    });
    const retry = fakeClient();
    await AlertDispatcher.run(retry.client, { pacingMs: 0 });
    expect(updates).toHaveLength(0);
  });

  it('shows the item, the threshold, the current ask, the 24h average and range, and the volume', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_199, askVolume: 9_243 }],
      history: [
        { item_id: 46, ask: 3_322 },
        { item_id: 46, ask: 3_400 },
      ],
    });
    const { client, send } = fakeClient();

    await AlertDispatcher.run(client, { pacingMs: 0 });

    const embed = sentEmbed(send.mock.calls[0][0]);
    expect(embed.title).toBe('Price Alert — Titanium bar');
    expect(embed.description?.startsWith(ICONS.down)).toBe(true);
    expect(embed.description).toContain('the sell price fell below your **3,200g** threshold');
    expect(embed.description).toContain('**3,199g** — the sell price fell below');
    expect(embed.description).toContain('avg sell price (2 snapshots) 3,361');
    expect(embed.description).toContain('range 3,322g–3,400g');
    expect(embed.description).toContain('volume 9,243');
    expect(embed.description).toContain('goes back above 3,200g');
  });

  it('caps the DMs of one run and leaves the rest armed', async () => {
    install({
      rows: [
        watch({ id: 1, itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
        watch({ id: 2, itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
      ],
      quotes: [{ itemId: 46, ask: 3_199 }],
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0, maxDms: 1 });

    expect(result).toEqual({ evaluated: 2, fired: 1, dmBlocked: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });

  it('does nothing when no alert is armed', async () => {
    install({ rows: [], quotes: [] });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result).toEqual({ evaluated: 0, fired: 0, dmBlocked: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('paces the second DM by the injected interval', async () => {
    vi.useFakeTimers();
    try {
      install({
        rows: [
          watch({ id: 1, itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
          watch({ id: 2, itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
        ],
        quotes: [{ itemId: 46, ask: 3_199 }],
      });
      const { client, send } = fakeClient();

      const run = AlertDispatcher.run(client, { pacingMs: 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await run;
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the 24h history of every watched item in one query', async () => {
    install({
      rows: [
        watch({ id: 1, itemId: 46, direction: 'below', threshold: 3_200, armed: false }),
        watch({ id: 2, itemId: 135, direction: 'below', threshold: 100, armed: false }),
      ],
      quotes: [{ itemId: 46, ask: 3_300 }, { itemId: 135, ask: 200 }],
    });
    const { client } = fakeClient();

    await AlertDispatcher.run(client, { pacingMs: 0 });

    const historyCalls = queryMock.mock.calls.filter(([sql]) =>
      /SELECT item_id, ask FROM price_snapshots/.test(String(sql))
    );
    expect(historyCalls).toHaveLength(1);
  });

  it("re-arms an 'above' alert when the ask falls back to the threshold", async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'above', threshold: 3_200, armed: false })],
      quotes: [{ itemId: 46, ask: 3_100 }],
    });
    const { client, send } = fakeClient();

    await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/armed = TRUE/);
  });

  it('counts a failed DM attempt against the per-run cap', async () => {
    install({
      rows: [
        watch({ id: 1, itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
        watch({ id: 2, itemId: 46, direction: 'below', threshold: 3_200, armed: true }),
      ],
      quotes: [{ itemId: 46, ask: 3_199 }],
    });
    const createDM = vi.fn<(userId: string) => Promise<never>>();
    createDM.mockRejectedValue(new Error('50007 Cannot send messages to this user'));
    const client: AlertClient = { users: { createDM } };

    const result = await AlertDispatcher.run(client, { pacingMs: 0, maxDms: 1 });

    expect(result).toEqual({ evaluated: 2, fired: 0, dmBlocked: 1 });
    expect(createDM).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].params[2]).toBe(false);
  });

  it('does not fire on a stale snapshot', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_199 }],
      snapshotAt: new Date(Date.now() - 11 * 60_000),
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result).toEqual({ evaluated: 1, fired: 0, dmBlocked: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('does not fire when no snapshot exists at all', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'below', threshold: 3_200, armed: true })],
      quotes: [{ itemId: 46, ask: 3_199 }],
      snapshotAt: null,
    });
    const { client, send } = fakeClient();

    const result = await AlertDispatcher.run(client, { pacingMs: 0 });

    expect(result.fired).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('renders an above alert without history or volume', async () => {
    install({
      rows: [watch({ itemId: 46, direction: 'above', threshold: 3_000, armed: true })],
      quotes: [{ itemId: 46, ask: 3_100, askVolume: null }],
    });
    const { client, send } = fakeClient();

    await AlertDispatcher.run(client, { pacingMs: 0 });

    const embed = sentEmbed(send.mock.calls[0][0]);
    expect(embed.description?.startsWith(ICONS.up)).toBe(true);
    expect(embed.description).toContain('the sell price rose above your **3,000g** threshold');
    expect(embed.description).toContain('no sell price history yet');
    expect(embed.description).toContain('goes back below 3,000g');
  });
});
