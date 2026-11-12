import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveLink } from '../src/archive.ts';
import { downloadAttachment, downloadLink } from '../src/download.ts';
import { MAX_UPLOAD_BYTES } from '../src/config.ts';

let root;
let tempEnvironment;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-bot-download-test-'));
  tempEnvironment = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { TEMP: root, TMP: root, TMPDIR: root });
});
afterEach(async () => {
  for (const [key, value] of Object.entries(tempEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test('URL bytes are staged on disk with content type and filename metadata, then cleaned up', async (t) => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const file = await downloadLink('https://example.com/image');
  assert.equal(file.filename, 'image.png');
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.data, undefined);
  assert.deepEqual(await readFile(file.path), Buffer.from(bytes));
  await file.cleanup();
  await assert.rejects(access(file.path));
});

test('attachments over 1 GiB and declared URL responses over 1 GiB are rejected immediately', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('oversized attachment must not fetch'));
  await assert.rejects(downloadAttachment({ name: 'huge.mp4', size: MAX_UPLOAD_BYTES + 1, url: 'https://cdn.example/a' }), /upload limit/);
  assert.equal(fetch.mock.calls.length, 0);
  fetch.mock.restore();
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
  }));
  await assert.rejects(downloadLink('https://example.com/huge'), /upload limit/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(root), []);
});

test('a chunked download accepts exactly 1 GiB and rejects one byte more without buffering it', async (t) => {
  // Reuse one small chunk: no 1 GiB allocation or live download is needed.
  const chunk = new Uint8Array(1024 ** 2);
  for (const extra of [0, 1]) {
    let emitted = 0;
    let cancelled = false;
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      pull(controller) {
        if (emitted < 1024) { emitted += 1; controller.enqueue(chunk); }
        else if (extra) {
          if (emitted++ === 1024) controller.enqueue(new Uint8Array([1]));
          // Keep the oversized response open until the downloader cancels it.
        } else controller.close();
      },
      cancel() { cancelled = true; },
    })));
    try {
      if (extra) {
        await assert.rejects(downloadLink('https://example.com/chunked.bin'), /upload limit/);
        assert.equal(cancelled, true);
      } else {
        const file = await downloadLink('https://example.com/chunked.bin');
        assert.equal((await stat(file.path)).size, MAX_UPLOAD_BYTES);
        await file.cleanup();
      }
      assert.deepEqual(await readdir(root), []);
    } finally { fetch.mock.restore(); }
  }
});

test('archiveLink cleans staged bytes after either successful or failed R2 upload', async (t) => {
  for (const fail of [false, true]) {
    const fetch = t.mock.method(globalThis, 'fetch', async (request) => {
      if (typeof request === 'string') return new Response('hello', { headers: { 'content-type': 'text/plain' } });
      assert.equal(await request.text(), 'hello');
      return new Response(null, { status: fail ? 403 : 200 });
    });
    try {
      if (fail) await assert.rejects(archiveLink('https://example.com/file.txt'), /R2 upload failed/);
      else assert.match((await archiveLink('https://example.com/file.txt')).url, /^https:\/\/archive.example.com\/[\w-]{21}$/);
      assert.deepEqual(await readdir(root), []);
    } finally { fetch.mock.restore(); }
  }
});

test('a failed or empty response leaves no staged files', async (t) => {
  for (const body of [null, new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } })]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body));
    try {
      await assert.rejects(downloadLink('https://example.com/broken'));
      assert.deepEqual(await readdir(root), []);
    } finally { fetch.mock.restore(); }
  }
});
