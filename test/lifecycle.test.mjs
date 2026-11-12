import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveLifecycle } from '../src/lib/lifecycle.ts';
import { SerialQueue } from '../src/lib/serialQueue.ts';
import { uploadToR2 } from '../src/r2.ts';
import { UPLOAD_PART_BYTES } from '../src/config.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a queued cancellation rejects promptly without running or poisoning later jobs', async () => {
  const queue = new SerialQueue();
  const release = deferred();
  const entered = deferred();
  const first = queue.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const controller = new AbortController();
  const queued = queue.run(async () => assert.fail('cancelled job must never run'), controller.signal);
  const rejected = assert.rejects(queued, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejected; // Must finish before the first job is released.
  release.resolve();
  await first;
  assert.equal(await queue.run(async () => 'next'), 'next');
});

test('shutdown aborts multipart uploads and queued jobs, and waits for owned cleanup', async (t) => {
  const lifecycle = new ArchiveLifecycle();
  const entered = deferred();
  const cleaned = deferred();
  const releaseCleanup = deferred();
  const directory = await mkdtemp(join(tmpdir(), 'media-bot-shutdown-test-'));
  const path = join(directory, 'source');
  const file = await open(path, 'w');
  await file.truncate(UPLOAD_PART_BYTES + 1);
  await file.close();
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url);
    if (url.searchParams.has('uploads')) return new Response('<UploadId>shutdown</UploadId>');
    if (request.method === 'DELETE') {
      assert.equal(request.signal.aborted, false);
      aborted = true;
      return new Response(null, { status: 204 });
    }
    entered.resolve();
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        void request.body.cancel();
        reject(request.signal.reason);
      }, { once: true });
    });
  });
  const work = lifecycle.run(async (signal) => {
    try { return await uploadToR2({ path, filename: 'source.bin', contentType: 'application/octet-stream', signal }); }
    finally {
      cleaned.resolve();
      await releaseCleanup.promise;
      await rm(directory, { recursive: true, force: true });
    }
  });
  const workRejected = assert.rejects(work, /shutting down/);
  await entered.promise;
  const queued = uploadToR2({ filename: 'queued.txt', contentType: 'text/plain', data: new Uint8Array([1]), signal: lifecycle.signal });
  const queuedRejected = assert.rejects(queued, /shutting down/);
  let stopped = false;
  const stopping = lifecycle.shutdown(async () => {}).then(() => { stopped = true; });
  await queuedRejected;
  await cleaned.promise;
  assert.equal(aborted, true);
  assert.equal(stopped, false, 'shutdown must wait for local cleanup');
  releaseCleanup.resolve();
  await stopping;
  await workRejected;
  await assert.rejects(access(path));
  await assert.rejects(lifecycle.run(async () => assert.fail('new work after shutdown')), /shutting down/);
});
