/**
 * `/help` — the command reference of the bot.
 *
 * One ephemeral embed: every command with a one-line description and its
 * response mode, plus the invite URL so a user can share the bot.
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { formatUnexpectedError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { safeReply } from '../ui/reply.js';
import { COLORS, ICONS, brandAuthor } from '../ui/theme.js';

const logger = createLogger('HELP');

/**
 * The permissions the invite URL asks for: view channels, send messages, embed
 * links, attach files (the chart PNG) and use slash commands.
 */
const INVITE_PERMISSIONS = 2147535872;

/** The community server: the same URL the showcase button points at. */
const COMMUNITY_URL = 'https://discord.gg/fepAZKG2Ss';

/** The invite URL of the bot, built from the client id of the environment. */
function inviteUrl(): string {
  const clientId = process.env.DISCORD_CLIENT_ID ?? '';
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

export const builder = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show help for Dee IdleClans Helper');

export async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const avatarUrl = interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle('Commands')
      .setThumbnail(avatarUrl)
      .addFields(
        {
          name: `${ICONS.margin} Market`,
          value: [
            '`/price <item>` — sell price, buy order and trade averages',
            '`/graph item <item> [range]` — average traded price over 24h, 7d, 30d or 1y',
            '`/watch <item>` — arm a DM price alert',
            '`/unwatch <item>` — remove a price alert',
            '`/watchlist` — the items you watch, with their sell price',
          ].join('\n'),
        },
        {
          name: `${ICONS.digest} Server`,
          value: [
            '`/digest add #channel` — subscribe a channel to the market digest',
            '`/digest remove` — unsubscribe a channel',
            '`/digest list` — the digest channels of this server',
            '`/digest interval <minutes>` — how often the digest posts, 15 minutes to once a day',
            'Access is set in Server Settings > Integrations · one channel per server',
          ].join('\n'),
        },
        {
          name: `${ICONS.note} Clan vault`,
          value: [
            '`/vault add <clan> #channel` — follow the vault of a clan',
            '`/vault remove <clan> #channel` — stop following it',
            '`/vault list` — the clan vault channels of this server',
            'Access is set in Server Settings > Integrations · up to 5 channels per server',
            'The bot reads the public clan log of the game: a 14-day window, and an entry can arrive up to ~30 minutes late.',
          ].join('\n'),
        },
        {
          name: `${ICONS.wiki} Links`,
          value: [
            `[Add Dee IdleClans Helper to your server](${inviteUrl()})`,
            `[Horde server](${COMMUNITY_URL})`,
            '*Made by HRDDee*',
          ].join('\n'),
        }
      )
      .setFooter({ text: '5 uses per minute (except /help) · digest and vault post publicly' });

    await safeReply(interaction, { embeds: [embed], flags: 64 });
  } catch (err) {
    logger.error('/help failed', { userId: interaction.user.id, error: err });
    const msg = formatUnexpectedError('/help', err);
    await safeReply(interaction, { content: msg, flags: 64 });
  }
}
