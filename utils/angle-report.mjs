// Usage: node utils/angle-report.mjs
// For yaw 0, 15, 25, 35, 45 at distance 0.9 and 1.6: the stage each angled shot reaches.
import { existsSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { angledShot, stageOf } = await import(root + '/src/testutil/angled.js');
const { decodeCameraFrame } = await import(root + '/src/picture/reader.js');
const { readImage } = await import(root + '/src/testutil/image.js');
for (const [cols, rows] of [[137, 77], [96, 54]]) for (const distance of [0.9, 1.6]) {
  for (const yawDeg of [0, 15, 25, 35, 45]) {
    const { img, packets, payload } = angledShot({ cols, rows, yawDeg, distance, dim: 0.35, blurPx: 2 });
    const s = performance.now();
    const out = decodeCameraFrame(img);
    const ms = Math.round(performance.now() - s);
    console.log(`${cols}x${rows} distance ${distance} yaw ${String(yawDeg).padStart(2)}  ${stageOf(out, packets, payload).padEnd(18)} ${String(out.read.finderPass ?? "-").padEnd(12)} ${ms} ms`);
  }
}
const real = root + '/test/photos/capture-2026-11-01T22-41-33-145Z.png';
if (existsSync(real)) {
  const s = performance.now();
  const out = decodeCameraFrame(readImage(real));
  const c = out.read.corners;
  console.log(`real capture  ${stageOf(out, null).padEnd(18)} ${Math.round(performance.now() - s)} ms  tr ${c?.tr ? c.tr.map(Math.round).join(',') : '-'}  (want 1575,256)`);
} else console.log('real capture  absent');
