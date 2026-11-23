/**
 * `/watchlist` — everything the user watches, with the price of the moment.
 *
 * The command lists the alerts and offers a select menu that removes one of
 * them. The menu carries the id of the watchlist row, so the removal hits the
 * row the user picked and not every alert of the item.
 */
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { ItemCatalogue } from '../services/ItemCatalogue.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import { WatchlistService } from '../services/WatchlistService.js';
import { rateLimiter } from '../utils/RateLimiter.js';
import { DeeError, formatUnexpectedError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { safeReply } from '../ui/reply.js';
import { COLORS, ICONS, brandAuthor, formatMoney, priceFooter } from '../ui/theme.js';

const logger = createLogger('WATCHLIST');

/** The prefix of the select menu id: it carries the removal of one alert. */
const MENU_PREFIX = 'watchlist:';

/** A select menu carries at most 25 options. */
const MAX_OPTIONS = 25;

/** Discord rejects an embed description longer than 4096 characters. */
const MAX_DESCRIPTION = 4096;

/**
 * Keep whole lines only: drop lines from the end until the joined text fits
 * the cap, so a bullet is never cut in half.
 */
function capDescription(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length === 0 ? line.length : length + 1 + line.length;
    if (next > cap) break;
    kept.push(line);
    length = next;
  }
  return kept.join('\n');
}

export const builder = new SlashCommandBuilder()
  .setName('watchlist')
  .setDescription('The items you watch and their sell price');

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  try {
    await rateLimiter.check(userId, 'watchlist');
  } catch (err) {
    if (err instanceof DeeError) {
      await safeReply(interaction, { content: err.message, flags: 64 });
      return;
    }
    throw err;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const rows = await WatchlistService.list(userId);

    const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;

    if (rows.length === 0) {
      const empty = new EmbedBuilder()
        .setColor(COLORS.muted)
        .setAuthor(brandAuthor(avatarUrl))
        .setTitle('Your watchlist is empty')
        .setDescription(
          'Use `/watch` to arm a price alert. It arrives in a DM when the sell price crosses your threshold.'
        )
        .setThumbnail(avatarUrl);

      await interaction.editReply({ embeds: [empty] });
      return;
    }

    const quotes = await SnapshotStore.latestQuotes();
    const items = await ItemCatalogue.getByIds(rows.map((row) => row.itemId));

    const note =
      rows.length > MAX_OPTIONS
        ? `You have ${rows.length} alerts; the menu below shows the first ${MAX_OPTIONS}. Use \`/unwatch\` to remove the others.`
        : '';

    const lines = rows.map((row) => {
      const name = items.get(row.itemId)?.name ?? `item ${row.itemId}`;
      const ask = quotes.get(row.itemId)?.ask ?? null;
      const askText = ask === null || ask <= 0 ? 'no sell order' : ask.toLocaleString('en-US');
      const state = !row.delivered
        ? `\n   ${ICONS.warning} DM blocked — enable DMs to receive alerts`
        : row.armed
          ? ''
          : `\n   ${ICONS.clock} Fired — re-arms when the price comes back`;
      return `${ICONS.alert} **${name}** — ${row.direction} **${formatMoney(row.threshold)}** · sell price ${askText}${state}`;
    });

    const description = [note, ...lines].filter((line) => line !== '').join('\n');
    const capped = capDescription(description, MAX_DESCRIPTION);

    const hasTrouble = rows.some((row) => !row.delivered || !row.armed);
    const snapshotAt = await SnapshotStore.latestSnapshotAt();

    const embed = new EmbedBuilder()
      .setColor(hasTrouble ? COLORS.warning : COLORS.success)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle('Your watchlist')
      .setDescription(capped)
      .setFooter({ text: priceFooter(snapshotAt) });

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${MENU_PREFIX}remove`)
      .setPlaceholder('Remove an alert')
      .addOptions(
        rows.slice(0, MAX_OPTIONS).map((row) => {
          const name = items.get(row.itemId)?.name ?? `item ${row.itemId}`;
          return {
            label: name.slice(0, 100),
            value: String(row.id),
            description: `${row.direction} ${formatMoney(row.threshold)}`.slice(0, 100),
          };
        })
      );

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  } catch (err) {
    logger.error('/watchlist failed', { userId, error: err });
    const msg = formatUnexpectedError('/watchlist', err);
    await interaction.editReply({ content: msg });
  }
}

/**
 * Handle the select menu of `/watchlist`: remove the row the user picked.
 */
export async function handleWatchlistMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const userId = interaction.user.id;
  const selected = interaction.values[0];
  const rowId = Number(selected);

  if (!Number.isInteger(rowId)) {
    await safeReply(interaction, { content: 'That alert is already gone.', flags: 64 });
    return;
  }

  try {
    const removed = await WatchlistService.removeById(rowId, userId);

    if (removed === 0) {
      await safeReply(interaction, { content: 'That alert is already gone.', flags: 64 });
      return;
    }

    await safeReply(interaction, { content: 'Removed the alert.', flags: 64 });
  } catch (err) {
    logger.error('/watchlist menu failed', { userId, error: err });
    await safeReply(interaction, { content: formatUnexpectedError('/watchlist', err), flags: 64 });
  }
}
