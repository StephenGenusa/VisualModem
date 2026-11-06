// The perspective pass's grid size estimate from the quad's homography.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homographySize } from '../src/picture/reader.js';

// A frontal 130 x 70 grid of square 10 px blocks: marker centers at block
// (3.5, 3.5), (126.5, 3.5), (3.5, 66.5) and the small one at (127.5, 67.5).
// The small marker sits one block further out than the parallelogram corner,
// so the estimate must be exact at every marker.
test('a frontal 130 x 70 grid of 10 px blocks gives exactly 123 x 63 blocks between the large markers', () => {
  const at = (bx, by) => [bx * 10, by * 10];
  const option = {
    tl: at(3.5, 3.5), tr: at(126.5, 3.5), bl: at(3.5, 66.5), br: at(127.5, 67.5),
    axes: { tl: [10, 10], tr: [10, 10], bl: [10, 10] },
  };
  const h = homographySize(option, 123, 63);
  assert.deepEqual({ cols: h.cols, rows: h.rows }, { cols: 123, rows: 63 });
  for (const e of h.perMarker.cols) assert.ok(Math.abs(e - 123) < 1e-6, `cols ${h.perMarker.cols}`);
  for (const e of h.perMarker.rows) assert.ok(Math.abs(e - 63) < 1e-6, `rows ${h.perMarker.rows}`);
});

test('the estimate needs each marker\'s row and column lengths and a small marker', () => {
  const option = { tl: [35, 35], tr: [1265, 35], bl: [35, 665], br: [1275, 675] };
  assert.equal(homographySize(option, 123, 63), null);
  assert.equal(homographySize({ ...option, axes: { tl: [10, 10], tr: [10, 10], bl: [10, 10] }, br: null }, 123, 63), null);
});
