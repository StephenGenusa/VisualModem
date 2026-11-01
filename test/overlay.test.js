import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayPoints } from '../web/receiver.js';

test('overlay points skip a missing bottom right marker', () => {
  const points = overlayPoints({ tl: [1, 2], tr: [10, 2], bl: [1, 9], br: null });
  assert.deepEqual(points, [[1, 2], [10, 2], [1, 9]]);
});
test('overlay points keep all four corners in draw order', () => {
  const points = overlayPoints({ tl: [1, 2], tr: [10, 2], bl: [1, 9], br: [10, 9] });
  assert.deepEqual(points, [[1, 2], [10, 2], [10, 9], [1, 9]]);
});
test('overlay points of no corners is empty', () => {
  assert.deepEqual(overlayPoints(null), []);
});
