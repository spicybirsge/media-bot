import type { Attachment, Message } from 'discord.js';

import { defaultArchiver, type ArchiveSuccess, type Archiver } from './archive.js';
import { config } from './config.js';
import { displayUrl } from './download.js';
import { describeError } from './lib/errors.js';
import { extractUrls } from './lib/links.js';
import { chunkLines } from './lib/messageChunks.js';
import { logger } from './logger.js';

interface UploadFailure {
  readonly label: string;
  readonly reason: string;
}

async function sendLines(message: Message, lines: readonly string[]): Promise<void> {
  if (!message.channel.isSendable()) {
    logger.warn(`Channel ${message.channelId} is not sendable; dropping ${lines.length} result line(s).`);
    return;
  }

  for (const content of chunkLines(lines)) {
    try {
      await message.channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error(`Failed to post results in channel ${message.channelId}.`, describeError(error));
    }
  }
}

/**
 * Ack -> upload -> post links. The original message is never deleted, so a
 * failed post can always be retried from the channel.
 */
export async function archiveMessage(
  message: Message,
  attachments: readonly Attachment[],
  links: readonly string[],
  archiver: Archiver = defaultArchiver,
): Promise<void> {
  try {
    await message.reply({ content: 'uploading...', allowedMentions: { repliedUser: false } });
  } catch (error) {
    logger.warn(`Could not acknowledge message ${message.id}.`, describeError(error));
  }

  const uploaded: ArchiveSuccess[] = [];
  const failures: UploadFailure[] = [];

  for (const attachment of attachments) {
    const label = attachment.name || 'attachment';

    try {
      uploaded.push(await archiver.archiveAttachment(attachment));
    } catch (error) {
      failures.push({ label, reason: describeError(error) });
      logger.error(`Failed to archive attachment "${label}".`, describeError(error));
    }
  }

  for (const link of links) {
    const label = displayUrl(link);

    try {
      uploaded.push(await archiver.archiveLink(link));
    } catch (error) {
      failures.push({ label, reason: describeError(error) });
      logger.error(`Failed to archive ${label}.`, describeError(error));
    }
  }

  if (uploaded.length > 0) {
    await sendLines(message, uploaded.map((entry) => entry.url));
  }

  if (failures.length > 0) {
    await sendLines(message, [
      '**upload failed**',
      ...failures.map((failure) => `- ${failure.label}: ${failure.reason}`),
    ]);
  }
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (message.channelId !== config.channelId) return;

  const attachments = [...message.attachments.values()];
  const links = extractUrls(message.content);

  if (attachments.length === 0 && links.length === 0) return;

  await archiveMessage(message, attachments, links);
}
