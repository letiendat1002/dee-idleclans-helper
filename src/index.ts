import {
  Client,
  Events,
  GatewayIntentBits,
  ActivityType,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

import { closePool } from './db/pool.js';
import { redis } from './cache/CacheService.js';
import { DeeError } from './utils/errors.js';
import { createLogger } from './utils/logger.js';
import { registerCommands } from './registerCommands.js';
import { safeReply } from './ui/reply.js';
import { ICONS } from './ui/theme.js';
import { builder as watchBuilder, handle as watchHandle, autocomplete as watchAutocomplete, handleWatchModal } from './commands/watch.js';
import { builder as unwatchBuilder, handle as unwatchHandle, autocomplete as unwatchAutocomplete } from './commands/unwatch.js';
import { builder as watchlistBuilder, handle as watchlistHandle, handleWatchlistMenu } from './commands/watchlist.js';
import {
  builder as graphBuilder,
  handle as graphHandle,
  autocomplete as graphAutocomplete,
  handleRangeMenu,
  handleShareButton,
} from './commands/graph.js';
import {
  builder as priceBuilder,
  handle as priceHandle,
  autocomplete as priceAutocomplete,
  handleShareButton as handlePriceShare,
} from './commands/price.js';
import { builder as digestBuilder, handle as digestHandle, autocomplete as digestAutocomplete } from './commands/digest.js';
import { builder as vaultBuilder, handle as vaultHandle, autocomplete as vaultAutocomplete } from './commands/vault.js';
import { builder as helpBuilder, handle as helpHandle } from './commands/help.js';
import { MessageHandler } from './events/MessageHandler.js';
import { AlertDispatcher } from './jobs/AlertDispatcher.js';
import { MarketDigest } from './jobs/MarketDigest.js';
import { VaultNotifier } from './jobs/VaultNotifier.js';
import { ItemCatalogue } from './services/ItemCatalogue.js';
import { DigestSettings } from './services/DigestSettings.js';
import { VaultLog } from './services/VaultLog.js';
import { beat } from './utils/heartbeat.js';

const logger = createLogger('BOT');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  logger.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment');
  process.exit(1);
}

// Command map — top-level command name → handler
interface CommandHandler {
  builder: SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  handle: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

const commandMap: Record<string, CommandHandler> = {
  'watch': { builder: watchBuilder, handle: watchHandle, autocomplete: watchAutocomplete },
  'unwatch': { builder: unwatchBuilder, handle: unwatchHandle, autocomplete: unwatchAutocomplete },
  'watchlist': { builder: watchlistBuilder, handle: watchlistHandle },
  'graph': { builder: graphBuilder, handle: graphHandle, autocomplete: graphAutocomplete },
  'price': { builder: priceBuilder, handle: priceHandle, autocomplete: priceAutocomplete },
  'digest': { builder: digestBuilder, handle: digestHandle, autocomplete: digestAutocomplete },
  'vault': { builder: vaultBuilder, handle: vaultHandle, autocomplete: vaultAutocomplete },
  'help': { builder: helpBuilder, handle: helpHandle },
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // GuildMessages is not privileged. MessageContent stays off: Discord still
    // delivers the content of a message that mentions the app, which is the
    // only message the mention handler reads.
    GatewayIntentBits.GuildMessages,
  ],
  // The library only reports an invalid-request storm when asked to: 401, 403
  // and 429 responses stay silent otherwise. A permission slip in a guild then
  // looks like "the bot ignores me".
  rest: { invalidRequestWarningInterval: 100 },
});

const messageHandler = new MessageHandler(client);
client.on('messageCreate', (message) => {
  void messageHandler.handleMessage(message);
});

/**
 * Drop the digest subscription of a deleted channel.
 *
 * A channel that is gone can never carry a digest again. The scheduler checks
 * the channels of the guild before every send and sweeps the table once an
 * hour, for the deletions this event missed.
 */
client.on(Events.ChannelDelete, (channel) => {
  void DigestSettings.removeChannelById(channel.id).catch((err: unknown) => {
    logger.error('Failed to drop the digest subscription of a deleted channel', {
      channelId: channel.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  void VaultLog.removeChannelById(channel.id).catch((err: unknown) => {
    logger.error('Failed to drop the clan vault subscription of a deleted channel', {
      channelId: channel.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

client.once('clientReady', async () => {
  logger.info(`Logged in as ${client.user?.tag}`);

  // Set bot presence
  client.user?.setPresence({
    activities: [
      {
        type: ActivityType.Listening,
        name: '/help',
      },
    ],
    status: 'online',
  });

  try {
    await import('./db/migrate.js').then(({ migrate }) => migrate());
    logger.info('Migrations complete');
  } catch (err) {
    logger.warn('Migration skipped — database unavailable', { error: (err as Error).message });
  }

  client.guilds.cache.forEach(async (guild) => {
    try {
      logger.info(`Synced guild: ${guild.name} (${guild.id})`);
    } catch (err) {
      logger.error(`Failed to sync guild ${guild.id}`, { error: err });
    }
  });

  client.on('guildCreate', async (guild) => {
    try {
      logger.info(`Joined new guild: ${guild.name} (${guild.id})`);
    } catch (err) {
      logger.error(`Failed to register guild ${guild.id}`, { error: err });
    }
  });

  try {
    await registerCommands(client.guilds.cache.map((guild) => guild.id));
  } catch (err) {
    logger.error('Command registration failed', { error: err });
  }

  // The collector owns market polling now. This heartbeat only proves the bot's
  // own event loop is turning, so its healthcheck keeps a signal to watch.
  beat();
  setInterval(() => beat(), 60_000);

  try {
    await ItemCatalogue.start(30 * 60_000);
    await AlertDispatcher.start(client, 120_000);
    await MarketDigest.start(client, 60_000);
    await VaultNotifier.start(client);
  } catch (err) {
    logger.error('Job startup failed', { error: err });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    const commandName = interaction.commandName;
    const handler = commandMap[commandName];
    if (handler?.autocomplete) {
      await handler.autocomplete(interaction);
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('watch:')) {
    await handleWatchModal(interaction);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('watchlist:')) {
    await handleWatchlistMenu(interaction);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('graph:range:')) {
    await handleRangeMenu(interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('graph:share:')) {
    await handleShareButton(interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('price:share:')) {
    await handlePriceShare(interaction);
    return;
  }

  if (interaction.isButton()) {
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;
  const handler = commandMap[commandName];
  if (!handler) return;

  try {
    await handler.handle(interaction);
  } catch (err) {
    if (err instanceof DeeError) {
      if (err.tier === 'E1') {
        await safeReply(interaction, { content: `${ICONS.warning} ${err.message}`, flags: 64 });
      } else if (err.tier === 'E2') {
        logger.error(`[E2] ${err.code}: ${err.message}`);
        await safeReply(interaction, {
          content: `${ICONS.warning} Something went wrong. Please try again.`,
          flags: 64,
        });
      } else {
        logger.error(`[E3] ${err.code}: ${err.message}`, err);
        await safeReply(interaction, {
          content: `${ICONS.warning} A critical error occurred.`,
          flags: 64,
        });
      }
    } else {
      logger.error(`[E3] Unhandled error in interaction:`, err);
      await safeReply(interaction, {
        content: `${ICONS.warning} An unexpected error occurred.`,
        flags: 64,
      });
    }
  }
});

/**
 * Stop the schedulers in the order that stops new writes, then release the
 * connections. One function serves both signals so the two paths cannot drift.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} — shutting down`);
  await ItemCatalogue.stop();
  await AlertDispatcher.stop();
  await MarketDigest.stop();
  await VaultNotifier.stop();
  await closePool();
  await redis.quit();
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', { error: reason });
});

client.login(TOKEN);
