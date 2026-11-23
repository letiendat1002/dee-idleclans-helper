import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply, check, getById, search, remove } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeReply: vi.fn(),
  check: vi.fn(),
  getById: vi.fn(),
  search: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check } }));
vi.mock('../services/ItemCatalogue.js', () => ({ ItemCatalogue: { getById, search } }));
vi.mock('../services/WatchlistService.js', () => ({ WatchlistService: { remove } }));

import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { DeeError } from '../utils/errors.js';
import { handle, autocomplete } from './unwatch.js';

/** A minimal interaction: only the members the handler reads. */
function fakeInteraction(overrides: Record<string, unknown> = {}): ChatInputCommandInteraction {
  return {
    user: { id: 'user-1' },
    client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    options: { getString: () => '46' },
    deferReply: vi.fn(),
    editReply: vi.fn(),
    ...overrides,
  } as unknown as ChatInputCommandInteraction;
}

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue(undefined);
  remove.mockResolvedValue(1);
  getById.mockResolvedValue({ itemId: 46, name: 'Titanium bar' });
  search.mockResolvedValue([{ itemId: 46, name: 'Titanium bar' }]);
});

describe('/unwatch handle', () => {
  it('answers a rate-limit error ephemerally without deferring', async () => {
    check.mockRejectedValueOnce(new DeeError('⏱ Slow down', 'E1', 'E1_004'));
    const interaction = fakeInteraction();

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: '⏱ Slow down', flags: 64 });
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('rejects a non-integer item id before any lookup', async () => {
    const interaction = fakeInteraction({ options: { getString: () => 'not-a-number' } });

    await handle(interaction);

    expect(getById).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'I do not know this item — pick one from the list.' });
  });

  it('rejects an unknown item', async () => {
    getById.mockResolvedValueOnce(null);
    const interaction = fakeInteraction();

    await handle(interaction);

    expect(remove).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'I do not know this item — pick one from the list.' });
  });

  it('says there is no alert when nothing was removed', async () => {
    remove.mockResolvedValueOnce(0);
    const interaction = fakeInteraction();

    await handle(interaction);

    expect(remove).toHaveBeenCalledWith('user-1', 46);
    const call = vi.mocked(interaction.editReply).mock.calls[0][0] as {
      embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    };
    const embed = call.embeds?.[0].toJSON();
    expect(embed?.title).toContain('No alert for Titanium bar');
    expect(embed?.description).toBe('Use `/watch` to arm one.');
  });

  it('reports a single removed alert', async () => {
    const interaction = fakeInteraction();

    await handle(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const single = vi.mocked(interaction.editReply).mock.calls[0][0] as {
      embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    };
    expect(single.embeds?.[0].toJSON().title).toContain('Alert removed — Titanium bar');
    expect(single.embeds?.[0].toJSON().description).toBe('No DM will fire for this item.');
  });

  it('reports several removed alerts', async () => {
    remove.mockResolvedValueOnce(2);
    const interaction = fakeInteraction();

    await handle(interaction);

    const many = vi.mocked(interaction.editReply).mock.calls[0][0] as {
      embeds?: Array<{ toJSON(): { description?: string } }>;
    };
    expect(many.embeds?.[0].toJSON().description).toContain('2 alerts removed');
  });

  it('answers with a reference id when the removal throws', async () => {
    remove.mockRejectedValueOnce(new Error('db down'));
    const interaction = fakeInteraction();

    await handle(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('🚨') });
  });
});

describe('/unwatch autocomplete', () => {
  it('maps the tradeable catalogue rows to choices', async () => {
    const respond = vi.fn();
    const interaction = {
      options: { getFocused: () => 'titan' },
      respond,
    } as unknown as Parameters<typeof autocomplete>[0];

    await autocomplete(interaction);

    expect(search).toHaveBeenCalledWith('titan', { tradeableOnly: true, limit: 25 });
    expect(respond).toHaveBeenCalledWith([{ name: 'Titanium bar', value: '46' }]);
  });
});
