import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackBuffer } from '../tools/feedback.js';

const entry = (n) => ({ tests: { 1: { attempts: 8, ok: n, frame: 0, markers: 0 } } });

test('sequence numbers increase and since returns only newer entries', () => {
  const buffer = createFeedbackBuffer();
  assert.equal(buffer.add(entry(1), 1000), 1);
  assert.equal(buffer.add(entry(2), 2000), 2);
  assert.equal(buffer.add(entry(3), 3000), 3);
  const newer = buffer.since(1);
  assert.deepEqual(newer.entries.map((e) => e.seq), [2, 3]);
  assert.equal(newer.entries[0].atMs, 2000);
  assert.equal(newer.entries[0].tests[1].ok, 2);
  assert.deepEqual(buffer.since(3), { seq: 3, entries: [] });
});

test('the buffer keeps the newest entries only', () => {
  const buffer = createFeedbackBuffer(5);
  for (let i = 1; i <= 8; i++) buffer.add(entry(i), i);
  assert.deepEqual(buffer.since(0).entries.map((e) => e.seq), [4, 5, 6, 7, 8]);
});

test('entries keep tests, health and collector', () => {
  const buffer = createFeedbackBuffer();
  const entry = {
    tests: { 3: { attempts: 8, ok: 2, frame: 5, markers: 1 } },
    health: { visible: true, camera: 'running', noMarkersStreak: 0, video: { width: 1920, height: 1080, resolution: '1080p' } },
    collector: { txId: 77, count: 1, have: 1, complete: true },
    attemptMs: [120, 130],
  };
  buffer.add(entry, 1000);
  const [got] = buffer.since(0).entries;
  assert.deepEqual(got.tests, entry.tests);
  assert.deepEqual(got.health, entry.health);
  assert.deepEqual(got.collector, entry.collector);
  assert.deepEqual(got.attemptMs, entry.attemptMs);
});
