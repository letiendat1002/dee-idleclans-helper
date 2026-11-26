import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply, check, getById, search, latestQuotes, latestSnapshotAt, add } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeReply: vi.fn(),
  check: vi.fn(),
  getById: vi.fn(),
  search: vi.fn(),
  latestQuotes: vi.fn(),
  latestSnapshotAt: vi.fn(),
  add: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
import { ICONS } from '../ui/theme.js';
vi.mock('../utils/RateLimiter.js', () => ({ rateLimiter: { check } }));
vi.mock('../services/ItemCatalogue.js', () => ({ ItemCatalogue: { getById, search } }));
vi.mock('../services/SnapshotStore.js', () => ({ SnapshotStore: { latestQuotes, latestSnapshotAt } }));
vi.mock('../services/WatchlistService.js', () => ({ WatchlistService: { add } }));

import type { ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import { DeeError } from '../utils/errors.js';
import { handle, handleWatchModal, autocomplete } from './watch.js';

/** The item every case watches unless it overrides it. */
const ITEM = { itemId: 46, name: 'Titanium bar' };

/** An interaction with only the members the handler reads. */
function commandInteraction(overrides: Record<string, unknown> = {}): ChatInputCommandInteraction {
  return {
    user: { id: 'user-1' },
    options: { getString: () => '46' },
    showModal: vi.fn(),
    ...overrides,
  } as unknown as ChatInputCommandInteraction;
}

/** A modal submit with the given input fields. */
function modalInteraction(
  customId: string,
  fields: Record<string, string>
): ModalSubmitInteraction {
  return {
    customId,
    user: { id: 'user-1' },
    client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    guildId: 'guild-1',
    fields: { getTextInputValue: (name: string) => fields[name] ?? '' },
  } as unknown as ModalSubmitInteraction;
}

beforeEach(() => {
  vi.clearAllMocks();
  latestSnapshotAt.mockResolvedValue(new Date('2026-11-14T05:56:00Z'));
  check.mockResolvedValue(undefined);
  getById.mockResolvedValue(ITEM);
  search.mockResolvedValue([ITEM]);
  latestQuotes.mockResolvedValue(new Map([[46, { itemId: 46, ask: 3_389 }]]));
  add.mockResolvedValue({ id: 7 });
});

describe('/watch handle', () => {
  it('answers a rate-limit error ephemerally', async () => {
    check.mockRejectedValueOnce(new DeeError('⏱ Slow down', 'E1', 'E1_004'));
    const interaction = commandInteraction();

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: '⏱ Slow down', flags: 64 });
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('rejects a non-integer item id without opening the modal', async () => {
    const interaction = commandInteraction({ options: { getString: () => 'x' } });

    await handle(interaction);

    expect(getById).not.toHaveBeenCalled();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, {
      content: 'I do not know this item — pick one from the list.',
      flags: 64,
    });
  });

  it('opens the modal with the current ask pre-filled', async () => {
    const interaction = commandInteraction();

    await handle(interaction);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = (interaction.showModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const json = modal.toJSON();
    expect(json.custom_id).toBe('watch:46');
    expect(json.title).toContain('Titanium bar');
    const inputs = json.components.flatMap((row: { components: Array<{ custom_id: string; value?: string }> }) => row.components);
    expect(inputs.find((input: { custom_id: string; value?: string }) => input.custom_id === 'threshold')?.value).toBe('3389');
  });

  it('leaves the threshold empty when the item has no ask', async () => {
    latestQuotes.mockResolvedValueOnce(new Map([[46, { itemId: 46, ask: 0 }]]));
    const interaction = commandInteraction();

    await handle(interaction);

    const modal = (interaction.showModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const inputs = modal.toJSON().components.flatMap((row: { components: Array<{ custom_id: string; value?: string }> }) => row.components);
    expect(inputs.find((input: { custom_id: string; value?: string }) => input.custom_id === 'threshold')?.value).toBe('');
  });

  it('answers a reference id when the catalogue throws', async () => {
    getById.mockRejectedValueOnce(new Error('db down'));
    const interaction = commandInteraction();

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: expect.stringContaining(ICONS.warning), flags: 64 });
  });
});

describe('/watch modal', () => {
  it('rejects a direction other than below or above', async () => {
    const interaction = modalInteraction('watch:46', { direction: 'sideways', threshold: '3200' });

    await handleWatchModal(interaction);

    expect(add).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, {
      content: 'The direction must be **below** or **above**.',
      flags: 64,
    });
  });

  it.each(['abc', '0', '-5', '1.5', '99999999999999999999'])(
    'rejects the threshold %s',
    async (threshold) => {
      const interaction = modalInteraction('watch:46', { direction: 'below', threshold });

      await handleWatchModal(interaction);

      expect(add).not.toHaveBeenCalled();
      expect(safeReply).toHaveBeenCalledWith(interaction, {
        content: 'The threshold must be a positive whole number of gold.',
        flags: 64,
      });
    }
  );

  it('trims and lowercases the direction', async () => {
    const interaction = modalInteraction('watch:46', { direction: '  BELOW ', threshold: ' 3200 ' });

    await handleWatchModal(interaction);

    expect(add).toHaveBeenCalledWith('user-1', 'guild-1', 46, 'below', 3_200);
  });

  it('rejects an item the catalogue does not know', async () => {
    getById.mockResolvedValueOnce(null);
    const interaction = modalInteraction('watch:46', { direction: 'below', threshold: '3200' });

    await handleWatchModal(interaction);

    expect(add).not.toHaveBeenCalled();
    expect(safeReply).toHaveBeenCalledWith(interaction, { content: 'I do not know this item.', flags: 64 });
  });

  it('arms the alert and confirms the threshold and the ask', async () => {
    const interaction = modalInteraction('watch:46', { direction: 'above', threshold: '4000' });

    await handleWatchModal(interaction);

    expect(add).toHaveBeenCalledWith('user-1', 'guild-1', 46, 'above', 4_000);
    const options = safeReply.mock.calls[0][1];
    expect(options.flags).toBe(64);
    const embed = options.embeds[0].toJSON();
    expect(embed.title).toContain('Alert armed — Titanium bar');
    expect(embed.description).toContain('rises above');
    expect(embed.description).toContain('4,000g');
    expect(embed.footer.text).toBe('Sell prices · snapshot 05:56 UTC');
    const text = (embed.fields ?? []).map((field: { value: string }) => field.value).join(' ');
    expect(text).toContain('3,389g');
  });

  it('answers a reference id when arming throws', async () => {
    add.mockRejectedValueOnce(new Error('db down'));
    const interaction = modalInteraction('watch:46', { direction: 'below', threshold: '3200' });

    await handleWatchModal(interaction);

    expect(safeReply).toHaveBeenCalledWith(interaction, { content: expect.stringContaining(ICONS.warning), flags: 64 });
  });
});

describe('/watch autocomplete', () => {
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
