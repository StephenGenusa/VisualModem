// Usage: node utils/readme-frames.mjs <outDir>   (env CW, CH, BLOCKS tune the probe frames)
// Renders README images with the app's own frame code: a Send frame, the Probe
// frames (with a duration list for ffmpeg) and a camera-like view for the phone mock.
import { mkdirSync, writeFileSync } from 'node:fs';
const P = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.argv[2];
const { fitGrid, computeLayout, computeLayoutV4 } = await import(P + '/src/picture/layout.js');
const { renderFrame } = await import(P + '/src/picture/render.js');
const { encodePayload } = await import(P + '/src/core/payload.js');
const { encodeTransmissionV4 } = await import(P + '/src/core/transmission.js');
const { createProbeSequence, buildProbeFrameV4 } = await import(P + '/src/optimize/probes.js');
const { renderCharacterization } = await import(P + '/src/optimize/characterize.js');
const { random32 } = await import(P + '/src/optimize/prbs.js');
const D = await import(P + '/src/testutil/distort.js');
const { writePng } = await import(P + '/src/testutil/image.js');

mkdirSync(OUT + '/probe', { recursive: true });
const W = 3840, H = 2160;
const cube2 = { kind: 'rgb', levels: [2, 2, 2] };

// One data frame of a 200 KB file, block 28 on a 4K screen, drawn at 7 px a block.
const rnd = random32(12345);
const data = new Uint8Array(204800).map(() => rnd() & 255);
const stream = await encodePayload({ type: 'file', name: 'sample.bin', mime: 'application/octet-stream', data }, '');
const g28 = fitGrid(W, H, 28);
const lay28 = computeLayoutV4(g28.cols, g28.rows);
const tx = encodeTransmissionV4(stream, lay28, { blockSize: 28, scheme: 'cube', levels: 2, parity: 32 });
const frame = renderFrame({ frameBytes: tx.frameAt(3), index: 3, scheme: tx.scheme, blockSize: 7, layout: lay28, version: 4 });
writePng(OUT + '/send-frame.png', frame);
console.log('send frame', frame.width + 'x' + frame.height, 'K', tx.K, 'packets', tx.packetsPerFrame);

// Camera-like view of a frame, for the phone mock: tilted, slightly soft, dark room.
const big = renderFrame({ frameBytes: tx.frameAt(5), index: 5, scheme: tx.scheme, blockSize: 9, layout: lay28, version: 4 });
const quad = D.tiltQuad(big.width, big.height, 1920, 1080, 6, 0.86);
let cam = D.warpToQuad(big, quad, 1920, 1080, [22, 23, 26]);
cam = D.blur(cam, 1);
cam = D.brightnessContrast(cam, 0.04, 0.92);
cam = D.noise(cam, 2.5, 7);
writePng(OUT + '/camera.png', cam);
writeFileSync(OUT + '/camera-quad.json', JSON.stringify(quad));

// Probe frames: half the loop, at real speed, with the run's pauses.
const CANVAS_W = Number(process.env.CW || 960), CANVAS_H = Number(process.env.CH || 540);
const seq = createProbeSequence({ cap: 45, parity: 32 });
const count = seq.probes.length;
const keepBlocks = new Set((process.env.BLOCKS || "45,28,19,13").split(",").map(Number));
const sweepBlock = 28;
const frames = [];
let n = 0;
function place(img) {
  const out = { data: new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4), width: CANVAS_W, height: CANVAS_H };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  const x0 = Math.floor((CANVAS_W - img.width) / 2), y0 = Math.floor((CANVAS_H - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    out.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + y0) * CANVAS_W + x0) * 4);
  }
  return out;
}
function emit(img, ms, caption) {
  const name = `f${String(n++).padStart(4, '0')}.png`;
  writePng(OUT + '/probe/' + name, place(img));
  frames.push({ name, ms, caption });
}
let first = true;
for (const step of seq.steps) {
  const blockSize = step.kind === 'characterize' ? step.blockSize : step.probe.blockSize;
  const isSweep = step.kind === 'probe' && step.probe.label.includes(' fps');
  if (isSweep ? blockSize !== sweepBlock : !keepBlocks.has(blockSize)) continue;
  const { cols, rows } = fitGrid(W, H, blockSize);
  const px = Math.max(1, Math.min(Math.floor(CANVAS_W / cols), Math.floor(CANVAS_H / rows)));
  const hold = step.holdMs + (first ? seq.settleMs : 0);
  first = false;
  if (step.kind === 'characterize') {
    const img = renderCharacterization({ layout: computeLayout(cols, rows), blockSize: px, probeId: step.probeId, probeCount: count });
    emit(img, hold, `Measuring the camera at block ${blockSize}`);
    continue;
  }
  const { probe } = step;
  const layoutV4 = computeLayoutV4(cols, rows);
  const txId = random32(probe.id * 7919)();
  const caption = `Probe ${probe.id} of ${count}: block ${blockSize}, ${probe.label}`;
  if (probe.static) {
    const fb = buildProbeFrameV4({ probe, txId, index: 0, layoutV4, probeCount: count }).frameBytes;
    emit(renderFrame({ frameBytes: fb, index: 0, scheme: probe.scheme, blockSize: px, layout: layoutV4, version: 4 }), hold, caption);
    continue;
  }
  const shown = Math.round((probe.fps * hold) / 1000);
  for (let i = 0; i < shown; i++) {
    const fb = buildProbeFrameV4({ probe, txId, index: i, layoutV4, probeCount: count }).frameBytes;
    emit(renderFrame({ frameBytes: fb, index: i, scheme: probe.scheme, blockSize: px, layout: layoutV4, version: 4 }), hold / shown, caption);
  }
}
writeFileSync(OUT + '/probe/frames.json', JSON.stringify(frames));
const total = frames.reduce((t, f) => t + f.ms, 0);
console.log('probe frames', frames.length, 'seconds', (total / 1000).toFixed(1));
