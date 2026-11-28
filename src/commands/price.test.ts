import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply, check, getById, latestQuote, latestSnapshotAt, latestQuoteAt, recentlySeenItemIds, getPriceAverages } = vi.hoisted(
  () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    safeReply: vi.fn(),
    check: vi.fn(),
    getById: vi.fn(),
    latestQuote: vi.fn(),
    latestSnapshotAt: vi.fn(),
    latestQuoteAt: vi.fn(),
    recentlySeenItemIds: vi.fn(),
    getPriceAverages: vi.fn(),
  })
);

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check } }));
vi.mock('../services/ItemCatalogue.js', () => ({ ItemCatalogue: { getById } }));
vi.mock('../services/SnapshotStore.js', () => ({
  SnapshotStore: { latestQuote, latestSnapshotAt, latestQuoteAt, recentlySeenItemIds },
}));
vi.mock('../services/IdleClansApi.js', () => ({ getPriceAveragesCached: getPriceAverages }));

import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { DeeError, ErrCodes } from '../utils/errors.js';
import { COLORS } from '../ui/theme.js';
import { handle, handleShareButton, handleWatchButton } from './price.js';

interface EmbedJson {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
}

interface Payload {
  content?: string;
  embeds?: Array<{ toJSON(): EmbedJson }>;
}

/** The interaction members `/price` reads. */
function fakeHandle(): {
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
      options: { getString: () => '46' },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
  };
}

/** One quote as the snapshot store returns it. */
function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { itemId: 46, ask: 148, bid: 140, askVolume: 5412, bidVolume: 1200, ...overrides };
}

/** The embed of the last reply. */
function lastEmbed(editReply: ReturnType<typeof fakeHandle>['editReply']): EmbedJson {
  const payload = editReply.mock.calls.at(-1)?.[0];
  const embed = payload?.embeds?.[0];

  if (!embed) throw new Error('no embed in the reply');
  return embed.toJSON();
}

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue(undefined);
  getById.mockResolvedValue({ itemId: 46, name: 'Teak log' });
  latestQuote.mockResolvedValue(quote());
  latestSnapshotAt.mockResolvedValue(new Date(Date.UTC(2026, 10, 14, 11, 40)));
  latestQuoteAt.mockResolvedValue(null);
  recentlySeenItemIds.mockResolvedValue(new Set([46]));
  getPriceAverages.mockResolvedValue(null);
});

describe('/price', () => {
  it('defers the reply as ephemeral', async () => {
    const { interaction, deferReply } = fakeHandle();

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('titles the card with the item', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).title).toBe('Teak log');
  });

  it('prints the sell price with the units available at it', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('Sell price **148g** · 5,412 units');
  });

  it('prints the buy order with the units wanted at it', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('Buy order **140g** · 1,200 units');
  });

  it('writes one unit in the singular', async () => {
    latestQuote.mockResolvedValue(quote({ askVolume: 1 }));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('Sell price **148g** · 1 unit');
  });

  it('prints the price alone when the depth is unknown', async () => {
    latestQuote.mockResolvedValue(quote({ askVolume: null }));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain('Sell price **148g**\n');
  });

  it('treats a price of 0 as no sell order instead of a free item', async () => {
    latestQuote.mockResolvedValue(quote({ ask: 0, askVolume: 0 }));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const description = lastEmbed(editReply).description ?? '';
    expect(description).toContain('No sell order right now.');
    expect(description).toContain('Buy order **140g**');
  });

  it('shows a muted card when neither side has an order', async () => {
    latestQuote.mockResolvedValue(quote({ ask: 0, bid: 0 }));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const embed = lastEmbed(editReply);
    expect(embed.description).toBe('No sell order and no buy order right now.');
    expect(embed.color).toBe(COLORS.muted);
  });

  it('reads the named item\'s own newest quote instead of every item in the table', async () => {
    const { interaction } = fakeHandle();

    await handle(interaction);

    expect(latestQuote).toHaveBeenCalledWith(46);
  });

  it('shows the muted card when the item has no snapshot row', async () => {
    latestQuote.mockResolvedValue(null);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toBe('No sell order and no buy order right now.');
  });

  it('refuses to quote an item the last two polls did not see', async () => {
    recentlySeenItemIds.mockResolvedValue(new Set());
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const embed = lastEmbed(editReply);
    expect(embed.description).toBe('This item is not on the market in the last two snapshots.');
    expect(embed.color).toBe(COLORS.muted);
  });

  it('prints the trade averages as their own labelled line', async () => {
    getPriceAverages.mockResolvedValue({ avg1d: 162, avg7d: 142, avg30d: 140, tradeVolume1d: 5000 });
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).description).toContain(
      '-# trade avg 1d **162g** · 7d **142g** · 30d **140g** · 5,000 traded (1d)'
    );
  });

  it('carries the snapshot in the footer', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).footer?.text).toBe('Sell prices · snapshot 11:40 UTC');
  });

  it('asks the user to pick from the list when the item is unknown', async () => {
    getById.mockResolvedValue(null);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(editReply.mock.calls.at(-1)?.[0]?.content).toBe('Pick an item from the list.');
  });

  it('acknowledges before the limiter, then answers a refusal', async () => {
    check.mockRejectedValue(new DeeError('Slow down.', 'E1', ErrCodes.RATE_LIMIT));
    const { interaction, deferReply } = fakeHandle();

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(safeReply).toHaveBeenCalledWith(interaction, { content: 'Slow down.', flags: 64 });
  });
});

/** The button interaction members the share handler reads. */
function fakeShare(customId: string): {
  interaction: ButtonInteraction;
  editReply: ReturnType<typeof vi.fn<(payload: { content?: string }) => Promise<void>>>;
  send: ReturnType<typeof vi.fn>;
} {
  const editReply = vi.fn<(payload: { content?: string }) => Promise<void>>(async () => undefined);
  const send = vi.fn(async () => undefined);

  return {
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
        permissionsFor: () => ({ has: () => true }),
        send,
      },
      deferReply: vi.fn(async () => undefined),
      editReply,
    } as unknown as ButtonInteraction,
  };
}

describe('/price share', () => {
  it('puts a share button under a card that carries a quote', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    type CardRow = { toJSON(): { components: Array<{ custom_id: string }> } };
    const lastReply = editReply.mock.calls.at(-1)?.[0] as unknown as { components?: CardRow[] } | undefined;
    const shared = lastReply?.components?.[0]?.toJSON();
    expect(shared?.components[0]?.custom_id).toBe('price:share:46');
    expect(shared?.components[1]?.custom_id).toBe('price:watch:46');
  });

  it('puts no share button on a card that quotes nothing', async () => {
    recentlySeenItemIds.mockResolvedValue(new Set<number>());
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const payload = editReply.mock.calls.at(-1)?.[0] as unknown as { components?: unknown[] };
    expect(payload.components).toEqual([]);
  });

  it('posts the same card to the channel and says where it went', async () => {
    const { interaction, editReply, send } = fakeShare('price:share:46');

    await handleShareButton(interaction);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0] as unknown as Payload & { content?: string };
    expect(payload.content).toBe('-# requested by <@user-1>');
    expect(payload.embeds?.[0].toJSON().title).toBe('Teak log');
    expect(editReply.mock.calls[0][0].content).toBe('Posted in <#chan-1>.');
  });

  it('refuses to post a card that quotes nothing', async () => {
    recentlySeenItemIds.mockResolvedValue(new Set<number>());
    const { interaction, send } = fakeShare('price:share:47');

    await handleShareButton(interaction);

    expect(send).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, {
      content: 'That item is not on the market right now.',
      flags: 64,
    });
  });
});

describe('/price data reliability', () => {
  it('renders the card without a trade average when none is available', async () => {
    getPriceAverages.mockResolvedValue(null);
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const description = lastEmbed(editReply).description ?? '';
    expect(description).toContain('Sell price **148g**');
    expect(description).not.toContain('trade avg');
  });

  it('stamps the quote with the item own capture time, not the newest poll', async () => {
    latestQuoteAt.mockResolvedValue(new Date(Date.UTC(2026, 10, 14, 11, 38)));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).footer?.text).toBe('Sell prices · snapshot 11:38 UTC');
  });

  it('stamps an off-market card with the feed time, not an old item row', async () => {
    latestQuoteAt.mockResolvedValue(new Date(Date.UTC(2026, 10, 14, 9, 0)));
    recentlySeenItemIds.mockResolvedValue(new Set<number>());
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(lastEmbed(editReply).footer?.text).toBe('Sell prices · snapshot 11:40 UTC');
  });
});

describe('/price watch button', () => {
  function fakeClick(customId: string): {
    interaction: ButtonInteraction;
    showModal: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  } {
    const showModal = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);

    return {
      showModal,
      reply,
      interaction: { customId, user: { id: 'user-1' }, showModal, reply } as unknown as ButtonInteraction,
    };
  }

  it('opens the watch modal on this item, pre-filled with its sell price', async () => {
    latestQuote.mockResolvedValue({ ask: 148 });
    const { interaction, showModal } = fakeClick('price:watch:46');

    await handleWatchButton(interaction);

    expect(showModal).toHaveBeenCalledTimes(1);
    const modal = showModal.mock.calls[0][0] as unknown as {
      toJSON(): { custom_id: string; components: Array<{ components: Array<{ custom_id: string; value?: string }> }> };
    };
    const json = modal.toJSON();
    expect(json.custom_id).toBe('watch:46');
    expect(json.components[1].components[0].value).toBe('148');
  });

  it('drops a modal Discord no longer accepts instead of throwing', async () => {
    latestQuote.mockResolvedValue({ ask: 148 });
    const { interaction, showModal } = fakeClick('price:watch:46');
    showModal.mockRejectedValueOnce(new Error('Unknown interaction'));

    await expect(handleWatchButton(interaction)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it('answers ephemerally when the item left the catalogue', async () => {
    getById.mockResolvedValue(null);
    const { interaction, reply, showModal } = fakeClick('price:watch:999');

    await handleWatchButton(interaction);

    expect(showModal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'That item is gone from the catalogue.' })
    );
  });

  it('does not open a modal when the rate limiter refuses the click', async () => {
    check.mockRejectedValue(new DeeError('Slow down.', 'E1', ErrCodes.RATE_LIMIT));
    const { interaction, reply, showModal } = fakeClick('price:watch:46');

    await handleWatchButton(interaction);

    expect(showModal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Slow down.' }));
  });
});
