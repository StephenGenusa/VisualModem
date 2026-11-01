import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probePayload } from '../src/optimize/prbs.js';

test('probe payload is fixed by txId and index', () => {
  assert.deepEqual([...probePayload(1, 0, 8)], [80, 214, 192, 176, 106, 85, 151, 8]);
  assert.deepEqual([...probePayload(1, 1, 8)], [137, 163, 124, 45, 102, 60, 254, 145]);
  assert.deepEqual([...probePayload(0xDEADBEEF, 3, 8)], [145, 10, 83, 209, 10, 10, 154, 168]);
  assert.equal(probePayload(5, 2, 3227).length, 3227);
});
