import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_OPTIONS, bitsPerChannel, levelValue, midpointThresholds, decideLevel,
  blocksFromBytes, bytesFromBlocks, grossBytes,
} from '../src/core/symbols.js';

test('level values hit 0 and 255 at the ends', () => {
  for (const L of LEVEL_OPTIONS) {
    assert.equal(levelValue(L, 0), 0); assert.equal(levelValue(L, L - 1), 255);
  }
  assert.equal(levelValue(4, 1), 85); assert.equal(levelValue(16, 1), 17);
});
test('midpoint thresholds for 4 levels', () => {
  assert.deepEqual(midpointThresholds(4), [42.5, 127.5, 212.5]);
  assert.equal(decideLevel(40, midpointThresholds(4)), 0);
  assert.equal(decideLevel(130, midpointThresholds(4)), 2);
});
test('round trip at every level count', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 7) & 0xff);
  for (const L of LEVEL_OPTIONS) {
    const blockCount = Math.ceil(bytes.length * 8 / (3 * bitsPerChannel(L)));
    const rgb = blocksFromBytes(bytes, L, blockCount);
    assert.equal(rgb.length, blockCount * 3);
    assert.deepEqual(bytesFromBlocks(rgb, L).subarray(0, bytes.length), bytes);
  }
});
test('first block of 4 level encoding of 0b110010_00', () => {
  const rgb = blocksFromBytes(new Uint8Array([0b11001000]), 4, 1);
  assert.deepEqual(Array.from(rgb), [255, 0, 170]);
});
test('grossBytes', () => { assert.equal(grossBytes(1000, 4), 750); assert.equal(grossBytes(1000, 256), 3000); });
