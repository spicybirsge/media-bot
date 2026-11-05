export class UploadError extends Error {
  override readonly name = 'UploadError';
}

/**
 * Turns an unknown thrown value into a short, single-line message that is safe
 * to show in Discord and in logs. Never pass signed URLs into this.
 */
export function describeError(error: unknown, maxLength = 300): string {
  let message: string;

  if (error instanceof Error) {
    message = error instanceof UploadError ? error.message : `${error.name}: ${error.message}`;
  } else {
    message = String(error);
  }

  const singleLine = message.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'unknown error';

  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}
