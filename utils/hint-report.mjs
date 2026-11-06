// Usage: node utils/hint-report.mjs [--runs <n>]
// What the finder hint saves on this machine: decode time (median of --runs,
// default 5), exactCells and estimated reads a second, with no hint and with
// the hint the camera path would hold, for angled shots (137x77, distance 0.9,
// clean and with the far side dimmed) and any gate photos in test/photos.
// A frame with a standard read gets a stale 'perspective' hint instead.
import { existsSync, readdirSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { angledShot } = await import(root + '/src/testutil/angled.js');
const { decodeCameraFrame } = await import(root + '/src/picture/reader.js');
const { readImage } = await import(root + '/src/testutil/image.js');
const args = process.argv.slice(2);
const i = args.indexOf('--runs');
const runs = i >= 0 ? Number(args[i + 1]) : 5;

function timed(img, opts) {
  const ms = [];
  let out;
  for (let k = 0; k < runs; k++) {
    const start = performance.now();
    out = decodeCameraFrame(img, opts);
    ms.push(performance.now() - start);
  }
  ms.sort((a, b) => a - b);
  return { out, ms: ms[Math.floor(ms.length / 2)] };
}
const good = ({ frame }) => (frame ? (frame.packets ? `${frame.packets.filter(Boolean).length}/${frame.packets.length}` : 'ok') : 'none');

function row(name, img) {
  const plain = timed(img);
  const hint = plain.out.read.finderPass === 'recovery' ? 'recovery' : 'perspective';
  const hinted = timed(img, { hint });
  const cols = [
    name.padEnd(34), String(plain.out.read.finderPass ?? '-').padEnd(11), good(plain.out).padEnd(6),
    `${plain.ms.toFixed(0)} ms`.padStart(7), String(plain.out.read.exactCells ?? 0).padStart(7), `${(1000 / plain.ms).toFixed(1)}/s`.padStart(8),
    hint.padEnd(11), String(hinted.out.read.finderPass ?? '-').padEnd(11), good(hinted.out).padEnd(6),
    `${hinted.ms.toFixed(0)} ms`.padStart(7), String(hinted.out.read.exactCells ?? 0).padStart(7), `${(1000 / hinted.ms).toFixed(1)}/s`.padStart(8),
  ];
  console.log(cols.join(' '));
}

console.log('image | no hint: pass, packets, time, cells, reads/s | hint | with hint: pass, packets, time, cells, reads/s');
for (const [label, far] of [['clean', { dim: 0, blurPx: 0 }], ['dim', { dim: 0.35, blurPx: 2 }]]) {
  for (const yawDeg of [0, 15, 25, 35, 45]) {
    row(`yaw ${yawDeg} ${label}`, angledShot({ cols: 137, rows: 77, yawDeg, distance: 0.9, ...far }).img);
  }
}
const dir = root + '/test/photos';
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((n) => /^capture-2026-11-06T.*\.png$/.test(n)).sort()) row(f.slice(8, -4), readImage(`${dir}/${f}`));
}
