import { lstat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { MAX_UPLOAD_BYTES, MAX_SOCIAL_TEMP_BYTES, MEDIA_PROCESS_TIMEOUT_MS } from './config.js';
import { logger } from './logger.js';
import { runProcess } from './socialProcess.js';

interface MediaDependencies {
  readonly run: typeof runProcess;
  readonly tools: { readonly ffmpeg: string; readonly ffprobe: string };
}

interface MediaStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  disposition?: { attached_pic?: number };
}

async function probeVideo(path: string, expectsAudio: boolean, deps: MediaDependencies) {
  const result = await deps.run(deps.tools.ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt:stream_disposition=attached_pic', '-of', 'json', path,
  ], { timeoutMs: 30_000 });
  try {
    if (result.failure || result.exitCode !== 0) throw new Error('Could not inspect the downloaded video.');
    const data = JSON.parse(result.stdout) as { streams?: MediaStream[] };
    const streams = Array.isArray(data?.streams) ? data.streams : [];
    const video = streams.find((stream) => stream?.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    const audio = streams.find((stream) => stream?.codec_type === 'audio');
    if (!video) throw new Error('Downloaded file contains no video stream.');
    if (expectsAudio && !audio) throw new Error('Downloaded video is missing its expected audio track.');
    return { video, audio };
  } catch (error) {
    logger.warn('Social video ffprobe validation failed.', {
      error, exitCode: result.exitCode, failure: result.failure ?? null,
      processError: result.error, stdout: result.stdout, stderr: result.stderr,
    });
    throw error;
  }
}

/** Produce a real MP4 with browser-compatible streams, preserving encoded media when possible. */
export async function prepareMp4(path: string, expectsAudio: boolean, deps: MediaDependencies): Promise<string> {
  const source = await probeVideo(path, expectsAudio, deps);
  const copyVideo = source.video.codec_name === 'h264' && source.video.pix_fmt === 'yuv420p';
  const copyAudio = !source.audio || source.audio.codec_name === 'aac';
  const output = join(dirname(path), `${basename(path, extname(path))}.discord.mp4`);
  const result = await deps.run(deps.tools.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-i', path,
    '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn',
    ...(copyVideo ? ['-c:v', 'copy'] : [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p',
    ]),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']),
    '-movflags', '+faststart', '-f', 'mp4', output,
  ], {
    cwd: dirname(path), timeoutMs: MEDIA_PROCESS_TIMEOUT_MS,
    maxDiskBytes: MAX_SOCIAL_TEMP_BYTES, maxFileBytes: MAX_UPLOAD_BYTES,
  });
  if (result.failure || result.exitCode !== 0) {
    logger.error('Social video MP4 preparation failed.', {
      exitCode: result.exitCode, failure: result.failure ?? null,
      error: result.error, stdout: result.stdout, stderr: result.stderr,
    });
    throw new Error(result.failure === 'disk-limit'
      ? 'Downloaded video exceeds the size limit during MP4 preparation.'
      : 'Downloaded video could not be prepared as MP4; check FFmpeg on the host.');
  }
  const { size } = await lstat(output);
  if (!size || size > MAX_UPLOAD_BYTES) throw new Error('Downloaded MP4 is empty or exceeds the 1 GiB file limit.');
  const prepared = await probeVideo(output, expectsAudio || !!source.audio, deps);
  if (prepared.video.codec_name !== 'h264' || prepared.video.pix_fmt !== 'yuv420p'
    || (prepared.audio && prepared.audio.codec_name !== 'aac')) {
    throw new Error('Downloaded MP4 does not contain compatible H.264/AAC streams.');
  }
  return output;
}
