/**
 * `/unwatch` — remove a price alert.
 *
 * The command removes every alert of the user for the item, so one item never
 * keeps a hidden alert behind.
 */
import {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { ItemCatalogue } from '../services/ItemCatalogue.js';
import { WatchlistService } from '../services/WatchlistService.js';
import { rateLimiter } from '../utils/RateLimiter.js';
import { DeeError, formatUnexpectedError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { safeReply } from '../ui/reply.js';
import { COLORS, brandAuthor } from '../ui/theme.js';

const logger = createLogger('UNWATCH');

export const builder = new SlashCommandBuilder()
  .setName('unwatch')
  .setDescription('Remove a price alert of an item')
  .addStringOption((opt) =>
    opt.setName('item').setDescription('Item name').setAutocomplete(true).setRequired(true)
  );

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const rawItem = interaction.options.getString('item', true);

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    await rateLimiter.check(userId, 'unwatch');
  } catch (err) {
    if (err instanceof DeeError) {
      await safeReply(interaction, { content: err.message, flags: 64 });
      return;
    }
    throw err;
  }

  try {
    const itemId = Number(rawItem);
    const item = Number.isInteger(itemId) ? await ItemCatalogue.getById(itemId) : null;

    if (!item) {
      await interaction.editReply({ content: 'I do not know this item — pick one from the list.' });
      return;
    }

    const removed = await WatchlistService.remove(userId, item.itemId);
    const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;

    if (removed === 0) {
      const none = new EmbedBuilder()
        .setColor(COLORS.muted)
        .setAuthor(brandAuthor(avatarUrl))
        .setTitle(`No alert for ${item.name}`)
        .setDescription('Use `/watch` to arm one.');

      await interaction.editReply({ embeds: [none] });
      return;
    }

    const done = new EmbedBuilder()
      .setColor(COLORS.success)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle(`Alert removed — ${item.name}`)
      .setDescription(
        removed === 1
          ? 'No DM will fire for this item.'
          : `${removed} alerts removed; no DM will fire for this item.`
      );

    await interaction.editReply({ embeds: [done] });
  } catch (err) {
    logger.error('/unwatch failed', { userId, error: err });
    const msg = formatUnexpectedError('/unwatch', err);
    await interaction.editReply({ content: msg });
  }
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  const rows = await ItemCatalogue.search(focused, { tradeableOnly: true, limit: 25 });

  await interaction.respond(rows.map((row) => ({ name: row.name, value: String(row.itemId) })));
}
