import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { renderFrame } from '../src/picture/render.js';
import { frameGrossBytes } from '../src/core/frame.js';
import { buildFrame, frameCapacity } from '../src/core/frame.js';
import { warpToQuad, tiltQuad, blur, brightnessContrast, colorCast, noise } from '../src/testutil/distort.js';
import { decodeCameraFrame } from '../src/picture/reader.js';

// The done criterion from the spec: 30 degree tilt, 2 px blur, 20 percent brightness change,
// mild color cast and pixel noise, at 16 px blocks and 4 levels per channel.
test('synthetic camera: spec done criterion', () => {
  const layout = computeLayout(60, 34);                 // 960 by 544 screen at 16 px
  const gross = frameGrossBytes(layout.dataBlockCount, 4);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 131) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, levels: 4, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, levels: 4, blockSize: 16, layout });
  const quad = tiltQuad(screen.width, screen.height, 1280, 720, 30, 0.85);
  let img = warpToQuad(screen, quad, 1280, 720);
  img = blur(img, 2);
  img = brightnessContrast(img, 0.2, 0.9);
  img = colorCast(img, [1.05, 1.0, 0.92]);
  img = noise(img, 6, 7);
  const { read, frame } = decodeCameraFrame(img);
  assert.equal(read.markersFound, true, read.reason);
  assert.ok(frame, 'frame did not parse');
  assert.deepEqual(frame.payload, payload);
  assert.ok(read.margin > 0.2, `margin ${read.margin}`);
});
test('synthetic camera: 16 levels is harder but a clean tilt still decodes', () => {
  const layout = computeLayout(60, 34);
  const gross = frameGrossBytes(layout.dataBlockCount, 16);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 64) }, (_, i) => (i * 17) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, levels: 16, parity: 64 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, levels: 16, blockSize: 16, layout });
  const img = blur(warpToQuad(screen, tiltQuad(screen.width, screen.height, 1920, 1080, 15, 0.9), 1920, 1080), 1);
  assert.deepEqual(decodeCameraFrame(img).frame.payload, payload);
});

// The same distortions on the default full grid: 120 by 67 blocks at 16 px on a 1080p camera.
// The small marker is about 40 px from its parallelogram prediction here, among many
// false size 5 candidates in the data, so the reader must check each candidate.
function fullGridCase(degrees) {
  const layout = computeLayout(120, 67);                // 1920 by 1072 screen at 16 px
  const gross = frameGrossBytes(layout.dataBlockCount, 4);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 131 + (i >> 8)) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, levels: 4, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, levels: 4, blockSize: 16, layout });
  const quad = tiltQuad(screen.width, screen.height, 1920, 1080, degrees, 0.85);
  let img = warpToQuad(screen, quad, 1920, 1080);
  img = blur(img, 2);
  img = brightnessContrast(img, 0.2, 0.9);
  img = colorCast(img, [1.05, 1.0, 0.92]);
  img = noise(img, 6, 7);
  const { read, frame } = decodeCameraFrame(img);
  assert.equal(read.markersFound, true, read.reason);
  assert.ok(frame, `frame did not parse: ${read.reason}`);
  assert.deepEqual(frame.payload, payload);
  assert.ok(read.cols === 120 && read.rows === 67, `grid ${read.cols} by ${read.rows}`);
}
test('synthetic camera: done criterion on the full 120 by 67 grid at 30 degrees', () => fullGridCase(30));
test('synthetic camera: full 120 by 67 grid at 10 degrees', () => fullGridCase(10));
test('synthetic camera: a dimmed white level still decodes, since the ramp is dimmed too', () => {
  const layout = computeLayout(60, 34);
  const gross = frameGrossBytes(layout.dataBlockCount, 2);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 131) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, levels: 2, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, levels: 2, blockSize: 16, layout, white: 120 });
  const quad = tiltQuad(screen.width, screen.height, 1280, 720, 20, 0.85);
  let img = warpToQuad(screen, quad, 1280, 720, [10, 10, 10]);
  img = blur(img, 1);
  img = noise(img, 4, 3);
  const { read, frame } = decodeCameraFrame(img);
  assert.equal(read.markersFound, true, read.reason);
  assert.ok(frame, `frame did not parse (${read.reason || 'no reason'})`);
  assert.deepEqual(frame.payload, payload);
});

// Every scheme under the done criterion distortions.
for (const scheme of [
  { kind: 'rgb', levels: [2, 2, 2] }, { kind: 'rgb', levels: [2, 4, 2] },
  { kind: 'gray', levels: 2 }, { kind: 'gray', levels: 4 },
]) {
  test(`synthetic camera: done criterion at ${scheme.kind} ${scheme.levels}`, () => {
    const layout = computeLayout(60, 34);
    const gross = frameGrossBytes(layout.dataBlockCount, scheme);
    const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 131 + 5) & 0xff);
    const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, scheme, parity: 32 }, gross);
    const screen = renderFrame({ frameBytes, index: 0, scheme, blockSize: 16, layout });
    let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, 1280, 720, 30, 0.85), 1280, 720);
    img = blur(img, 2);
    img = brightnessContrast(img, 0.2, 0.9);
    img = colorCast(img, [1.05, 1.0, 0.92]);
    img = noise(img, 6, 7);
    const { read, frame } = decodeCameraFrame(img);
    assert.ok(frame, `frame did not parse: ${read.reason}`);
    assert.deepEqual(frame.header.scheme, scheme);
    assert.deepEqual(read.scheme, scheme);
    assert.deepEqual(frame.payload, payload);
  });
}

// Measured on a real phone from the calibration strip's pure color cells
// (capture 17-07-16): black, and the response to pure red, green and blue, less black.
const PHONE_BLACK = [35, 29, 27];
const PHONE_COLUMNS = [[208, -29, -27], [13, 198, -27], [-35, -19, 225]];

test('green 4 decodes through a camera that mixes channels as a real phone does', async () => {
  const { channelMix } = await import('../src/testutil/distort.js');
  const scheme = { kind: 'rgb', levels: [2, 4, 2] };
  const layout = computeLayout(60, 34);
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  const payload = Uint8Array.from({ length: frameCapacity(gross, 32) }, (_, i) => (i * 131 + 9) & 0xff);
  const frameBytes = buildFrame({ payload, index: 0, count: 1, txId: 1, blockSize: 16, scheme, parity: 32 }, gross);
  const screen = renderFrame({ frameBytes, index: 0, scheme, blockSize: 16, layout });
  let img = warpToQuad(screen, tiltQuad(screen.width, screen.height, 1280, 720, 15, 0.85), 1280, 720);
  img = blur(img, 1);
  img = channelMix(img, PHONE_COLUMNS, PHONE_BLACK);
  img = noise(img, 4, 3);
  const { read, frame } = decodeCameraFrame(img);
  assert.ok(frame, `frame did not parse: ${read.reason ?? ''} means ${JSON.stringify(read.means)}`);
  assert.deepEqual(frame.payload, payload);
});
