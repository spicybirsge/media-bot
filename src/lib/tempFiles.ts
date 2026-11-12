import { rm } from 'node:fs/promises';
import { logger } from '../logger.js';

/** Only pass a directory created by this bot's mkdtemp call. */
export async function removeTempDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
    logger.warn('Could not remove a temporary archive directory.', error);
  });
}
