import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../tools/session.js';

const t1 = { id: 1, txId: 5, cols: 85, rows: 48, blockSize: 45, levels: 2 };

test('starts empty at 1080p', () => {
  assert.deepEqual(createSession().get(), { test: null, camera: '1080p', cameraSeq: 0 });
});

test('set merges and returns the state', () => {
  const s = createSession();
  assert.deepEqual(s.set({ camera: '4k' }), { test: null, camera: '4k', cameraSeq: 1 });
  assert.deepEqual(s.set({ test: t1 }), { test: t1, camera: '4k', cameraSeq: 1 });
  assert.deepEqual(s.set({ test: null }), { test: null, camera: '4k', cameraSeq: 1 });
});

test('an unknown camera value is ignored', () => {
  const s = createSession();
  assert.equal(s.set({ camera: '8k' }).camera, '1080p');
  assert.equal(s.get().cameraSeq, 0);
});

test('a test without an id is ignored', () => {
  const s = createSession();
  s.set({ test: t1 });
  assert.deepEqual(s.set({ test: { txId: 9 } }).test, t1);
});

test('every camera request counts, even one for the size already set', () => {
  const s = createSession();
  s.set({ camera: '1080p' });
  assert.equal(s.set({ camera: '1080p' }).cameraSeq, 2);
});
