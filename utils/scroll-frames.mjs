// Cuts a smooth top-to-bottom scroll of a tall page image into fixed 16:9 frames.
// Usage: node utils/scroll-frames.mjs <tall.png> <outDir> <viewHeight> <seconds> <fps>
import { readFileSync, writeFileSync } from 'node:fs';
const { PNG } = await import('pngjs');
const [src, outDir, vh, secs, fps] = process.argv.slice(2);
const img = PNG.sync.read(readFileSync(src));
const W = img.width, VH = Number(vh), travel = img.height - VH;
const frames = [];
const write = (y, ms) => {
  const out = new PNG({ width: W, height: VH });
  img.data.copy(out.data, 0, y * W * 4, (y + VH) * W * 4);
  const name = `s${String(frames.length).padStart(4, '0')}.png`;
  writeFileSync(`${outDir}/${name}`, PNG.sync.write(out));
  frames.push({ name, ms });
};
write(0, 2000);
const n = Math.round(Number(secs) * Number(fps));
for (let i = 1; i < n; i++) {
  const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); // ease in and out
  write(Math.round(e * travel), 1000 / Number(fps));
}
write(travel, 2500);
writeFileSync(`${outDir}/frames.json`, JSON.stringify(frames));
console.log('frames', frames.length, 'travel', travel);
