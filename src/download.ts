import type { Attachment } from 'discord.js';

import { FETCH_TIMEOUT_MS, MAX_BUFFER_BYTES } from './config.js';
import { describeError, formatBytes, UploadError } from './lib/errors.js';
import {
  contentTypeForFilename,
  ensureExtension,
  filenameFromUrl,
  hasExtension,
} from './lib/filename.js';
import { normalizeContentType } from './lib/mime.js';

const USER_AGENT = 'media-bot/1.0 (Discord archiver)';

export interface DownloadedFile {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
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

async function readBody(response: Response, label: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    total += value.byteLength;
    if (total > MAX_BUFFER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UploadError(
        `${label}: response is larger than the ${formatBytes(MAX_BUFFER_BYTES)} in-memory limit`,
      );
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

interface FetchedBytes {
  readonly data: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
}

async function fetchBytes(target: string, label: string): Promise<FetchedBytes> {
  let response: Response;

  try {
    response = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BUFFER_BYTES) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new UploadError(
      `${label}: ${formatBytes(declaredLength)} exceeds the ${formatBytes(MAX_BUFFER_BYTES)} in-memory limit`,
    );
  }

  let data: Uint8Array;
  try {
    data = await readBody(response, label);
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(`${label}: download failed (${describeError(error)})`);
  }

  return {
    data,
    contentType: normalizeContentType(response.headers.get('content-type')),
    finalUrl: response.url || target,
  };
}

/** Fetches a Discord attachment immediately: its CDN URL is signed and expires. */
export async function downloadAttachment(attachment: Attachment): Promise<DownloadedFile> {
  const label = attachment.name || 'attachment';

  if (attachment.size > MAX_BUFFER_BYTES) {
    throw new UploadError(
      `${label}: ${formatBytes(attachment.size)} exceeds the ${formatBytes(MAX_BUFFER_BYTES)} in-memory limit`,
    );
  }

  const fetched = await fetchBytes(attachment.url, label);
  const filename = ensureExtension(
    attachment.name,
    attachment.contentType ?? fetched.contentType,
    fetched.data,
  );

  return {
    filename,
    contentType: resolveContentType([attachment.contentType, fetched.contentType], filename),
    data: fetched.data,
  };
}

/**
 * Fetches any http(s) link as raw bytes. HTML is archived as HTML instead of
 * being rendered, and the filename comes from the URL path, the post-redirect
 * URL, or the response content type.
 */
export async function downloadLink(rawUrl: string): Promise<DownloadedFile> {
  const url = parseHttpUrl(rawUrl);
  const label = displayUrl(url.href);
  const fetched = await fetchBytes(url.href, label);

  if (fetched.data.byteLength === 0) {
    throw new UploadError(`${label}: empty response`);
  }

  const originalName = filenameFromUrl(url.href);
  const redirectedName = filenameFromUrl(fetched.finalUrl);
  const baseName = hasExtension(originalName)
    ? originalName
    : hasExtension(redirectedName)
      ? redirectedName
      : originalName || redirectedName || 'download';

  const filename = ensureExtension(baseName, fetched.contentType, fetched.data);

  return {
    filename,
    contentType: resolveContentType([fetched.contentType], filename),
    data: fetched.data,
  };
}
