import type { Attachment } from 'discord.js';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES } from './config.js';
import { describeError, UploadError } from './lib/errors.js';
import { formatBytes } from './lib/format.js';
import {
  contentTypeForFilename,
  ensureExtension,
  filenameFromUrl,
  hasExtension,
} from './lib/filename.js';
import { normalizeContentType } from './lib/mime.js';
import { removeTempDirectory } from './lib/tempFiles.js';
import { archiveLifecycle } from './lib/lifecycle.js';

const USER_AGENT = 'media-bot/1.0 (Discord archiver)';

export interface DownloadedFile {
  readonly filename: string;
  readonly contentType: string;
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

function parseHttpUrl(raw: string): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new UploadError('invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UploadError(`unsupported protocol: ${url.protocol}`);
  }

  if (!url.hostname) {
    throw new UploadError('URL has no hostname');
  }

  return url;
}

/** Host + path only, so signed query strings never reach chat or logs. */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'link';
  }
}

function resolveContentType(
  candidates: ReadonlyArray<string | null | undefined>,
  filename: string,
): string {
  const specific = candidates
    .map(normalizeContentType)
    .find(
      (value) =>
        value !== '' &&
        value !== 'application/octet-stream' &&
        value !== 'binary/octet-stream' &&
        value !== 'application/unknown',
    );

  return specific ?? contentTypeForFilename(filename);
}

async function saveBody(response: Response, path: string, label: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new UploadError(`${label}: empty response`);
  const file = await open(path, 'wx').catch(async (error: unknown) => {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw error;
  });
  let total = 0;
  let head: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) throw new UploadError(`${label}: response exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`);
      // Keep only a small header for MIME/extension sniffing; persist the rest to disk.
      if (head.byteLength < 512) head = Buffer.concat([head, value.subarray(0, 512 - head.byteLength)]);
      await file.writeFile(value);
    }
    if (!total) throw new UploadError(`${label}: empty response`);
    return head;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
}

interface FetchedFile {
  readonly head: Uint8Array;
  readonly path: string;
  readonly cleanup: () => Promise<void>;
  readonly contentType: string;
  readonly finalUrl: string;
}

async function fetchFile(target: string, label: string, signal?: AbortSignal): Promise<FetchedFile> {
  const combined = AbortSignal.any([
    archiveLifecycle.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : []),
  ]);
  combined.throwIfAborted();
  let response: Response;

  try {
    response = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
      },
      signal: combined,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new UploadError(`${label}: timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`);
    }

    throw new UploadError(`${label}: download failed (${describeError(error)})`);
  }

  if (!response.ok) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    const status = `${response.status} ${response.statusText}`.trim();
    throw new UploadError(`${label}: HTTP ${status}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new UploadError(
      `${label}: ${formatBytes(declaredLength)} exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`,
    );
  }

  const directory = await mkdtemp(join(tmpdir(), 'media-bot-download-')).catch(async (error: unknown) => {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  });
  const path = join(directory, 'download');
  const cleanup = () => removeTempDirectory(directory);
  let head: Uint8Array;
  try {
    head = await saveBody(response, path, label);
  } catch (error) {
    await cleanup();
    if (error instanceof UploadError) throw error;
    throw new UploadError(`${label}: download failed (${describeError(error)})`);
  }

  return {
    head, path, cleanup,
    contentType: normalizeContentType(response.headers.get('content-type')),
    finalUrl: response.url || target,
  };
}

/** Fetches a Discord attachment immediately: its CDN URL is signed and expires. */
export async function downloadAttachment(attachment: Attachment, signal?: AbortSignal): Promise<DownloadedFile> {
  const label = attachment.name || 'attachment';

  if (attachment.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `${label}: ${formatBytes(attachment.size)} exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`,
    );
  }

  const fetched = await fetchFile(attachment.url, label, signal);
  const filename = ensureExtension(
    attachment.name,
    attachment.contentType ?? fetched.contentType,
    fetched.head,
  );

  return {
    filename,
    contentType: resolveContentType([attachment.contentType, fetched.contentType], filename),
    path: fetched.path,
    cleanup: fetched.cleanup,
  };
}

/**
 * Fetches any http(s) link as raw bytes. HTML is archived as HTML instead of
 * being rendered, and the filename comes from the URL path, the post-redirect
 * URL, or the response content type.
 */
export async function downloadLink(rawUrl: string, signal?: AbortSignal): Promise<DownloadedFile> {
  const url = parseHttpUrl(rawUrl);
  const label = displayUrl(url.href);
  const fetched = await fetchFile(url.href, label, signal);

  const originalName = filenameFromUrl(url.href);
  const redirectedName = filenameFromUrl(fetched.finalUrl);
  const baseName = hasExtension(originalName)
    ? originalName
    : hasExtension(redirectedName)
      ? redirectedName
      : originalName || redirectedName || 'download';

  const filename = ensureExtension(baseName, fetched.contentType, fetched.head);

  return {
    filename,
    contentType: resolveContentType([fetched.contentType], filename),
    path: fetched.path,
    cleanup: fetched.cleanup,
  };
}
