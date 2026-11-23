import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('REPLY');

/** What `safeReply` forwards; an edit takes the ephemeral flag from the original reply. */
export interface ReplyPayload {
  content?: string;
  embeds?: InteractionReplyOptions['embeds'];
  components?: InteractionReplyOptions['components'];
  flags?: InteractionReplyOptions['flags'];
}

/**
 * Safely reply to an interaction, swallowing errors if the interaction
 * has already expired (Discord code 10062: Unknown interaction).
 * Prevents a failed reply from crashing the bot process.
 *
 * Lives here rather than in `index.ts` so a command module does not import the
 * entry point: that import made every command depend on the module that
 * registers it.
 */
export async function safeReply(
  interaction:
    | ChatInputCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction
    | ButtonInteraction,
  options: ReplyPayload
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: options.content,
        embeds: options.embeds,
        components: options.components,
      });
    } else {
      await interaction.reply(options);
    }
  } catch (err) {
    logger.warn('Failed to reply to interaction (may have expired)', {
      error: (err as Error).message,
    });
  }
}
