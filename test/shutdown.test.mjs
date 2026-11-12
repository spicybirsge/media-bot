import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveLifecycle } from '../src/lib/lifecycle.ts';
import { archiveSocialLink } from '../src/socialDownload.ts';
import { runProcess, stopSocialProcesses } from '../src/socialProcess.ts';

// This file has its own test process: shutting down the singleton is intentional.
test('social shutdown kills an active downloader, skips queued posts and removes partial files', async () => {
  let directory;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const dependencies = {
    tools: { ytDlp: 'test-tool', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    run: async (command, args, options) => {
      directory = options.cwd;
      await writeFile(join(directory, 'partial.mp4.part'), 'partial data');
      const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      entered();
      return running;
    },
    upload: async () => assert.fail('shutdown must not upload partial files'),
  };
  const active = archiveSocialLink('https://x.com/a/status/123', dependencies);
  await started;
  const queued = assert.rejects(archiveSocialLink('https://x.com/a/status/456', dependencies), /shutting down/);
  await archiveLifecycle.shutdown(stopSocialProcesses);
  await active;
  await queued;
  await assert.rejects(access(directory));
});
