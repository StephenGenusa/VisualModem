// The perspective finder pass runs only after the standard search failed. Images
// that read with the standard search alone, rebuilt here with the builders of camera-synthetic,
// camera-v4, fastfinder and fouredge, must still read on the standard pass,
// with the same bytes and the same exact-search work as before the perspective pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeLayout, computeLayoutV4 } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { schemeFromLevels } from '../src/core/scheme.js';
import { frameShapeV4, buildFrameV4 } from '../src/core/framev4.js';
import { buildFrame, frameCapacity, frameGrossBytes, frameToBlocks, FRAME_TYPES } from '../src/core/frame.js';
import { warpToQuad, tiltQuad, blur, brightnessContrast, colorCast, noise, lensDistort } from '../src/testutil/distort.js';
import { probePayload } from '../src/optimize/prbs.js';
import { decodeCameraFrame, readBytes } from '../src/picture/reader.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

// camera-synthetic: the done criterion distortions.
function synthetic(cols, rows, W, H, degrees) {
  const layout = computeLayout(cols, rows);
  const gross = frameGrossBytes(layout.dataBlockCount, 4);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 131 + (i >> 8)) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, levels: 4, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, levels: 4, blockSize: 16, layout });
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, degrees, 0.85), W, H);
  img = blur(img, 2);
  img = brightnessContrast(img, 0.2, 0.9);
  img = colorCast(img, [1.05, 1.0, 0.92]);
  return noise(img, 6, 7);
}

// camera-v4 and fouredge: a 137x77 (or other) version 4 screen.
function screenV4(cols, rows, blockPx, scheme = schemeFromLevels(2)) {
  const layout = computeLayoutV4(cols, rows);
  const shape = frameShapeV4(layout, scheme, 32);
  const next = seeded(0x1234abcd);
  const packets = Array.from({ length: shape.packets }, (_, i) => ({ symbolId: 5 + i, data: Uint8Array.from({ length: shape.packetBytes }, next) }));
  const frameBytes = buildFrameV4({ blockSize: blockPx, scheme, parity: 32, txId: 0x1234abcd, sourceCount: 100, streamLength: 20000, packets }, shape);
  return renderFrame({ frameBytes, index: 0, scheme, blockSize: blockPx, layout, version: 4 });
}
const camera1080 = (screen, k1 = 0) => {
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, 1920, 1080, 3, 0.88), 1920, 1080);
  if (k1) img = lensDistort(img, k1);
  return noise(brightnessContrast(blur(img, 1), 0.2, 0.9), 3, 5);
};
function paintTopStrip(screen, cols, blockPx) {
  for (let col = 8; col < cols - 8; col++) {
    for (let y = 6 * blockPx; y < 7 * blockPx; y++) {
      for (let x = col * blockPx; x < (col + 1) * blockPx; x++) screen.data.fill(128, (y * screen.width + x) * 4, (y * screen.width + x) * 4 + 3);
    }
  }
  return screen;
}

// fastfinder: a gray probe frame, optionally bent by the lens.
function probeShot(cols, rows, W, H, scale, blockPx, k1 = 0) {
  const scheme = { kind: 'gray', levels: 2 };
  const layout = computeLayout(cols, rows);
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  const frameBytes = buildFrame({
    payload: probePayload(9, 0, frameCapacity(gross, 32)), index: 0, count: 4, txId: 9, blockSize: 19,
    scheme, parity: 32, frameType: FRAME_TYPES.probe, probeId: 1, probeCount: 5,
  }, gross);
  const blocks = frameToBlocks(frameBytes, scheme, layout.dataBlockCount);
  const screen = renderFrame({ frameBytes, index: 0, scheme, blockSize: blockPx, layout, blocks });
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, W, H, 3, scale), W, H);
  if (k1) img = lensDistort(img, k1);
  return noise(brightnessContrast(blur(img, 1), 0.2, 0.9), 3, 5);
}

// The bytes each image read before the perspective pass (sha256 of readBytes, first 16 hex)
// and the strip cells its exact search sampled.
const CASES = [
  ['camera-synthetic: 60x34 at 30 degrees', () => synthetic(60, 34, 1280, 720, 30), '47d6124dec52bb90', 681],
  ['camera-synthetic: 120x67 at 30 degrees', () => synthetic(120, 67, 1920, 1080, 30), 'ec1f0cebcd8dec19', 18951],
  ['camera-v4: cube 137x77', () => camera1080(screenV4(137, 77, 13)), '2b60c0cea82d2e48', 381],
  ['camera-v4: gray 2 137x77', () => camera1080(screenV4(137, 77, 13, { kind: 'gray', levels: 2 })), '42d83bb9fe4eaf87', 381],
  ['fastfinder: 4K at half size', () => probeShot(202, 113, 3840, 2160, 0.88, 17), '3d5ebbfbe5e364a9', 599],
  ['fastfinder: 1080p', () => probeShot(137, 77, 1920, 1080, 0.88, 13), '763c9c6a2d0797ea', 381],
  ['fastfinder: bent grid on the corrected pass', () => probeShot(202, 113, 1920, 1080, 0.88, 9, 0.02), '3d5ebbfbe5e364a9', 70827],
  ['fouredge: v4 with its top strip covered', () => camera1080(paintTopStrip(screenV4(137, 77, 13), 137, 13)), '2b60c0cea82d2e48', 8269],
];

// The relaxed rules never run when the standard search fits: one test per image.
for (const [name, build, bytes, cells] of CASES) {
  test(`the relaxed rules never run when the standard search fits: ${name}`, () => {
    const { read, frame } = decodeCameraFrame(build());
    assert.ok(frame, read.reason);
    assert.equal(read.finderPass, 'standard');
    const hash = createHash('sha256').update(readBytes(read)).digest('hex').slice(0, 16);
    assert.equal(hash, bytes, 'bytes');
    assert.equal(read.exactCells, cells, 'exact cells');
  });
}
