import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, access, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSocialLink, downloadArguments } from '../src/socialDownload.ts';
import { runProcess } from '../src/socialProcess.ts';
import { validateSocialLink } from '../src/lib/socialLinks.ts';

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const tools = { ytDlp: 'test-yt-dlp', ffmpeg: 'ffmpeg', ffprobe: 'test-ffprobe' };
const streams = (audio = true) => JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
  ...(audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : []),
] });
const copyMp4 = async (args) => { await copyFile(args[args.indexOf('-i') + 1], args.at(-1)); return ok(); };

test('yt-dlp arguments include audio merging, no playlist expansion, Node and final-file metadata', () => {
  const args = downloadArguments(validateSocialLink('https://youtu.be/abcdefghijk'), tools);
  assert.equal(args[args.indexOf('--format') + 1], 'bv*+ba/b/bv');
  assert.ok(args.includes('--no-playlist') && args.includes('--ignore-config') && args.includes('--abort-on-unavailable-fragments'));
  assert.ok(args.includes(`node:${process.execPath}`));
  assert.ok(args.some((arg) => arg.startsWith('after_move:')));
  assert.equal(args[args.indexOf('--output-na-placeholder') + 1], 'null');
  assert.equal(args[args.indexOf('--max-filesize') + 1], String(1024 ** 3));
  assert.ok(!args.includes('--ffmpeg-location')); // Bare ffmpeg is resolved through PATH by yt-dlp.
  assert.equal(args.at(-2), '--');
});

test('uploads completed videos despite another item failing, and always removes temporary files', async () => {
  let directory;
  const uploaded = [];
  const result = await archiveSocialLink('https://x.com/a/status/123', {
    tools,
    run: async (command, args, options) => {
      if (command === tools.ffprobe) return ok(streams());
      if (command === tools.ffmpeg) return copyMp4(args);
      directory = options.cwd;
      await writeFile(join(directory, '00001.mp4'), 'first');
      await writeFile(join(directory, '00002.mp4'), 'second');
      return { exitCode: 1, stderr: 'ERROR: 403 https://cdn.example/video?token=secret', stdout: [
        JSON.stringify({ filepath: '00001.mp4', title: '../first', acodec: 'aac' }),
        JSON.stringify({ filepath: '00002.mp4', title: 'second', acodec: 'aac' }),
      ].join('\n') };
    },
    upload: async (file) => { uploaded.push(file); return { url: `https://bucket/${uploaded.length}` }; },
  });
  assert.equal(result.uploaded.length, 2);
  assert.deepEqual(uploaded.map((item) => item.filename), ['first.mp4', 'second.mp4']);
  assert.equal(result.errors.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(access(directory));
});

test('rejects a video missing expected audio while preserving a genuinely silent video', async () => {
  const result = await archiveSocialLink('https://instagram.com/p/abc/', {
    tools,
    run: async (command, args, options) => {
      if (command === tools.ffprobe) return ok(streams(false));
      if (command === tools.ffmpeg) return copyMp4(args);
      for (const name of ['missing', 'silent']) await writeFile(join(options.cwd, `${name}.mp4`), 'video');
      return ok([
        { filepath: 'missing.mp4', title: 'missing', acodec: 'none', audio_codecs: ['none', 'aac'] },
        { filepath: 'silent.mp4', title: 'silent', acodec: 'none', audio_codecs: ['none'] },
      ].map(JSON.stringify).join('\n'));
    },
    upload: async () => ({ url: 'https://bucket/silent' }),
  });
  assert.deepEqual(result.uploaded.map((item) => item.url), ['https://bucket/silent']);
  assert.match(result.errors[0], /missing its expected audio/);
});

test('upload failure and invalid metadata/path do not prevent a later item uploading', async () => {
  let calls = 0;
  const result = await archiveSocialLink('https://x.com/a/status/123', {
    tools,
    run: async (command, args, options) => {
      if (command === tools.ffprobe) return ok(streams());
      if (command === tools.ffmpeg) return copyMp4(args);
      for (const name of ['one', 'two']) await writeFile(join(options.cwd, `${name}.mp4`), 'video');
      return ok(['bad JSON',
        JSON.stringify({ filepath: '../outside.mp4' }),
        JSON.stringify({ filepath: 'one.mp4', title: 'one', acodec: 'aac' }),
        JSON.stringify({ filepath: 'two.mp4', title: 'two', acodec: 'aac' }),
      ].join('\n'));
    },
    upload: async () => { if (++calls === 1) throw new Error('secret signed URL'); return { url: 'https://bucket/two' }; },
  });
  assert.equal(result.uploaded.length, 1);
  assert.equal(result.errors.length, 3);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('photo entries are skipped without masking a different error in the same carousel', async () => {
  for (const loginFailure of [false, true]) {
    const result = await archiveSocialLink('https://instagram.com/p/abc/', {
      tools,
      run: async (command, args, options) => {
        if (command === tools.ffprobe) return ok(streams());
        if (command === tools.ffmpeg) return copyMp4(args);
        await writeFile(join(options.cwd, 'video.mp4'), 'video');
        return {
          exitCode: 1,
          stdout: JSON.stringify({ filepath: 'video.mp4', title: 'video', acodec: 'aac' }),
          stderr: 'ERROR: No video formats found' + (loginFailure ? '\nERROR: Login required' : ''),
        };
      },
      upload: async () => ({ url: 'https://bucket/video' }),
    });
    assert.equal(result.uploaded.length, 1);
    assert.equal(result.errors.length, loginFailure ? 1 : 0);
    if (loginFailure) assert.match(result.errors[0], /login cookies/);
  }
});

test('photo-only, oversized, login-required and unavailable-tool results are distinct', async () => {
  for (const [processResult, noVideos, error] of [
    [{ exitCode: 1, stdout: '', stderr: 'There is no video in this post' }, true, undefined],
    [ok('MEDIA_BOT_VIDEO_START:"unfinished"\n'), false, /did not finish/],
    [{ ...ok('MEDIA_BOT_VIDEO_START:"oversized"\n'), stderr: 'File is larger than max-filesize' }, false, /1 GiB/],
    [{ exitCode: 1, stdout: '', stderr: 'Login required: https://signed.example/?secret' }, false, /login cookies/],
    [{ exitCode: null, stdout: '', stderr: '', failure: 'unavailable' }, false, /YT_DLP_PATH/],
  ]) {
    const result = await archiveSocialLink('https://instagram.com/p/abc/', { tools, run: async () => processResult, upload: async () => assert.fail('no upload expected') });
    assert.equal(result.noVideos, noVideos);
    if (error) assert.match(result.errors[0], error);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('malformed metadata logs full diagnostics without falsely reporting a size limit', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const stdout = 'MEDIA_BOT_VIDEO_START:"123"\n{"filepath":"00001.mp4","acodec":NA}\n';
  const stderr = 'WARNING: details https://cdn.example/video?token=visible-in-console';
  const result = await archiveSocialLink('https://x.com/a/status/123', {
    tools, run: async () => ({ ...ok(stdout), stderr }),
    upload: async () => assert.fail('invalid metadata must not upload'),
  });
  assert.deepEqual(result.errors, ['yt-dlp returned invalid metadata for one or more videos.']);
  const diagnostic = warn.mock.calls.find((call) => call.arguments[0].includes('downloader diagnostics'));
  assert.equal(diagnostic.arguments[1].stdout, stdout);
  assert.equal(diagnostic.arguments[1].stderr, stderr);
  assert.equal(diagnostic.arguments[1].invalidMetadata, 1);
  assert.ok(!JSON.stringify(result).includes('visible-in-console'));
});

test('process runner captures nonzero exit, missing executable and enforces timeout', async () => {
  const failed = await runProcess(process.execPath, ['-e', 'process.stdout.write("partial"); process.exit(2)'], { timeoutMs: 5000 });
  assert.equal(failed.stdout, 'partial');
  assert.equal(failed.exitCode, 2);
  const missing = await runProcess('media-bot-nonexistent-executable', [], { timeoutMs: 5000 });
  assert.equal(missing.failure, 'unavailable');
  assert.equal(missing.error.code, 'ENOENT');
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
  assert.equal(timeout.failure, 'timeout');
});

test('process runner stops a growing file even when the downloader does not declare its size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-bot-process-test-'));
  try {
    const result = await runProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync("video.part", Buffer.alloc(2048)); setInterval(() => {}, 1000)'], {
      cwd: directory, timeoutMs: 5000, maxDiskBytes: 1024,
    });
    assert.equal(result.failure, 'disk-limit');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
