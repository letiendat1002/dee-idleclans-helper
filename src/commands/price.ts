/**
 * `/price` — the market of one item right now.
 *
 * Two sides, both from the newest snapshot: the sell price with the units
 * available at it, and the buy order with the units wanted at it. Then the
 * game's own trade averages, labelled as a different unit. `/graph item` shows
 * how the sell price got here; this command shows where it stands.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { ItemCatalogue, type ItemRow } from '../services/ItemCatalogue.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import { getPriceAveragesCached } from '../services/IdleClansApi.js';
import { rateLimiter } from '../utils/RateLimiter.js';
import { ErrCodes, DeeError, formatUnexpectedError, userError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { safeReply } from '../ui/reply.js';
import { COLORS, brandAuthor, formatMoney, priceFooter, tradeAverageText } from '../ui/theme.js';
import { postToChannel, selfAvatar, shareButton, watchButton, type ChannelCard } from '../ui/share.js';
import { buildModal } from './watch.js';

const logger = createLogger('PRICE');

export const builder = new SlashCommandBuilder()
  .setName('price')
  .setDescription('An item’s sell price and buy order right now')
  .addStringOption((opt) =>
    opt.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true)
  );

/** A side of the market: a price, and how many units sit at it when known. */
function side(price: number | null | undefined, volume: number | null | undefined): string | null {
  if (price === null || price === undefined || price <= 0) return null;
  if (volume === null || volume === undefined) return `**${formatMoney(price)}**`;

  const count = `${volume.toLocaleString('en-US')} ${volume === 1 ? 'unit' : 'units'}`;

  return `**${formatMoney(price)}** · ${count}`;
}

/** A card and whether it stands behind a quote: a muted card cannot be posted. */
interface PriceCard {
  card: ChannelCard;
  onMarket: boolean;
}

async function renderPriceCard(item: ItemRow, avatarUrl: string | null): Promise<PriceCard> {
  const [quote, averages, snapshotAt, quoteAt, seen] = await Promise.all([
    SnapshotStore.latestQuote(item.itemId),
    getPriceAveragesCached(item.itemId),
    SnapshotStore.latestSnapshotAt(),
    SnapshotStore.latestQuoteAt(item.itemId),
    SnapshotStore.recentlySeenItemIds(),
  ]);

  const live = seen.has(item.itemId) ? quote : null;
  const sell = side(live?.ask, live?.askVolume);
  const buy = side(live?.bid, live?.bidVolume);

  const embed = new EmbedBuilder()
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(item.name)
    .setThumbnail(avatarUrl)
    .setFooter({ text: priceFooter(quoteAt ?? snapshotAt) });

  if (!seen.has(item.itemId)) {
    return {
      onMarket: false,
      card: {
        embeds: [
          embed
            .setColor(COLORS.muted)
            .setDescription('This item is not on the market in the last two snapshots.')
            .setFooter({ text: priceFooter(snapshotAt) }),
        ],
      },
    };
  }

  if (sell === null && buy === null) {
    return {
      onMarket: false,
      card: {
        embeds: [
          embed
            .setColor(COLORS.muted)
            .setDescription('No sell order and no buy order right now.')
            .setFooter({ text: priceFooter(snapshotAt) }),
        ],
      },
    };
  }

  const lines: string[] = [];
  lines.push(sell === null ? 'No sell order right now.' : `Sell price ${sell}`);
  lines.push(buy === null ? 'No buy order right now.' : `Buy order ${buy}`);

  const average = tradeAverageText(averages);
  if (average !== null) lines.push(`-# trade avg ${average}`);

  return {
    onMarket: true,
    card: { embeds: [embed.setColor(COLORS.brand).setDescription(lines.join('\n'))] },
  };
}

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await rateLimiter.check(userId, 'price');
  } catch (err) {
    if (err instanceof DeeError) {
      await safeReply(interaction, { content: err.message, flags: 64 });
      return;
    }
    throw err;
  }

  try {
    const itemId = Number(interaction.options.getString('item', true));
    const item = Number.isInteger(itemId) ? await ItemCatalogue.getById(itemId) : null;

    if (!item) {
      await interaction.editReply({ content: 'Pick an item from the list.' });
      return;
    }

    const { card, onMarket } = await renderPriceCard(item, selfAvatar(interaction));
    await interaction.editReply({
      ...card,
      // A muted card says the snapshot holds nothing to quote: there is nothing to post
      // and nothing to alert on either.
      components: onMarket
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...shareButton(`price:share:${item.itemId}`).components,
              ...watchButton(item.itemId).components
            ),
          ]
        : [],
    });
  } catch (err) {
    logger.error('/price failed', { userId, error: err });
    await interaction.editReply({ content: formatUnexpectedError('/price', err) });
  }
}

/** The watch button: open the `/watch` modal already pointed at this item. */
export async function handleWatchButton(interaction: ButtonInteraction): Promise<void> {
  const itemId = Number(interaction.customId.split(':')[2]);

  try {
    await rateLimiter.check(interaction.user.id, 'watch');
  } catch (err) {
    if (err instanceof DeeError) {
      await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw err;
  }

  const item = Number.isInteger(itemId) ? await ItemCatalogue.getById(itemId) : null;
  if (!item) {
    await interaction.reply({
      content: 'That item is gone from the catalogue.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // the modal has to open inside Discord's 3 s budget and cannot be deferred, so
  // this reads one item: `latestQuotes()` scans every item and measured 2.9 s on a
  // 2.8 M-row dev table, which is exactly the timeout this handler must avoid.
  const quote = await SnapshotStore.latestQuote(item.itemId);

  try {
    await interaction.showModal(buildModal(item.itemId, item.name, quote?.ask ?? null));
  } catch (err) {
    // A card outlives the 3 s interaction token: a click on an old card, or a
    // second one, fails here with 10062. discord.js raises that rejection as an
    // unhandled Client 'error', which killed the process on the dev stack, so
    // the miss is logged and dropped instead of propagating.
    logger.warn('watch modal could not open', {
      itemId: item.itemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The share button: post the same card to the channel, then say where it went. */
export async function handleShareButton(interaction: ButtonInteraction): Promise<void> {
  const itemId = Number(interaction.customId.split(':')[2]);

  await postToChannel(interaction, { command: '/price', bucket: 'price' }, `price:${itemId}`, async () => {
    const item = Number.isInteger(itemId) ? await ItemCatalogue.getById(itemId) : null;
    if (!item) throw userError('That item is gone from the catalogue.', ErrCodes.INVALID_INPUT);

    const { card, onMarket } = await renderPriceCard(item, selfAvatar(interaction));
    if (!onMarket) {
      throw userError('That item is not on the market right now.', ErrCodes.INVALID_INPUT);
    }

    return card;
  });
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  const rows = await ItemCatalogue.search(focused, { tradeableOnly: true, limit: 25 });

  await interaction.respond(rows.map((row) => ({ name: row.name, value: String(row.itemId) })));
}
