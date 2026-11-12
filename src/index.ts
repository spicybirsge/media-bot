import { Client, Events, GatewayIntentBits } from 'discord.js';

import { commandMap } from './commands/index.js';
import { config } from './config.js';
import { describeError } from './lib/errors.js';
import { logger } from './logger.js';
import { handleMessageCreate } from './messageHandler.js';
import { registerGuildCommands } from './registerCommands.js';
import { checkSocialTools } from './socialDownload.js';
import { handleSocialMessage } from './socialMessageHandler.js';
import { stopSocialProcesses } from './socialProcess.js';
import { archiveLifecycle } from './lib/lifecycle.js';

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
  if (config.socialChannelId) {
    void checkSocialTools().catch(() => logger.warn('Could not check social video tools.'));
  }

  if (!config.guildId) {
    logger.warn('DISCORD_GUILD_ID is not set; skipping slash-command registration.');
    return;
  }

  registerGuildCommands(ready.user.id).catch((error: unknown) => {
    logger.error('Failed to register guild commands.', describeError(error));
  });
});

client.on(Events.MessageCreate, (message) => {
  if (archiveLifecycle.signal.aborted) return;
  const handler = message.channelId === config.socialChannelId ? handleSocialMessage : handleMessageCreate;
  handler(message).catch((error: unknown) => {
    logger.error('Unhandled error in the channel watcher.', describeError(error));
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (archiveLifecycle.signal.aborted) return;
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  command.execute(interaction).catch((error: unknown) => {
    logger.error(`Unhandled error in /${interaction.commandName}.`, describeError(error));
  });
});

client.on(Events.Error, (error) => {
  logger.error('Discord client error.', describeError(error));
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection.', describeError(reason));
});

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;

    void archiveLifecycle.shutdown(stopSocialProcesses)
      .catch((error: unknown) => logger.error('Archive shutdown failed.', error))
      .finally(() => client.destroy()).finally(() => process.exit(0));
  });
}

try {
  await client.login(config.discordToken);
} catch (error) {
  logger.error('Discord login failed.', describeError(error));
  process.exit(1);
}
