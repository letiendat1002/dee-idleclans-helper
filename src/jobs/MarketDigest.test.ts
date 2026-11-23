import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelType, type Client } from 'discord.js';

const { queryMock, logger, detectSignalsMock, getByIdMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  detectSignalsMock: vi.fn(),
  getByIdMock: vi.fn(),
}));

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  pool: { connect: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => logger,
}));

vi.mock('../services/AlertEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/AlertEngine.js')>();
  return { ...actual, detectSignals: detectSignalsMock };
});

vi.mock('../services/ItemCatalogue.js', () => ({
  ItemCatalogue: { getById: getByIdMock },
}));

// Trade averages are context: these tests model a game that published none.
vi.mock('../services/IdleClansApi.js', () => ({
  getPriceAveragesCached: vi.fn(async () => null),
}));

import { SIGNAL_CONFIG, type PriceSignal, type SignalInput } from '../services/AlertEngine.js';
import { getPriceAveragesCached as getPriceAverages } from '../services/IdleClansApi.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import type { DigestSubscription } from '../services/DigestSettings.js';
import { MarketDigest } from './MarketDigest.js';
import { ICONS } from '../ui/theme.js';

/** The moment the tests run at; the digest labels its times in UTC. */
const NOW = new Date('2026-11-11T14:30:00Z');

/** The guild the tests post to. */
const GUILD = 'guild-main';

/** The channel the digest posts to. */
const CHANNEL = 'channel-main';

/** A row of the `digest_channels` table. */
interface SubscriptionFixture {
  guild_id: string;
  channel_id: string;
  last_sent_at: string | null;
  interval_min: number;
}

/** A quote of the newest snapshot of an item. */
interface QuoteFixture {
  itemId: number;
  ask: number | null;
  bid: number | null;
  askVolume: number | null;
  bidVolume: number | null;
}

/** A row of the `alert_cooldowns` table. */
interface CooldownFixture {
  guild_id: string;
  item_id: number;
  direction: string;
  last_signal_at: string;
}

/** What the pool mock answers with. */
interface PoolFixture {
  subscriptions?: SubscriptionFixture[];
  quotes?: QuoteFixture[];
  histories?: Array<{ item_id: number; ask: string | number }>;
  seen?: number[];
  cooldowns?: CooldownFixture[];
  /** The capture time of the newest snapshot; one minute old unless a test says otherwise. */
  snapshotAt?: Date;
}

/** The cooldown upserts the pool mock received. */
let cooldownUpserts: unknown[][] = [];

/** The rows the pool mock was asked to stamp as sent. */
let markSentCalls: string[] = [];

/** The rows the pool mock was asked to delete. */
let deleteCalls: string[] = [];

/**
 * Answer the pool mock per statement: the subscriptions, the newest quotes,
 * the ask history, the recently seen items, the cooldown rows, the cooldown
 * upsert, the sent stamp and the deletion each get their own answer.
 */
function stubPool(fixture: PoolFixture = {}): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('MAX(captured_at)')) {
      const capturedAt = fixture.snapshotAt ?? NOW;
      return { rows: [{ captured_at: capturedAt }], rowCount: 1 };
    }
    if (sql.includes('FROM digest_channels dc')) {
      const rows = (fixture.subscriptions ?? []).map((row) => ({
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        created_by: 'user-1',
        created_at: new Date('2026-11-01T00:00:00Z'),
        last_sent_at: row.last_sent_at === null ? null : new Date(row.last_sent_at),
        interval_min: row.interval_min,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO alert_cooldowns')) {
      cooldownUpserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE digest_channels')) {
      markSentCalls.push(String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM digest_channels')) {
      deleteCalls.push(String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM alert_cooldowns')) {
      const guildId = String(params[0]);
      const since = new Date(String(params[1]));
      const rows = (fixture.cooldowns ?? []).filter(
        (row) => row.guild_id === guildId && new Date(row.last_signal_at) >= since
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('WITH recent_polls')) {
      const rows = (fixture.seen ?? []).map((item_id) => ({ item_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('DISTINCT ON')) {
      const rows = (fixture.quotes ?? []).map((quote) => ({
        item_id: quote.itemId,
        ask: quote.ask,
        bid: quote.bid,
        ask_volume: quote.askVolume,
        bid_volume: quote.bidVolume,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('item_id = ANY($1)')) {
      const rows = fixture.histories ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

/** The statements the pool mock received, in order. */
function sqlCalls(): Array<{ sql: string; params: unknown[] }> {
  return (queryMock.mock.calls as Array<[string, unknown[] | undefined]>).map(([sql, params]) => ({
    sql,
    params: params ?? [],
  }));
}

/** One channel of the fake guild. */
interface ChannelFixture {
  id: string;
  name?: string;
  canPost?: boolean;
  fail?: boolean;
}

/** A client whose guild holds the given channels. */
function fakeClient(fixtures: ChannelFixture[]): {
  client: Client;
  sends: Map<string, ReturnType<typeof vi.fn>>;
} {
  const sends = new Map<string, ReturnType<typeof vi.fn>>();
  const channels = new Map<string, unknown>();

  for (const fixture of fixtures) {
    const send = vi.fn(async () => {
      if (fixture.fail) throw new Error('the channel refused the message');
      return { id: 'message-1' };
    });
    sends.set(fixture.id, send);
    channels.set(fixture.id, {
      id: fixture.id,
      name: fixture.name ?? fixture.id,
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => fixture.canPost ?? true }),
      send,
    });
  }

  const guild = {
    id: GUILD,
    members: { me: { id: 'bot-1' } },
    channels: { cache: channels },
  };
  const client = {
    user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' },
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;

  return { client, sends };
}

/** The embed of the message the channel received. */
function sentEmbed(
  send: ReturnType<typeof vi.fn>,
  index = 0
): { title?: string; description?: string; footer?: { text: string } } {
  const payload = send.mock.calls[index][0] as { embeds: Array<{ toJSON(): unknown }> };
  return payload.embeds[0].toJSON() as { title?: string; description?: string; footer?: { text: string } };
}

/** The message payload the channel received. */
function sentPayload(send: ReturnType<typeof vi.fn>, index = 0): { embeds: unknown[]; flags: number } {
  return send.mock.calls[index][0] as { embeds: unknown[]; flags: number };
}

/** A price signal the mocked signal engine returns. */
function signal(
  overrides: Partial<PriceSignal> &
    Pick<PriceSignal, 'itemId' | 'direction' | 'dev' | 'currentAsk' | 'avgAsk' | 'position'>
): PriceSignal {
  return {
    lo: 0,
    hi: 0,
    askVolume: 0,
    ...overrides,
  };
}

/** A subscription of the guild. */
function subscription(overrides: Partial<DigestSubscription> = {}): DigestSubscription {
  return {
    guildId: GUILD,
    channelId: CHANNEL,
    createdBy: 'user-1',
    createdAt: null,
    lastSentAt: null,
    intervalMin: 60,
    ...overrides,
  };
}

/** The moment of the last send of a subscription, `minutes` minutes ago. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** The newest quotes of the market: two sell orders, one without and one thin. */
const QUOTES: QuoteFixture[] = [
  { itemId: 46, ask: 634, bid: 600, askVolume: 78077, bidVolume: 100 },
  { itemId: 12, ask: 176, bid: 150, askVolume: 788774, bidVolume: 200 },
  { itemId: 99, ask: 812, bid: 700, askVolume: 32776, bidVolume: 300 },
  { itemId: 7, ask: 0, bid: 10, askVolume: 0, bidVolume: 5 },
  { itemId: 8, ask: 500, bid: 400, askVolume: SIGNAL_CONFIG.minAskVolume - 1, bidVolume: 50 },
];

/** The item ids of the last two polls: every quote but the thin one is current. */
const SEEN = [46, 12, 99, 7, 8];

/** The signals of the three liquid items. */
const SIGNALS: PriceSignal[] = [
  signal({ itemId: 46, direction: 'down', dev: -0.028, currentAsk: 634, avgAsk: 652, lo: 634, hi: 700, position: 0, askVolume: 78077 }),
  signal({ itemId: 12, direction: 'down', dev: -0.017, currentAsk: 176, avgAsk: 179, lo: 176, hi: 200, position: 0, askVolume: 788774 }),
  signal({ itemId: 99, direction: 'up', dev: 0.083, currentAsk: 812, avgAsk: 750, lo: 700, hi: 812, position: 1, askVolume: 32776 }),
];

/** The catalogue names of the items under test. */
const NAMES: Record<number, string> = {
  1: 'Item one',
  2: 'Item two',
  3: 'Item three',
  4: 'Item four',
  5: 'Item five',
  6: 'Item six',
  7: 'Item seven',
  8: 'Item eight',
  12: 'Cooked carp',
  46: 'Titanium ore',
  99: 'Meteorite ore',
};

/** Eight signals of different size, to prove that only the five largest are posted. */
const EIGHT_SIGNALS: PriceSignal[] = [
  signal({ itemId: 1, direction: 'down', dev: -0.02, currentAsk: 100, avgAsk: 102, position: 0 }),
  signal({ itemId: 2, direction: 'down', dev: -0.05, currentAsk: 100, avgAsk: 105, position: 0 }),
  signal({ itemId: 3, direction: 'up', dev: 0.09, currentAsk: 110, avgAsk: 101, position: 1 }),
  signal({ itemId: 4, direction: 'down', dev: -0.03, currentAsk: 100, avgAsk: 103, position: 0 }),
  signal({ itemId: 5, direction: 'up', dev: 0.04, currentAsk: 104, avgAsk: 100, position: 1 }),
  signal({ itemId: 6, direction: 'up', dev: 0.12, currentAsk: 112, avgAsk: 100, position: 1 }),
  signal({ itemId: 7, direction: 'down', dev: -0.11, currentAsk: 89, avgAsk: 100, position: 0 }),
  signal({ itemId: 8, direction: 'up', dev: 0.07, currentAsk: 107, avgAsk: 100, position: 1 }),
];

/** A cooldown row of an item that signalled recently. */
function cooldown(guildId: string, itemId: number, direction: string, minutesAgoValue: number): CooldownFixture {
  return {
    guild_id: guildId,
    item_id: itemId,
    direction,
    last_signal_at: new Date(NOW.getTime() - minutesAgoValue * 60_000).toISOString(),
  };
}

describe('MarketDigest.run', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cooldownUpserts = [];
    markSentCalls = [];
    deleteCalls = [];
    detectSignalsMock.mockReturnValue(SIGNALS);
    getByIdMock.mockImplementation(async (itemId: number) => {
      const name = NAMES[itemId];
      return name === undefined ? null : { itemId, name };
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts nothing when no signal qualifies', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    detectSignalsMock.mockReturnValue([]);
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 0, signals: 0 });
    expect(sends.get(CHANNEL)).not.toHaveBeenCalled();
  });

  it('posts nothing when the snapshot is stale', async () => {
    stubPool({
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
      snapshotAt: new Date(NOW.getTime() - 11 * 60_000),
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 0, signals: 0 });
    expect(sends.get(CHANNEL)).not.toHaveBeenCalled();
  });

  it('posts one message per subscribed channel', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: 'channel-a' }, { id: 'channel-b' }]);

    const result = await MarketDigest.run(client, GUILD, [
      subscription({ channelId: 'channel-a' }),
      subscription({ channelId: 'channel-b' }),
    ]);

    expect(result).toEqual({ channels: 2, signals: 3 });
    expect(sends.get('channel-a')).toHaveBeenCalledTimes(1);
    expect(sends.get('channel-b')).toHaveBeenCalledTimes(1);
  });

  it('stamps the last send of a channel after a successful send', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    expect(markSentCalls).toEqual([CHANNEL]);
  });

  it('skips a channel missing from the cache of the guild and deletes its row', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: 'channel-other' }]);

    const result = await MarketDigest.run(client, GUILD, [subscription({ channelId: 'channel-gone' })]);

    expect(result).toEqual({ channels: 0, signals: 0 });
    expect(sends.has('channel-gone')).toBe(false);
    expect(deleteCalls).toEqual(['channel-gone']);
  });

  it('drops a channel the bot may not post in and deletes its row', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: CHANNEL, canPost: false }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 0, signals: 0 });
    expect(sends.get(CHANNEL)).not.toHaveBeenCalled();
    expect(deleteCalls).toEqual([CHANNEL]);
  });

  it('keeps posting to the other channels when one channel fails', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: 'channel-a', fail: true }, { id: 'channel-b' }]);

    const result = await MarketDigest.run(client, GUILD, [
      subscription({ channelId: 'channel-a' }),
      subscription({ channelId: 'channel-b' }),
    ]);

    expect(result).toEqual({ channels: 1, signals: 3 });
    expect(sends.get('channel-b')).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('posts the five largest deviations when eight signals qualify', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    detectSignalsMock.mockReturnValue(EIGHT_SIGNALS);
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 1, signals: 5 });
    const description = sentEmbed(sends.get(CHANNEL)!).description ?? '';
    expect(description).toContain('Item six');
    expect(description).toContain('Item seven');
    expect(description).toContain('Item three');
    expect(description).toContain('Item eight');
    expect(description).toContain('Item two');
    expect(description).not.toContain('Item one');
    expect(description).not.toContain('Item four');
    expect(description).not.toContain('Item five');
  });

  it('sends the digest with the notifications suppressed', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    expect(sentPayload(sends.get(CHANNEL)!).flags).toBe(4096);
  });

  it('states the number of eligible items in the header instead of the catalogue size', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const description = sentEmbed(sends.get(CHANNEL)!).description ?? '';
    expect(description).toContain('3 liquid items tracked');
    expect(description).not.toContain('627');
  });

  it('renders every field of an item line', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const description = sentEmbed(sends.get(CHANNEL)!).description ?? '';
    expect(description.startsWith('3 liquid items tracked · 3 notable moves since 13:30 UTC')).toBe(true);
    // no fence: inside one the custom emoji and the bold names would print as raw markup
    expect(description).not.toContain('```');
    expect(description).toContain(`${ICONS.up} **Meteorite ore**  750g → 812g  (+8.3%)`);
    expect(description).toContain('-# at 24h high · volume 32,776');
    expect(description).toContain(`${ICONS.down} **Titanium ore**  652g → 634g  (-2.8%)`);
    expect(description).toContain('-# at 24h low · volume 78,077');
    expect(description).toContain(`${ICONS.down} **Cooked carp**  179g → 176g  (-1.7%)`);
    expect(description).toContain('-# at 24h low · volume 788,774');
  });

  it('says "one notable move" instead of "1 notable moves"', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    detectSignalsMock.mockReturnValue([SIGNALS[0]]);
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    expect(sentEmbed(sends.get(CHANNEL)!).description?.startsWith('3 liquid items tracked · 1 notable move since')).toBe(
      true
    );
  });

  it("adds the game's trade averages on their own line", async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    vi.mocked(getPriceAverages).mockResolvedValue({
      avg1d: 750,
      avg7d: 812,
      avg30d: 900,
      tradeVolume1d: 12_345,
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const description = sentEmbed(sends.get(CHANNEL)!).description ?? '';
    expect(description).toContain('trade avg 1d 750g · 7d 812g · 30d 900g');
  });

  it('rounds a fractional average instead of printing its full precision', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    detectSignalsMock.mockReturnValue([
      signal({ itemId: 99, direction: 'up', dev: 3.164, currentAsk: 148, avgAsk: 35.542857142857144, lo: 35, hi: 148, position: 1, askVolume: 14191 }),
    ]);
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const description = sentEmbed(sends.get(CHANNEL)!).description ?? '';
    expect(description).toContain('-# at 24h high · volume');
    expect(description).not.toContain('35.542');
    expect(description).toContain('36g → 148g');
  });

  it('titles the embed with the current time and the fixed footer', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const embed = sentEmbed(sends.get(CHANNEL)!);
    expect(embed.title).toBe('Market Watch — 14:30 UTC');
    expect(embed.footer?.text).toContain('refreshed every 2 minutes');
  });

  it('skips an item that already signalled for the guild within six hours', async () => {
    stubPool({
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
      cooldowns: [cooldown(GUILD, 46, 'down', 60)],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 1, signals: 2 });
    expect(sentEmbed(sends.get(CHANNEL)!).description).not.toContain('Titanium ore');
  });

  it('keeps an item whose cooldown ran out', async () => {
    stubPool({
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
      cooldowns: [cooldown(GUILD, 46, 'down', 6 * 60 + 5)],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 1, signals: 3 });
    expect(sentEmbed(sends.get(CHANNEL)!).description).toContain('Titanium ore');
  });

  it('does not let another direction of the same item suppress it', async () => {
    stubPool({
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
      cooldowns: [cooldown(GUILD, 46, 'up', 60)],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 1, signals: 3 });
    expect(sentEmbed(sends.get(CHANNEL)!).description).toContain('Titanium ore');
  });

  it('does not let the cooldown of another guild suppress an item', async () => {
    stubPool({
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
      cooldowns: [cooldown('guild-other', 46, 'down', 60)],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    const result = await MarketDigest.run(client, GUILD, [subscription()]);

    expect(result).toEqual({ channels: 1, signals: 3 });
    expect(sentEmbed(sends.get(CHANNEL)!).description).toContain('Titanium ore');
  });

  it('upserts the cooldown of the posted items only', async () => {
    stubPool({
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
      cooldowns: [cooldown(GUILD, 46, 'down', 60)],
    });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    expect(cooldownUpserts).toHaveLength(1);
    const [guildId, itemIds, directions, at] = cooldownUpserts[0];
    expect(guildId).toBe(GUILD);
    expect(itemIds).toEqual([99, 12]);
    expect(directions).toEqual(['up', 'down']);
    expect(at).toEqual(NOW);
  });

  it('never feeds a zero ask to the signal engine', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const inputs = detectSignalsMock.mock.calls[0][0] as SignalInput[];
    expect(inputs.map((input) => input.itemId)).toEqual([46, 12, 99, 8]);
    expect(inputs.every((input) => (input.currentAsk ?? 0) > 0)).toBe(true);
  });

  it('asks for the history of every candidate in one query', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const historyCalls = sqlCalls().filter((call) => call.sql.includes('item_id = ANY($1)'));
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0].params[0]).toEqual([46, 12, 99, 8]);
  });

  it('drops an item that was not seen in the last two polls', async () => {
    stubPool({ quotes: QUOTES, seen: [46, 12, 99], histories: [] });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    const inputs = detectSignalsMock.mock.calls[0][0] as SignalInput[];
    expect(inputs.map((input) => input.itemId)).toEqual([46, 12, 99]);
  });

  it('looks up the name of the posted items only', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    detectSignalsMock.mockReturnValue(EIGHT_SIGNALS);
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    expect(getByIdMock.mock.calls.map((call) => call[0])).toEqual([6, 7, 3, 8, 2]);
  });

  it('falls back to the item id when the catalogue has no row', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    getByIdMock.mockResolvedValue(null);
    detectSignalsMock.mockReturnValue([
      signal({ itemId: 4242, direction: 'up', dev: 0.5, currentAsk: 10, avgAsk: 5, position: 1 }),
    ]);
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription()]);

    expect(sentEmbed(sends.get(CHANNEL)!).description).toContain(`${ICONS.up} **4242**`);
  });

  it('states the time of the previous digest of the channel', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.run(client, GUILD, [subscription({ lastSentAt: new Date('2026-11-11T13:30:00Z') })]);

    expect(sentEmbed(sends.get(CHANNEL)!, 0).description).toContain('since 13:30 UTC');
  });
});

describe('MarketDigest.start', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cooldownUpserts = [];
    markSentCalls = [];
    deleteCalls = [];
    detectSignalsMock.mockReturnValue(SIGNALS);
    getByIdMock.mockImplementation(async (itemId: number) => {
      const name = NAMES[itemId];
      return name === undefined ? null : { itemId, name };
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    await MarketDigest.stop();
    vi.useRealTimers();
  });

  it('sends a digest to a channel whose last send is older than the interval', async () => {
    stubPool({
      subscriptions: [
        { guild_id: GUILD, channel_id: CHANNEL, last_sent_at: minutesAgo(120), interval_min: 60 },
      ],
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.start(client, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sends.get(CHANNEL)).toHaveBeenCalledTimes(1);
    expect(markSentCalls).toEqual([CHANNEL]);
  });

  it('sends nothing to a channel whose last send is inside the interval', async () => {
    stubPool({
      subscriptions: [
        { guild_id: GUILD, channel_id: CHANNEL, last_sent_at: minutesAgo(5), interval_min: 60 },
      ],
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.start(client, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sends.get(CHANNEL)).not.toHaveBeenCalled();
    expect(markSentCalls).toEqual([]);
  });

  it('sends a digest to a channel that never sent one', async () => {
    stubPool({
      subscriptions: [
        { guild_id: GUILD, channel_id: CHANNEL, last_sent_at: null, interval_min: 60 },
      ],
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.start(client, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sends.get(CHANNEL)).toHaveBeenCalledTimes(1);
  });

  it('runs a tick immediately and then on the interval', async () => {
    stubPool({
      subscriptions: [
        { guild_id: GUILD, channel_id: CHANNEL, last_sent_at: minutesAgo(120), interval_min: 60 },
      ],
      quotes: QUOTES,
      seen: SEEN,
      histories: [],
    });
    const { client, sends } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.start(client, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sends.get(CHANNEL)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(sends.get(CHANNEL)).toHaveBeenCalledTimes(2);
  });

  it('does not stack a second tick on a running one', async () => {
    let release: () => void = () => {};
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM digest_channels dc')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { rows: [], rowCount: 0 };
    });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.start(client, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.warn).toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('stops the scheduler', async () => {
    stubPool({ quotes: QUOTES, seen: SEEN, histories: [] });
    const { client } = fakeClient([{ id: CHANNEL }]);

    await MarketDigest.start(client, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await MarketDigest.stop();

    const before = sqlCalls().length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(sqlCalls()).toHaveLength(before);
  });
});

describe('SnapshotStore.askHistories', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
  });

  it('returns the ask prices of every requested item', async () => {
    stubPool({
      histories: [
        { item_id: 46, ask: '100' },
        { item_id: 46, ask: '120' },
        { item_id: 12, ask: '50' },
      ],
    });
    const since = new Date('2026-11-10T00:00:00Z');

    const histories = await SnapshotStore.askHistories([46, 12], since);

    expect(histories.get(46)).toEqual([100, 120]);
    expect(histories.get(12)).toEqual([50]);
    const call = sqlCalls()[0];
    expect(call.sql).toContain('item_id = ANY($1)');
    expect(call.sql).toContain('ask IS NOT NULL');
    expect(call.params).toEqual([[46, 12], since]);
  });

  it('leaves an item without rows out of the map', async () => {
    stubPool({ histories: [{ item_id: 46, ask: '100' }] });

    const histories = await SnapshotStore.askHistories([46, 12], new Date());

    expect(histories.has(12)).toBe(false);
  });
});

describe('SnapshotStore.recentlySeenItemIds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubPool();
  });

  it('returns the item ids of the last two polls', async () => {
    stubPool({ seen: [46, 12] });

    const seen = await SnapshotStore.recentlySeenItemIds();

    expect([...seen]).toEqual([46, 12]);
    expect(sqlCalls()[0].sql).toContain('LIMIT 2');
  });
});
