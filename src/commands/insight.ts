/**
 * `/insight` — configure the market insights of a server.
 *
 * The insights are a channel post, like the digest, but they answer a different
 * question: the state of the book against its own history, not "what just
 * moved". The bot has no Manage Channels permission, so the owner creates the
 * channel first and points the command at it.
 *
 * Who may run it is a server decision, and Discord owns that decision: the
 * command is registered with `ManageGuild` as its default, and an admin narrows
 * or widens it in Server Settings > Integrations. The handler does not re-check
 * it -- that check cannot see the Integrations overrides.
 */
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  InteractionContextType,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { rateLimiter } from '../utils/RateLimiter.js';
import { DeeError, formatUnexpectedError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { canPost } from '../ui/channel.js';
import { COLORS, ICONS, brandAuthor, formatUtcClock } from '../ui/theme.js';
import { InsightSettings, MAX_CHANNELS_PER_GUILD } from '../services/InsightSettings.js';

const logger = createLogger('INSIGHT');

/** The most channels one guild may subscribe. */
const MAX_CHANNELS = MAX_CHANNELS_PER_GUILD;

/** The cadences the command offers, in hours: a rate cap, not a schedule. */
const HOUR_CHOICES = [1, 2, 4, 6, 12, 24];

/** Month names, because `toLocaleDateString` differs by runtime. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const builder = new SlashCommandBuilder()
  .setName('insight')
  .setDescription('Configure the market insights of this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Subscribe a channel to the market insights')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel for the market insights').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Unsubscribe a channel from the market insights')
      .addStringOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to unsubscribe')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the insight channel of this server')
  )
  .addSubcommand((sub) =>
    sub
      .setName('interval')
      .setDescription('Set how often insights may post')
      .addIntegerOption((opt) =>
        opt
          .setName('hours')
          .setDescription('Hours between posts')
          .setRequired(true)
          .addChoices(...HOUR_CHOICES.map((hours) => ({ name: `${hours} ${hours === 1 ? 'hour' : 'hours'}`, value: hours })))
      )
  );

/** `4 hours`, `1 hour`: a reply must not say `1 hours`. */
function formatInterval(minutes: number): string {
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** `26 Nov`: the date a post last happened. */
function dayMonth(value: Date): string {
  return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`;
}

/** `1 channel`, `2 channels`. */
function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'channel' : 'channels'}`;
}

/** Subscribe a channel to the insights. */
async function handleAdd(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const option = interaction.options.getChannel('channel', true);
  const cached = guild.channels.cache.get(option.id);
  const me = guild.members.me;

  if (!cached || !me) {
    await interaction.editReply({
      content: 'I cannot see that channel. Pick another one and run the command again.',
    });
    return;
  }

  if (cached.type !== ChannelType.GuildText && cached.type !== ChannelType.GuildAnnouncement) {
    await interaction.editReply({ content: 'The insights need a text channel.' });
    return;
  }

  if (!canPost(cached, me)) {
    await interaction.editReply({
      content: 'I cannot post in that channel — grant me View Channel and Send Messages there.',
    });
    return;
  }

  const channel = await InsightSettings.addChannel(guild.id, option.id, interaction.user.id);

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`Insights on — #${cached.name}`)
    .setDescription(
      [
        `${ICONS.digest} Book states post in #${cached.name}, at most every ${formatInterval(channel.intervalMin)}. It never pushes a notification.`,
        'No finding, no post: silence means nothing crossed its threshold.',
        '',
        `A server can subscribe at most ${countLabel(MAX_CHANNELS)}.`,
        'The bot cannot create channels — create one first and run this command again.',
      ].join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/** Unsubscribe a channel from the insights. */
async function handleRemove(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const channelId = interaction.options.getString('channel', true);
  const removed = await InsightSettings.removeChannel(guild.id, channelId);

  if (removed === 0) {
    await interaction.editReply({ content: 'That channel does not receive insights.' });
    return;
  }

  const name = guild.channels.cache.get(channelId)?.name ?? channelId;
  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`Insights off — #${name}`);

  await interaction.editReply({ embeds: [embed] });
}

/** Show the insight channel of the guild and its cadence. */
async function handleList(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const channels = await InsightSettings.listChannels(guild.id);
  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;

  const lines = channels.map((channel) => {
    const name = guild.channels.cache.get(channel.channelId)?.name ?? channel.channelId;
    const last =
      channel.lastSentAt === null
        ? 'no insight sent yet'
        : `last post ${dayMonth(channel.lastSentAt)}, ${formatUtcClock(channel.lastSentAt)} UTC`;
    return `#${name} — every ${formatInterval(channel.intervalMin)} · ${last}`;
  });

  const embed = new EmbedBuilder()
    .setColor(channels.length === 0 ? COLORS.muted : COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle('Insight channels')
    .setDescription(
      channels.length === 0
        ? 'No channel receives insights yet. Run `/insight add #channel` to pick one.'
        : [`${countLabel(channels.length)} subscribed.`, '', ...lines].join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/** Set the rate cap of the guild's insight channel. */
async function handleInterval(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const hours = interaction.options.getInteger('hours', true);
  const channels = await InsightSettings.listChannels(guild.id);
  const channel = channels[0];

  if (!channel) {
    await interaction.editReply({
      content: 'No channel receives insights yet. Run `/insight add #channel` first.',
    });
    return;
  }

  const stored = await InsightSettings.setIntervalMinutes(guild.id, channel.channelId, hours * 60);

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle('Insights cadence')
    .setDescription(`Insights post at most every ${formatInterval(stored)} in this server.`);

  await interaction.editReply({ embeds: [embed] });
}

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  if (!interaction.inCachedGuild()) return;

  // ACK before any I/O: Discord drops an unanswered interaction 3s after the click.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;

  try {
    await rateLimiter.check(userId, 'insight');
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      await handleAdd(interaction, guild);
    } else if (subcommand === 'remove') {
      await handleRemove(interaction, guild);
    } else if (subcommand === 'list') {
      await handleList(interaction, guild);
    } else if (subcommand === 'interval') {
      await handleInterval(interaction, guild);
    }
  } catch (err) {
    if (err instanceof DeeError) {
      logger.warn('/insight refused', { userId, error: err.message });
      await interaction.editReply({ content: err.message });
      return;
    }

    logger.error('/insight failed', { userId, error: err });
    const msg = formatUnexpectedError('/insight', err);
    await interaction.editReply({ content: msg });
  }
}

/** Offer the subscribed channels of the guild as choices. */
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(false).toLowerCase();
  const channels = await InsightSettings.listChannels(guild.id);
  const choices: Array<{ name: string; value: string }> = [];
  const used = new Set<string>();

  for (const channel of channels) {
    const name = guild.channels.cache.get(channel.channelId)?.name ?? channel.channelId;
    if (focused.length > 0 && !name.toLowerCase().includes(focused)) continue;

    let label = name;
    while (used.has(label)) label = `${name} (${channel.channelId})`;
    used.add(label);

    choices.push({ name: label.slice(0, 100), value: channel.channelId });
    if (choices.length >= 25) break;
  }

  await interaction.respond(choices);
}
