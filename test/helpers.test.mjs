import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadCommand } from '../src/commands/upload.ts';
import { sanitizeFilename, contentDisposition } from '../src/lib/filename.ts';
import { extractUrls } from '../src/lib/links.ts';
import { chunkLines } from '../src/lib/messageChunks.ts';
import { SerialQueue } from '../src/lib/serialQueue.ts';
import { validateSocialLink } from '../src/lib/socialLinks.ts';
import { uploadToR2 } from '../src/r2.ts';

test('social validation canonicalizes individual posts and rejects other pages and lookalike hosts', () => {
  const accepted = [
    ['https://youtu.be/abcdefghijk?si=tracking', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['https://www.youtube.com/watch?v=abcdefghijk&list=playlist', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['https://m.youtube.com/shorts/abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['https://instagram.com/p/ABC_-12/?img_index=2', 'https://www.instagram.com/p/ABC_-12/'],
    ['https://www.instagram.com/reel/ABC_123/', 'https://www.instagram.com/reel/ABC_123/'],
    ['https://twitter.com/person/status/12345/video/2?s=20', 'https://x.com/i/status/12345'],
    ['https://x.com/i/web/status/12345', 'https://x.com/i/status/12345'],
  ];
  for (const [input, expected] of accepted) {
    const result = validateSocialLink(input);
    assert.equal(result.valid, true, input);
    assert.equal(result.url, expected);
  }
  for (const url of [
    'file:///tmp/video.mp4', 'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://youtube.com@evil.test/watch?v=abcdefghijk', 'https://evil@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:8000/watch?v=abcdefghijk', 'https://youtube.com/playlist?list=abc',
    'https://youtube.com/watch?v=bad', 'https://youtube.com/@someone',
    'https://instagram.com/person/', 'https://instagram.com/stories/person/1/',
    'https://x.com/person', 'https://x.com/home', 'https://example.com/a.mp4',
  ]) assert.equal(validateSocialLink(url).valid, false, url);
});

test('link extraction handles Discord formatting, punctuation and duplicate links', () => {
  assert.deepEqual(extractUrls('See <https://youtu.be/abcdefghijk>, [post](https://x.com/a/status/123). https://x.com/a/status/123'), [
    'https://youtu.be/abcdefghijk', 'https://x.com/a/status/123',
  ]);
  assert.deepEqual(extractUrls('photo attached, no URLs'), []);
});

test('filename metadata strips traversal, controls and unsafe punctuation and caps length', () => {
  const filename = sanitizeFilename('../folder\\evil\u0000 name?".mp4');
  assert.equal(filename, 'evil_name.mp4');
  assert.ok(sanitizeFilename('a'.repeat(400) + '.mp4').length <= 84);
  const disposition = contentDisposition('../video\r\n"unsafe".mp4');
  assert.ok(disposition.startsWith('inline; filename="'));
  assert.ok(!/[\r\n]/.test(disposition));
});

test('/upload rejects a non-owner before reading options or contacting R2', async () => {
  const replies = [];
  await uploadCommand.execute({ user: { id: '100000000000000004' }, reply: async (reply) => replies.push(reply) });
  assert.equal(replies[0].content, 'Not authorized.');
});

test('R2 upload uses a bare nanoid and public base with sanitized filename metadata', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input) => { request = input; return new Response(null, { status: 200 }); };
  try {
    const stored = await uploadToR2({ filename: '../movie.mp4', contentType: 'video/mp4', data: new Uint8Array([1]) });
    assert.match(stored.key, /^[A-Za-z0-9_-]{21}$/);
    assert.equal(stored.url, `https://archive.example.com/${stored.key}`);
    assert.equal(new URL(request.url).pathname, `/test-bucket/${stored.key}`);
    assert.match(request.headers.get('content-disposition'), /filename="movie.mp4"/);
  } finally { globalThis.fetch = originalFetch; }
});

test('queue serializes jobs and recovers from rejection', async () => {
  const queue = new SerialQueue();
  const events = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = queue.run(async () => { events.push('first'); await blocked; throw new Error('expected'); });
  const rejected = assert.rejects(first, /expected/);
  const second = queue.run(async () => { events.push('second'); return 2; });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release();
  await rejected;
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first', 'second']);
});

test('message chunks respect Discord length limits even for a long single line', () => {
  const chunks = chunkLines(['url', 'a'.repeat(5000), 'end']);
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  assert.equal(chunks.join('').replaceAll('\n', ''), 'url' + 'a'.repeat(5000) + 'end');
});
