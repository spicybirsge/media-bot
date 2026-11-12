import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { uploadCommand } from '../src/commands/upload.ts';
import { SerialQueue } from '../src/lib/serialQueue.ts';

function interaction() {
  const replies = [];
  return {
    user: { id: '100000000000000003' }, createdTimestamp: Date.now(), replies,
    options: { getAttachment: () => null, getString: () => 'https://example.com/file' },
    deferReply: async (reply) => replies.push(reply),
    editReply: async (reply) => replies.push(reply),
  };
}

test('/upload reports cancellation before its reply expires, including queue wait', async () => {
  const queue = new SerialQueue();
  let release;
  const blocked = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const input = interaction();
  const executing = uploadCommand.execute(input, {
    timeoutMs: 30,
    archiveAttachment: async () => assert.fail('not an attachment'),
    archiveLink: async (url, signal) => queue.run(async () => assert.fail('deadline must skip queued work'), signal),
  });
  // Keep an active handle because AbortSignal.timeout deliberately unrefs its timer.
  await Promise.all([executing, delay(60)]);
  assert.match(input.replies.at(-1).content, /timed out.*archive channel/);
  release();
  await blocked;
});

test('/upload returns a successful result and passes a cancellation signal through', async () => {
  const input = interaction();
  await uploadCommand.execute(input, {
    timeoutMs: 1000,
    archiveAttachment: async () => assert.fail('not an attachment'),
    archiveLink: async (url, signal) => {
      assert.equal(signal.aborted, false);
      return { name: 'file', url: 'https://archive.example.com/result' };
    },
  });
  assert.equal(input.replies.at(-1).content, 'https://archive.example.com/result');
});
