import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

const {
  checkMock,
  addChannelMock,
  removeChannelMock,
  listChannelsMock,
  setIntervalMinutesMock,
  canPostMock,
} = vi.hoisted(() => ({
  checkMock: vi.fn(),
  addChannelMock: vi.fn(),
  removeChannelMock: vi.fn(),
  listChannelsMock: vi.fn(),
  setIntervalMinutesMock: vi.fn(),
  canPostMock: vi.fn(),
}));

vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check: checkMock } }));
vi.mock('../ui/channel.js', () => ({ canPost: canPostMock }));
vi.mock('../services/InsightSettings.js', () => ({
  MAX_CHANNELS_PER_GUILD: 1,
  InsightSettings: {
    addChannel: addChannelMock,
    removeChannel: removeChannelMock,
    listChannels: listChannelsMock,
    setIntervalMinutes: setIntervalMinutesMock,
  },
}));

import { handle, autocomplete } from './insight.js';
import { DeeError } from '../utils/errors.js';

const CHANNEL_ID = '20';

const SUBSCRIBED = {
  guildId: '10',
  channelId: CHANNEL_ID,
  createdBy: '30',
  intervalMin: 240,
  createdAt: null,
  lastSentAt: null,
};

/** A text channel the bot may post in. */
const TEXT_CHANNEL = {
  id: CHANNEL_ID,
  name: 'insights',
  type: ChannelType.GuildText,
  permissionsFor: () => ({ has: () => true }),
};

/** A guild whose cache holds one channel. */
const GUILD = {
  id: '10',
  channels: { cache: new Map([[CHANNEL_ID, TEXT_CHANNEL]]) },
  members: { me: { id: 'bot' } },
};

/** The interaction fields the handler reads. */
function interaction(subcommand: string, options: Record<string, unknown> = {}): ChatInputCommandInteraction {
  return {
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => options.channel,
      getString: () => options.channelId,
      getInteger: () => options.hours,
      getFocused: () => '',
    },
    inCachedGuild: () => true,
    guild: GUILD,
    user: { id: '30' },
    client: { user: { displayAvatarURL: () => 'https://cdn.example/a.png' } },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

/** The description of the embed the handler replied with. */
async function repliedText(interaction: ChatInputCommandInteraction): Promise<string> {
  const call = (interaction.editReply as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls[0];
  const payload = call[0] as { content?: string; embeds?: Array<{ toJSON(): { title?: string; description?: string } }> };
  if (payload.content !== undefined) return payload.content;
  const embed = payload.embeds?.[0]?.toJSON();
  return `${embed?.title ?? ''}\n${embed?.description ?? ''}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkMock.mockResolvedValue(undefined);
  canPostMock.mockReturnValue(true);
  listChannelsMock.mockResolvedValue([]);
  addChannelMock.mockResolvedValue({ ...SUBSCRIBED, channelId: '21' });
  removeChannelMock.mockResolvedValue(1);
  setIntervalMinutesMock.mockResolvedValue(360);
});

describe('/insight add', () => {
  it('subscribes a channel the bot may post in', async () => {
    const call = interaction('add', { channel: TEXT_CHANNEL });

    await handle(call);

    expect(addChannelMock).toHaveBeenCalledWith('10', CHANNEL_ID, '30');
    expect(await repliedText(call)).toContain('Insights on');
  });

  it('refuses a channel the bot cannot see', async () => {
    const call = interaction('add', { channel: { id: '99' } });

    await handle(call);

    expect(addChannelMock).not.toHaveBeenCalled();
    expect(await repliedText(call)).toContain('cannot see that channel');
  });

  it('refuses a channel that is not a text channel', async () => {
    const voice = { ...TEXT_CHANNEL, type: ChannelType.GuildVoice };
    const call = {
      ...interaction('add', { channel: voice }),
      guild: { ...GUILD, channels: { cache: new Map([[CHANNEL_ID, voice]]) } },
    } as unknown as ChatInputCommandInteraction;

    await handle(call);

    expect(addChannelMock).not.toHaveBeenCalled();
    expect(await repliedText(call)).toContain('need a text channel');
  });

  it('refuses a channel the bot may not post in', async () => {
    canPostMock.mockReturnValue(false);
    const call = interaction('add', { channel: TEXT_CHANNEL });

    await handle(call);

    expect(addChannelMock).not.toHaveBeenCalled();
    expect(await repliedText(call)).toContain('cannot post in that channel');
  });
});

describe('/insight remove', () => {
  it('unsubscribes a channel', async () => {
    const call = interaction('remove', { channelId: CHANNEL_ID });

    await handle(call);

    expect(removeChannelMock).toHaveBeenCalledWith('10', CHANNEL_ID);
    expect(await repliedText(call)).toContain('Insights off');
  });

  it('says so when the channel was not subscribed', async () => {
    removeChannelMock.mockResolvedValue(0);
    const call = interaction('remove', { channelId: CHANNEL_ID });

    await handle(call);

    expect(await repliedText(call)).toContain('does not receive insights');
  });
});

describe('/insight list', () => {
  it('reports an empty server', async () => {
    const call = interaction('list');

    await handle(call);

    expect(await repliedText(call)).toContain('No channel receives insights yet');
  });

  it('reports the channel, its cadence and its last post', async () => {
    listChannelsMock.mockResolvedValue([
      { ...SUBSCRIBED, lastSentAt: new Date('2026-11-27T04:05:00Z') },
    ]);
    const call = interaction('list');

    await handle(call);

    const text = await repliedText(call);
    expect(text).toContain('#insights');
    expect(text).toContain('every 4 hours');
    expect(text).toContain('last post 27 Nov');
  });

  it('says that nothing was posted yet', async () => {
    listChannelsMock.mockResolvedValue([SUBSCRIBED]);
    const call = interaction('list');

    await handle(call);

    expect(await repliedText(call)).toContain('no insight sent yet');
  });
});

describe('/insight interval', () => {
  it('stores the cadence', async () => {
    listChannelsMock.mockResolvedValue([SUBSCRIBED]);
    const call = interaction('interval', { hours: 6 });

    await handle(call);

    expect(setIntervalMinutesMock).toHaveBeenCalledWith('10', CHANNEL_ID, 360);
    expect(await repliedText(call)).toContain('every 6 hours');
  });

  it('refuses a cadence before a channel is subscribed', async () => {
    const call = interaction('interval', { hours: 6 });

    await handle(call);

    expect(setIntervalMinutesMock).not.toHaveBeenCalled();
    expect(await repliedText(call)).toContain('No channel receives insights yet');
  });
});

describe('/insight refusals', () => {
  it('acknowledges before the limiter and answers a refusal in that reply', async () => {
    checkMock.mockRejectedValue(new DeeError('Too many calls.', 'E1', 'RATE_LIMIT'));
    const call = interaction('list');

    await handle(call);

    expect((call.deferReply as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls).toEqual([
      [{ flags: MessageFlags.Ephemeral }],
    ]);
    expect(await repliedText(call)).toContain('Too many calls.');
  });

  it('stays quiet outside a guild', async () => {
    const call = { ...interaction('list'), inCachedGuild: () => false } as unknown as ChatInputCommandInteraction;

    await handle(call);

    expect((call.deferReply as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

describe('/insight autocomplete', () => {
  it('offers the subscribed channels', async () => {
    listChannelsMock.mockResolvedValue([SUBSCRIBED]);
    const respond = vi.fn().mockResolvedValue(undefined);

    await autocomplete({
      guild: GUILD,
      options: { getFocused: () => '' },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith([{ name: 'insights', value: CHANNEL_ID }]);
  });

  it('offers nothing without a guild', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);

    await autocomplete({ guild: null, options: { getFocused: () => '' }, respond } as never);

    expect(respond).toHaveBeenCalledWith([]);
  });
});
