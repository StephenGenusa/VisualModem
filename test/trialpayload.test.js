import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrialStream } from '../src/tune/trialpayload.js';
import { peekManifest, decodePayload } from '../src/core/payload.js';

test('fits one frame', async () => {
  for (const capacity of [200, 1000, 5000, 40000]) {
    const stream = await buildTrialStream(1, capacity, 42);
    assert.ok(stream.length <= capacity, `${stream.length} > ${capacity}`);
    assert.ok(stream.length >= capacity - 64, `${stream.length} leaves too much of ${capacity} empty`);
  }
});

test('distinct trials have distinct transmission ids', async () => {
  const ids = new Set();
  for (const [trial, seed] of [[1, 42], [2, 42], [1, 43]]) {
    ids.add(peekManifest(await buildTrialStream(trial, 1000, seed)).txId);
  }
  assert.equal(ids.size, 3);
});

test('round trips', async () => {
  const record = await decodePayload(await buildTrialStream(7, 1000, 1));
  assert.equal(record.type, 'file');
  assert.equal(record.name, 't7');
});

test('too small', async () => {
  await assert.rejects(buildTrialStream(1, 40, 1), (err) => err.code === 'TRIAL_TOO_SMALL');
});

test('a 73 byte frame still holds a trial (1366 by 768 at 2 levels, parity 32)', async () => {
  const stream = await buildTrialStream(1, 73, 9);
  assert.ok(stream.length <= 73);
});

test('a multi frame stream fills its frames', async () => {
  const stream = await buildTrialStream(1, 1000, 5, 12);
  assert.ok(stream.length <= 12000, `${stream.length}`);
  assert.ok(stream.length >= 12000 - 64, `${stream.length}`);
});
