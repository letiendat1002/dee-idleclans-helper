/**
 * `/watch` — arm a price alert that arrives in a DM.
 *
 * The command is two steps: the command opens a modal, the modal carries the
 * direction and the threshold, and only the modal submit writes the alert.
 * A modal keeps the interaction small and lets the client check the input
 * before it reaches the bot.
 */
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ItemCatalogue } from '../services/ItemCatalogue.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import { WatchlistService } from '../services/WatchlistService.js';
import { rateLimiter } from '../utils/RateLimiter.js';
import { DeeError, formatUnexpectedError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { safeReply } from '../ui/reply.js';
import { COLORS, ICONS, brandAuthor, formatMoney, priceFooter } from '../ui/theme.js';

const logger = createLogger('WATCH');

/** The prefix of the modal id: it carries the item the alert is about. */
const MODAL_PREFIX = 'watch:';

export const builder = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Get a DM when the price of an item crosses your threshold')
  .addStringOption((opt) =>
    opt.setName('item').setDescription('Item name').setAutocomplete(true).setRequired(true)
  );

/**
 * The modal that asks for the direction and the threshold.
 *
 * The threshold is pre-filled with the current ask, so the common alert — "tell
 * me when it falls" — needs one number typed.
 */
export function buildModal(itemId: number, itemName: string, currentAsk: number | null): ModalBuilder {
  const prefill = currentAsk === null || currentAsk <= 0 ? '' : String(Math.round(currentAsk));

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${itemId}`)
    .setTitle(`Watch ${itemName}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('direction')
          .setLabel('Direction: below or above')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('below')
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('threshold')
          .setLabel('Threshold in gold')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('3200')
          .setRequired(true)
          .setValue(prefill)
      )
    );
}

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const rawItem = interaction.options.getString('item', true);

  try {
    await rateLimiter.check(userId, 'watch');
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
      await safeReply(interaction, { content: 'I do not know this item — pick one from the list.', flags: 64 });
      return;
    }

    const quotes = await SnapshotStore.latestQuotes();
    const ask = quotes.get(item.itemId)?.ask ?? null;

    // a deferred interaction cannot open a modal: Discord rejects it as
    // already acknowledged, so the modal answers the command directly
    await interaction.showModal(buildModal(item.itemId, item.name, ask));
  } catch (err) {
    logger.error('/watch failed', { userId, error: err });
    await safeReply(interaction, { content: formatUnexpectedError('/watch', err), flags: 64 });
  }
}

/**
 * Handle the modal of `/watch`: validate the input, arm the alert and answer
 * with the confirmation.
 */
export async function handleWatchModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    const itemId = Number(interaction.customId.slice(MODAL_PREFIX.length));
    const direction = interaction.fields.getTextInputValue('direction').trim().toLowerCase();
    const thresholdRaw = interaction.fields.getTextInputValue('threshold').trim();

    if (direction !== 'below' && direction !== 'above') {
      await safeReply(interaction, {
        content: 'The direction must be **below** or **above**.',
        flags: 64,
      });
      return;
    }

    const threshold = Number(thresholdRaw);
    if (!/^\d+$/.test(thresholdRaw) || !Number.isSafeInteger(threshold) || threshold <= 0) {
      await safeReply(interaction, {
        content: 'The threshold must be a positive whole number of gold.',
        flags: 64,
      });
      return;
    }

    const item = await ItemCatalogue.getById(itemId);
    if (!item) {
      await safeReply(interaction, { content: 'I do not know this item.', flags: 64 });
      return;
    }

    await WatchlistService.add(
      interaction.user.id,
      interaction.guildId,
      itemId,
      direction,
      threshold
    );

    const quotes = await SnapshotStore.latestQuotes();
    const ask = quotes.get(itemId)?.ask ?? null;

    const snapshotAt = await SnapshotStore.latestSnapshotAt();
    const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
    const askText = ask === null || ask <= 0 ? 'no sell order' : formatMoney(ask);
    const motion = direction === 'below' ? `${ICONS.down} falls below` : `${ICONS.up} rises above`;

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle(`Alert armed — ${item.name}`)
      .setDescription(`A DM when the sell price ${motion} **${formatMoney(threshold)}**.`)
      .addFields(
        { name: 'Sell price now', value: askText, inline: true },
        {
          name: 'What happens next',
          value: 'It fires once, then re-arms when the price comes back.',
          inline: true,
        }
      )
      .setFooter({ text: priceFooter(snapshotAt) });

    await safeReply(interaction, { embeds: [embed], flags: 64 });
  } catch (err) {
    logger.error('/watch modal failed', { userId: interaction.user.id, error: err });
    await safeReply(interaction, { content: formatUnexpectedError('/watch', err), flags: 64 });
  }
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  const rows = await ItemCatalogue.search(focused, { tradeableOnly: true, limit: 25 });

  await interaction.respond(rows.map((row) => ({ name: row.name, value: String(row.itemId) })));
}
