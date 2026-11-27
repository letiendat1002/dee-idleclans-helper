/**
 * `/graph` — how an item's traded price has moved, drawn the way the game's own
 * market page draws it.
 *
 * The series is the game's published trade history, not our own snapshots: the
 * vendor buckets it for us (30 minutes over a day, 6 hours over a week, a day
 * over a month, a week over a year) and the year window is the only way back
 * past a month. That is also why the picture has no y axis: the card states the
 * numbers around it, exactly as the vendor page does.
 *
 * The `range` option picks the window, and the card carries two controls: a
 * range menu that re-renders in place and a share button that posts the same
 * card to the channel. Both carry the item id and the range in the custom id --
 * the message outlives the process, so there is no in-memory state to lose.
 *
 * Every figure is a trade price or a count of units. The card never says what
 * the numbers mean for a player.
 */
import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { ItemCatalogue, type ItemRow } from '../services/ItemCatalogue.js';
import { getTradeHistoryCached, type HistoryPeriod } from '../services/IdleClansApi.js';
import { rateLimiter } from '../utils/RateLimiter.js';
import { ErrCodes, DeeError, formatUnexpectedError, userError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { safeReply } from '../ui/reply.js';
import { COLORS, brandAuthor, formatMoney } from '../ui/theme.js';
import { renderHistoryPng, tradedRange, type HistoryPoint } from '../ui/chartHistory.js';
import { postToChannel, selfAvatar, shareButton, type ChannelCard } from '../ui/share.js';

const logger = createLogger('GRAPH');

const RANGES = ['24h', '7d', '30d', '1y'] as const;
export type GraphRange = (typeof RANGES)[number];

/** The window each range asks the game for. */
const PERIOD: Record<GraphRange, HistoryPeriod> = {
  '24h': '1d',
  '7d': '7d',
  '30d': '30d',
  '1y': '1y',
};

const RANGE_LABEL: Record<GraphRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '1y': '1 year',
};

/** The bucket the game answers in, which is the x axis a reader is looking at. */
const RANGE_BUCKET: Record<GraphRange, string> = {
  '24h': '30 minutes',
  '7d': '6 hours',
  '30d': '1 day',
  '1y': '1 week',
};

function parseRange(value: string | null | undefined): GraphRange {
  return value === '7d' || value === '30d' || value === '1y' ? value : '24h';
}

/** A bucket start: a wall clock inside a day, a date once the window is longer. */
function stamp(at: number, range: GraphRange): string {
  const iso = new Date(at).toISOString();
  return range === '24h' ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/**
 * A unit count in the shortest form that keeps three significant figures.
 *
 * The vendor page writes 4.78b for 4,776,123,456; a plain comma group would
 * push the line past the fence and lose the reading.
 */
function formatUnits(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
}

/** The signed change from the first bucket to the last, or null for one bucket. */
function changeText(points: HistoryPoint[]): string | null {
  if (points.length < 2) return null;
  const first = points[0].avg;
  const last = points[points.length - 1].avg;
  const change = ((last - first) / first) * 100;
  return `${change >= 0 ? '+' : '-'}${Math.abs(change).toFixed(1)}%`;
}

export const builder = new SlashCommandBuilder()
  .setName('graph')
  .setDescription('Price trends')
  .addSubcommand((sub) =>
    sub
      .setName('item')
      .setDescription('An item’s average traded price over the last day, week, month or year')
      .addStringOption((opt) =>
        opt.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('range')
          .setDescription('How much history to show')
          .addChoices(
            { name: '24h', value: '24h' },
            { name: '7d', value: '7d' },
            { name: '30d', value: '30d' },
            { name: '1y', value: '1y' }
          )
      )
  );

/**
 * Answer with the game's trade history of one item.
 *
 * The game answers in its own buckets and omits a bucket in which nothing
 * traded, so the card always states how many buckets it drew and which span
 * they cover: a year view with 41 points is a year with 41 traded weeks, not a
 * year of silence.
 */
async function renderCard(
  item: ItemRow,
  range: GraphRange,
  avatarUrl: string | null
): Promise<ChannelCard> {
  const bucket = RANGE_BUCKET[range];
  const base = new EmbedBuilder()
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`${item.name} — average traded price, last ${RANGE_LABEL[range]}`);

  const rows = await getTradeHistoryCached(item.itemId, PERIOD[range]);

  if (rows === null) {
    return {
      embeds: [
        base
          .setColor(COLORS.muted)
          .setDescription('The game did not answer the history request. Try again in a minute.')
          .setFooter({ text: 'Traded prices · no history' }),
      ],
    };
  }

  // A bucket with no average is not a price: the game leaves the bucket out
  // rather than publishing a zero, and a zero would draw a cliff to the floor.
  const points: HistoryPoint[] = rows
    .filter((row) => row.avg !== null && row.avg > 0)
    .map((row) => ({
      at: row.at,
      avg: row.avg as number,
      low: row.low,
      high: row.high,
      volume: row.volume !== null && row.volume > 0 ? row.volume : 0,
    }))
    .sort((a, b) => a.at - b.at);

  if (points.length === 0) {
    return {
      embeds: [
        base
          .setColor(COLORS.muted)
          .setDescription(`No trades recorded in the last ${RANGE_LABEL[range]}.`)
          .setFooter({ text: 'Traded prices · no trades' }),
      ],
    };
  }

  const last = points[points.length - 1];
  const traded = tradedRange(points);
  const change = changeText(points);
  const totalVolume = points.reduce((sum, point) => sum + point.volume, 0);
  const span = `${stamp(points[0].at, range)} → ${stamp(last.at, range)}`;

  const lines: string[] = [
    `-# Average traded price per ${bucket}; the bars are units traded.`,
  ];

  if (change !== null && traded !== null) {
    lines.push(`**${change}** over ${RANGE_LABEL[range]} · traded ${formatMoney(traded.low)} to ${formatMoney(traded.high)}`);
  }

  const summary: Array<[string, string]> = [['last', formatMoney(last.avg)]];
  if (traded !== null) summary.push(['low', formatMoney(traded.low)], ['high', formatMoney(traded.high)]);
  summary.push(['volume', `${formatUnits(totalVolume)} units`]);
  lines.push('```', ...summary.map(([label, value]) => `${label.padEnd(6)} ${value}`), '```');
  lines.push(`-# ${points.length} buckets of ${bucket} · ${span} UTC`);

  const embed = base
    .setColor(COLORS.brand)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Traded prices · ${bucket} buckets · last ${stamp(last.at, range)} UTC` });

  const png = renderHistoryPng(points);
  if (png === null) {
    lines.push('-# Only one bucket has a traded price, so there is nothing to draw yet.');
    embed.setDescription(lines.join('\n'));
    return { embeds: [embed] };
  }

  embed.setImage('attachment://chart.png');
  return {
    embeds: [embed],
    files: [new AttachmentBuilder(png, { name: 'chart.png' })],
  };
}

/**
 * The two controls under the card: a range menu that re-renders in place, and a
 * share button that posts the same card to the channel.
 */
export function rangeControls(
  itemId: number,
  range: GraphRange
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`graph:range:${itemId}`)
    .setPlaceholder(`Range: ${range}`)
    .addOptions(
      RANGES.map((value) => ({
        label: RANGE_LABEL[value],
        description: `one point per ${RANGE_BUCKET[value]}`,
        value,
        default: value === range,
      }))
    );

  return [
    new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(menu),
    shareButton(`graph:share:${itemId}:${range}`),
  ];
}

/** The range menu: re-render the same item at the chosen range, in place. */
export async function handleRangeMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const userId = interaction.user.id;
  const itemId = Number(interaction.customId.slice('graph:range:'.length));
  const range = parseRange(interaction.values[0]);

  try {
    await interaction.deferUpdate();
    await rateLimiter.check(userId, 'graph');

    const item = Number.isInteger(itemId) ? await ItemCatalogue.getById(itemId) : null;
    if (!item) {
      await interaction.editReply({ content: 'Pick an item from the list.', embeds: [], components: [] });
      return;
    }

    const card = await renderCard(item, range, selfAvatar(interaction));
    // `attachments: []` drops the previous chart; without it the edit appends a
    // second image under the first.
    await interaction.editReply({
      ...card,
      components: rangeControls(item.itemId, range),
      attachments: [],
    });
  } catch (err) {
    if (err instanceof DeeError) {
      await interaction.followUp({ content: err.message, flags: 64 });
      return;
    }
    logger.error('/graph range failed', { userId, error: err });
    await interaction.followUp({ content: formatUnexpectedError('/graph', err), flags: 64 });
  }
}

/** The share button: post the same card to the channel, then say where it went. */
export async function handleShareButton(interaction: ButtonInteraction): Promise<void> {
  const [, , itemIdRaw, rangeRaw] = interaction.customId.split(':');
  const itemId = Number(itemIdRaw);
  const range = parseRange(rangeRaw);

  await postToChannel(interaction, { command: '/graph', bucket: 'graph' }, `graph:${itemId}:${range}`, async () => {
    const item = Number.isInteger(itemId) ? await ItemCatalogue.getById(itemId) : null;
    if (!item) throw userError('That item is gone from the catalogue.', ErrCodes.INVALID_INPUT);

    return renderCard(item, range, selfAvatar(interaction));
  });
}

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await rateLimiter.check(userId, 'graph');
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

    const range = parseRange(interaction.options.getString('range'));
    const card = await renderCard(item, range, selfAvatar(interaction));
    await interaction.editReply({ ...card, components: rangeControls(item.itemId, range) });
  } catch (err) {
    logger.error('/graph failed', { userId, error: err });
    await interaction.editReply({ content: formatUnexpectedError('/graph', err) });
  }
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  const rows = await ItemCatalogue.search(focused, { tradeableOnly: true, limit: 25 });

  await interaction.respond(rows.map((row) => ({ name: row.name, value: String(row.itemId) })));
}
