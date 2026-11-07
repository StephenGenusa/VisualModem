import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRefreshHz, refreshesPerFrame, actualFps, checkCells } from '../src/picture/cadence.js';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { frameGrossBytes } from '../src/core/frame.js';

test('60 Hz gives the integer splits', () => {
  assert.deepEqual([15, 10, 7.5, 6, 4].map((fps) => refreshesPerFrame(60, fps)), [4, 6, 8, 10, 15]);
  assert.deepEqual([15, 10, 7.5, 6, 4].map((fps) => actualFps(60, fps)), [15, 10, 7.5, 6, 4]);
});

test('50 Hz TV', () => {
  assert.ok(Math.abs(actualFps(50, 7.5) - 7.14) < 0.01);
  assert.equal(refreshesPerFrame(50, 7.5), 7);
});

test('a frame rate above the refresh rate shows each frame for one refresh', () => {
  assert.equal(refreshesPerFrame(60, 200), 1);
  assert.equal(actualFps(60, 200), 60);
});

test('refresh estimate ignores a stalled frame', () => {
  const stamps = [0];
  for (let i = 0; i < 29; i++) stamps.push(stamps[stamps.length - 1] + (i === 10 ? 120 : 16.7));
  assert.equal(estimateRefreshHz(stamps), 60);
});

test('refresh estimate snaps to common rates within 3 percent and rounds otherwise', () => {
  const at = (ms, n = 30) => Array.from({ length: n }, (_, i) => i * ms);
  assert.equal(estimateRefreshHz(at(20.3)), 50);
  assert.equal(estimateRefreshHz(at(1000 / 119)), 120);
  assert.equal(estimateRefreshHz(at(1000 / 144.5)), 144);
  assert.equal(estimateRefreshHz(at(1000 / 75)), 75);
  assert.equal(estimateRefreshHz(at(1000 / 90.4)), 90);
});

test('the self-check cells are 64 distinct cells inside the grid, the same for a seed', () => {
  const cells = checkCells(40, 30, 64, 7);
  assert.equal(cells.length, 64);
  assert.equal(new Set(cells).size, 64);
  for (const c of cells) assert.ok(Number.isInteger(c) && c >= 0 && c < 40 * 30);
  assert.deepEqual(checkCells(40, 30, 64, 7), cells);
  assert.deepEqual(checkCells(4, 3, 64, 7).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
});

// Nearest neighbour upscale, as drawImage does with smoothing off.
function upscale(img, k) {
  const width = img.width * k;
  const height = img.height * k;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = ((Math.floor(y / k) * img.width) + Math.floor(x / k)) * 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = img.data[s + c];
    }
  }
  return { data, width, height };
}

test('a frame drawn at 1 px per block and scaled matches the full render', () => {
  const layout = computeLayout(40, 30);
  for (const [scheme, white, index] of [[{ kind: 'gray', levels: 4 }, 255, 0], [{ kind: 'rgb', levels: [4, 4, 4] }, 160, 3]]) {
    const frameBytes = Uint8Array.from({ length: frameGrossBytes(layout.dataBlockCount, scheme) }, (_, i) => (i * 37 + 11) & 0xff);
    const opts = { frameBytes, index, scheme, layout, white };
    const small = renderFrame({ ...opts, blockSize: 1 });
    assert.equal(small.width, 40);
    assert.equal(small.height, 30);
    const big = renderFrame({ ...opts, blockSize: 16 });
    const scaled = upscale(small, 16);
    assert.equal(scaled.width, big.width);
    assert.equal(scaled.height, big.height);
    assert.ok(Buffer.from(scaled.data).equals(Buffer.from(big.data)));
  }
});

test('shownRate gives the rate the screen can really show and whether it differs', async () => {
  const { shownRate } = await import('../src/picture/cadence.js');
  assert.deepEqual(shownRate(29, 60), { fps: 30, differs: true });
  assert.deepEqual(shownRate(15, 60), { fps: 15, differs: false });
  assert.deepEqual(shownRate(10, 120), { fps: 10, differs: false });
  assert.deepEqual(shownRate(25, 60), { fps: 30, differs: true });
});
