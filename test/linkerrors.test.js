import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { buildFrame, frameCapacity, frameGrossBytes, frameToBlocks, FRAME_TYPES, HEADER_CELLS, HEADER_CODEWORD } from '../src/core/frame.js';
import { tiltQuad, warpToQuad, blur, brightnessContrast, noise } from '../src/testutil/distort.js';
import { decodeCameraFrame } from '../src/picture/reader.js';
import { probePayload, random32 } from '../src/optimize/prbs.js';
import { truthFrame, measureErrors, codewordSuccess, ERASURE_DISTANCE } from '../src/optimize/linkerrors.js';

const COLS = 120, ROWS = 67, BLOCK = 16;
const SCHEME = { kind: 'rgb', levels: [4, 4, 4] };
const PARITY = 32;

// A probe frame of the full grid, as web/probe.js builds it.
function probe(scheme = SCHEME) {
  const layout = computeLayout(COLS, ROWS);
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  const txId = 0x1234ABCD, index = 3;
  const frameBytes = buildFrame({
    payload: probePayload(txId, index, frameCapacity(gross, PARITY)), index, count: 8, txId, blockSize: BLOCK,
    scheme, parity: PARITY, frameType: FRAME_TYPES.probe, probeId: 2, probeCount: 5, probeFps: 7.5,
  }, gross);
  return { layout, gross, frameBytes, blocks: frameToBlocks(frameBytes, scheme, layout.dataBlockCount) };
}

function shoot({ layout, frameBytes, blocks }, scheme = SCHEME) {
  const screen = renderFrame({ frameBytes, index: 3, scheme, blockSize: BLOCK, layout, blocks });
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, 1920, 1080, 5, 0.85), 1920, 1080);
  img = blur(img, 1);
  img = brightnessContrast(img, 0.2, 0.9);
  img = noise(img, 3, 5);
  const { read } = decodeCameraFrame(img);
  assert.equal(read.markersFound, true, read.reason);
  assert.ok(read.frameHeader, 'header did not read');
  return read;
}

// Data index of each grid cell, -1 for reserved cells.
function dataIndexOf(layout) {
  const at = new Int32Array(layout.cols * layout.rows).fill(-1);
  layout.dataCells.forEach((cell, i) => { at[cell] = i; });
  return at;
}

test('a clean probe read has no errors', () => {
  const p = probe();
  const read = shoot(p);
  const truth = truthFrame(read.frameHeader, p.gross);
  assert.deepEqual(truth, p.frameBytes);
  const stats = measureErrors(read, truth);
  assert.equal(stats.cells, p.layout.dataBlockCount - HEADER_CELLS);
  assert.equal(stats.cellErrors, 0);
  assert.ok(stats.codewords.length === Math.floor((p.gross - HEADER_CODEWORD) / 255) && stats.codewords.length > 0);
  for (const c of stats.codewords) assert.equal(c.errors, 0);
  assert.equal(stats.region.cells.reduce((a, b) => a + b, 0), stats.cells);
});

test('painted cells are counted in their region', () => {
  const p = probe();
  const at = dataIndexOf(p.layout);
  // Grid fifth (row 2, col 3) is cols 72..95, rows 27..40; 12 cells spaced 3 apart.
  let painted = 0;
  for (let row = 29; row <= 38 && painted < 12; row += 3) {
    for (let col = 75; col <= 90 && painted < 12; col += 5) {
      const i = at[row * COLS + col];
      assert.ok(i >= HEADER_CELLS, 'painted cell is a payload cell');
      for (let c = 0; c < 3; c++) p.blocks[i * 3 + c] = 255 - p.blocks[i * 3 + c];
      painted++;
    }
  }
  assert.equal(painted, 12);
  const read = shoot(p);
  const stats = measureErrors(read, truthFrame(read.frameHeader, p.gross));
  assert.equal(stats.cellErrors, 12);
  assert.equal(stats.region.errors[2 * 5 + 3], 12);
  // An inverted 4 level cell is wrong in every channel.
  assert.deepEqual(stats.byChannel, { r: 12, g: 12, b: 12 });
  assert.equal(stats.near.wrong, 36);
  assert.ok(stats.codewords.reduce((a, c) => a + c.errors, 0) > 0);
});

test('header only: garbage payload is measured, not thrown', () => {
  const p = probe();
  const next = random32(99);
  for (let i = HEADER_CELLS * 3; i < p.blocks.length; i++) p.blocks[i] = next() & 0xff;
  const read = shoot(p);
  const stats = measureErrors(read, truthFrame(read.frameHeader, p.gross));
  assert.ok(stats.cellErrors > 0.3 * stats.cells, `${stats.cellErrors} of ${stats.cells}`);
  assert.equal(codewordSuccess(stats.codewords, 32, false), 0);
});

test('erasures decode what errors alone cannot', () => {
  const c = [{ errors: 20, flagged: 24, flaggedErrors: 18 }];
  assert.equal(codewordSuccess(c, 32, false), 0);
  assert.equal(codewordSuccess(c, 32, true), 1);
});

test('truthFrame ignores data frames', () => {
  assert.equal(truthFrame({ version: 3, frameType: 0, txId: 1, index: 0, payloadLength: 10 }, 4000), null);
});

// Hand made reads, no image: the distance rule, gray luminance and byte flags.
test('near: samples under the erasure distance are flagged, and so are their bytes', () => {
  const scheme = { kind: 'gray', levels: 2 };
  const layout = computeLayout(50, 60);
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  assert.equal(Math.floor((gross - HEADER_CODEWORD) / 255), 1); // one full payload codeword
  const cellsN = layout.dataBlockCount;
  const truth = new Uint8Array(gross); // all zero: every payload cell is black
  const blocks = frameToBlocks(truth, scheme, cellsN);
  const v = (i, y) => blocks.fill(y, (HEADER_CELLS + i) * 3, (HEADER_CELLS + i) * 3 + 3);
  // Threshold 100, means 0 and 200: half gap 100, so 0.2 is 20 units.
  v(0, 85);  // distance 0.15, right: flagged
  v(1, 105); // distance 0.05, wrong: flagged and wrong
  v(2, 150); // distance 0.5, wrong: not flagged
  v(9, 81);  // distance 0.19, byte 1: flagged
  const read = {
    version: 3, scheme, blocks, cols: 50, rows: 60, frameHeader: { frameType: 2 },
    thresholds: { y: [100] }, means: { y: [0, 200] }, headerThresholds: { r: [128], g: [128], b: [128] },
  };
  assert.equal(ERASURE_DISTANCE, 0.2);
  const stats = measureErrors(read, truth);
  assert.equal(stats.cellErrors, 2);
  assert.deepEqual(stats.byChannel, { y: 2 });
  assert.deepEqual(stats.byLevel, { y: [2, 0] });
  assert.deepEqual(stats.near, { flagged: 3, flaggedWrong: 1, wrong: 2 });
  assert.deepEqual(stats.codewords, [{ errors: 1, flagged: 2, flaggedErrors: 1 }]);
});
