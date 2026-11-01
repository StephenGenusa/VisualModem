import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { frameGrossBytes } from '../src/core/frame.js';
import { frameCapacity, buildFrame } from '../src/core/frame.js';
import { renderFrame } from '../src/picture/render.js';
import { readImageFrame } from '../src/picture/filereader.js';

function roundTrip(blockSize, levels, cols, rows) {
  const layout = computeLayout(cols, rows);
  const gross = frameGrossBytes(layout.dataBlockCount, levels);
  const payload = Uint8Array.from({ length: Math.min(300, frameCapacity(gross, 8)) }, (_, i) => i & 0xff);
  const frameBytes = buildFrame({ payload, index: 1, count: 2, txId: 7, blockSize, levels, parity: 8 }, gross);
  const img = renderFrame({ frameBytes, index: 1, levels, blockSize, layout });
  const out = readImageFrame(img);
  assert.ok(out, `no frame read at ${blockSize}px ${levels} levels`);
  assert.equal(out.blockSize, blockSize); assert.equal(out.levels, levels);
  assert.deepEqual(out.frame.payload, payload);
}
test('1px 256 levels', () => roundTrip(1, 256, 64, 40));
test('1px 16 levels', () => roundTrip(1, 16, 64, 40));
test('4px 4 levels', () => roundTrip(4, 4, 40, 30));
test('2px 2 levels', () => roundTrip(2, 2, 40, 30));
test('no frame in a blank image', () => {
  assert.equal(readImageFrame({ data: new Uint8ClampedArray(200 * 200 * 4), width: 200, height: 200 }), null);
});
test('no frame in noise', () => {
  const data = new Uint8ClampedArray(200 * 200 * 4);
  let s = 1; for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = s >> 16; }
  assert.equal(readImageFrame({ data, width: 200, height: 200 }), null);
});
test('a version 3 file frame decodes', () => {
  const layout = computeLayout(64, 40);
  const scheme = { kind: 'gray', levels: 4 };
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  const payload = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 3, blockSize: 2, scheme, parity: 8 }, gross);
  const out = readImageFrame(renderFrame({ frameBytes, index: 0, scheme, blockSize: 2, layout }));
  assert.ok(out, 'no frame read');
  assert.deepEqual(out.scheme, scheme);
  assert.deepEqual(out.frame.payload, payload);
});
test('a version 2 file frame at 256 levels still decodes', async () => {
  const { buildFrameV2 } = await import('../src/core/frame.js');
  const { grossBytes } = await import('../src/core/symbols.js');
  const layout = computeLayout(64, 40);
  const gross = grossBytes(layout.dataBlockCount, 256);
  const payload = Uint8Array.from({ length: 1000 }, (_, i) => (i * 13) & 0xff);
  const frameBytes = buildFrameV2({ payload, index: 0, count: 1, txId: 3, blockSize: 1, levels: 256, parity: 0 }, gross);
  const out = readImageFrame(renderFrame({ frameBytes, index: 0, levels: 256, blockSize: 1, layout, version: 2 }));
  assert.ok(out, 'no frame read');
  assert.equal(out.frame.header.version, 2);
  assert.equal(out.levels, 256);
  assert.deepEqual(out.frame.payload, payload);
});

test('a version 3 1920x1080 block 1 file reads without paying for a version 4 layout', () => {
  const { cols, rows } = { cols: 1920, rows: 1080 };
  const layout = computeLayout(cols, rows);
  const scheme = { kind: 'gray', levels: 2 };
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  const payload = Uint8Array.from({ length: 500 }, (_, i) => (i * 11) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 5, blockSize: 1, scheme, parity: 8 }, gross);
  const img = renderFrame({ frameBytes, index: 0, scheme, blockSize: 1, layout });
  // Building the version 4 layout alone takes 300 ms at this size, and a read
  // that did it first measured about 420 ms warm (575 cold) against about 160 ms without it.
  // The best of three reads is used so a loaded machine cannot fail the check.
  let best = Infinity, out;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    out = readImageFrame(img);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(out, 'no frame read');
  assert.deepEqual(out.frame.payload, payload);
  assert.ok(best < 300, `${Math.round(best)} ms`);
});
