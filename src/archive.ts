import type { Attachment } from 'discord.js';

import { downloadAttachment, downloadLink } from './download.js';
import { uploadToR2 } from './r2.js';
import { archiveLifecycle } from './lib/lifecycle.js';

export interface ArchiveSuccess {
  readonly name: string;
  readonly url: string;
}

export function archiveAttachment(attachment: Attachment, signal?: AbortSignal): Promise<ArchiveSuccess> {
  return archiveLifecycle.run(async () => {
    const file = await downloadAttachment(attachment, signal);
    try {
      const stored = await uploadToR2({ ...file, signal });
      return { name: file.filename, url: stored.url };
    } finally {
      await file.cleanup();
    }
  });
}

export function archiveLink(rawUrl: string, signal?: AbortSignal): Promise<ArchiveSuccess> {
  return archiveLifecycle.run(async () => {
    const file = await downloadLink(rawUrl, signal);
    try {
      const stored = await uploadToR2({ ...file, signal });
      return { name: file.filename, url: stored.url };
    } finally {
      await file.cleanup();
    }
  });
}

export interface Archiver {
  archiveAttachment(attachment: Attachment): Promise<ArchiveSuccess>;
  archiveLink(rawUrl: string): Promise<ArchiveSuccess>;
}

export const defaultArchiver: Archiver = { archiveAttachment, archiveLink };
