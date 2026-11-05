import { config as loadEnv } from 'dotenv';

loadEnv({ quiet: true });

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Discord snowflakes are 17-20 digit decimal strings. */
const SNOWFLAKE = /^\d{17,20}$/;
/** R2 bucket names: 3-63 chars, lowercase letters/numbers/hyphens, alphanumeric ends. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * R2's single-request PutObject ceiling (5 GiB). This is a protocol limit,
 * not a product decision.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

/**
 * Process-memory guard for buffered downloads, not a product limit. Bodies are
 * buffered before they are signed and uploaded, so an unbounded response could
 * exhaust the heap; 256 MiB is well above Discord's largest attachment cap and
 * can be raised if a bigger link needs archiving.
 */
export const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/** Give slow hosts (and large files) room to finish. */
export const FETCH_TIMEOUT_MS = 5 * 60_000;

export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** Public custom-domain base, never the S3 endpoint. No trailing slash. */
  readonly publicBaseUrl: string;
  readonly endpoint: string;
}

export interface AppConfig {
  readonly discordToken: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly guildId: string | null;
  readonly r2: R2Config;
}

function read(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function loadConfig(): AppConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = read(name);
    if (!value) problems.push(`${name} is missing`);
    return value;
  };

  const discordToken = required('DISCORD_TOKEN');
  const channelId = required('DISCORD_CHANNEL_ID');
  const ownerId = required('OWNER_ID');
  const guildId = read('DISCORD_GUILD_ID') || null;

  const accountId = required('R2_ACCOUNT_ID');
  const accessKeyId = required('R2_ACCESS_KEY_ID');
  const secretAccessKey = required('R2_SECRET_ACCESS_KEY');
  const bucket = required('R2_BUCKET');
  const publicBaseUrlRaw = required('R2_PUBLIC_BASE_URL');

  for (const [name, value] of [
    ['DISCORD_CHANNEL_ID', channelId],
    ['OWNER_ID', ownerId],
    ['DISCORD_GUILD_ID', guildId ?? ''],
  ] as const) {
    if (value && !SNOWFLAKE.test(value)) {
      problems.push(`${name} must be a Discord snowflake (17-20 digits)`);
    }
  }

  if (bucket && !BUCKET_NAME.test(bucket)) {
    problems.push('R2_BUCKET must be 3-63 lowercase letters, numbers, or hyphens');
  }

  let publicBaseUrl = '';
  if (publicBaseUrlRaw) {
    try {
      const parsed = new URL(publicBaseUrlRaw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        problems.push('R2_PUBLIC_BASE_URL must use http or https');
      } else if (parsed.hostname.endsWith('.r2.cloudflarestorage.com')) {
        problems.push('R2_PUBLIC_BASE_URL must be the public bucket base URL, not the R2 S3 endpoint');
      } else if (parsed.search || parsed.hash) {
        problems.push('R2_PUBLIC_BASE_URL must not contain a query string or fragment');
      } else {
        publicBaseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
      }
    } catch {
      problems.push('R2_PUBLIC_BASE_URL is not a valid URL');
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid environment configuration:\n- ${problems.join('\n- ')}`);
  }

  return {
    discordToken,
    channelId,
    ownerId,
    guildId,
    r2: {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
      publicBaseUrl,
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    },
  };
}

export const config = loadConfig();
