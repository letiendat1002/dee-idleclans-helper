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
import { builder, handle } from './digest.js';

/** One row of the fake `digest_channels` table. */
interface ChannelRow {
  guild_id: string;
  channel_id: string;
  created_by: string;
  created_at: Date;
  last_sent_at: Date | null;
}

/** The rows of the fake `digest_channels` table. */
let channelRows: ChannelRow[] = [];

/** The rows of the fake `guild_settings` table. */
let settingRows: Array<{ guild_id: string; digest_interval_min: number }> = [];

/**
 * Answer the pool mock the way the tables of the digest would answer.
 */
function stubPool(): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO digest_channels')) {
      const [guildId, channelId, userId] = params as string[];
      const known = channelRows.some(
        (row) => row.guild_id === guildId && row.channel_id === channelId
      );
      if (!known) {
        channelRows.push({
          guild_id: guildId,
          channel_id: channelId,
          created_by: userId,
          created_at: new Date('2026-11-01T00:00:00Z'),
          last_sent_at: null,
        });
      } else if (!sql.includes('ON CONFLICT')) {
        throw new Error('duplicate key value violates unique constraint "digest_channels_pkey"');
      }
      return { rows: [], rowCount: known ? 0 : 1 };
    }

    if (sql.includes('DELETE FROM digest_channels')) {
      const [guildId, channelId] = params as string[];
      const before = channelRows.length;
      channelRows = channelRows.filter(
        (row) => !(row.guild_id === guildId && row.channel_id === channelId)
      );
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('FROM digest_channels') && sql.includes('AND channel_id = $2')) {
      const [guildId, channelId] = params as string[];
      const rows = channelRows.filter(
        (row) => row.guild_id === guildId && row.channel_id === channelId
      );
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM digest_channels')) {
      const [guildId] = params as string[];
      const rows = channelRows.filter((row) => row.guild_id === guildId);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('INSERT INTO guild_settings')) {
      const [guildId, minutes] = params as string[];
      const known = settingRows.find((row) => row.guild_id === guildId);
      if (known) known.digest_interval_min = Number(minutes);
      else settingRows.push({ guild_id: guildId, digest_interval_min: Number(minutes) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM guild_settings')) {
      const [guildId] = params as string[];
      const row = settingRows.find((candidate) => candidate.guild_id === guildId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  });
}

/** The interaction members `/digest` reads. */
interface FakeOptions {
  guildId?: string | null;
  memberPermissions?: boolean;
  botPost?: boolean;
  subcommand?: string;
  channelId?: string;
  channelName?: string;
  channelType?: ChannelType;
  hoursValue?: number;
  minutesValue?: number;
  stringValue?: string;
}

interface EditPayload {
  content?: string;
  embeds?: Array<{ toJSON(): APIEmbed }>;
}

/** The interaction `/digest` works on. */
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
        getString: () => options.stringValue ?? channelId,
        getInteger: (name: string) =>
          name === 'hours' ? (options.hoursValue ?? 1) : (options.minutesValue ?? 0),
      },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
  };
}

/** The statements the pool mock received, in order. */
function sqlCalls(): Array<{ sql: string; params: unknown[] }> {
  return (queryMock.mock.calls as Array<[string, unknown[] | undefined]>).map(([sql, params]) => ({
    sql,
    params: params ?? [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  channelRows = [];
  settingRows = [];
  check.mockResolvedValue(undefined);
  stubPool();
});

describe('/digest handle', () => {
  it('answers a rate-limit error ephemerally', async () => {
    check.mockRejectedValueOnce(new DeeError('⏱ Slow down', 'E1', 'E1_004'));
    const { interaction, deferReply } = fake();

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: '⏱ Slow down', flags: 64 });
    expect(deferReply).not.toHaveBeenCalled();
  });

  it('writes nothing when the member lacks the Manage Server permission', async () => {
    const { interaction, deferReply } = fake({ memberPermissions: false, botPost: true });

    await handle(interaction);

    expect(queryMock).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, {
      content: expect.stringContaining('Manage Server'),
      flags: 64,
    });
  });

  it('refuses a DM invocation without throwing', async () => {
    const { interaction, deferReply, editReply } = fake({ guildId: null, memberPermissions: true });

    await expect(handle(interaction)).resolves.toBeUndefined();

    expect(queryMock).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it('subscribes a channel for a member with the Manage Server permission', async () => {
    const { interaction, deferReply, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      subcommand: 'add',
    });

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const insert = sqlCalls().find((call) => call.sql.includes('INSERT INTO digest_channels'));
    expect(insert?.params).toEqual(['guild-1', 'channel-1', 'user-1']);
    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.title).toContain('Digest on');
    expect(embed?.title).toContain('general');
  });

  it('names the channel cap in the reply of a subscription', async () => {
    const { interaction, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      subcommand: 'add',
    });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.description).toContain('at most 1 channel.');
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
        created_by: 'user-1',
        created_at: new Date('2026-11-01T00:00:00Z'),
        last_sent_at: null,
      },
    ];
    const { interaction, editReply } = fake({
      memberPermissions: true,
      subcommand: 'remove',
      stringValue: 'channel-1',
    });

    await handle(interaction);

    const remove = sqlCalls().find((call) => call.sql.includes('DELETE FROM digest_channels'));
    expect(remove?.params).toEqual(['guild-1', 'channel-1']);
    expect(editReply).toHaveBeenCalledWith({ content: expect.stringContaining('general') });
  });

  it('lists the digest channels of the guild', async () => {
    channelRows = [
      {
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        created_by: 'user-1',
        created_at: new Date('2026-11-01T00:00:00Z'),
        last_sent_at: null,
      },
    ];
    const { interaction, editReply } = fake({ memberPermissions: true, subcommand: 'list' });

    await handle(interaction);

    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.title).toContain('Digest channels');
    expect(embed?.description).toContain('#general');
    expect(embed?.description).toContain('1 channel subscribed');
  });

  it('stores the interval the member asked for', async () => {
    const { interaction, editReply } = fake({
      memberPermissions: true,
      subcommand: 'interval',
      hoursValue: 0,
      minutesValue: 30,
    });

    await handle(interaction);

    const update = sqlCalls().find((call) => call.sql.includes('INSERT INTO guild_settings'));
    expect(update?.params).toEqual(['guild-1', 30]);
    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.description).toContain('every 30 minutes');
  });

  it('adds the minutes to the hours and speaks hours back', async () => {
    const { interaction, editReply } = fake({
      memberPermissions: true,
      subcommand: 'interval',
      hoursValue: 1,
      minutesValue: 45,
    });

    await handle(interaction);

    const update = sqlCalls().find((call) => call.sql.includes('INSERT INTO guild_settings'));
    expect(update?.params).toEqual(['guild-1', 105]);
    const embed = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(embed?.description).toContain('every 1 hour 45 minutes');
  });

  it('offers quarter-hour presets from 15 minutes to 24 hours', () => {
    const interval = builder.toJSON().options?.find((option) => option.name === 'interval');
    const options = interval && 'options' in interval ? interval.options : undefined;
    const hours = options?.find((option) => option.name === 'hours');
    const minutes = options?.find((option) => option.name === 'minutes');
    const values = (option: typeof hours) =>
      option && 'choices' in option ? option.choices?.map((c) => c.value) : undefined;

    expect(values(hours)).toEqual(Array.from({ length: 25 }, (_, hours) => hours));
    expect(values(minutes)).toEqual([15, 30, 45]);
  });

  it('answers a reference id when the settings write throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const { interaction, editReply } = fake({
      memberPermissions: true,
      botPost: true,
      subcommand: 'add',
    });

    await handle(interaction);

    expect(editReply).toHaveBeenCalledWith({ content: expect.stringContaining('🚨') });
  });
});
