import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveSocialLink } from '../src/socialDownload.ts';
import { prepareMp4 } from '../src/socialMedia.ts';
import { runProcess } from '../src/socialProcess.ts';

// Opt in when host tools are available. All media is generated locally; no network or R2 access.
test('real yt-dlp downloads and merges local streams, then ffprobe validates the uploaded files', {
  skip: !process.env.TEST_YT_DLP_PATH,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-bot-tools-test-'));
  let downloadDirectory;
  try {
    const source = join(root, 'source.mp4');
    const audio = join(root, 'audio.m4a');
    const ffmpeg = process.env.TEST_FFMPEG_PATH || 'ffmpeg';
    const ffprobe = process.env.TEST_FFPROBE_PATH || 'ffprobe';
    for (const [file, mediaArgs] of [
      [source, ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5', '-t', '0.4', '-an', '-c:v', 'libx264']],
      [audio, ['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.4', '-vn', '-c:a', 'aac']],
    ]) {
      const generated = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...mediaArgs, file], { timeoutMs: 30000 });
      assert.equal(generated.exitCode, 0, 'could not generate local media fixture');
    }
    const info = join(root, 'info.json');
    await writeFile(info, JSON.stringify({
      id: 'local-test', title: 'local merged video', extractor: 'generic', webpage_url: 'https://example.invalid/test',
      formats: [
        { format_id: 'video', url: pathToFileURL(source).href, ext: 'mp4', vcodec: 'h264', acodec: 'none', width: 64, height: 64 },
        { format_id: 'audio', url: pathToFileURL(audio).href, ext: 'm4a', vcodec: 'none', acodec: 'aac' },
      ],
    }));
    const uploads = [];
    const result = await archiveSocialLink('https://youtu.be/abcdefghijk', {
      tools: { ytDlp: process.env.TEST_YT_DLP_PATH, ffmpeg, ffprobe },
      run: async (command, args, options) => {
        if (command !== process.env.TEST_YT_DLP_PATH) return runProcess(command, args, options);
        downloadDirectory = options.cwd;
        // Replace the public URL with a local metadata fixture. Local file URLs are
        // enabled for this test only; the production arguments never enable them.
        return runProcess(command, [...args.slice(0, -2), '--enable-file-urls', '--load-info-json', info], options);
      },
      upload: async (file) => { uploads.push({ ...file, data: await readFile(file.path) }); return { url: 'https://bucket/local-video' }; },
    });
    assert.deepEqual(result.errors, []);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].contentType, 'video/mp4');
    assert.ok(uploads[0].filename.endsWith('.mp4'));
    assert.ok(uploads[0].data.indexOf('moov') < uploads[0].data.indexOf('mdat'));
    assert.ok(uploads[0].data.byteLength > 0);
    const merged = join(root, 'merged.mp4');
    await writeFile(merged, uploads[0].data);
    const probe = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', merged], { timeoutMs: 30000 });
    assert.deepEqual(JSON.parse(probe.stdout).streams.map((stream) => stream.codec_type).sort(), ['audio', 'video']);
    await assert.rejects(access(downloadDirectory));

    // X/Instagram can provide a playable combined file without reporting its
    // audio codec. Previously %(acodec)j emitted bare NA, breaking the JSON.
    await writeFile(info, JSON.stringify({
      id: 'unknown-codec', title: 'local video without codec metadata', extractor: 'generic',
      url: pathToFileURL(merged).href, ext: 'mp4',
    }));
    const unknownUploads = [];
    const unknownCodec = await archiveSocialLink('https://x.com/i/status/12345', {
      tools: { ytDlp: process.env.TEST_YT_DLP_PATH, ffmpeg, ffprobe },
      run: async (command, args, options) => {
        if (command !== process.env.TEST_YT_DLP_PATH) return runProcess(command, args, options);
        downloadDirectory = options.cwd;
        const result = await runProcess(command, [...args.slice(0, -2), '--enable-file-urls', '--load-info-json', info], options);
        const metadata = result.stdout.split(/\r?\n/).find((line) => line.startsWith('{'));
        assert.equal(JSON.parse(metadata).acodec, null);
        return result;
      },
      upload: async (file) => { unknownUploads.push(file); return { url: 'https://bucket/unknown-codec' }; },
    });
    assert.deepEqual(unknownCodec.errors, []);
    assert.equal(unknownUploads.length, 1);
    assert.equal(unknownUploads[0].contentType, 'video/mp4');
    await assert.rejects(access(downloadDirectory));

    // A WebM with VP9/Opus needs codec conversion, not just a new filename/container.
    const webm = join(root, 'incompatible.webm');
    const generatedWebm = await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', merged,
      '-c:v', 'libvpx-vp9', '-c:a', 'libopus', webm,
    ], { timeoutMs: 30000 });
    assert.equal(generatedWebm.exitCode, 0);
    const compatible = await prepareMp4(webm, true, { run: runProcess, tools: { ffmpeg, ffprobe } });
    const compatibleProbe = await runProcess(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', compatible,
    ], { timeoutMs: 30000 });
    const compatibleStreams = JSON.parse(compatibleProbe.stdout).streams;
    assert.deepEqual(compatibleStreams.map((stream) => stream.codec_name).sort(), ['aac', 'h264']);
    assert.equal(compatibleStreams.find((stream) => stream.codec_name === 'h264').pix_fmt, 'yuv420p');

    const odd = join(root, 'odd.webm');
    const generatedOdd = await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=65x63:rate=5',
      '-t', '0.4', '-pix_fmt', 'yuv444p', '-c:v', 'libvpx-vp9', odd,
    ], { timeoutMs: 30000 });
    assert.equal(generatedOdd.exitCode, 0);
    const padded = await prepareMp4(odd, false, { run: runProcess, tools: { ffmpeg, ffprobe } });
    const paddedProbe = await runProcess(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', padded,
    ], { timeoutMs: 30000 });
    const paddedVideo = JSON.parse(paddedProbe.stdout).streams[0];
    assert.equal(paddedVideo.width, 66);
    assert.equal(paddedVideo.height, 64);
    assert.equal(paddedVideo.codec_name, 'h264');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
