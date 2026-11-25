import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType, type Client } from 'discord.js';

const { queryMock, logger, getClanLogsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getClanLogsMock: vi.fn(),
}));

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  pool: { connect: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => logger,
}));

vi.mock('../services/IdleClansApi.js', () => ({
  getClanLogs: getClanLogsMock,
}));

import type { ClanLogEntry } from '../services/IdleClansApi.js';
import { VaultNotifier, formatVaultLine, vaultDescription } from './VaultNotifier.js';

/** The guild the tests post to. */
const GUILD = 'guild-1';

/** One row of the fake `vault_channels` table. */
interface ChannelRow {
  guild_id: string;
  channel_id: string;
  clan_name: string;
  created_by: string;
  created_at: Date;
}

/** One row of the fake `vault_events` table. */
interface EventRow {
  clan_name: string;
  event_key: string;
  member_username: string;
  message: string;
  kind: string;
  item_name: string;
  quantity: number;
  happened_at: Date;
}

/** The rows of the fake `vault_channels` table. */
let channelRows: ChannelRow[] = [];

/** The rows of the fake `vault_events` table. */
let eventRows: EventRow[] = [];

/** A subscription of a clan, created at the given moment. */
function subscribe(channelId: string, clanName: string, createdAt: Date): void {
  channelRows.push({
    guild_id: GUILD,
    channel_id: channelId,
    clan_name: clanName,
    created_by: 'user-1',
    created_at: createdAt,
  });
}

/**
 * Answer the pool mock the way the two tables of the clan vault would answer.
 */
function stubPool(): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('DELETE FROM vault_channels')) {
      const byGuild = sql.includes('guild_id = $1 AND channel_id = $2');
      const guildId = byGuild ? (params[0] as string) : null;
      const channelId = byGuild ? (params[1] as string) : (params[0] as string);
      const before = channelRows.length;
      channelRows = channelRows.filter(
        (row) => row.channel_id !== channelId || (guildId !== null && row.guild_id !== guildId)
      );
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('DISTINCT clan_name')) {
      const rows = [...new Set(channelRows.map((row) => row.clan_name))].map((clan_name) => ({
        clan_name,
      }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM vault_channels') && sql.includes('clan_name = $1')) {
      const [clanName] = params as string[];
      const rows = channelRows.filter((row) => row.clan_name === clanName);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM vault_channels') && sql.includes('guild_id = $1')) {
      const [guildId] = params as string[];
      const rows = channelRows.filter((row) => row.guild_id === guildId);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('INSERT INTO vault_events')) {
      const [
        clanName,
        eventKeys,
        memberUsernames,
        messages,
        kinds,
        itemNames,
        quantities,
        happenedAts,
      ] = params as [string, string[], string[], string[], string[], string[], number[], Date[]];

      const inserted: EventRow[] = [];
      eventKeys.forEach((eventKey, index) => {
        const known = eventRows.some(
          (row) => row.clan_name === clanName && row.event_key === eventKey
        );
        if (known) return;

        const row: EventRow = {
          clan_name: clanName,
          event_key: eventKey,
          member_username: memberUsernames[index],
          message: messages[index],
          kind: kinds[index],
          item_name: itemNames[index],
          quantity: quantities[index],
          happened_at: happenedAts[index],
        };
        eventRows.push(row);
        inserted.push(row);
      });
      return { rows: inserted, rowCount: inserted.length };
    }

    if (sql.includes('DELETE FROM vault_events')) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  });
}

/** One channel of the fake guild. */
interface ChannelFixture {
  id: string;
  canPost?: boolean;
  fail?: boolean;
  missing?: boolean;
}

/** A client whose guild holds the given channels. */
function fakeClient(
  fixtures: ChannelFixture[],
  options: { meMissing?: boolean } = {}
): {
  client: Client;
  sends: Map<string, ReturnType<typeof vi.fn>>;
} {
  const sends = new Map<string, ReturnType<typeof vi.fn>>();
  const channels = new Map<string, unknown>();

  for (const fixture of fixtures) {
    if (!fixture.missing) {
      const send = vi.fn(async () => {
        if (fixture.fail) throw new Error('the channel refused the message');
        return { id: 'message-1' };
      });
      sends.set(fixture.id, send);
      channels.set(fixture.id, {
        id: fixture.id,
        name: fixture.id,
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => fixture.canPost ?? true }),
        send,
      });
    }
  }

  const guild = {
    id: GUILD,
    members: { me: options.meMissing ? null : { id: 'bot-1' } },
    channels: { cache: channels },
  };
  const client = {
    user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' },
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;

  return { client, sends };
}

/** One entry of the clan log of a clan. */
function entry(message: string, timestamp: string, member = 'USERNAME'): ClanLogEntry {
  return { clanName: 'AOE', memberUsername: member, message, timestamp };
}

/** The embed of the message the channel received. */
function sentEmbed(
  send: ReturnType<typeof vi.fn>,
  index = 0
): { title?: string; description?: string; footer?: { text: string } } {
  const payload = send.mock.calls[index][0] as { embeds: Array<{ toJSON(): unknown }> };
  return payload.embeds[0].toJSON() as {
    title?: string;
    description?: string;
    footer?: { text: string };
  };
}

/** The flags of the message the channel received. */
function sentFlags(send: ReturnType<typeof vi.fn>, index = 0): number {
  const payload = send.mock.calls[index][0] as { embeds: unknown[]; flags: number };
  return payload.flags;
}

beforeEach(() => {
  vi.clearAllMocks();
  channelRows = [];
  eventRows = [];
  stubPool();
  getClanLogsMock.mockResolvedValue([]);
});

describe('VaultNotifier.runClan', () => {
  it('posts only events newer than the subscription', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-02T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-01T10:00:00.000Z'),
      entry('USERNAME added 7x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client, sends } = fakeClient([{ id: 'channel-1' }]);

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result).toEqual({ channels: 1, events: 1 });
    const embed = sentEmbed(sends.get('channel-1') as ReturnType<typeof vi.fn>);
    expect(embed.title).toContain('AOE');
    expect(embed.description).toContain('7x Gold');
    expect(embed.description).not.toContain('5x Gold');
  });

  it('does not backfill when a channel subscribes', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-10T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold (tier 2).', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client, sends } = fakeClient([{ id: 'channel-1' }]);

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result).toEqual({ channels: 0, events: 0 });
    expect((sends.get('channel-1') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('posts each event once across two ticks', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client, sends } = fakeClient([{ id: 'channel-1' }]);

    await VaultNotifier.runClan(client, 'AOE');
    const second = await VaultNotifier.runClan(client, 'AOE');

    expect(second).toEqual({ channels: 0, events: 0 });
    expect((sends.get('channel-1') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('caps a digest at ten lines and says how many were left out', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue(
      Array.from(
        { length: 12 },
        (_, index) =>
          entry(
            `USERNAME added ${index + 1}x Gold.`,
            `2026-11-02T10:${String(index).padStart(2, '0')}:00.000Z`
          )
      )
    );
    const { client, sends } = fakeClient([{ id: 'channel-1' }]);

    await VaultNotifier.runClan(client, 'AOE');

    const embed = sentEmbed(sends.get('channel-1') as ReturnType<typeof vi.fn>);
    expect(embed.description).toContain('… and 2 more');
  });

  it('removes a channel the bot cannot post in', async () => {
    subscribe('channel-gone', 'AOE', new Date('2026-11-01T00:00:00Z'));
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client, sends } = fakeClient([{ id: 'channel-gone', canPost: false }, { id: 'channel-1' }]);

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result.channels).toBe(1);
    expect(channelRows.map((row) => row.channel_id)).toEqual(['channel-1']);
    expect((sends.get('channel-1') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('keeps the subscription when the guild is not in the cache', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const client = {
      user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' },
      guilds: { cache: new Map() },
    } as unknown as Client;

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result.channels).toBe(0);
    expect(channelRows.map((row) => row.channel_id)).toEqual(['channel-1']);
  });

  it('keeps the subscription while the member cache has not resolved', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client } = fakeClient([{ id: 'channel-1' }], { meMissing: true });

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result.channels).toBe(0);
    expect(channelRows.map((row) => row.channel_id)).toEqual(['channel-1']);
  });

  it('removes a channel that no longer exists', async () => {
    subscribe('channel-gone', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client } = fakeClient([{ id: 'channel-gone', missing: true }]);

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result).toEqual({ channels: 0, events: 1 });
    expect(channelRows).toHaveLength(0);
  });

  it('posts nothing when the clan returns nothing new', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([]);
    const { client, sends } = fakeClient([{ id: 'channel-1' }]);

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result).toEqual({ channels: 0, events: 0 });
    expect((sends.get('channel-1') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('keeps one failing channel from stopping the others', async () => {
    subscribe('channel-bad', 'AOE', new Date('2026-11-01T00:00:00Z'));
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
    ]);
    const { client, sends } = fakeClient([{ id: 'channel-bad', fail: true }, { id: 'channel-1' }]);

    const result = await VaultNotifier.runClan(client, 'AOE');

    expect(result.channels).toBe(1);
    expect((sends.get('channel-1') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('posts one message per channel with suppressed notifications', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockResolvedValue([
      entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z'),
      entry('USERNAME withdrew 2x Gold from tier 1.', '2026-11-02T11:00:00.000Z'),
    ]);
    const { client, sends } = fakeClient([{ id: 'channel-1' }]);

    await VaultNotifier.runClan(client, 'AOE');

    const send = sends.get('channel-1') as ReturnType<typeof vi.fn>;
    expect(send.mock.calls).toHaveLength(1);
    expect(sentFlags(send)).toBe(4096);
  });

  it('keeps a failing clan from stopping the others', async () => {
    subscribe('channel-1', 'AOE', new Date('2026-11-01T00:00:00Z'));
    subscribe('channel-2', 'TST', new Date('2026-11-01T00:00:00Z'));
    getClanLogsMock.mockImplementation(async (clanName: string) => {
      if (clanName === 'AOE') throw new Error('the clan log is down');
      return [entry('USERNAME added 5x Gold.', '2026-11-02T10:00:00.000Z')];
    });
    const { client, sends } = fakeClient([{ id: 'channel-1' }, { id: 'channel-2' }]);

    await VaultNotifier.tick(client);

    expect(getClanLogsMock).toHaveBeenCalledWith('AOE');
    expect(getClanLogsMock).toHaveBeenCalledWith('TST');
    expect((sends.get('channel-1') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((sends.get('channel-2') as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe('vaultDescription', () => {
  it('names the entries and the count that did not fit', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      clanName: 'AOE',
      eventKey: `key-${index}`,
      memberUsername: 'USERNAME',
      message: `USERNAME added ${index + 1}x Gold.`,
      kind: 'deposit' as const,
      itemName: 'Gold',
      quantity: index + 1,
      happenedAt: new Date(`2026-11-02T10:${String(index).padStart(2, '0')}:00.000Z`),
    }));

    const description = vaultDescription(events);

    expect(description).toContain('12 new entries');
    expect(description).toContain('… and 2 more');
  });

  it('names no leftover count when every entry fits', () => {
    const events = [
      {
        clanName: 'AOE',
        eventKey: 'key-1',
        memberUsername: 'USERNAME',
        message: 'USERNAME added 5x Gold.',
        kind: 'deposit' as const,
        itemName: 'Gold',
        quantity: 5,
        happenedAt: new Date('2026-11-02T10:00:00.000Z'),
      },
    ];

    expect(vaultDescription(events)).not.toContain('and 0 more');
  });
});

describe('formatVaultLine', () => {
  /** One parsed vault event, as the log reader hands it over. */
  const event = (kind: 'deposit' | 'withdraw' | 'move', message: string, quantity: number) => ({
    clanName: 'AOE',
    eventKey: `key-${kind}-${quantity}`,
    memberUsername: 'USERNAME',
    message,
    kind,
    itemName: 'Gold',
    quantity,
    happenedAt: new Date('2026-11-25T04:35:00.000Z'),
  });

  it('reads a deposit and a withdrawal with the same vault wording', () => {
    expect(formatVaultLine(event('deposit', 'USERNAME added 69x Gold (tier 1).', 69))).toBe(
      'USERNAME added 69x Gold to vault 1'
    );
    expect(formatVaultLine(event('withdraw', 'USERNAME withdrew 67x Gold from tier 1.', 67))).toBe(
      'USERNAME withdrew 67x Gold from vault 1'
    );
  });

  it('names both vaults of a move', () => {
    expect(
      formatVaultLine(event('move', 'USERNAME moved 5x Gold from tier 1 to tier 2.', 5))
    ).toBe('USERNAME moved 5x Gold from vault 1 to vault 2');
  });

  it('leaves the location out when the game named none', () => {
    expect(formatVaultLine(event('deposit', 'USERNAME added 5x Gold.', 5))).toBe(
      'USERNAME added 5x Gold'
    );
  });
});
