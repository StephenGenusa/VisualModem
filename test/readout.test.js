import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReadout } from '../web/readout.js';

test('readout for a 1080p screen at defaults', () => {
  const r = computeReadout({ widthPx: 1920, heightPx: 1080, blockSize: 16, levels: 4, parity: 32, fps: 2 }, 10_000);
  assert.equal(r.cols, 120); assert.equal(r.rows, 67); assert.equal(r.cap, 54);
  assert.equal(r.tooSmall, false); assert.equal(r.tooLarge, false);
  assert.equal(r.frameCount, Math.ceil(10_000 / r.bytesPerFrame));
  assert.equal(r.loopSeconds, r.frameCount / 2);
});
test('block size over the cap is flagged', () => {
  assert.equal(computeReadout({ widthPx: 800, heightPx: 600, blockSize: 40, levels: 4, parity: 0, fps: 1 }, 10).tooSmall, true);
});
test('too large is flagged', () => {
  assert.equal(computeReadout({ widthPx: 800, heightPx: 600, blockSize: 20, levels: 2, parity: 128, fps: 1 }, 50_000_000).tooLarge, true);
});
