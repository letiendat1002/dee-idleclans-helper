import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply, check, getById, getHistory } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeReply: vi.fn(),
  check: vi.fn(),
  getById: vi.fn(),
  getHistory: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check } }));
vi.mock('../services/ItemCatalogue.js', () => ({ ItemCatalogue: { getById } }));
vi.mock('../services/IdleClansApi.js', () => ({ getTradeHistoryCached: getHistory }));

import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { DeeError, ErrCodes } from '../utils/errors.js';
import { handle, handleRangeMenu, handleShareButton } from './graph.js';

interface EmbedJson {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  image?: { url?: string };
}

interface Payload {
  content?: string;
  embeds?: Array<{ toJSON(): EmbedJson }>;
  files?: Array<{ name?: string; attachment?: Buffer }>;
  components?: Array<{ toJSON(): { components: Array<Record<string, unknown>> } }>;
  attachments?: unknown[];
}

/** Buckets at 30-minute spacing from 09:00 UTC, the shape a 24h answer has. */
function buckets(rows: Array<Partial<{ avg: number | null; low: number | null; high: number | null; volume: number | null }>>) {
  const start = Date.parse('2026-11-22T09:00:00Z');
  return rows.map((row, index) => ({
    at: start + index * 30 * 60_000,
    avg: 100,
    low: 90,
    high: 110,
    volume: 10,
    ...row,
  }));
}

function fakeHandle(range?: string): {
  interaction: ChatInputCommandInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn<(payload: Payload) => Promise<void>>>;
} {
  const deferReply = vi.fn<(options: { flags?: number }) => Promise<void>>();
  deferReply.mockResolvedValue(undefined);
  const editReply = vi.fn<(payload: Payload) => Promise<void>>();
  editReply.mockResolvedValue(undefined);

  return {
    deferReply,
    editReply,
    interaction: {
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
      options: { getString: (name: string) => (name === 'range' ? range ?? null : '46') },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
  };
}

function fakeMenu(range: string, customId = 'graph:range:46'): {
  interaction: StringSelectMenuInteraction;
  deferUpdate: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn<(payload: Payload) => Promise<void>>>;
} {
  const deferUpdate = vi.fn(async () => undefined);
  const editReply = vi.fn<(payload: Payload) => Promise<void>>(async () => undefined);

  return {
    deferUpdate,
    editReply,
    interaction: {
      customId,
      values: [range],
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
      deferUpdate,
      editReply,
    } as unknown as StringSelectMenuInteraction,
  };
}

function fakeShare(
  customId: string,
  canSend = true
): {
  interaction: ButtonInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn<(payload: { content?: string }) => Promise<void>>>;
  send: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn<(payload: { content?: string }) => Promise<void>>(async () => undefined);
  const send = vi.fn(async () => undefined);

  return {
    deferReply,
    editReply,
    send,
    interaction: {
      customId,
      user: { id: 'user-1' },
      deferred: true,
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
      channel: {
        id: 'chan-1',
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => canSend }),
        send,
      },
      deferReply,
      editReply,
    } as unknown as ButtonInteraction,
  };
}

function lastEmbed(editReply: ReturnType<typeof fakeHandle>['editReply']): EmbedJson {
  const payload = editReply.mock.calls.at(-1)?.[0];
  const embed = payload?.embeds?.[0];

  if (!embed) throw new Error('no embed in the reply');
  return embed.toJSON();
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue(undefined);
  getById.mockResolvedValue({ itemId: 46, name: 'Teak log' });
  getHistory.mockResolvedValue(
    buckets([{ avg: 100, low: 95, high: 110 }, { avg: 120, low: 110, high: 130 }, { avg: 150, low: 140, high: 160 }])
  );
});

describe('/graph item', () => {
  it('defers the reply as ephemeral', async () => {
    const { interaction, deferReply } = fakeHandle();

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('titles the card with the item and the window', async () => {
    const { interaction, editReply } = fakeHandle('30d');

    await handle(interaction);

    expect(lastEmbed(editReply).title).toBe('Teak log — average traded price, last 30 days');
  });

  it('says which series the line is and what the bars are', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('Average traded price per 30 minutes');
    expect(lastEmbed(editReply).description).toContain('the bars are units traded');
  });

  it('prints the last bucket, the traded range and the units in a fence', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const description = lastEmbed(editReply).description ?? '';
    expect(description).toContain('last   150g');
    expect(description).toContain('low    95g');
    expect(description).toContain('high   160g');
    expect(description).toContain('volume 30 units');
  });

  it('states the change from the first bucket to the last, and the traded range', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    // 100 -> 150 is +50.0%, and the range is 95..160
    expect(lastEmbed(editReply).description).toContain('**+50.0%** over 24 hours · traded 95g to 160g');
  });

  it('falls back to the average when a bucket carries no low or high', async () => {
    getHistory.mockResolvedValue(buckets([{ avg: 100, low: null, high: null }, { avg: 200, low: null, high: null }]));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('traded 100g to 200g');
  });

  it('attaches the chart and points the embed at it', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const payload = editReply.mock.calls.at(-1)?.[0];
    expect(lastEmbed(editReply).image?.url).toBe('attachment://chart.png');
    expect(payload?.files).toHaveLength(1);
    expect(payload?.files?.[0].name).toBe('chart.png');
    expect(payload?.files?.[0].attachment?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('counts the buckets it drew and the span they cover', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('3 buckets of 30 minutes · 2026-11-22 09:00 → 2026-11-22 10:00 UTC');
  });

  it('drops a bucket with no average instead of drawing a zero', async () => {
    getHistory.mockResolvedValue(buckets([{ avg: 100 }, { avg: null }, { avg: 0 }, { avg: 120 }]));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('2 buckets of 30 minutes');
  });

  it('draws the buckets in time order even when the game answers out of order', async () => {
    const rows = buckets([{ avg: 100 }, { avg: 150 }]);
    getHistory.mockResolvedValue([rows[1], rows[0]]);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('**+50.0%**');
    expect(lastEmbed(editReply).description).toContain('last   150g');
  });

  it('says a single bucket in words instead of drawing a dot', async () => {
    getHistory.mockResolvedValue(buckets([{ avg: 100 }]));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('Only one bucket has a traded price');
    expect(editReply.mock.calls.at(-1)?.[0].files).toBeUndefined();
  });

  it('shows a muted card when the game did not answer the history request', async () => {
    getHistory.mockResolvedValue(null);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const embed = lastEmbed(editReply);
    expect(embed.description).toBe('The game did not answer the history request. Try again in a minute.');
    expect(embed.footer?.text).toBe('Traded prices · no history');
  });

  it('shows a muted card when nothing traded in the window', async () => {
    getHistory.mockResolvedValue([]);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toBe('No trades recorded in the last 24 hours.');
  });

  it('asks the game for the window the range names', async () => {
    const cases: Array<[string, string]> = [
      ['24h', '1d'],
      ['7d', '7d'],
      ['30d', '30d'],
      ['1y', '1y'],
    ];

    for (const [range, period] of cases) {
      const { interaction } = fakeHandle(range);
      await handle(interaction);
      expect(getHistory).toHaveBeenLastCalledWith(46, period);
    }
  });

  it('defaults to the 24 hour window when no range is given', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(getHistory).toHaveBeenCalledWith(46, '1d');
    expect(lastEmbed(editReply).title).toContain('last 24 hours');
  });

  it('names the yearly bucket and the last bucket date in the footer', async () => {
    getHistory.mockResolvedValue(
      buckets([{ avg: 100 }, { avg: 120 }]).map((row, index) => ({
        ...row,
        at: Date.parse('2025-11-20T00:00:00Z') + index * 7 * 24 * 60 * 60 * 1000,
      }))
    );
    const { interaction, editReply } = fakeHandle('1y');

    await handle(interaction);

    const embed = lastEmbed(editReply);
    expect(embed.description).toContain('buckets of 1 week');
    expect(embed.footer?.text).toBe('Traded prices · 1 week buckets · last 2025-11-27 UTC');
  });

  it('asks the user to pick from the list when the item is unknown', async () => {
    getById.mockResolvedValueOnce(null);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(editReply.mock.calls[0][0].content).toBe('Pick an item from the list.');
  });

  it('acknowledges before the limiter, then answers a refusal', async () => {
    check.mockRejectedValue(new DeeError('Slow down.', 'E1', ErrCodes.RATE_LIMIT));
    const { interaction, deferReply } = fakeHandle();

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(safeReply).toHaveBeenCalledWith(interaction, { content: 'Slow down.', flags: 64 });
  });

  it('reports an unexpected failure with its reference', async () => {
    getHistory.mockRejectedValue(new Error('boom'));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(editReply.mock.calls.at(-1)?.[0].content).toContain('unexpected error');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('/graph item controls', () => {
  it('puts a range menu with four windows and a share button under the card', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const rows = editReply.mock.calls[0][0].components ?? [];
    expect(rows).toHaveLength(2);

    const menu = rows[0].toJSON().components[0];
    expect(menu.custom_id).toBe('graph:range:46');
    expect((menu.options as Array<{ value: string }>).map((option) => option.value)).toEqual([
      '24h',
      '7d',
      '30d',
      '1y',
    ]);
    expect((menu.options as Array<{ value: string; default?: boolean }>).find((option) => option.default)?.value).toBe('24h');
    expect(rows[1].toJSON().components[0].custom_id).toBe('graph:share:46:24h');
  });

  it('marks the requested range as the current one', async () => {
    const { interaction, editReply } = fakeHandle('1y');

    await handle(interaction);

    const menu = editReply.mock.calls[0][0].components?.[0].toJSON().components[0];
    expect((menu.options as Array<{ value: string; default?: boolean }>).find((option) => option.default)?.value).toBe('1y');
  });

  it('re-renders the same item at the chosen range in place', async () => {
    const { interaction, deferUpdate, editReply } = fakeMenu('7d');

    await handleRangeMenu(interaction);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(getHistory).toHaveBeenCalledWith(46, '7d');
    const payload = editReply.mock.calls[0][0];
    expect(payload.embeds?.[0].toJSON().title).toBe('Teak log — average traded price, last 7 days');
    // the previous chart must be dropped, not appended to
    expect(payload.attachments).toEqual([]);
    expect(payload.components).toHaveLength(2);
  });

  it('says so when the item left the catalogue', async () => {
    getById.mockResolvedValueOnce(null);
    const { interaction, editReply } = fakeMenu('24h', 'graph:range:999');

    await handleRangeMenu(interaction);

    expect(editReply.mock.calls[0][0].content).toBe('Pick an item from the list.');
  });

  it('posts the same card to the channel and says where it went', async () => {
    const { interaction, editReply, send } = fakeShare('graph:share:46:1y');

    await handleShareButton(interaction);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0] as unknown as Payload & { content?: string };
    expect(payload.content).toBe('-# requested by <@user-1>');
    expect(payload.embeds?.[0].toJSON().title).toBe('Teak log — average traded price, last 1 year');
    expect(payload.files).toHaveLength(1);
    expect(editReply.mock.calls[0][0].content).toBe('Posted in <#chan-1>.');
  });

  it('spends the command bucket, so a rate-limited click posts nothing', async () => {
    check.mockRejectedValue(new DeeError('Slow down.', 'E1', ErrCodes.RATE_LIMIT));
    const { interaction, send } = fakeShare('graph:share:50:30d');

    await handleShareButton(interaction);

    expect(check).toHaveBeenCalledWith('user-1', 'graph');
    expect(send).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, { content: 'Slow down.', flags: 64 });
  });

  it('names the missing permission instead of failing silently', async () => {
    const { interaction, send } = fakeShare('graph:share:48:30d', false);

    await handleShareButton(interaction);

    expect(send).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, {
      content: 'I need Send Messages in this channel to post there.',
      flags: 64,
    });
  });
});
