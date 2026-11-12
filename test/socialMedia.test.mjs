import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMp4 } from '../src/socialMedia.ts';

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const tools = { ffmpeg: 'test-ffmpeg', ffprobe: 'test-ffprobe' };

test('MP4 preparation copies compatible streams, converts unsupported codecs, and preserves silent clips', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-bot-mp4-test-'));
  try {
    for (const [name, videoCodec, pixelFormat, audioCodec] of [
      ['compatible', 'h264', 'yuv420p', 'aac'],
      ['incompatible', 'hevc', 'yuv420p10le', 'opus'],
      ['silent', 'h264', 'yuv420p', undefined],
    ]) {
      let ffmpegArgs;
      let probes = 0;
      const output = await prepareMp4(join(directory, `${name}.mkv`), !!audioCodec, {
        tools,
        run: async (command, args, options) => {
          if (command === tools.ffprobe) {
            const input = probes++ === 0;
            return ok(JSON.stringify({ streams: [
              { codec_type: 'video', codec_name: input ? videoCodec : 'h264', pix_fmt: input ? pixelFormat : 'yuv420p' },
              ...(audioCodec ? [{ codec_type: 'audio', codec_name: input ? audioCodec : 'aac' }] : []),
            ] }));
          }
          ffmpegArgs = args;
          assert.ok(options.timeoutMs > 0 && options.maxDiskBytes > 0 && options.maxFileBytes > 0);
          await writeFile(args.at(-1), 'mp4');
          return ok();
        },
      });
      assert.equal(output, join(directory, `${name}.discord.mp4`));
      assert.equal(probes, 2);
      assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-c:v') + 1], name === 'incompatible' ? 'libx264' : 'copy');
      assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-c:a') + 1], name === 'incompatible' ? 'aac' : 'copy');
      assert.ok(ffmpegArgs.includes('0:a:0?') && ffmpegArgs.includes('+faststart'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed MP4 conversion is reported instead of uploading the original MKV', async () => {
  await assert.rejects(prepareMp4('failed.mkv', true, {
    tools,
    run: async (command) => command === tools.ffprobe
      ? ok(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac' }] }))
      : { exitCode: 1, stdout: '', stderr: 'FFmpeg muxing failed' },
  }), /could not be prepared as MP4/);
});
