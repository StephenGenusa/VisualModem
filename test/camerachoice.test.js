import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraRequest, CAMERA_CHOICES } from '../src/tune/camerachoice.js';

test('the phone offers 1080p and 4K', () => {
  assert.deepEqual(CAMERA_CHOICES.map((c) => c.id), ['1080p', '4k']);
});

test('a server that never asked for a camera leaves the phone\'s choice alone', () => {
  assert.deepEqual(cameraRequest({ camera: '1080p', cameraSeq: 0 }, null), { camera: null, seq: 0 });
});

test('a new request from the test runner is followed once', () => {
  const first = cameraRequest({ camera: '4k', cameraSeq: 3 }, 2);
  assert.deepEqual(first, { camera: '4k', seq: 3 });
  // The same request on the next reply does not undo a choice made since.
  assert.deepEqual(cameraRequest({ camera: '4k', cameraSeq: 3 }, first.seq), { camera: null, seq: 3 });
});

test('a request for the size already chosen still counts as a request', () => {
  assert.deepEqual(cameraRequest({ camera: '1080p', cameraSeq: 4 }, 3), { camera: '1080p', seq: 4 });
});

test('the first reply after loading follows a request the runner already made', () => {
  assert.deepEqual(cameraRequest({ camera: '4k', cameraSeq: 7 }, null), { camera: '4k', seq: 7 });
});

test('no state, an old server or an unknown size asks for nothing', () => {
  assert.deepEqual(cameraRequest(null, 2), { camera: null, seq: 2 });
  assert.deepEqual(cameraRequest({ camera: '4k' }, null), { camera: null, seq: null });
  assert.deepEqual(cameraRequest({ camera: '8k', cameraSeq: 5 }, 4), { camera: null, seq: 5 });
});
