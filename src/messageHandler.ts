import { DiscordAPIError, type Attachment, type Message } from 'discord.js';

import { defaultArchiver, type ArchiveSuccess, type Archiver } from './archive.js';
import { config } from './config.js';
import { displayUrl } from './download.js';
import { describeError } from './lib/errors.js';
import { extractUrls } from './lib/links.js';
import { logger } from './logger.js';

/** Discord's hard message limit is 2000 characters; keep a margin. */
const CHUNK_LIMIT = 1900;
const UNKNOWN_MESSAGE = 10008;

interface UploadFailure {
  readonly label: string;
  readonly reason: string;
}

function chunkLines(lines: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (!line) continue;

    if (!current) {
      current = line;
      continue;
    }

    if (current.length + 1 + line.length > CHUNK_LIMIT) {
      chunks.push(current);
      current = line;
      continue;
    }

    current += `\n${line}`;
  }

  if (current) chunks.push(current);

  return chunks;
}

async function sendLines(message: Message, lines: readonly string[]): Promise<boolean> {
  if (!message.channel.isSendable()) {
    logger.warn(`Channel ${message.channelId} is not sendable; dropping ${lines.length} result line(s).`);
    return false;
  }

  let posted = true;

  for (const content of chunkLines(lines)) {
    try {
      await message.channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      posted = false;
      logger.error(`Failed to post results in channel ${message.channelId}.`, describeError(error));
    }
  }

  return posted;
}

async function deleteOriginal(message: Message): Promise<void> {
  if (!message.deletable) {
    logger.warn(`Message ${message.id} is not deletable; leaving it in place.`);
    await sendLines(message, ['uploaded, but the original message could not be deleted (missing Manage Messages?).']);
    return;
  }

  try {
    await message.delete();
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE) {
      // Already gone, which is the desired end state.
      return;
    }

    logger.error(`Failed to delete message ${message.id}.`, describeError(error));
    await sendLines(message, ['uploaded, but the original message could not be deleted (missing Manage Messages?).']);
  }
}

/**
 * Ack -> upload -> post links -> delete. The original is deleted only if every
 * item uploaded; a partial failure keeps it so nothing is lost.
 */
export async function archiveMessage(
  message: Message,
  attachments: readonly Attachment[],
  links: readonly string[],
  archiver: Archiver = defaultArchiver,
): Promise<void> {
  try {
    await message.reply({ content: 'upload...', allowedMentions: { repliedUser: false } });
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

  let resultsPosted = true;

  if (uploaded.length > 0) {
    resultsPosted = await sendLines(message, uploaded.map((entry) => entry.url));
  }

  if (failures.length > 0) {
    await sendLines(message, [
      '**upload failed**',
      ...failures.map((failure) => `- ${failure.label}: ${failure.reason}`),
    ]);
    return;
  }

  if (uploaded.length === 0) return;

  if (!resultsPosted) {
    logger.error('Public links could not be posted; leaving the original message in place.');
    return;
  }

  await deleteOriginal(message);
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (message.channelId !== config.channelId) return;

  const attachments = [...message.attachments.values()];
  const links = extractUrls(message.content);

  if (attachments.length === 0 && links.length === 0) return;

  await archiveMessage(message, attachments, links);
}
