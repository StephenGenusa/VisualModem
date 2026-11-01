import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { buildFrame, frameCapacity, frameGrossBytes, frameToBlocks, FRAME_TYPES } from '../src/core/frame.js';
import { tiltQuad, warpToQuad, blur, brightnessContrast, noise, lensDistort } from '../src/testutil/distort.js';
import { decodeCameraFrame } from '../src/picture/reader.js';
import { toGray, toGrayHalf } from '../src/picture/finder.js';
import { probePayload } from '../src/optimize/prbs.js';

test('gray values match the rounded luminance for every color', () => {
  const n = 256 * 256 * 256;
  const data = new Uint8ClampedArray(n * 4);
  for (let c = 0; c < n; c++) { data[c * 4] = c >> 16; data[c * 4 + 1] = (c >> 8) & 255; data[c * 4 + 2] = c & 255; }
  const gray = toGray({ data, width: n, height: 1 });
  let bad = 0;
  for (let c = 0; c < n; c++) {
    if (gray[c] !== Math.round(0.299 * (c >> 16) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255))) bad++;
  }
  assert.equal(bad, 0);
});

test('the half size gray image averages each 2 by 2 block, dropping an odd last row and column', () => {
  // 5 x 3 gray pixels (r = g = b), so luminance equals the value.
  const values = [
    0, 100, 200, 200, 7,
    100, 0, 40, 40, 7,
    9, 9, 9, 9, 9,
  ];
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const half = toGrayHalf({ data, width: 5, height: 3 });
  assert.equal(half.width, 2);
  assert.equal(half.height, 1);
  assert.deepEqual([...half.gray], [50, 120]);
});

const SCHEME = { kind: 'gray', levels: 2 };

// A probe frame of a cols x rows grid, filling `scale` of a W x H camera image.
function shot(cols, rows, W, H, scale, blockPx) {
  const layout = computeLayout(cols, rows);
  const gross = frameGrossBytes(layout.dataBlockCount, SCHEME);
  const frameBytes = buildFrame({
    payload: probePayload(9, 0, frameCapacity(gross, 32)), index: 0, count: 4, txId: 9, blockSize: 19,
    scheme: SCHEME, parity: 32, frameType: FRAME_TYPES.probe, probeId: 1, probeCount: 5,
  }, gross);
  const blocks = frameToBlocks(frameBytes, SCHEME, layout.dataBlockCount);
  const screen = renderFrame({ frameBytes, index: 0, scheme: SCHEME, blockSize: blockPx, layout, blocks });
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, scale), W, H);
  img = blur(img, 1);
  img = brightnessContrast(img, 0.2, 0.9);
  return noise(img, 3, 5);
}

test('a 4K camera image finds its markers at half size and still decodes', () => {
  const { read, frame } = decodeCameraFrame(shot(202, 113, 3840, 2160, 0.88, 17));
  assert.ok(frame, read.reason);
  assert.equal(read.finderScale, 2);
});

test('a large image whose markers are too fine at half size falls back to full size', () => {
  // About 5 image pixels a block: under the finder's 3 pixel minimum at half size.
  const { read, frame } = decodeCameraFrame(shot(120, 67, 3840, 2160, 0.16, 6));
  assert.ok(frame, read.reason);
  assert.equal(read.finderScale, 1);
});

test('a 1080p camera image is searched at full size', () => {
  const { read, frame } = decodeCameraFrame(shot(137, 77, 1920, 1080, 0.88, 13));
  assert.ok(frame, read.reason);
  assert.equal(read.finderScale, 1);
});

// A slight lens bend: the timing strips no longer match exactly at any size,
// so only the corrected pass reads the grid. The phone's camera does this at
// small blocks. The exact search still tries about a thousand sizes per marker
// candidate first; it sampled both whole strips of each (about 750,000 cells
// here), and now rejects most on a short middle stretch.
function bentShot(cols, rows, W, H, blockPx, k1) {
  const layout = computeLayout(cols, rows);
  const gross = frameGrossBytes(layout.dataBlockCount, SCHEME);
  const frameBytes = buildFrame({
    payload: probePayload(9, 0, frameCapacity(gross, 32)), index: 0, count: 4, txId: 9, blockSize: 19,
    scheme: SCHEME, parity: 32, frameType: FRAME_TYPES.probe, probeId: 1, probeCount: 5,
  }, gross);
  const blocks = frameToBlocks(frameBytes, SCHEME, layout.dataBlockCount);
  const screen = renderFrame({ frameBytes, index: 0, scheme: SCHEME, blockSize: blockPx, layout, blocks });
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, 0.88), W, H);
  img = lensDistort(img, k1);
  img = blur(img, 1);
  img = brightnessContrast(img, 0.2, 0.9);
  return noise(img, 3, 5);
}

test('a slightly bent grid reaches the corrected pass without sampling every strip of every exact size', () => {
  const { read, frame } = decodeCameraFrame(bentShot(202, 113, 1920, 1080, 9, 0.02));
  assert.ok(frame, read.reason);
  assert.notEqual(read.correction.lens, 0); // the corrected pass read it
  assert.ok(read.exactCells <= 100_000, `${read.exactCells} strip cells sampled by the exact search`);
});
