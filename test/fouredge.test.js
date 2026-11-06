// Four-edge timing: version 4 frames carry timing strips on all four sides,
// so the reader can blend the offset fits across the grid and accept a grid
// with one strip of each pair covered. Every image here uses the lifted chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, computeLayoutV4 } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { schemeFromLevels } from '../src/core/scheme.js';
import { frameShapeV4, buildFrameV4 } from '../src/core/framev4.js';
import { buildFrame, frameCapacity, frameGrossBytes } from '../src/core/frame.js';
import { tiltQuad, warpToQuad, lensDistort, blur, brightnessContrast, noise } from '../src/testutil/distort.js';
import { decodeCameraFrame } from '../src/picture/reader.js';

const SCHEME = schemeFromLevels(2);

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

function screenV4(cols, rows, blockPx, index = 0, txId = 0x1234abcd) {
  const layout = computeLayoutV4(cols, rows);
  const shape = frameShapeV4(layout, SCHEME, 32);
  const next = seeded(txId);
  const packets = Array.from({ length: shape.packets }, (_, i) => ({
    symbolId: 5 + i,
    data: Uint8Array.from({ length: shape.packetBytes }, next),
  }));
  const frameBytes = buildFrameV4({
    blockSize: blockPx, scheme: SCHEME, parity: 32, txId, sourceCount: 100, streamLength: 20000, packets,
  }, shape);
  return renderFrame({ frameBytes, index, scheme: SCHEME, blockSize: blockPx, layout, version: 4 });
}

function screenV3(cols, rows, blockPx) {
  const layout = computeLayout(cols, rows);
  const gross = frameGrossBytes(layout.dataBlockCount, SCHEME);
  const next = seeded(77);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, next);
  const frameBytes = buildFrame({ payload, index: 0, count: 4, txId: 9, blockSize: blockPx, scheme: SCHEME, parity: 32 }, gross);
  return renderFrame({ frameBytes, index: 0, scheme: SCHEME, blockSize: blockPx, layout });
}

// Paints whole cells of a screen image flat mid gray, as a covered strip.
function paintCells(screen, cells, blockPx) {
  for (const [col, row] of cells) {
    for (let y = row * blockPx; y < (row + 1) * blockPx; y++) {
      for (let x = col * blockPx; x < (col + 1) * blockPx; x++) {
        const p = (y * screen.width + x) * 4;
        screen.data[p] = 128; screen.data[p + 1] = 128; screen.data[p + 2] = 128;
      }
    }
  }
  return screen;
}

const topStrip = (cols) => Array.from({ length: cols - 16 }, (_, i) => [8 + i, 6]);
const leftStrip = (rows) => Array.from({ length: rows - 16 }, (_, i) => [6, 8 + i]);

// The 1080p scale camera chain of test/camera-v4.test.js.
const COLS = 137, ROWS = 77, BLOCK_PX = 13, W = 1920, H = 1080;
const camera1080 = (screen) => noise(brightnessContrast(blur(
  warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, 0.88), W, H), 1), 0.2, 0.9), 3, 5);

test('a bowed v4 grid reads on four edges', () => {
  const screen = screenV4(213, 120, 16);
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, 3840, 2160, 5, 0.9), 3840, 2160);
  img = lensDistort(img, -0.03);
  img = noise(brightnessContrast(blur(img, 1), 0.2, 0.9), 3, 5);
  const { read, frame } = decodeCameraFrame(img);
  assert.ok(frame, read.reason);
  assert.match(read.edges, /bottom/);
  assert.match(read.edges, /right/);
});

test('a v4 frame reads with its top strip covered', () => {
  const screen = paintCells(screenV4(COLS, ROWS, BLOCK_PX), topStrip(COLS), BLOCK_PX);
  const { read, frame } = decodeCameraFrame(camera1080(screen));
  assert.ok(frame, read.reason);
  assert.ok(read.edges.startsWith('bottom+left'), read.edges);
});

test('a v4 frame reads with its left strip covered', () => {
  const screen = paintCells(screenV4(COLS, ROWS, BLOCK_PX), leftStrip(ROWS), BLOCK_PX);
  const { read, frame } = decodeCameraFrame(camera1080(screen));
  assert.ok(frame, read.reason);
  assert.ok(read.edges.startsWith('top+right'), read.edges);
});

// The corrected pass on the other pairs: the lens bend of
// test/fastfinder.test.js, so no size matches exactly, with the top strip covered.
test('a bent v4 frame with its top strip covered reads on the corrected pass', () => {
  const screen = paintCells(screenV4(202, 113, 9), topStrip(202), 9);
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, 0.88), W, H);
  img = lensDistort(img, 0.02);
  img = noise(brightnessContrast(blur(img, 1), 0.2, 0.9), 3, 5);
  const { read, frame } = decodeCameraFrame(img);
  assert.ok(frame, read.reason);
  assert.notEqual(read.correction.lens, 0);
  assert.ok(read.edges.startsWith('bottom+left'), read.edges);
  assert.ok(frame.packets.every(Boolean), 'every packet');
});

test('the right strip reads at either phase', () => {
  for (const index of [0, 1]) {
    const screen = paintCells(screenV4(COLS, ROWS, BLOCK_PX, index), leftStrip(ROWS), BLOCK_PX);
    const { read, frame } = decodeCameraFrame(camera1080(screen));
    assert.ok(frame, `index ${index}: ${read.reason}`);
    assert.ok(read.edges.startsWith('top+right'), `index ${index}: ${read.edges}`);
  }
});

const blockedV3 = () => camera1080(paintCells(screenV3(COLS, ROWS, BLOCK_PX), topStrip(COLS), BLOCK_PX));

test('a v3 frame with a blocked top strip is not misread', () => {
  const { read, frame } = decodeCameraFrame(blockedV3());
  assert.equal(frame, null);
  assert.equal(read.reason, 'timing mismatch');
});

// read.exactCells for this image before four-edge timing (measured before it landed).
const EXACT_CELLS_BEFORE = 44672;

test('the fallback costs little when nothing matches', () => {
  const { read } = decodeCameraFrame(blockedV3());
  assert.ok(read.exactCells <= 2 * EXACT_CELLS_BEFORE, `${read.exactCells} strip cells against ${EXACT_CELLS_BEFORE} before`);
});

// A version 3 frame whose cells under the version 4 bottom and right strips
// alternate, as data cells could: painted on the screen after rendering, so
// the payload's error correction absorbs the changed cells. (Version 3 draws
// its right column solid; painting it too is the harder case.)
const GRAY = { kind: 'gray', levels: 2 };
function alternatingV3(blockTop) {
  const layout = computeLayout(COLS, ROWS);
  const gross = frameGrossBytes(layout.dataBlockCount, GRAY);
  const next = seeded(78);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, next);
  const frameBytes = buildFrame({ payload, index: 0, count: 4, txId: 9, blockSize: BLOCK_PX, scheme: GRAY, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, scheme: GRAY, blockSize: BLOCK_PX, layout });
  const paint = (col, row, v) => {
    for (let y = row * BLOCK_PX; y < (row + 1) * BLOCK_PX; y++) {
      for (let x = col * BLOCK_PX; x < (col + 1) * BLOCK_PX; x++) screen.data.fill(v, (y * screen.width + x) * 4, (y * screen.width + x) * 4 + 3);
    }
  };
  for (let c = 27; c <= COLS - 7; c++) paint(c, ROWS - 1, (c - 27) % 2 ? 255 : 0);
  for (let r = 8; r <= ROWS - 7; r++) paint(COLS - 1, r, (r - 8) % 2 ? 255 : 0);
  if (blockTop) paintCells(screen, topStrip(COLS), BLOCK_PX);
  return { payload, img: camera1080(screen) };
}

test('a v3 frame with alternating bottom and right cells reads on top and left only', () => {
  const { payload, img } = alternatingV3(false);
  const { read, frame } = decodeCameraFrame(img);
  assert.ok(frame, read.reason);
  assert.equal(read.version, 3);
  assert.equal(read.edges, 'top+left');
  assert.deepEqual(frame.payload, payload);
});

test('the same v3 frame with its top strip blocked returns no frame', () => {
  const { read, frame } = decodeCameraFrame(alternatingV3(true).img);
  assert.equal(frame, null);
  assert.equal(read.reason, 'timing mismatch');
});
