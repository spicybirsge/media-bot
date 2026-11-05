import { Client, Events, GatewayIntentBits } from 'discord.js';

import { uploadCommand } from './commands/upload.js';
import { config } from './config.js';
import { describeError } from './lib/errors.js';
import { logger } from './logger.js';
import { handleMessageCreate } from './messageHandler.js';
import { registerGuildCommands } from './registerCommands.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // Required for message.content; also enable it in the Discord developer portal.
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (ready) => {
  logger.info(`Logged in as ${ready.user.tag} (${ready.user.id}).`);
  logger.info(`Watching channel ${config.channelId}.`);

  if (!config.guildId) {
    logger.warn('DISCORD_GUILD_ID is not set; run `pnpm register` to publish /upload.');
    return;
  }

  registerGuildCommands(ready.user.id).catch((error: unknown) => {
    logger.error('Failed to register guild commands.', describeError(error));
  });
});

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((error: unknown) => {
    logger.error('Unhandled error in the channel watcher.', describeError(error));
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== uploadCommand.data.name) return;

  uploadCommand.execute(interaction).catch((error: unknown) => {
    logger.error('Unhandled error in /upload.', describeError(error));
  });
});

client.on(Events.Error, (error) => {
  logger.error('Discord client error.', describeError(error));
});

client.on(Events.Warn, (message) => {
  logger.warn(`Discord client warning: ${message}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection.', describeError(reason));
});

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}; shutting down.`);
    void client.destroy().finally(() => process.exit(0));
  });
}

try {
  await client.login(config.discordToken);
} catch (error) {
  logger.error('Discord login failed.', describeError(error));
  process.exit(1);
}
