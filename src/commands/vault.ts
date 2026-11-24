/**
 * `/vault` — follow the vault of a clan in a channel.
 *
 * The bot reads the public clan log of the game and posts the ins and outs of
 * the vault: what a member added, what a member withdrew and what moved
 * between the tiers. The bot has no Manage Channels permission, so it cannot
 * create the channel — the owner creates it first and points the command at
 * it.
 *
 * The command is a set of subcommands: `add`, `remove` and `list`.
 *
 * Who may point the bot at a clan is a server decision, and Discord owns that
 * decision: the command is registered with `ManageGuild` as its default, and a
 * server admin narrows or widens it in Server Settings > Integrations. The
 * handler does not re-check the permission -- that check cannot see the
 * Integrations overrides, so it would be a second and wrong source of truth.
 * The permission of the bot is only ever asked about posting.
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
import { COLORS, ICONS, brandAuthor } from '../ui/theme.js';
import { VaultLog, MAX_VAULT_CHANNELS_PER_GUILD } from '../services/VaultLog.js';

const logger = createLogger('VAULT');

/** The most channels one guild may follow with the clan vault. */
const MAX_CHANNELS = MAX_VAULT_CHANNELS_PER_GUILD;

/** What the bot reads and how late an entry can be. */
const SOURCE_NOTE =
  'The bot reads the public clan log of the game: a 14-day window, and an entry can arrive up to ~30 minutes late.';

export const builder = new SlashCommandBuilder()
  .setName('vault')
  .setDescription('Follow the clan vault of a clan in a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Subscribe a channel to the vault of a clan')
      .addStringOption((opt) =>
        opt
          .setName('clan')
          .setDescription('Name of the clan')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel for the clan vault').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Unsubscribe a channel from the vault of a clan')
      .addStringOption((opt) =>
        opt
          .setName('clan')
          .setDescription('Name of the clan')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to unsubscribe')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the clan vault channels of this server')
  );

/**
 * Subscribe a channel to the vault of a clan.
 */
async function handleAdd(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const clan = interaction.options.getString('clan', true).trim();
  const option = interaction.options.getChannel('channel', true);
  const cached = guild.channels.cache.get(option.id);
  const me = guild.members.me;

  if (clan.length === 0) {
    await interaction.editReply({ content: 'Name the clan the channel follows.' });
    return;
  }

  if (!cached || !me) {
    await interaction.editReply({
      content: 'I cannot see that channel. Pick another one and run the command again.',
    });
    return;
  }

  if (cached.type !== ChannelType.GuildText && cached.type !== ChannelType.GuildAnnouncement) {
    await interaction.editReply({ content: 'The clan vault needs a text channel.' });
    return;
  }

  if (!canPost(cached, me)) {
    await interaction.editReply({
      content: 'I cannot post in that channel — grant me View Channel and Send Messages there.',
    });
    return;
  }

  await VaultLog.subscribe(guild.id, option.id, clan, interaction.user.id);

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`Clan vault on — #${cached.name}`)
    .setDescription(
      [
        `${ICONS.digest} The vault of ${clan} posts in #${cached.name}. It never pushes a notification.`,
        '',
        `A server can subscribe at most ${MAX_CHANNELS} channels.`,
        SOURCE_NOTE,
      ].join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Unsubscribe a channel from the vault of a clan.
 *
 * The channel option is a string, not a channel picker: Discord offers
 * autocomplete on string options only, and the choice carries the id of the
 * channel.
 */
async function handleRemove(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const clan = interaction.options.getString('clan', true).trim();
  const channelId = interaction.options.getString('channel', true);
  const removed = await VaultLog.unsubscribe(guild.id, channelId, clan);

  if (removed === 0) {
    await interaction.editReply({
      content: `That channel does not follow the vault of ${clan}.`,
    });
    return;
  }

  const name = guild.channels.cache.get(channelId)?.name ?? channelId;
  await interaction.editReply({ content: `Clan vault off — #${name} no longer follows ${clan}.` });
}

/**
 * Show the channels of the guild that follow a clan vault.
 */
async function handleList(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
  const subscriptions = await VaultLog.listSubscriptions(guild.id);
  const clans = new Set(subscriptions.map((row) => row.clanName));

  const lines = subscriptions.map((row) => {
    const name = guild.channels.cache.get(row.channelId)?.name ?? row.channelId;
    return `#${name} · ${row.clanName}`;
  });

  const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle('Clan vault channels')
    .setDescription(
      [
        `${subscriptions.length} of ${MAX_CHANNELS} channels subscribed · ${clans.size} ${
          clans.size === 1 ? 'clan' : 'clans'
        }.`,
        '',
        ...(lines.length === 0 ? ['No channel follows a clan vault yet.'] : lines),
        '',
        SOURCE_NOTE,
      ].join('\n')
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;

  try {
    await rateLimiter.check(userId, 'vault');
  } catch (err) {
    if (err instanceof DeeError) {
      await safeReply(interaction, { content: err.message, flags: 64 });
      return;
    }
    throw err;
  }

  // Outside a cached server there is nothing to configure: the command
  // answers nothing.
  if (!interaction.inCachedGuild()) return;

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
    }
  } catch (err) {
    if (err instanceof DeeError) {
      logger.warn('/vault refused', { userId, error: err.message });
      await interaction.editReply({ content: err.message });
      return;
    }

    logger.error('/vault failed', { userId, error: err });
    const msg = formatUnexpectedError('/vault', err);
    await interaction.editReply({ content: msg });
  }
}

/**
 * Offer the clans and the channels of the guild as choices.
 */
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const term = focused.value.toLowerCase();
  const subscriptions = await VaultLog.listSubscriptions(guild.id);

  if (focused.name === 'clan') {
    const clans = [...new Set(subscriptions.map((row) => row.clanName))].filter((clan) =>
      clan.toLowerCase().includes(term)
    );
    await interaction.respond(
      clans.slice(0, 25).map((clan) => ({ name: clan.slice(0, 100), value: clan }))
    );
    return;
  }

  const clan = interaction.options.getString('clan', false);
  const rows = clan ? subscriptions.filter((row) => row.clanName === clan) : subscriptions;

  const choices: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.channelId)) continue;
    seen.add(row.channelId);

    const name = guild.channels.cache.get(row.channelId)?.name ?? row.channelId;
    if (term.length > 0 && !name.toLowerCase().includes(term)) continue;

    choices.push({ name: name.slice(0, 100), value: row.channelId });
    if (choices.length >= 25) break;
  }

  await interaction.respond(choices);
}
