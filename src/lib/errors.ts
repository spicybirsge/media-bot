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
