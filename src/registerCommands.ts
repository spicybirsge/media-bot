import { REST } from 'discord.js';
import { pathToFileURL } from 'node:url';

import { commands } from './commands/index.js';
import { config } from './config.js';
import { describeError } from './lib/errors.js';
import { logger } from './logger.js';

const REST_VERSION = '10';

function guildCommandsRoute(applicationId: string, guildId: string): `/${string}` {
  return `/applications/${applicationId}/guilds/${guildId}/commands`;
}

/** Guild-scoped registration, so command updates appear immediately. */
export async function registerGuildCommands(applicationId: string): Promise<void> {
  const guildId = config.guildId;

  if (!guildId) {
    return;
  }

  const rest = new REST({ version: REST_VERSION }).setToken(config.discordToken);
  const body = commands.map((command) => command.data.toJSON());
  await rest.put(guildCommandsRoute(applicationId, guildId), { body });
  logger.info(
    `Registered ${commands.map((command) => `/${command.data.name}`).join(', ')} in guild ${guildId} (${body.length} command(s)).`,
  );
}

async function main(): Promise<void> {
  if (!config.guildId) {
    throw new Error('DISCORD_GUILD_ID is required to register guild commands.');
  }

  const rest = new REST({ version: REST_VERSION }).setToken(config.discordToken);
  const application = (await rest.get('/applications/@me')) as { id?: string };

  if (!application.id) {
    throw new Error('Could not resolve the application id for the bot token.');
  }

  await registerGuildCommands(application.id);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    logger.error('Command registration failed.', describeError(error));
    process.exitCode = 1;
  }
}
