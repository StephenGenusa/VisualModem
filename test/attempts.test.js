import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttempt } from '../src/tune/attempts.js';

const t = { id: 3, txId: 77, cols: 147, rows: 83, blockSize: 26, levels: 2 };
// Corners for a grid whose column estimate is (|tr - tl| / pitch) + 7.
const corners = (cols, pitch) => ({ tl: [100, 100], tr: [100 + (cols - 7) * pitch, 100], bl: [100, 600], br: null });

test('a good read of this test is ok', () => {
  assert.equal(classifyAttempt({ stage: 'ok', header: { txId: 77 } }, { markersFound: true, cols: 147, rows: 83 }, t), 'ok');
});

test('a good read of another transmission is markers, not ok', () => {
  assert.equal(classifyAttempt({ stage: 'ok', header: { txId: 12 } }, { markersFound: true, cols: 128, rows: 72 }, t), 'markers');
});

test("a payload failure on this test's grid is frame", () => {
  assert.equal(classifyAttempt({ stage: 'payload failed', header: { txId: 77 } }, { markersFound: true, cols: 147, rows: 83 }, t), 'frame');
});

test("a timing mismatch whose column estimate is near this test's is frame", () => {
  const read = { markersFound: true, reason: 'timing mismatch', corners: corners(150, 8), pitch: 8 };
  assert.equal(classifyAttempt({ stage: 'timing mismatch' }, read, t), 'frame');
});

test('the stale tag case', () => {
  // The previous test's frame (128 columns) is still on screen under the new test id.
  const read = { markersFound: true, reason: 'timing mismatch', corners: corners(128, 9.6), pitch: 9.6 };
  assert.equal(classifyAttempt({ stage: 'timing mismatch' }, read, t), 'markers');
});

test('no markers is none', () => {
  assert.equal(classifyAttempt({ stage: 'no markers' }, { markersFound: false }, t), 'none');
});
test('estimateColumns reads the grid width from the corners and pitch', async () => {
  const { estimateColumns } = await import('../src/tune/attempts.js');
  assert.equal(estimateColumns({ corners: { tl: [0, 0], tr: [930, 0] }, pitch: 10 }), 100);
  assert.equal(estimateColumns({ corners: { tl: [0, 0] }, pitch: 10 }), null);
  assert.equal(estimateColumns({ corners: { tl: [0, 0], tr: [930, 0] }, pitch: 0 }), null);
});
