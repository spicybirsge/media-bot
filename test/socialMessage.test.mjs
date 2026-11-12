import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSocialMessage } from '../src/socialMessageHandler.ts';

function message(content, overrides = {}) {
  const replies = [];
  return {
    id: 'message', channelId: '100000000000000002', author: { bot: false }, content,
    replies, reply: async (options) => { replies.push(options); }, ...overrides,
  };
}

test('ignores bots, unrelated channels, and messages without URLs', async () => {
  for (const input of [message('hello'), message('https://youtu.be/abcdefghijk', { author: { bot: true } }),
    message('https://youtu.be/abcdefghijk', { channelId: '100000000000000001' })]) {
    await handleSocialMessage(input, async () => assert.fail('should not download'));
    assert.deepEqual(input.replies, []);
  }
});

test('invalid-only messages receive an explanation and skip count without an uploading ack', async () => {
  const input = message('https://example.com/a https://instagram.com/person/');
  await handleSocialMessage(input, async () => assert.fail('should not download'));
  const content = input.replies.map((reply) => reply.content).join('\n');
  assert.match(content, /Skipped 2 link/);
  assert.match(content, /Supported platforms/);
  assert.match(content, /post or reel/);
  assert.ok(!content.includes('uploading...'));
});

test('acks before downloads, returns all media URLs and reports mixed link failures', async () => {
  const input = message('https://youtu.be/abcdefghijk https://example.com/no https://x.com/a/status/123 https://instagram.com/p/xyz/');
  let called = 0;
  await handleSocialMessage(input, async () => {
    assert.equal(input.replies[0].content, 'uploading...');
    called += 1;
    if (called === 1) throw new Error('https://signed.example.com/?secret=never-echo');
    if (called === 2) return { uploaded: [{ url: 'https://bucket/one' }, { url: 'https://bucket/two' }], errors: ['One video failed.'], noVideos: false };
    return { uploaded: [], errors: [], noVideos: true };
  });
  assert.equal(called, 3);
  const content = input.replies.slice(1).map((reply) => reply.content).join('\n');
  assert.match(content, /https:\/\/bucket\/one\nhttps:\/\/bucket\/two/);
  assert.match(content, /Skipped 1 link/);
  assert.match(content, /errors in 2 link/);
  assert.match(content, /No downloadable videos found in 1 post/);
  assert.ok(!content.includes('secret'));
  assert.ok(input.replies.every((reply) => reply.allowedMentions.parse.length === 0 && !reply.allowedMentions.repliedUser));
});

test('canonical duplicates download once and an ack failure does not discard uploads', async () => {
  const input = message('https://youtu.be/abcdefghijk https://youtube.com/watch?v=abcdefghijk&list=abc');
  let replies = 0;
  input.reply = async (options) => { if (++replies === 1) throw new Error('cannot ack'); input.replies.push(options); };
  let calls = 0;
  await handleSocialMessage(input, async () => { calls += 1; return { uploaded: [{ url: 'https://bucket/video' }], errors: [], noVideos: false }; });
  assert.equal(calls, 1);
  assert.match(input.replies[0].content, /https:\/\/bucket\/video/);
});

test('mixed-link errors identify their original input positions', async () => {
  const input = message('https://example.com/invalid https://x.com/a/status/123 https://instagram.com/person/ https://youtu.be/abcdefghijk');
  await handleSocialMessage(input, async (url) => {
    if (url.includes('x.com')) return { uploaded: [], errors: ['Post unavailable.'], noVideos: false };
    throw new Error('download failed');
  });
  const content = input.replies.map((reply) => reply.content).join('\n');
  assert.match(content, /Link 2: Post unavailable/);
  assert.match(content, /Link 4: could not process/);
  assert.ok(!content.includes('Link 1:'));
});
