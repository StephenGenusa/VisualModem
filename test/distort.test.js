import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { warpToQuad, tiltQuad, noise, rotate90, viewQuad, farSideFalloff } from '../src/testutil/distort.js';
import { readImage, writePng } from '../src/testutil/image.js';

const flat = (w, h, rgb) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([...rgb, 255], i * 4); return { data: d, width: w, height: h }; };
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

test('warp places the source inside the quad', () => {
  const src = flat(100, 50, [200, 10, 10]);
  const out = warpToQuad(src, [[20, 20], [120, 30], [110, 80], [25, 75]], 200, 100);
  assert.deepEqual(px(out, 70, 50), [200, 10, 10]);
  assert.deepEqual(px(out, 2, 2), [40, 40, 40]);
});
test('tiltQuad at zero degrees is an axis aligned rectangle', () => {
  const q = tiltQuad(160, 90, 400, 300, 0, 0.5);
  assert.ok(Math.abs(q[0][1] - q[1][1]) < 1e-6 && Math.abs(q[1][0] - q[2][0]) < 1e-6);
  assert.ok(Math.abs((q[1][0] - q[0][0]) - 200) < 1e-6);
});
test('noise is deterministic and bounded', () => {
  const a = noise(flat(20, 20, [128, 128, 128]), 5, 42), b = noise(flat(20, 20, [128, 128, 128]), 5, 42);
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, flat(20, 20, [128, 128, 128]).data);
});
test('rotate90 moves the top left pixel to the top right', () => {
  const img = flat(3, 2, [0, 0, 0]); img.data.set([255, 0, 0, 255], 0);
  const r = rotate90(img);
  assert.equal(r.width, 2); assert.equal(r.height, 3);
  assert.deepEqual(px(r, 1, 0), [255, 0, 0]);
});
test('png round trip', () => {
  const p = join(tmpdir(), 'vm-test.png');
  writePng(p, flat(4, 4, [1, 2, 3]));
  assert.deepEqual(px(readImage(p), 3, 3), [1, 2, 3]);
});

test('viewQuad at zero yaw and pitch is an axis aligned rectangle centered in the output', () => {
  const q = viewQuad(1000, 500, 1920, 1080, { yawDeg: 0, distance: 0.9, scale: 0.5 });
  assert.ok(Math.abs(q[0][1] - q[1][1]) < 1e-6 && Math.abs(q[2][1] - q[3][1]) < 1e-6);
  assert.ok(Math.abs(q[0][0] - q[3][0]) < 1e-6 && Math.abs(q[1][0] - q[2][0]) < 1e-6);
  assert.ok(Math.abs((q[0][0] + q[1][0]) / 2 - 960) < 1e-6 && Math.abs((q[0][1] + q[3][1]) / 2 - 540) < 1e-6);
  assert.ok(Math.abs(q[1][0] - q[0][0] - 960) < 1e-6);
});

test('viewQuad at 30 degrees and distance 0.9 shrinks the far edge to 0.5-0.7 of the near edge', () => {
  const q = viewQuad(1000, 500, 1920, 1080, { yawDeg: 30, distance: 0.9, scale: 0.5 });
  const ratio = (q[1][1] < q[2][1] ? q[2][1] - q[1][1] : 0) / (q[3][1] - q[0][1]);
  assert.ok(ratio > 0.5 && ratio < 0.7, `ratio ${ratio}`);
});

test('farSideFalloff with no dimming or blur leaves the image unchanged, and dims the far side', () => {
  const img = flat(40, 20, [100, 100, 100]);
  const q = viewQuad(40, 20, 40, 20, { yawDeg: 30, distance: 0.9, scale: 0.5 });
  assert.deepEqual(farSideFalloff(img, q, { dim: 0, blurPx: 0 }).data, img.data);
  const out = farSideFalloff(img, q, { dim: 0.4, blurPx: 0 });
  assert.ok(px(out, 38, 10)[0] < 70 && px(out, 1, 10)[0] > 95);
});
