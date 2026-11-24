/**
 * `/digest` — configure the market digest of a server.
 *
 * The digest is a channel post, not a DM: the whole server sees the moves of
 * the market. The bot has no Manage Channels permission, so it cannot create
 * the channel — the owner creates it first and points the command at it.
 *
 * The command is a set of subcommands: `add`, `remove`, `list` and `interval`.
 * Configuring the bot of a whole server is a server decision, so the gate is
 * the Manage Server permission of the member who runs the command. The
 * permission of the bot is only ever asked about posting: a bot that may
 * manage channels does not grant that right to anybody else.
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
import { safeReply } from '../ui/reply.js';
import { canPost } from '../ui/channel.js';
import { COLORS, ICONS, brandAuthor, formatUtcClock } from '../ui/theme.js';
import { DigestSettings, MAX_CHANNELS_PER_GUILD } from '../services/DigestSettings.js';

const logger = createLogger('DIGEST');

/** The most channels one guild may subscribe to the digest. */
const MAX_CHANNELS = MAX_CHANNELS_PER_GUILD;

export const builder = new SlashCommandBuilder()
  .setName('digest')
  .setDescription('Configure the market digest of this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Subscribe a channel to the market digest')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel for the market digest').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Unsubscribe a channel from the market digest')
      .addStringOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to unsubscribe')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the digest channels of this server')
  )
  .addSubcommand((sub) =>
    sub
      .setName('interval')
      .setDescription('Set how often the digest posts')
      .addIntegerOption((opt) =>
        opt
          .setName('hours')
          .setDescription('Hours between posts')
          .setRequired(true)
          .addChoices(
            ...Array.from({ length: 25 }, (_, hours) => ({
              name: hours === 1 ? '1 hour' : `${hours} hours`,
              value: hours,
            }))
          )
      )
      .addIntegerOption((opt) =>
        opt
          .setName('minutes')
          .setDescription('Optional: add 15, 30 or 45 minutes')
          .addChoices(
            { name: '15 minutes', value: 15 },
            { name: '30 minutes', value: 30 },
            { name: '45 minutes', value: 45 }
          )
      )
  );

/** `30 minutes`, `1 hour`, `1 hour 30 minutes`: a reply must never say "90 minutes". */
function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourLabel = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return rest === 0 ? hourLabel : `${hourLabel} ${rest} minutes`;
}

/** `1 channel`, `2 channels`: a reply must never say "1 channels". */
function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'channel' : 'channels'}`;
}

/**
 * Subscribe a channel to the digest.
 */
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
    await interaction.editReply({ content: 'The digest needs a text channel.' });
    return;
  }

  if (!canPost(cached, me)) {
    await interaction.editReply({
      content: 'I cannot post in that channel — grant me View Channel and Send Messages there.',
    });
    return;
  }

  await DigestSettings.addChannel(guild.id, option.id, interaction.user.id);
  const interval = await DigestSettings.readIntervalMinutes(guild.id);

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`Digest on — #${cached.name}`)
    .setDescription(
      [
        `${ICONS.digest} Notable market moves post in #${cached.name}, every ${formatInterval(interval)}. It never pushes a notification.`,
        '',
        `A server can subscribe at most ${countLabel(MAX_CHANNELS)}.`,
        'The bot cannot create channels — create one first and run this command again.',
      ].join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Unsubscribe a channel from the digest.
 *
 * The option is a string, not a channel picker: Discord offers autocomplete on
 * string options only, and the choice carries the id of the channel.
 */
async function handleRemove(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const channelId = interaction.options.getString('channel', true);
  const removed = await DigestSettings.removeChannel(guild.id, channelId);

  if (removed === 0) {
    await interaction.editReply({ content: 'That channel does not receive the market digest.' });
    return;
  }

  const name = guild.channels.cache.get(channelId)?.name ?? channelId;
  await interaction.editReply({ content: `Digest off — #${name}.` });
}

/**
 * Show the digest channels of the guild and its cadence.
 */
async function handleList(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const channels = await DigestSettings.listChannels(guild.id);
  const interval = await DigestSettings.readIntervalMinutes(guild.id);

  const lines = channels.map((channel) => {
    const name = guild.channels.cache.get(channel.channelId)?.name ?? channel.channelId;
    const last =
      channel.lastSentAt === null
        ? 'no digest sent yet'
        : `last digest ${formatUtcClock(channel.lastSentAt)} UTC`;
    return `#${name} — ${last}`;
  });

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle('Digest channels')
    .setDescription(
      [
        `Every ${formatInterval(interval)} · ${countLabel(channels.length)} subscribed.`,
        '',
        ...(lines.length === 0 ? ['No channel receives the digest yet.'] : lines),
      ].join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Set the cadence of the guild.
 */
async function handleInterval(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const hours = interaction.options.getInteger('hours', true);
  const minutes = interaction.options.getInteger('minutes') ?? 0;
  const stored = await DigestSettings.setIntervalMinutes(guild.id, hours * 60 + minutes);

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle('Digest cadence')
    .setDescription(`The market digest posts every ${formatInterval(stored)} in this server.`);

  await interaction.editReply({ embeds: [embed] });
}

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  try {
    await rateLimiter.check(userId, 'digest');
  } catch (err) {
    if (err instanceof DeeError) {
      await safeReply(interaction, { content: err.message, flags: 64 });
      return;
    }
    throw err;
  }

  // Outside a cached server there is nothing to configure and no way to read
  // the permission of the member: the command answers nothing.
  if (!interaction.inCachedGuild()) return;

  const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!canManage) {
    await safeReply(interaction, {
      content: 'You need the Manage Server permission to configure the digest.',
      flags: 64,
    });
    return;
  }

  const guild = interaction.guild;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
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
      logger.warn('/digest refused', { userId, error: err.message });
      await interaction.editReply({ content: err.message });
      return;
    }

    logger.error('/digest failed', { userId, error: err });
    const msg = formatUnexpectedError('/digest', err);
    await interaction.editReply({ content: msg });
  }
}

/**
 * Offer the subscribed channels of the guild as choices.
 */
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(false).toLowerCase();
  const channels = await DigestSettings.listChannels(guild.id);
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
