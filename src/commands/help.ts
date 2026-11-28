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
import { COLORS, ICONS, brandAuthor, formatUtcClock } from '../ui/theme.js';
import { ItemCatalogue } from '../services/ItemCatalogue.js';

const logger = createLogger('HELP');

/**
 * The permissions the invite URL asks for: view channels, send messages, embed
 * links, attach files (the chart PNG) and use slash commands.
 */
const INVITE_PERMISSIONS = 2147535872;

/** The community server: the same URL the showcase button points at. */
const COMMUNITY_URL = 'https://discord.gg/fepAZKG2Ss';

/** The published policy pages, the URLs Discord asks for at verification. */
const POLICY_URL = 'https://letiendat1002.github.io/dee-idleclans-helper';

/**
 * The support page. Ko-fi takes a card or PayPal without an account, which is what
 * a player has; GitHub Sponsors needs a GitHub account and stays in the README.
 * A donation unlocks nothing: every feature is free.
 */
const SPONSOR_URL = 'https://ko-fi.com/letiendat1002';

/**
 * The catalogue freshness, when this process has checked it.
 *
 * A renamed item shows an old name until the next sync, so the one line that
 * costs nothing to say keeps a stale name from reading like a bot bug.
 */
function catalogueLine(): string {
  const at = ItemCatalogue.lastSyncedAt;
  return at === null ? '' : ` · catalogue ${formatUtcClock(at)} UTC`;
}

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
            '`/digest interval <hours> [minutes]` — how often the digest posts, 15 minutes to once a day',
            '`/insight add #channel` — subscribe a channel to the market insights',
            '`/insight remove` · `/insight list` — the insight channel of this server',
            '`/insight interval <hours>` — how often insights may post, 1 to 24 hours',
            'Access is set in Server Settings > Integrations · one channel per server for each',
          ].join('\n'),
        },
        {
          name: `${ICONS.vault} Clan vault`,
          value: [
            '`/vault add <clan> #channel` — follow the vault of a clan',
            '`/vault remove <clan> #channel` — stop following it',
            '`/vault list` — the clan vault channels of this server',
            '`/vault recent <clan>` — the newest entries the bot has recorded',
            'Access is set in Server Settings > Integrations · up to 5 channels per server',
            'The bot reads the public clan log of the game: a 14-day window, and an entry can arrive up to ~30 minutes late.',
          ].join('\n'),
        },
        {
          name: `${ICONS.wiki} Links`,
          value: [
            `[Add to your server](${inviteUrl()})`,
            `[Community server](${COMMUNITY_URL})`,
            `[Support on Ko-fi](${SPONSOR_URL})`,
            '',
            `[Privacy](${POLICY_URL}/privacy.html) · [Terms](${POLICY_URL}/terms.html)`,
          ].join('\n'),
        }
      )
      // Discord does not render markdown in a footer, so a policy link there
      // showed as literal brackets. The links live in the field; the footer is
      // one plain line.
      .setFooter({
        text:
          'Made by HRDDee · 5 uses per minute (except /help) · digest, insights and vault post publicly' +
          catalogueLine(),
      });

    await safeReply(interaction, { embeds: [embed], flags: 64 });
  } catch (err) {
    logger.error('/help failed', { userId: interaction.user.id, error: err });
    const msg = formatUnexpectedError('/help', err);
    await safeReply(interaction, { content: msg, flags: 64 });
  }
}
