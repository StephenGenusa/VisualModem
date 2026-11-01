import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { warpToQuad, tiltQuad, noise, rotate90 } from '../src/testutil/distort.js';
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
