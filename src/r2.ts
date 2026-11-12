import { open, type FileHandle } from 'node:fs/promises';
import { AwsClient } from 'aws4fetch';
import { nanoid } from 'nanoid';

import { config, FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES, UPLOAD_PART_BYTES } from './config.js';
import { describeError, UploadError } from './lib/errors.js';
import { contentDisposition } from './lib/filename.js';
import { formatBytes } from './lib/format.js';
import { SerialQueue } from './lib/serialQueue.js';
import { logger } from './logger.js';
import { archiveLifecycle } from './lib/lifecycle.js';

const client = new AwsClient({
  accessKeyId: config.r2.accessKeyId,
  secretAccessKey: config.r2.secretAccessKey,
  service: 's3', region: 'auto', retries: 2,
});
// Bound part-buffer memory across social jobs, the archive watcher and /upload.
const uploads = new SerialQueue();

export interface StoredObject {
  readonly key: string;
  readonly url: string;
  readonly size: number;
}

interface UploadMetadata {
  readonly filename: string;
  readonly contentType: string;
  readonly signal?: AbortSignal;
}

export type UploadInput = UploadMetadata & (
  | { readonly path: string; readonly data?: never }
  | { readonly data: Uint8Array; readonly path?: never }
);

/** Public links never include the S3 endpoint, upload ID or a signed query. */
export function publicUrl(key: string): string {
  return `${config.r2.publicBaseUrl}/${encodeURIComponent(key)}`;
}

function checkSize(size: number): void {
  if (size > MAX_UPLOAD_BYTES) throw new UploadError(`File exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function request(url: URL, init: RequestInit): Promise<Response> {
  const response = await client.fetch(url.href, init);
  if (!response.ok) {
    logger.error('R2 request failed.', {
      status: response.status, details: await response.text().catch(() => ''),
    });
    throw new UploadError(`R2 upload failed (HTTP ${response.status})`);
  }
  return response;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlValue(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]
    ?.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function readPart(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(data, read, length - read, offset + read);
    if (!bytesRead) throw new UploadError('Upload source file is incomplete');
    read += bytesRead;
  }
  return data;
}

async function multipart(
  target: URL, file: FileHandle, size: number, headers: Record<string, string>, signal: AbortSignal,
): Promise<void> {
  const create = new URL(target);
  create.searchParams.set('uploads', '');
  const initiated = await request(create, { method: 'POST', headers, signal });
  const uploadId = xmlValue(await initiated.text(), 'UploadId');
  if (!uploadId) throw new UploadError('R2 did not return a multipart upload ID');
  const upload = new URL(target);
  upload.searchParams.set('uploadId', uploadId);

  try {
    const parts: string[] = [];
    for (let offset = 0, number = 1; offset < size; offset += UPLOAD_PART_BYTES, number += 1) {
      signal.throwIfAborted();
      const data = await readPart(file, offset, Math.min(UPLOAD_PART_BYTES, size - offset));
      const part = new URL(upload);
      part.searchParams.set('partNumber', String(number));
      // aws4fetch retries the same bounded part on 429/5xx responses.
      const response = await request(part, {
        method: 'PUT', body: data, headers: { 'content-length': String(data.byteLength) }, signal,
      });
      const etag = response.headers.get('etag');
      await discard(response);
      if (!etag) throw new UploadError('R2 did not return an ETag for an uploaded part');
      parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
    }
    const completed = await request(upload, {
      method: 'POST', headers: { 'content-type': 'application/xml' }, signal,
      body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`,
    });
    const body = await completed.text();
    // S3 can send HTTP 200 and then report an error inside the completion XML.
    if (!/<CompleteMultipartUploadResult(?:\s|>)/.test(body) || /<Error(?:\s|>)/.test(body)) {
      throw new UploadError('R2 could not complete the multipart upload');
    }
  } catch (error) {
    // Cleanup must still run if the caller's timeout/signal has already fired.
    try {
      const response = await request(upload, { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
      await discard(response);
    } catch (abortError) {
      logger.error('Could not abort an incomplete R2 multipart upload.', abortError);
    }
    throw error;
  }
}

async function upload(input: UploadInput): Promise<StoredObject> {
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  signal.throwIfAborted();
  const key = nanoid();
  const target = new URL(`${config.r2.endpoint}/${encodeURIComponent(config.r2.bucket)}/${key}`);
  const headers = { 'content-type': input.contentType, 'content-disposition': contentDisposition(input.filename) };
  let file: FileHandle | undefined;
  try {
    let size: number;
    if (input.path !== undefined) {
      file = await open(input.path, 'r');
      const stat = await file.stat();
      if (!stat.isFile()) throw new UploadError('Upload source must be a regular file');
      size = stat.size;
      checkSize(size);
      if (size > UPLOAD_PART_BYTES) {
        await multipart(target, file, size, headers, signal);
      } else {
        const data = await readPart(file, 0, size);
        const response = await request(target, { method: 'PUT', headers, body: data, signal });
        await discard(response);
      }
    } else {
      size = input.data.byteLength;
      checkSize(size);
      const response = await request(target, { method: 'PUT', headers, body: input.data, signal });
      await discard(response);
    }
    return { key, url: publicUrl(key), size };
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(`R2 upload failed (${describeError(error)})`, { cause: error });
  } finally {
    await file?.close();
  }
}

/** Disk sources larger than 16 MiB use multipart; no whole-file read is performed. */
export function uploadToR2(input: UploadInput): Promise<StoredObject> {
  const signal = AbortSignal.any([archiveLifecycle.signal, ...(input.signal ? [input.signal] : [])]);
  return uploads.run(() => upload({ ...input, signal }), signal);
}
