import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadToR2 } from '../src/r2.ts';
import { MAX_UPLOAD_BYTES, UPLOAD_PART_BYTES } from '../src/config.ts';

const initiated = () => new Response('<InitiateMultipartUploadResult><UploadId>a&amp;b+/=</UploadId></InitiateMultipartUploadResult>');
const completed = () => new Response('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');

async function withFile(size, run) {
  const directory = await mkdtemp(join(tmpdir(), 'media-bot-r2-test-'));
  const path = join(directory, 'large.bin');
  try {
    const file = await open(path, 'w');
    try { await file.truncate(size); } finally { await file.close(); }
    return await run(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('1 GiB file is uploaded in bounded parts with one nanoid, metadata and ordered completion', async (t) => {
  assert.equal(MAX_UPLOAD_BYTES, 1024 ** 3);
  const sizes = [];
  const keys = new Set();
  let completion;
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url);
    keys.add(url.pathname.split('/').at(-1));
    if (url.searchParams.has('uploads')) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('content-type'), 'video/mp4');
      assert.match(request.headers.get('content-disposition'), /filename="movie.mp4"/);
      return initiated();
    }
    assert.equal(url.searchParams.get('uploadId'), 'a&b+/=');
    if (request.method === 'PUT') {
      const size = Number(request.headers.get('content-length'));
      assert.ok(size > 0 && size <= UPLOAD_PART_BYTES);
      sizes.push(size);
      assert.equal(Number(url.searchParams.get('partNumber')), sizes.length);
      // Consume the stream without allocating a second whole-part ArrayBuffer.
      let received = 0;
      for await (const chunk of request.body) received += chunk.byteLength;
      assert.equal(received, size);
      return new Response(null, { headers: { etag: `"etag-${sizes.length}"` } });
    }
    completion = await request.text();
    assert.equal(request.method, 'POST');
    return completed();
  });
  const result = await withFile(MAX_UPLOAD_BYTES, (path) => uploadToR2({ path, filename: 'movie.mp4', contentType: 'video/mp4' }));
  assert.equal(result.size, MAX_UPLOAD_BYTES);
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), MAX_UPLOAD_BYTES);
  assert.equal(sizes.length, 64);
  assert.equal(keys.size, 1);
  assert.match(result.key, /^[A-Za-z0-9_-]{21}$/);
  assert.equal(result.url, `https://archive.example.com/${result.key}`);
  assert.match(completion, /<PartNumber>1<\/PartNumber><ETag>&quot;etag-1&quot;<\/ETag>/);
  assert.match(completion, /<PartNumber>64<\/PartNumber>/);
});

test('larger than 1 GiB is rejected before making an R2 request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('must reject before network'));
  await withFile(MAX_UPLOAD_BYTES + 1, async (path) => {
    await assert.rejects(uploadToR2({ path, filename: 'too-large.mp4', contentType: 'video/mp4' }), /upload limit/);
  });
  assert.equal(fetch.mock.calls.length, 0);
});

test('small disk files use a single PUT and preserve their bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'media-bot-r2-small-'));
  try {
    const path = join(directory, 'small.txt');
    await writeFile(path, 'hello');
    const fetch = t.mock.method(globalThis, 'fetch', async (request) => {
      assert.equal(request.method, 'PUT');
      assert.equal(new URL(request.url).search, '');
      assert.equal(await request.text(), 'hello');
      return new Response(null);
    });
    await uploadToR2({ path, filename: 'small.txt', contentType: 'text/plain' });
    assert.equal(fetch.mock.calls.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('multipart part retries reuse the same part and byte range', async (t) => {
  const attempts = [];
  let completion;
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url);
    if (url.searchParams.has('uploads')) return initiated();
    if (request.method === 'POST') { completion = await request.text(); return completed(); }
    const part = Number(url.searchParams.get('partNumber'));
    attempts.push([part, Number(request.headers.get('content-length'))]);
    await request.body.cancel();
    if (attempts.length === 1) return new Response(null, { status: 503 });
    return new Response(null, { headers: { etag: `"part-${part}"` } });
  });
  await withFile(UPLOAD_PART_BYTES + 3, (path) => uploadToR2({ path, filename: 'file.bin', contentType: 'application/octet-stream' }));
  assert.deepEqual(attempts, [[1, UPLOAD_PART_BYTES], [1, UPLOAD_PART_BYTES], [2, 3]]);
  assert.equal((completion.match(/<Part>/g) || []).length, 2);
});

test('failed parts, missing ETags and HTTP-200 completion errors abort multipart uploads', async (t) => {
  for (const failure of ['part', 'etag', 'completion', 'cancel']) {
    const controller = new AbortController();
    let aborted = false;
    let completedRequest = false;
    const fetch = t.mock.method(globalThis, 'fetch', async (request) => {
      const url = new URL(request.url);
      if (url.searchParams.has('uploads')) return initiated();
      assert.equal(url.searchParams.get('uploadId'), 'a&b+/=');
      if (request.method === 'DELETE') {
        assert.equal(request.signal.aborted, false, 'abort cleanup needs its own live signal');
        aborted = true;
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST') {
        completedRequest = true;
        return new Response('<Error><Code>InvalidPart</Code></Error>');
      }
      await request.body.cancel();
      if (failure === 'cancel') { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); }
      if (failure === 'part') return new Response(null, { status: 403 });
      return new Response(null, { headers: failure === 'etag' ? {} : { etag: '"part"' } });
    });
    try {
      await withFile(UPLOAD_PART_BYTES + 1, (path) => assert.rejects(uploadToR2({ path, filename: 'file.bin', contentType: 'application/octet-stream', signal: controller.signal })));
      assert.equal(aborted, true, failure);
      assert.equal(completedRequest, failure === 'completion');
    } finally { fetch.mock.restore(); }
  }
});
