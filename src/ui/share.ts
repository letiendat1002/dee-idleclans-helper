/**
 * The `Post to channel` control, shared by the public market commands.
 *
 * Only the item (and the range, where the surface has one) travels in the custom
 * id, never the rendered card: the message outlives the process, so a restart
 * must not turn the button into a dead one. The click re-reads and re-renders,
 * which also keeps the post as fresh as the click rather than as old as the
 * message it sits under.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type AttachmentBuilder,
  type ButtonInteraction,
  type EmbedBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import { rateLimiter, type LimitName } from '../utils/RateLimiter.js';
import { ErrCodes, DeeError, formatUnexpectedError, userError } from '../utils/errors.js';
import { safeReply } from './reply.js';
import { canPost } from './channel.js';

/** One post per user, surface and card per minute: the click is cheap, the channel is not. */
const COOLDOWN_MS = 60_000;

/** The last time each user posted each card, in memory: a restart may re-post once. */
const lastPosted = new Map<string, number>();

export interface ChannelCard {
  embeds: EmbedBuilder[];
  files?: AttachmentBuilder[];
}

export function watchButton(itemId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`price:watch:${itemId}`)
      .setLabel('Watch price')
      .setStyle(ButtonStyle.Primary)
  );
}

export function shareButton(customId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('Post to channel')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Post the card the click belongs to, then say where it went.
 *
 * `render` runs after the cooldown check, so a suppressed click costs no query.
 */
export async function postToChannel(
  interaction: ButtonInteraction,
  surface: { command: string; bucket: LimitName },
  key: string,
  render: () => Promise<ChannelCard>
): Promise<void> {
  const { command, bucket } = surface;
  const userId = interaction.user.id;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await rateLimiter.check(userId, bucket);

    if (Date.now() - (lastPosted.get(`${userId}:${key}`) ?? 0) < COOLDOWN_MS) {
      await interaction.editReply({ content: 'Posted that one a moment ago.' });
      return;
    }

    const channel = interaction.channel;
    if (channel === null || !channel.isTextBased()) {
      throw userError('I can only post inside a server channel.', ErrCodes.INVALID_INPUT);
    }

    const self = interaction.client.user;
    if (!canPost(channel, self)) {
      throw userError('I need Send Messages in this channel to post there.', ErrCodes.PERMISSION_DENIED);
    }

    const send = (channel as { send?: (options: MessageCreateOptions) => Promise<unknown> }).send;
    if (typeof send !== 'function') {
      throw userError('I can only post inside a server channel.', ErrCodes.INVALID_INPUT);
    }

    const card = await render();
    await send.call(channel, { content: `-# requested by <@${userId}>`, ...card });
    lastPosted.set(`${userId}:${key}`, Date.now());
    await interaction.editReply({ content: `Posted in <#${channel.id}>.` });
  } catch (err) {
    if (err instanceof DeeError) {
      await safeReply(interaction, { content: err.message, flags: 64 });
      return;
    }
    await safeReply(interaction, { content: formatUnexpectedError(command, err), flags: 64 });
  }
}

/** The bot's own avatar, which every card's author line carries. */
export function selfAvatar(interaction: {
  client: { user: { displayAvatarURL(options?: { size?: number }): string } | null };
}): string | null {
  return interaction.client.user?.displayAvatarURL({ size: 128 }) ?? null;
}
