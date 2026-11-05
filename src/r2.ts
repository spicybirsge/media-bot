import { AwsClient } from 'aws4fetch';
import { nanoid } from 'nanoid';

import { config, MAX_UPLOAD_BYTES } from './config.js';
import { describeError, formatBytes, UploadError } from './lib/errors.js';
import { contentDisposition } from './lib/filename.js';
import { logger } from './logger.js';

/**
 * aws4fetch signs a single S3 request with WebCrypto. R2 accepts the signed
 * `UNSIGNED-PAYLOAD`-free payload hash this produces, and the service/region
 * values are only placeholders.
 */
const client = new AwsClient({
  accessKeyId: config.r2.accessKeyId,
  secretAccessKey: config.r2.secretAccessKey,
  service: 's3',
  region: 'auto',
});

export interface StoredObject {
  readonly key: string;
  readonly url: string;
  readonly size: number;
}

export interface UploadInput {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** Builds the public link and guarantees it never points at the S3 endpoint. */
export function publicUrl(key: string): string {
  return `${config.r2.publicBaseUrl}/${encodeURIComponent(key)}`;
}

export async function uploadToR2(input: UploadInput): Promise<StoredObject> {
  const { filename, contentType, data } = input;

  if (data.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `${filename}: ${formatBytes(data.byteLength)} exceeds R2's ${formatBytes(MAX_UPLOAD_BYTES)} single-request limit`,
    );
  }

  const key = nanoid();
  const target = `${config.r2.endpoint}/${encodeURIComponent(config.r2.bucket)}/${encodeURIComponent(key)}`;

  let response: Response;
  try {
    response = await client.fetch(target, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'content-disposition': contentDisposition(filename),
      },
      body: data,
    });
  } catch (error) {
    throw new UploadError(`R2 upload failed (${describeError(error)})`);
  }

  if (!response.ok) {
    let detail = '';

    try {
      detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch {
      // The status alone is enough when the error body cannot be read.
    }

    const status = `${response.status} ${response.statusText}`.trim();
    throw new UploadError(`R2 upload failed (${status})${detail ? `: ${detail}` : ''}`);
  }

  if (response.body) void response.body.cancel().catch(() => undefined);

  const url = publicUrl(key);
  logger.info(`Uploaded ${filename} (${formatBytes(data.byteLength)}) -> ${url}`);

  return { key, url, size: data.byteLength };
}
