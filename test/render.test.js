import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame, calibrationColors } from '../src/picture/render.js';

const layout = computeLayout(40, 30);
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

test('dimensions and finder pattern', () => {
  const img = renderFrame({ frameBytes: new Uint8Array(100), index: 0, levels: 4, blockSize: 4, layout });
  assert.equal(img.width, 160); assert.equal(img.height, 120);
  assert.deepEqual(px(img, 2, 2), [0, 0, 0]);       // outer ring
  assert.deepEqual(px(img, 6, 6), [255, 255, 255]); // white ring
  assert.deepEqual(px(img, 14, 14), [0, 0, 0]);     // center
  assert.deepEqual(px(img, 30, 30), [255, 255, 255]); // quiet corner
});
test('parity strip follows frame index', () => {
  const even = renderFrame({ frameBytes: new Uint8Array(100), index: 2, levels: 4, blockSize: 4, layout });
  const odd = renderFrame({ frameBytes: new Uint8Array(100), index: 3, levels: 4, blockSize: 4, layout });
  assert.deepEqual(px(even, 158, 40), [0, 0, 0]);
  assert.deepEqual(px(odd, 158, 40), [255, 255, 255]);
});
test('calibration strip for 4 levels', () => {
  const c = calibrationColors(4);
  assert.deepEqual(Array.from(c.subarray(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(c.subarray(4 * 3, 4 * 3 + 3)), [85, 85, 85]);
  assert.deepEqual(Array.from(c.subarray(15 * 3, 15 * 3 + 3)), [255, 255, 255]);
  assert.deepEqual(Array.from(c.subarray(16 * 3, 19 * 3)), [255, 0, 0, 0, 255, 0, 0, 0, 255]);
  assert.equal(new Set(calibrationColors(256).subarray(0, 48).filter((v, i) => i % 3 === 0)).size, 16);
});
test('first data cell carries the first block', () => {
  const img = renderFrame({ frameBytes: new Uint8Array([0b11001000]), index: 0, levels: 4, blockSize: 4, layout, version: 2 });
  assert.deepEqual(px(img, 8 * 4 + 2, 2), [255, 0, 170]);
});
test('timing strip alternates', () => {
  const img = renderFrame({ frameBytes: new Uint8Array(100), index: 0, levels: 4, blockSize: 4, layout });
  assert.deepEqual(px(img, 8 * 4 + 2, 6 * 4 + 2), [0, 0, 0]);
  assert.deepEqual(px(img, 9 * 4 + 2, 6 * 4 + 2), [255, 255, 255]);
});
test('white level dims every light value and leaves black at 0', () => {
  const frameBytes = Uint8Array.from({ length: 300 }, (_, i) => i * 37);
  const full = renderFrame({ frameBytes, index: 1, levels: 4, blockSize: 4, layout });
  const dim = renderFrame({ frameBytes, index: 1, levels: 4, blockSize: 4, layout, white: 160 });
  assert.deepEqual(px(dim, 2, 2), [0, 0, 0]);         // finder outer ring stays black
  assert.deepEqual(px(dim, 6, 6), [160, 160, 160]);   // finder white ring
  for (let i = 0; i < full.data.length; i++) {
    if (i % 4 === 3) continue;
    assert.equal(dim.data[i], Math.round(full.data[i] * 160 / 255));
  }
});
test('white level 255 is the same as no white level', () => {
  const frameBytes = Uint8Array.from({ length: 300 }, (_, i) => i * 37);
  const a = renderFrame({ frameBytes, index: 0, levels: 2, blockSize: 4, layout });
  const b = renderFrame({ frameBytes, index: 0, levels: 2, blockSize: 4, layout, white: 255 });
  assert.deepEqual(a.data, b.data);
});
test('the header cells use the cube while the payload uses gray 4', async () => {
  const { HEADER_CELLS, frameGrossBytes } = await import('../src/core/frame.js');
  const scheme = { kind: 'gray', levels: 4 };
  const frameBytes = Uint8Array.from({ length: frameGrossBytes(layout.dataBlockCount, scheme) }, (_, i) => (i * 37 + 11) & 0xff);
  const img = renderFrame({ frameBytes, index: 0, scheme, blockSize: 4, layout });
  const cellColor = (i) => {
    const cell = layout.dataCells[i];
    return px(img, (cell % layout.cols) * 4 + 2, Math.floor(cell / layout.cols) * 4 + 2);
  };
  for (let i = 0; i < HEADER_CELLS; i++) assert.ok(cellColor(i).every((v) => v === 0 || v === 255), `header cell ${i}`);
  const gray = new Set();
  for (let i = HEADER_CELLS; i < layout.dataBlockCount; i++) {
    const [r, g, b] = cellColor(i);
    assert.ok(r === g && g === b, `payload cell ${i} is not gray`);
    gray.add(r);
  }
  assert.deepEqual([...gray].sort((a, b) => a - b), [0, 85, 170, 255]);
});
test('the version 3 calibration strip steps each channel by its own levels', () => {
  const c = calibrationColors({ kind: 'rgb', levels: [2, 4, 2] });
  const cell = (i) => Array.from(c.subarray(i * 3, i * 3 + 3));
  assert.deepEqual(cell(0), [0, 0, 0]);
  assert.deepEqual(cell(4), [0, 85, 0]);
  assert.deepEqual(cell(8), [255, 170, 255]);
  assert.deepEqual(cell(15), [255, 255, 255]);
  const g = calibrationColors({ kind: 'gray', levels: 4 });
  assert.deepEqual(Array.from(g.subarray(4 * 3, 5 * 3)), [85, 85, 85]);
  assert.deepEqual(calibrationColors({ kind: 'rgb', levels: [4, 4, 4] }), calibrationColors(4));
  assert.deepEqual(Array.from(c.subarray(16 * 3, 19 * 3)), [255, 0, 0, 0, 255, 0, 0, 0, 255]);
});
