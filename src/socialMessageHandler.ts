import type { Message } from 'discord.js';

import { config } from './config.js';
import { extractUrls } from './lib/links.js';
import { chunkLines } from './lib/messageChunks.js';
import { validateSocialLink } from './lib/socialLinks.js';
import { logger } from './logger.js';
import { archiveSocialLink, type SocialArchiveResult } from './socialDownload.js';

type SocialArchiver = (url: string) => Promise<SocialArchiveResult>;

async function replyLines(message: Message, lines: readonly string[]): Promise<void> {
  for (const content of chunkLines(lines)) {
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {
      logger.warn(`Could not post social video results for message ${message.id}.`);
    });
  }
}

export async function handleSocialMessage(
  message: Message,
  archive: SocialArchiver = archiveSocialLink,
): Promise<void> {
  if (message.author.bot || !config.socialChannelId || message.channelId !== config.socialChannelId) return;
  const links = extractUrls(message.content);
  if (links.length === 0) return;

  const valid: { url: string; position: number }[] = [];
  const invalidReasons: string[] = [];
  const seen = new Set<string>();
  for (const [index, url] of links.entries()) {
    const link = validateSocialLink(url);
    if (!link.valid) invalidReasons.push(link.reason);
    else if (!seen.has(link.url)) {
      seen.add(link.url);
      valid.push({ url: link.url, position: index + 1 });
    }
  }

  if (valid.length > 0) await replyLines(message, ['uploading...']);
  const urls: string[] = [];
  const errors: string[] = [];
  let noVideos = 0;
  let failedLinks = 0;
  for (const { url, position } of valid) {
    try {
      const result = await archive(url);
      urls.push(...result.uploaded.map((entry) => entry.url));
      if (result.noVideos) noVideos += 1;
      if (result.errors.length > 0) {
        failedLinks += 1;
        errors.push(...result.errors.map((reason) => `Link ${position}: ${reason}`));
      }
    } catch (error) {
      failedLinks += 1;
      errors.push(`Link ${position}: could not process this post. Please try again.`);
      logger.warn(`Could not archive social link ${position} in message ${message.id}.`, error);
    }
  }

  await replyLines(message, [
    ...urls,
    ...(invalidReasons.length > 0 ? [
      `Skipped ${invalidReasons.length} link(s) because they were invalid.`,
      ...new Set(invalidReasons),
    ] : []),
    ...(noVideos > 0 ? [`No downloadable videos found in ${noVideos} post(s); photos and live/upcoming streams are skipped.`] : []),
    ...(failedLinks > 0 ? [`Download/upload errors in ${failedLinks} link(s):`, ...errors] : []),
  ]);
}
