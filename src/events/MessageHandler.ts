/**
 * The public showcase reply to an @mention.
 *
 * A mention is the only message the bot can read without the MessageContent
 * intent: Discord's documented exception delivers the content of a message
 * that mentions the app. The reply is deliberately public — it is an advert
 * for the server — and rate-limited to one per user per minute so a mention
 * cannot be used to flood a channel.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { COLORS, ICONS, brandAuthor } from '../ui/theme.js';

const logger = createLogger('MENTION');

/** One showcase reply per user per minute. */
const COOLDOWN_MS = 60_000;

/** The number of remembered cooldowns before the expired ones are dropped. */
const COOLDOWN_SWEEP_AT = 1_000;

/** The community server. The showcase links to it, not to the game wiki. */
const COMMUNITY_URL = 'https://discord.gg/fepAZKG2Ss';

/** The source. A stranger can check the code and the licence before inviting the bot. */
const REPO_URL = 'https://github.com/letiendat1002/dee-idleclans-helper';

/**
 * ViewChannel | SendMessages | EmbedLinks | AttachFiles | UseApplicationCommands
 * = 1024 + 2048 + 16384 + 32768 + 2147483648.
 */
const INVITE_PERMISSIONS = 2_147_535_872;

/** The slice of the Discord client the handler needs: whose mention to match, and its avatar. */
export interface MentionClient {
  user: { id: string; displayAvatarURL?: (options?: { size?: number }) => string } | null;
}

/** The slice of a Discord message the handler needs. */
export interface MentionSource {
  author: { id: string; bot: boolean };
  guildId: string | null;
  mentions: { users: { has(id: string): boolean } };
  reply(payload: MessageCreateOptions): Promise<unknown>;
}

/** The OAuth invite: bot scope, application commands, and only the three permissions used. */
function inviteUrl(): string {
  const clientId = process.env.DISCORD_CLIENT_ID ?? '';

  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

/** The showcase embed of spec §5.6. */
export function buildShowcaseEmbed(avatarUrl: string | null = null): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle('Idle Clans market intel')
    .setThumbnail(avatarUrl)
    .setDescription(
      [
        '**What it answers**',
        `${ICONS.alert} \`/watch\` and \`/digest\` — a DM when a price crosses your threshold, and the notable moves in your channel`,
        '',
        'Every answer comes from the same 2-minute snapshot, so two players quoting a price in the same minute see the same number.',
      ].join('\n')
    );
}

/** The invite, community and source buttons of the showcase. */
export function buildShowcaseRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Add to server').setStyle(ButtonStyle.Link).setURL(inviteUrl()),
    new ButtonBuilder().setLabel('Community server').setStyle(ButtonStyle.Link).setURL(COMMUNITY_URL),
    new ButtonBuilder().setLabel('Source on GitHub').setStyle(ButtonStyle.Link).setURL(REPO_URL)
  );
}

export class MessageHandler {
  private readonly client: MentionClient;
  /** The time of the last showcase reply per user id. */
  private readonly lastReplyAt = new Map<string, number>();

  constructor(client: MentionClient) {
    this.client = client;
  }

  /**
   * Reply to a mention with the showcase, at most once per user per minute.
   *
   * Guild channels only: the showcase is an advert for a server, and a DM
   * has no audience for it.
   */
  async handleMessage(message: MentionSource): Promise<void> {
    if (message.guildId === null) return;
    if (message.author.bot) return;

    const me = this.client.user;
    if (!me || !message.mentions.users.has(me.id)) return;

    const now = Date.now();
    this.sweepCooldowns(now);

    const last = this.lastReplyAt.get(message.author.id);
    if (last !== undefined && now - last < COOLDOWN_MS) return;

    this.lastReplyAt.set(message.author.id, now);

    try {
      await message.reply({
        embeds: [buildShowcaseEmbed(me.displayAvatarURL?.({ size: 128 }) ?? null)],
        components: [buildShowcaseRow()],
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      // A reply that failed did not consume the user's cooldown.
      this.lastReplyAt.delete(message.author.id);
      logger.warn('showcase reply failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Drop the expired cooldowns once the map has grown, so it cannot grow forever. */
  private sweepCooldowns(now: number): void {
    if (this.lastReplyAt.size < COOLDOWN_SWEEP_AT) return;

    for (const [userId, at] of this.lastReplyAt) {
      if (now - at >= COOLDOWN_MS) this.lastReplyAt.delete(userId);
    }
  }
}
