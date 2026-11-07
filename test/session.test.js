import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../tools/session.js';
import { resetRequest } from '../src/tune/camerachoice.js';

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

test('the Refine word goes to the phone, and leaves the state when cleared', () => {
  const s = createSession();
  const word = { seq: 1, active: true, word: 'Refine 2:13 left', kind: 'work' };
  assert.deepEqual(s.set({ refine: word }).refine, word);
  assert.equal(s.set({ camera: '4k' }).refine.seq, 1, 'kept across other changes');
  assert.equal(s.set({ refine: { word: 7 } }).refine.seq, 1, 'a bad value is ignored');
  assert.ok(!('refine' in s.set({ refine: null })));
  assert.deepEqual(createSession().get(), { test: null, camera: '1080p', cameraSeq: 0 });
});

test('a reset request carries a new seq each time and the phone follows each once', () => {
  const s = createSession();
  assert.ok(!('reset' in s.get()), 'no reset until one is asked for');
  // A phone that loads now starts empty anyway: it only notes where the count is.
  let seen = null;
  let resets = 0;
  const reply = () => {
    const r = resetRequest(s.get(), seen);
    seen = r.seq;
    if (r.reset) resets++;
  };
  reply();
  assert.equal(resets, 0);
  assert.deepEqual(s.set({ reset: true }).reset, { seq: 1 });
  reply();
  reply();
  assert.equal(resets, 1, 'followed once, though every reply carries it');
  assert.deepEqual(s.set({ camera: '4k' }).reset, { seq: 1 }, 'kept across other changes');
  assert.deepEqual(s.set({ reset: true }).reset, { seq: 2 }, 'a new request, a new seq');
  assert.deepEqual(s.set({ reset: 'yes' }).reset, { seq: 2 }, 'only true asks');
  reply();
  reply();
  assert.equal(resets, 2);
});
