import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import { builder as watchBuilder } from './commands/watch.js';
import { builder as unwatchBuilder } from './commands/unwatch.js';
import { builder as watchlistBuilder } from './commands/watchlist.js';
import { builder as graphBuilder } from './commands/graph.js';
import { builder as priceBuilder } from './commands/price.js';
import { builder as digestBuilder } from './commands/digest.js';
import { builder as vaultBuilder } from './commands/vault.js';
import { builder as helpBuilder } from './commands/help.js';
import { createLogger } from './utils/logger.js';

dotenv.config();

const logger = createLogger('REGISTER');

const TOKEN = process.env.DISCORD_TOKEN!;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;

const commands = [
  watchBuilder,
  unwatchBuilder,
  watchlistBuilder,
  graphBuilder,
  priceBuilder,
  digestBuilder,
  vaultBuilder,
  helpBuilder,
].map((b) => b.toJSON());

/**
 * Publish the slash commands once, globally.
 *
 * Registering the same names both globally and on a guild makes Discord list
 * every command twice in the picker, so the global set is the only one written
 * and any guild-scoped copy is cleared. The trade-off is propagation: a change
 * may take up to an hour to reach every client.
 *
 * The clear runs for every guild the bot is in, not just the test guild: a bot
 * that was ever invited with a per-guild registration keeps that stale copy in
 * the servers it joined back then, and the duplicate can shadow the global one.
 */
export async function registerCommands(guildIds: string[] = []): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  logger.info('Registering slash commands globally...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  logger.info(`Registered ${commands.length} commands globally`);

  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [] });
  }
  if (guildIds.length > 0) {
    logger.info(`Cleared the guild-scoped commands of ${guildIds.length} guild${guildIds.length === 1 ? '' : 's'}`, {
      guildIds,
    });
  }
}
