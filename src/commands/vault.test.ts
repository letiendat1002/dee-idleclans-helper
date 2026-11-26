import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply, check, queryMock } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeReply: vi.fn(),
  check: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check } }));
vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));

import { ChannelType, MessageFlags, type APIEmbed, type ChatInputCommandInteraction } from 'discord.js';
import { DeeError } from '../utils/errors.js';
import { MAX_VAULT_CHANNELS_PER_GUILD } from '../services/VaultLog.js';
import { handle } from './vault.js';

/** One row of the fake `vault_channels` table. */
interface ChannelRow {
  guild_id: string;
  channel_id: string;
  clan_name: string;
  created_by: string;
  created_at: Date;
}

/** The rows of the fake `vault_channels` table. */
let channelRows: ChannelRow[] = [];

/** The moment a fake subscription was created at. */
const CREATED_AT = new Date('2026-11-01T00:00:00Z');

/**
 * Answer the pool mock the way the two tables of the clan vault would answer.
 */
function stubPool(): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO vault_channels')) {
      const [guildId, channelId, clanName, userId] = params as string[];
      const known = channelRows.some(
        (row) =>
          row.guild_id === guildId &&
          row.channel_id === channelId &&
          row.clan_name === clanName
      );
      if (!known) {
        channelRows.push({
          guild_id: guildId,
          channel_id: channelId,
          clan_name: clanName,
          created_by: userId,
          created_at: CREATED_AT,
        });
      }
      return { rows: [], rowCount: known ? 0 : 1 };
    }

    if (sql.includes('FROM vault_events')) {
      const [clanName, limit] = params as [string, number];
      const rows = eventRows
        .filter((row) => row.clan_name === clanName)
        .sort((a, b) => b.happened_at.getTime() - a.happened_at.getTime())
        .slice(0, limit);
      return { rows };
    }

    if (sql.includes('DELETE FROM vault_channels') && sql.includes('clan_name = $3')) {
      const [guildId, channelId, clanName] = params as string[];
      const before = channelRows.length;
      channelRows = channelRows.filter(
        (row) =>
          !(row.guild_id === guildId && row.channel_id === channelId && row.clan_name === clanName)
      );
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('FROM vault_channels') && sql.includes('AND channel_id = $2')) {
      const [guildId, channelId, clanName] = params as string[];
      const rows = channelRows.filter(
        (row) =>
          row.guild_id === guildId && row.channel_id === channelId && row.clan_name === clanName
      );
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM vault_channels')) {
      const [guildId] = params as string[];
      const rows = channelRows.filter((row) => row.guild_id === guildId);
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  });
}

/** The interaction members `/vault` reads. */
interface VaultEventRow {
  clan_name: string;
  event_key: string;
  member_username: string;
  message: string;
  kind: 'deposit' | 'withdraw' | 'move';
  item_name: string;
  quantity: number;
  happened_at: Date;
}

/** The rows of the fake `vault_events` table. */
let eventRows: VaultEventRow[] = [];

interface FakeOptions {
  guildId?: string | null;
  memberPermissions?: boolean;
  botPost?: boolean;
  subcommand?: string;
  clanValue?: string;
  channelId?: string;
  channelName?: string;
  channelType?: ChannelType;
  stringValue?: string;
  limit?: number | null;
}

interface EditPayload {
  content?: string;
  embeds?: Array<{ toJSON(): APIEmbed }>;
}

/** The interaction `/vault` works on. */
function fake(options: FakeOptions = {}): {
  interaction: ChatInputCommandInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn<(payload: EditPayload) => Promise<void>>>;
} {
  const deferReply = vi.fn<() => Promise<void>>();
  deferReply.mockResolvedValue(undefined);
  const editReply = vi.fn<(payload: EditPayload) => Promise<void>>();
  editReply.mockResolvedValue(undefined);

  const guildId = options.guildId === undefined ? 'guild-1' : options.guildId;
  const channelId = options.channelId ?? 'channel-1';
  const channel = {
    id: channelId,
    name: options.channelName ?? 'general',
    type: options.channelType ?? ChannelType.GuildText,
    permissionsFor: () => ({ has: () => options.botPost ?? false }),
  };
  const guild =
    guildId === null
      ? null
      : {
          id: guildId,
          members: { me: { id: 'bot-1', permissions: { has: () => true } } },
          channels: { cache: new Map([[channelId, channel]]) },
        };

  return {
    deferReply,
    editReply,
    interaction: {
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
      guildId,
      guild,
      memberPermissions: { has: () => options.memberPermissions ?? false },
      inCachedGuild: () => guild !== null,
      options: {
        getSubcommand: () => options.subcommand ?? 'add',
        getChannel: () => channel,
        getString: (name: string) => {
          if (name === 'clan') return options.clanValue ?? 'AOE';
          return options.stringValue ?? channelId;
        },
        getInteger: (name: string) => (name === 'limit' ? (options.limit ?? null) : null),
      },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  channelRows = [];
  eventRows = [];
  check.mockResolvedValue(undefined);
  stubPool();
});

describe('/vault handle', () => {
  it('answers a rate-limit error ephemerally', async () => {
    check.mockRejectedValueOnce(new DeeError('Slow down', 'E1', 'E1_004'));
    const { interaction, deferReply } = fake();

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: 'Slow down', flags: 64 });
    expect(deferReply).not.toHaveBeenCalled();
  });

  it('runs even when the member has no Manage Server, because Discord owns command access', async () => {
    const { interaction, deferReply } = fake({ memberPermissions: false, botPost: true, subcommand: 'add' });

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(safeReply).not.toHaveBeenCalled();
  });

  it('refuses a DM invocation without throwing', async () => {
    const { interaction, deferReply, editReply } = fake({ guildId: null, memberPermissions: true });

    await expect(handle(interaction)).resolves.toBeUndefined();

    expect(queryMock).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it('subscribes a channel', async () => {
    const { interaction, deferReply, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      subcommand: 'add',
      clanValue: 'AOE',
    });

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(channelRows).toHaveLength(1);
    expect(channelRows[0]).toMatchObject({ guild_id: 'guild-1', channel_id: 'channel-1', clan_name: 'AOE' });
    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.title).toContain('Clan vault on');
    expect(embed?.description).toContain('AOE');
  });

  it('names the channel cap in the reply of a subscription', async () => {
    const { interaction, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      subcommand: 'add',
    });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.description).toContain(`${MAX_VAULT_CHANNELS_PER_GUILD} channels`);
  });

  it('refuses a sixth channel', async () => {
    for (let index = 0; index < MAX_VAULT_CHANNELS_PER_GUILD; index += 1) {
      channelRows.push({
        guild_id: 'guild-1',
        channel_id: `channel-${index}`,
        clan_name: 'AOE',
        created_by: 'user-1',
        created_at: CREATED_AT,
      });
    }
    const { interaction, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      subcommand: 'add',
      channelId: 'channel-extra',
    });

    await handle(interaction);

    expect(channelRows).toHaveLength(MAX_VAULT_CHANNELS_PER_GUILD);
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(String(MAX_VAULT_CHANNELS_PER_GUILD)),
    });
  });

  it('refuses a channel the bot may not post in', async () => {
    const { interaction, editReply } = fake({
      memberPermissions: true,
      botPost: false,
      subcommand: 'add',
    });

    await handle(interaction);

    expect(queryMock).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('View Channel and Send Messages'),
    });
  });

  it('refuses a channel that is not a text channel', async () => {
    const { interaction, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      channelType: ChannelType.GuildVoice,
      subcommand: 'add',
    });

    await handle(interaction);

    expect(queryMock).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: expect.stringContaining('text channel') });
  });

  it('unsubscribes the channel the member picked', async () => {
    channelRows = [
      {
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        clan_name: 'AOE',
        created_by: 'user-1',
        created_at: CREATED_AT,
      },
    ];
    const { interaction, editReply } = fake({
      memberPermissions: true,
      subcommand: 'remove',
      clanValue: 'AOE',
      stringValue: 'channel-1',
    });

    await handle(interaction);

    expect(channelRows).toHaveLength(0);
    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.title).toContain('Clan vault off');
    expect(embed?.description).toContain('AOE');
  });

  it('lists the clan vault channels of the guild', async () => {
    channelRows = [
      {
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        clan_name: 'AOE',
        created_by: 'user-1',
        created_at: CREATED_AT,
      },
    ];
    const { interaction, editReply } = fake({ memberPermissions: true, subcommand: 'list' });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.title).toContain('Clan vault channels');
    expect(embed?.description).toContain('AOE');
    expect(embed?.description).toContain(`1 of ${MAX_VAULT_CHANNELS_PER_GUILD} channels subscribed`);
  });

  it('shows the newest entries of a clan, grouped by direction', async () => {
    eventRows = [
      {
        clan_name: 'DeeCorp',
        event_key: 'k1',
        member_username: 'dee',
        message: 'dee added 5x Gold.',
        kind: 'deposit',
        item_name: 'Gold',
        quantity: 5,
        happened_at: new Date('2026-11-25T10:10:00Z'),
      },
      {
        clan_name: 'DeeCorp',
        event_key: 'k2',
        member_username: 'dee',
        message: 'dee withdrew 2x Gold.',
        kind: 'withdraw',
        item_name: 'Gold',
        quantity: 2,
        happened_at: new Date('2026-11-25T10:12:00Z'),
      },
    ];
    const { interaction, editReply } = fake({
      memberPermissions: true,
      subcommand: 'recent',
      clanValue: 'DeeCorp',
      limit: 20,
    });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.title).toContain('DeeCorp');
    expect(embed?.description).toContain('entries · 10:10–10:12 UTC');
    expect(embed?.description).toContain('**In · 1**');
    expect(embed?.description).toContain('**Out · 1**');
    expect(embed?.footer?.text).toBe('clan log · last 14 days');
  });

  it('says so when a clan has no entry in the window', async () => {
    const { interaction, editReply } = fake({ memberPermissions: true, subcommand: 'recent' });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.description).toBe('No entries recorded for AOE.');
  });

  it('counts distinct channels, not subscriptions, against the cap', async () => {
    channelRows = [
      { guild_id: 'guild-1', channel_id: 'channel-1', clan_name: 'AOE', created_by: 'user-1', created_at: CREATED_AT },
      { guild_id: 'guild-1', channel_id: 'channel-1', clan_name: 'TST', created_by: 'user-1', created_at: CREATED_AT },
      { guild_id: 'guild-1', channel_id: 'channel-2', clan_name: 'AOE', created_by: 'user-1', created_at: CREATED_AT },
      { guild_id: 'guild-1', channel_id: 'channel-2', clan_name: 'TST', created_by: 'user-1', created_at: CREATED_AT },
      { guild_id: 'guild-1', channel_id: 'channel-3', clan_name: 'AOE', created_by: 'user-1', created_at: CREATED_AT },
      { guild_id: 'guild-1', channel_id: 'channel-3', clan_name: 'TST', created_by: 'user-1', created_at: CREATED_AT },
    ];
    const { interaction, editReply } = fake({ memberPermissions: true, subcommand: 'list' });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.description).toContain(`3 of ${MAX_VAULT_CHANNELS_PER_GUILD} channels subscribed`);
    expect(embed?.description).not.toContain(`6 of`);
  });
});
