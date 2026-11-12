import { mkdtemp, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ArchiveSuccess } from './archive.js';
import { MAX_UPLOAD_BYTES, MAX_SOCIAL_TEMP_BYTES, MEDIA_PROCESS_TIMEOUT_MS } from './config.js';
import { sanitizeFilename, contentTypeForFilename } from './lib/filename.js';
import { SerialQueue } from './lib/serialQueue.js';
import { validateSocialLink, type SocialLink } from './lib/socialLinks.js';
import { removeTempDirectory } from './lib/tempFiles.js';
import { archiveLifecycle } from './lib/lifecycle.js';
import { logger } from './logger.js';
import { uploadToR2 } from './r2.js';
import { prepareMp4 } from './socialMedia.js';
import { runProcess, type ProcessResult } from './socialProcess.js';

const queue = new SerialQueue();

export interface SocialArchiveResult {
  readonly uploaded: readonly ArchiveSuccess[];
  readonly errors: readonly string[];
  readonly noVideos: boolean;
}

export interface SocialTools {
  readonly ytDlp: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly cookiesFile?: string;
}

export function socialTools(): SocialTools {
  return {
    ytDlp: process.env.YT_DLP_PATH?.trim() || 'yt-dlp',
    ffmpeg: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH?.trim() || 'ffprobe',
    cookiesFile: process.env.SOCIAL_COOKIES_FILE?.trim() || undefined,
  };
}

export interface SocialDependencies {
  readonly run: typeof runProcess;
  readonly upload: typeof uploadToR2;
  readonly tools: SocialTools;
}

interface FinishedVideo {
  filepath: string;
  title: string;
  expectsAudio: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function hasAudio(codec: unknown): boolean {
  return typeof codec === 'string' && !['none', 'unknown', 'NA', ''].includes(codec);
}

function onlyNoVideoErrors(stderr: string): boolean {
  const noVideo = /no video (?:formats|could be found)|no videos? found|there is no video|does not contain (?:a |any )?video|media .+ is not a video/i;
  const errors = stderr.split(/\r?\n/).filter((line) => /\bERROR:/i.test(line));
  // A carousel can mix photos (no formats) with videos or with other failures.
  return errors.length > 0 ? errors.every((line) => noVideo.test(line)) : noVideo.test(stderr);
}

/** The print template deliberately excludes CDN URLs, cookies, and other diagnostics. */
function finishedVideos(stdout: string): { videos: FinishedVideo[]; started: number; invalid: number } {
  const videos: FinishedVideo[] = [];
  let started = 0;
  let invalid = 0;
  for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
    if (line.startsWith('MEDIA_BOT_VIDEO_START:')) { started += 1; continue; }
    try {
      const item = record(JSON.parse(line));
      if (!item || typeof item.filepath !== 'string' || !item.filepath) throw new Error('Invalid downloader output');
      videos.push({
        filepath: item.filepath,
        title: typeof item.title === 'string' ? item.title : 'video',
        expectsAudio: hasAudio(item.acodec) || (Array.isArray(item.audio_codecs) && item.audio_codecs.some(hasAudio)),
      });
    } catch { invalid += 1; }
  }
  return { videos, started, invalid };
}

/** Discord gets fixed messages; the console gets the full diagnostic output. */
function downloadFailure(result: ProcessResult): string {
  switch (result.failure) {
    case 'unavailable': return 'yt-dlp is unavailable. Install it or configure YT_DLP_PATH.';
    case 'timeout': return 'Download timed out after 30 minutes.';
    case 'disk-limit': return 'Download exceeded the size limit (1 GiB per file or 4 GiB temporary storage per post).';
    case 'output-limit': return 'Downloader produced too much output.';
    case 'process': return 'Could not run the downloader.';
  }
  const diagnostic = result.stderr.toLowerCase();
  if (/sign in|log.?in|cookies|authentication|private|age.restrict|confirm your age/.test(diagnostic)) {
    return 'Post is private, restricted, or requires login cookies.';
  }
  if (/429|rate.?limit|too many requests/.test(diagnostic)) return 'Platform rate limit reached. Try again later.';
  if (/ffmpeg|ffprobe/.test(diagnostic)) return 'FFmpeg failed or is unavailable; check the host installation.';
  if (/javascript runtime|challenge solv|ejs/.test(diagnostic)) return 'YouTube challenge setup failed; check yt-dlp, EJS and the Node runtime.';
  if (/not available|unavailable|not found|does not exist|404|removed|deleted/.test(diagnostic)) return 'Post is unavailable or has been deleted.';
  if (/larger than max|maximum.*size|filesize|file is larger/.test(diagnostic)) return 'Video exceeds the 1 GiB file limit.';
  return 'Video download failed. The platform may have blocked access or changed its format.';
}

export function downloadArguments(link: SocialLink, tools: SocialTools): string[] {
  return [
    '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-progress', '--no-colors',
    '--use-extractors', 'youtube,instagram,twitter',
    '--no-simulate', '--no-playlist', '--no-abort-on-error', '--abort-on-unavailable-fragments',
    '--socket-timeout', '30', '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '2',
    '--max-filesize', String(MAX_UPLOAD_BYTES),
    '--match-filters', '!is_live & !is_upcoming',
    // Prefer combined or separate video+audio; the final fallback allows genuinely silent clips.
    '--format', 'bv*+ba/b/bv', '--format-sort', 'vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4/mkv',
    ...(tools.ffmpeg !== 'ffmpeg' ? ['--ffmpeg-location', resolve(tools.ffmpeg)] : []),
    '--js-runtimes', `node:${process.execPath}`,
    '--output', '%(autonumber)05d.%(ext)s',
    // Missing fields bypass the JSON formatter and would otherwise be emitted as bare NA.
    '--output-na-placeholder', 'null',
    // A literal-only --print template is treated as a metadata field by yt-dlp.
    '--print', 'before_dl:MEDIA_BOT_VIDEO_START:%(id)j',
    '--print', 'after_move:{"filepath":%(filepath)j,"title":%(title)j,"acodec":%(acodec)j,"audio_codecs":%(formats.:.acodec)j}',
    ...(tools.cookiesFile ? ['--cookies', resolve(tools.cookiesFile)] : []),
    '--', link.url,
  ];
}

async function videoPath(directory: string, reportedPath: string): Promise<string> {
  const path = resolve(directory, reportedPath);
  const actual = await realpath(path);
  const inside = relative(await realpath(directory), actual);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !(await lstat(path)).isFile()) {
    throw new Error('Invalid output path');
  }
  return actual;
}

async function archivePost(link: SocialLink, deps: SocialDependencies): Promise<SocialArchiveResult> {
  const directory = await mkdtemp(join(tmpdir(), 'media-bot-social-'));
  const uploaded: ArchiveSuccess[] = [];
  const errors: string[] = [];
  try {
    const result = await deps.run(deps.tools.ytDlp, downloadArguments(link, deps.tools), {
      cwd: directory, timeoutMs: MEDIA_PROCESS_TIMEOUT_MS, maxDiskBytes: MAX_SOCIAL_TEMP_BYTES, maxFileBytes: MAX_UPLOAD_BYTES,
    });
    const { videos, started, invalid } = finishedVideos(result.stdout);
    if (invalid > 0) errors.push('yt-dlp returned invalid metadata for one or more videos.');
    // Known photo-only errors are an empty result, not an invalid-link or login failure.
    const noVideoError = !result.failure && onlyNoVideoErrors(result.stderr);
    if (result.failure || (result.exitCode !== 0 && !noVideoError)) {
      errors.push(downloadFailure(result));
    }
    if (!result.failure && result.exitCode === 0) {
      if (/larger than max|file is larger/i.test(result.stderr)) {
        errors.push('One or more videos exceed the 1 GiB file limit.');
      } else if (started > videos.length && invalid === 0) {
        errors.push('One or more videos did not finish downloading.');
      }
    }
    if (errors.length > 0) {
      logger.warn(`Social video downloader diagnostics: ${link.url}`, {
        exitCode: result.exitCode, failure: result.failure ?? null,
        error: result.error,
        started, completed: videos.length, invalidMetadata: invalid,
        errors,
        stdout: result.stdout, stderr: result.stderr,
      });
    }

    const seen = new Set<string>();
    for (const [index, video] of videos.entries()) {
      if (archiveLifecycle.signal.aborted) break;
      let path: string;
      try {
        path = await videoPath(directory, video.filepath);
        if (seen.has(path)) continue;
        seen.add(path);
      } catch (error) {
        logger.warn(`Social video output path failed (video ${index + 1}): ${link.url}`, error);
        errors.push(`Video ${index + 1}: downloaded file is missing or invalid.`);
        continue;
      }
      try {
        const { size } = await lstat(path);
        if (!size || size > MAX_UPLOAD_BYTES) {
          logger.warn(`Social video size check failed (video ${index + 1}): ${link.url}`, { bytes: size, limit: MAX_UPLOAD_BYTES });
          errors.push(`Video ${index + 1}: file is empty or exceeds the 1 GiB file limit.`);
          continue;
        }
        path = await prepareMp4(path, video.expectsAudio, deps);
      } catch (error) {
        logger.warn(`Social video validation failed (video ${index + 1}): ${link.url}`, error);
        // These messages are generated locally; never include raw process stderr.
        const reason = error instanceof SyntaxError ? 'Invalid ffprobe response.'
          : error instanceof Error && error.message.startsWith('Downloaded') ? error.message
            : 'Video validation/MP4 preparation failed; check FFmpeg/ffprobe on the host.';
        errors.push(`Video ${index + 1}: ${reason}`);
        continue;
      }
      const filename = sanitizeFilename(`${video.title}.mp4`, 'video');
      try {
        const stored = await deps.upload({
          filename, contentType: contentTypeForFilename(filename), path,
        });
        uploaded.push({ name: filename, url: stored.url });
      } catch (error) {
        logger.error(`Social video read/upload failed (video ${index + 1}): ${link.url}`, error);
        errors.push(`Video ${index + 1}: could not read the file or upload it to R2.`);
      }
    }
    return { uploaded, errors, noVideos: videos.length === 0 && errors.length === 0 };
  } finally {
    // Only delete the directory created by mkdtemp, never a downloader-reported path.
    await removeTempDirectory(directory);
  }
}

export async function archiveSocialLink(rawUrl: string, dependencies?: SocialDependencies): Promise<SocialArchiveResult> {
  const link = validateSocialLink(rawUrl);
  if (!link.valid) return { uploaded: [], errors: [link.reason], noVideos: false };
  const deps = dependencies ?? { run: runProcess, upload: uploadToR2, tools: socialTools() };
  // Includes MP4 preparation and R2 upload, not only the downloader subprocess.
  return archiveLifecycle.run((signal) => queue.run(() => archivePost(link, deps), signal));
}

/** Non-fatal startup diagnostics: the original watcher still works without these tools. */
export async function checkSocialTools(): Promise<void> {
  const tools = socialTools();
  for (const [name, executable, flag] of [
    ['yt-dlp', tools.ytDlp, '--version'], ['FFmpeg', tools.ffmpeg, '-version'], ['ffprobe', tools.ffprobe, '-version'],
  ] as const) {
    const result = await runProcess(executable, [flag], { timeoutMs: 10_000 });
    if (result.failure || result.exitCode !== 0) {
      logger.warn(`Social videos: ${name} is unavailable; check its installation and pm2 PATH.`, {
        exitCode: result.exitCode, failure: result.failure ?? null,
        error: result.error, stdout: result.stdout, stderr: result.stderr,
      });
    }
  }
}
