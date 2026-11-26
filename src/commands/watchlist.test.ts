import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply, check, list, latestQuotes, latestSnapshotAt, getByIds, removeById } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeReply: vi.fn(),
  check: vi.fn(),
  list: vi.fn(),
  latestQuotes: vi.fn(),
  latestSnapshotAt: vi.fn(),
  getByIds: vi.fn(),
  removeById: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
import { ICONS } from '../ui/theme.js';
vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check } }));
vi.mock('../services/ItemCatalogue.js', () => ({ ItemCatalogue: { getByIds } }));
vi.mock('../services/SnapshotStore.js', () => ({ SnapshotStore: { latestQuotes, latestSnapshotAt } }));
vi.mock('../services/WatchlistService.js', () => ({ WatchlistService: { list, removeById } }));

import { MessageFlags, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { DeeError } from '../utils/errors.js';
import { handle, handleWatchlistMenu } from './watchlist.js';

interface ComponentsPayload {
  content?: string;
  embeds?: Array<{ toJSON(): { title?: string; description?: string; footer?: { text: string } } }>;
  components?: Array<{ toJSON(): { components: Array<{ options?: Array<{ label: string; value: string }> }> } }>;
}

/** The interaction members `/watchlist` reads. */
function fakeHandle(): {
  interaction: ChatInputCommandInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn<(options: ComponentsPayload) => Promise<void>>>;
} {
  const deferReply = vi.fn<(options: { flags?: number }) => Promise<void>>();
  deferReply.mockResolvedValue(undefined);
  const editReply = vi.fn<(options: ComponentsPayload) => Promise<void>>();
  editReply.mockResolvedValue(undefined);

  return {
    deferReply,
    editReply,
    interaction: {
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
  };
}

/** A watchlist row as the service returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    discordUserId: 'user-1',
    guildId: 'guild-1',
    itemId: 46,
    direction: 'below',
    threshold: 3_200,
    armed: true,
    delivered: true,
    lastFiredAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  latestSnapshotAt.mockResolvedValue(new Date('2026-11-14T05:56:00Z'));
  check.mockResolvedValue(undefined);
  list.mockResolvedValue([]);
  latestQuotes.mockResolvedValue(new Map([[46, { itemId: 46, ask: 3_389 }]]));
  getByIds.mockResolvedValue(new Map([[46, { itemId: 46, name: 'Titanium bar' }]]));
  removeById.mockResolvedValue(1);
});

describe('/watchlist handle', () => {
  it('answers a rate-limit error ephemerally', async () => {
    check.mockRejectedValueOnce(new DeeError('⏱ Slow down', 'E1', 'E1_004'));
    const { interaction, deferReply } = fakeHandle();

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: '⏱ Slow down', flags: 64 });
    expect(deferReply).not.toHaveBeenCalled();
  });

  it('says so when the user has no alert', async () => {
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const empty = editReply.mock.calls[0][0].embeds?.[0].toJSON();
    expect(empty?.title).toContain('Your watchlist is empty');
    expect(empty?.description).toContain('Use `/watch` to arm a price alert');
  });

  it('lists every alert with its state and offers a select menu', async () => {
    list.mockResolvedValueOnce([
      row(),
      row({ id: 8, armed: false, delivered: false }),
      row({ id: 9, armed: false }),
    ]);
    const { interaction, deferReply, editReply } = fakeHandle();

    await handle(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const options = editReply.mock.calls[0][0];
    const embed = options.embeds?.[0].toJSON();
    expect(embed?.title).toContain('Your watchlist');
    expect(embed?.description).toContain('Titanium bar');
    expect(embed?.description).toContain('DM blocked');
    expect(embed?.description).toContain('Fired — re-arms when the price comes back');
    expect(options.components?.[0].toJSON().components[0].options).toHaveLength(3);
  });

  it('renders "no sell order" when the market has no ask', async () => {
    list.mockResolvedValueOnce([row()]);
    latestQuotes.mockResolvedValueOnce(new Map([[46, { itemId: 46, ask: 0 }]]));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(editReply.mock.calls[0][0].embeds?.[0].toJSON().description).toContain('no sell order');
  });

  it('caps the select menu at 25 rows and says so', async () => {
    list.mockResolvedValueOnce(Array.from({ length: 26 }, (_, index) => row({ id: index + 1 })));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    const options = editReply.mock.calls[0][0];
    expect(options.embeds?.[0].toJSON().description).toContain('first 25');
    expect(options.components?.[0].toJSON().components[0].options).toHaveLength(25);
  });

  it('answers a reference id when the listing throws', async () => {
    list.mockRejectedValueOnce(new Error('db down'));
    const { interaction, editReply } = fakeHandle();

    await handle(interaction);

    expect(editReply).toHaveBeenCalledWith({ content: expect.stringContaining(ICONS.warning) });
  });
});

describe('/watchlist select menu', () => {
  /** A select-menu interaction with the given value. */
  function fakeMenu(value: string): StringSelectMenuInteraction {
    return {
      user: { id: 'user-1' },
      values: [value],
    } as unknown as StringSelectMenuInteraction;
  }

  it('rejects a non-integer row id before touching the database', async () => {
    await handleWatchlistMenu(fakeMenu('abc'));

    expect(removeById).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(expect.anything(), {
      content: 'That alert is already gone.',
      flags: 64,
    });
  });

  it('reports an already-removed alert', async () => {
    removeById.mockResolvedValueOnce(0);

    await handleWatchlistMenu(fakeMenu('7'));

    expect(removeById).toHaveBeenCalledWith(7, 'user-1');
    expect(safeReply).toHaveBeenCalledWith(expect.anything(), {
      content: 'That alert is already gone.',
      flags: 64,
    });
  });

  it('confirms the removal', async () => {
    await handleWatchlistMenu(fakeMenu('7'));

    expect(safeReply).toHaveBeenCalledWith(expect.anything(), {
      content: 'Removed the alert.',
      flags: 64,
    });
  });

  it('answers a reference id when the removal throws', async () => {
    removeById.mockRejectedValueOnce(new Error('db down'));

    await handleWatchlistMenu(fakeMenu('7'));

    expect(safeReply).toHaveBeenCalledWith(expect.anything(), {
      content: expect.stringContaining(ICONS.warning),
      flags: 64,
    });
  });
});
