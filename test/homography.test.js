import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homographyFromPoints, affineFromPoints, applyHomography, invertHomography } from '../src/picture/homography.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
test('identity from a unit square', () => {
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = homographyFromPoints(sq, sq);
  const [x, y] = applyHomography(H, 0.3, 0.7); near(x, 0.3); near(y, 0.7);
});
test('maps a square to a trapezoid and back', () => {
  const src = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const dst = [[10, 20], [90, 15], [120, 110], [-5, 95]];
  const H = homographyFromPoints(src, dst);
  for (let i = 0; i < 4; i++) { const p = applyHomography(H, ...src[i]); near(p[0], dst[i][0]); near(p[1], dst[i][1]); }
  const inv = invertHomography(H);
  const back = applyHomography(inv, ...dst[2]); near(back[0], 100); near(back[1], 100);
});
test('affine from three points', () => {
  const H = affineFromPoints([[0, 0], [1, 0], [0, 1]], [[5, 5], [7, 5], [5, 8]]);
  const p = applyHomography(H, 1, 1); near(p[0], 7); near(p[1], 8);
  near(H[6], 0); near(H[7], 0); near(H[8], 1);
});
