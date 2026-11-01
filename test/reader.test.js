import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { frameGrossBytes } from '../src/core/frame.js';
import { buildFrame, frameCapacity } from '../src/core/frame.js';
import { brightnessContrast, rotate90, warpToQuad, lensDistort, bloom, blur } from '../src/testutil/distort.js';
import { readCameraFrame, decodeCameraFrame, measureStripOffsets } from '../src/picture/reader.js';
import { homographyFromPoints } from '../src/picture/homography.js';

const layout = computeLayout(40, 30);
const gross = frameGrossBytes(layout.dataBlockCount, 4);
const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 31) & 0xff);
const frameBytes = buildFrame({ payload, index: 5, count: 6, txId: 99, blockSize: 16, levels: 4, parity: 32 }, gross);
const frame = renderFrame({ frameBytes, index: 5, levels: 4, blockSize: 16, layout });

test('clean render reads back exactly', () => {
  const { read, frame: f } = decodeCameraFrame(frame);
  assert.equal(read.markersFound, true); assert.equal(read.cols, 40); assert.equal(read.rows, 30);
  assert.equal(read.levels, 4); assert.equal(read.parity, 1);
  assert.ok(read.margin > 0.95);
  assert.deepEqual(f.payload, payload); assert.equal(f.header.index, 5);
});
test('calibration absorbs a brightness and contrast change', () => {
  const img = brightnessContrast(frame, -0.1, 0.7);
  const { frame: f } = decodeCameraFrame(img);
  assert.deepEqual(f.payload, payload);
});
test('rotated 90 degrees decodes', () => {
  assert.deepEqual(decodeCameraFrame(rotate90(frame)).frame.payload, payload);
});
test('no markers', () => {
  const r = readCameraFrame({ data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 });
  assert.equal(r.markersFound, false);
});
test('broken top timing strip reports a timing mismatch', () => {
  const img = { data: Uint8ClampedArray.from(frame.data), width: frame.width, height: frame.height };
  const { timingTop } = layout;
  for (let y = timingTop.row * 16; y < (timingTop.row + 1) * 16; y++) {
    img.data.fill(255, (y * img.width + timingTop.colStart * 16) * 4, (y * img.width + (timingTop.colEnd + 1) * 16) * 4);
  }
  const r = readCameraFrame(img);
  assert.equal(r.markersFound, true); assert.equal(r.reason, 'timing mismatch');
});
test('clean render: every sample sits on a level, so margin is near 1', () => {
  assert.ok(decodeCameraFrame(frame).read.margin > 0.99);
});
test('tall image holding a wide grid turned 90 degrees decodes', () => {
  // 60 by 20 grid at 4 px, turned to 80 by 240 and placed in a 96 by 260 image:
  // the grid has more columns than the image's width allows at 3 px per block.
  const wide = computeLayout(60, 20);
  const g = frameGrossBytes(wide.dataBlockCount, 4);
  const p = Uint8Array.from({ length: frameCapacity(g, 32) }, (_, i) => (i * 7) & 0xff);
  const bytes = buildFrame({ payload: p, index: 0, count: 1, txId: 3, blockSize: 4, levels: 4, parity: 32 }, g);
  const turned = rotate90(renderFrame({ frameBytes: bytes, index: 0, levels: 4, blockSize: 4, layout: wide }));
  const img = warpToQuad(turned, [[8, 10], [88, 10], [88, 250], [8, 250]], 96, 260, [255, 255, 255]);
  assert.deepEqual(decodeCameraFrame(img).frame.payload, p);
});

test('measureStripOffsets on a clean render is near zero', () => {
  const H = homographyFromPoints([[0, 0], [40, 0], [40, 30], [0, 30]], [[0, 0], [640, 0], [640, 480], [0, 480]]);
  const cells = [];
  for (let c = 8; c <= 40 - 9; c++) cells.push([c, 6]);
  const points = measureStripOffsets(frame, H, cells, 'x', 5).filter((p) => p.strength >= 20);
  assert.ok(points.length >= 8, `${points.length} strong edges`);
  for (const p of points) assert.ok(Math.abs(p.offset) <= 0.05, `edge ${p.index} offset ${p.offset}`);
});

test('a barrel lens that drifts the strip still decodes', () => {
  // A phone photo of a TV showed the top timing strip's edges
  // drifting up to a quarter block from where the four markers put them, and
  // the reader failed with a timing mismatch. k1 = -0.02 reproduces that.
  const big = computeLayout(166, 93);
  const g = frameGrossBytes(big.dataBlockCount, 2);
  const p = Uint8Array.from({ length: frameCapacity(g, 32) }, (_, i) => (i * 131 + 7) & 0xff);
  const bytes = buildFrame({ payload: p, index: 0, count: 1, txId: 4, blockSize: 9, levels: 2, parity: 32 }, g);
  const screen = renderFrame({ frameBytes: bytes, index: 0, levels: 2, blockSize: 9, layout: big });
  const W = 1920, H = 1080, px = (W - screen.width) / 2, py = (H - screen.height) / 2;
  let img = warpToQuad(screen, [[px, py], [W - px, py], [W - px, H - py], [px, H - py]], W, H, [30, 30, 30]);
  img = blur(bloom(lensDistort(img, -0.02), 2), 1);
  const { read, frame: f } = decodeCameraFrame(img);
  assert.ok(f, `frame did not parse (${read.reason || 'payload failed'})`);
  assert.deepEqual(f.payload, p);
});

test('the timing check tolerates two misread strip cells', () => {
  const img = { data: Uint8ClampedArray.from(frame.data), width: frame.width, height: frame.height };
  const { timingTop } = layout;
  for (const col of [timingTop.colStart + 4, timingTop.colStart + 12]) {
    for (let y = timingTop.row * 16; y < (timingTop.row + 1) * 16; y++) {
      for (let x = col * 16; x < (col + 1) * 16; x++) {
        const o = (y * img.width + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 - img.data[o];
      }
    }
  }
  const { read, frame: f } = decodeCameraFrame(img);
  assert.ok(f, `frame did not parse (${read.reason || 'payload failed'})`);
});
test('gray 4 decodes through a color cast', async () => {
  const { colorCast } = await import('../src/testutil/distort.js');
  const scheme = { kind: 'gray', levels: 4 };
  const g = frameGrossBytes(layout.dataBlockCount, scheme);
  const p = Uint8Array.from({ length: frameCapacity(g, 32) }, (_, i) => (i * 53 + 1) & 0xff);
  const bytes = buildFrame({ payload: p, index: 0, count: 1, txId: 5, blockSize: 16, scheme, parity: 32 }, g);
  const img = colorCast(renderFrame({ frameBytes: bytes, index: 0, scheme, blockSize: 16, layout }), [1.15, 1.0, 0.8]);
  const { read, frame: f } = decodeCameraFrame(img);
  assert.ok(f, `no frame: ${read.reason}`);
  assert.deepEqual(read.scheme, scheme);
  assert.deepEqual(f.payload, p);
});
test('a probe frame reports its probe id', () => {
  const scheme = { kind: 'rgb', levels: [2, 4, 2] };
  const g = frameGrossBytes(layout.dataBlockCount, scheme);
  const bytes = buildFrame({ payload: new Uint8Array(40), index: 0, count: 1, txId: 5, blockSize: 16, scheme, parity: 32, frameType: 2, probeId: 7, probeCount: 36 }, g);
  const { read, frame: f } = decodeCameraFrame(renderFrame({ frameBytes: bytes, index: 0, scheme, blockSize: 16, layout }));
  assert.equal(read.frameType, 2); assert.equal(read.probeId, 7); assert.equal(read.probeCount, 36);
  assert.equal(f.header.probeId, 7);
  assert.equal(read.frameHeader.parity, 32);
  assert.equal(typeof read.scheme, 'object');
});
test('decodeCameraFrame returns a sampler on the found geometry', () => {
  const { sample } = decodeCameraFrame(frame);
  assert.deepEqual(sample(layout.calibration.colStart + 16, layout.calibration.row).map(Math.round), [255, 0, 0]);
  assert.equal(sample(-50, -50), null);
});
test('colorUnmixer turns the phone\'s measured pure colors back into screen values', async () => {
  const { colorUnmixer } = await import('../src/picture/reader.js');
  const black = [35, 29, 27];
  const pure = [[243, 0, 0], [48, 227, 0], [0, 10, 252]];
  const unmix = colorUnmixer(black, pure);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1);
  assert.ok(near(unmix([48, 227, 0]), [0, 255, 0]), JSON.stringify(unmix([48, 227, 0])));
  assert.ok(near(unmix(black), [0, 0, 0]));
  assert.equal(colorUnmixer(black, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]), null);
  assert.equal(colorUnmixer(black, [null, [48, 227, 0], [0, 10, 252]]), null);
});

test('the version 4 layout cache holds at most 4 sizes', async () => {
  const { layoutV4For, layoutCacheSize } = await import('../src/picture/reader.js');
  for (const [c, r] of [[33, 20], [40, 24], [48, 28], [56, 32], [64, 36], [72, 40]]) layoutV4For(c, r);
  assert.equal(layoutCacheSize(), 4);
  assert.equal(layoutV4For(72, 40).cols, 72);
});
