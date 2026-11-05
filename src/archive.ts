import type { Attachment } from 'discord.js';

import { downloadAttachment, downloadLink } from './download.js';
import { uploadToR2 } from './r2.js';

export interface ArchiveSuccess {
  readonly name: string;
  readonly url: string;
}

export async function archiveAttachment(attachment: Attachment): Promise<ArchiveSuccess> {
  const file = await downloadAttachment(attachment);
  const stored = await uploadToR2(file);

  return { name: file.filename, url: stored.url };
}

export async function archiveLink(rawUrl: string): Promise<ArchiveSuccess> {
  const file = await downloadLink(rawUrl);
  const stored = await uploadToR2(file);

  return { name: file.filename, url: stored.url };
}

export interface Archiver {
  archiveAttachment(attachment: Attachment): Promise<ArchiveSuccess>;
  archiveLink(rawUrl: string): Promise<ArchiveSuccess>;
}

export const defaultArchiver: Archiver = { archiveAttachment, archiveLink };
