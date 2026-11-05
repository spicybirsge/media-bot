import { statsCommand } from './stats.js';
import { uploadCommand } from './upload.js';

/** Every slash command, in registration order. */
export const commands = [uploadCommand, statsCommand] as const;

export type BotCommand = (typeof commands)[number];

export const commandMap = new Map<string, BotCommand>();

for (const command of commands) {
  commandMap.set(command.data.name, command);
}
