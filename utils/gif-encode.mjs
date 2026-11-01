// Minimal animated GIF encoder: one global palette (the 256 most used colors,
// others mapped to the nearest), LZW, per-frame delays, unchanged-pixel
// rectangles cropped per frame. Usage: node utils/gif-encode.mjs <framesDir> <frames.json> <out.gif>
import { readFileSync, writeFileSync } from 'node:fs';
const { PNG } = await import('pngjs');
const [dir, listPath, out] = process.argv.slice(2);
const list = JSON.parse(readFileSync(listPath, 'utf8'));
const imgs = list.map((f) => PNG.sync.read(readFileSync(dir + '/' + f.name)));
const W = imgs[0].width, H = imgs[0].height;
const counts = new Map();
for (const im of imgs) for (let i = 0; i < im.data.length; i += 4) {
  const k = (im.data[i] << 16) | (im.data[i + 1] << 8) | im.data[i + 2];
  counts.set(k, (counts.get(k) || 0) + 1);
}
const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k);
while (palette.length < 256) palette.push(0);
const index = new Map(palette.map((k, i) => [k, i]));
const nearest = (k) => {
  if (index.has(k)) return index.get(k);
  let best = 0, bd = Infinity;
  const r = k >> 16, g = (k >> 8) & 255, b = k & 255;
  for (let i = 0; i < 256; i++) {
    const p = palette[i], d = (r - (p >> 16)) ** 2 + (g - ((p >> 8) & 255)) ** 2 + (b - (p & 255)) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  index.set(k, best);
  return best;
};
const bytes = [];
const push = (...b) => bytes.push(...b);
const u16 = (v) => push(v & 255, v >> 8);
push(...Buffer.from('GIF89a')); u16(W); u16(H); push(0xf7, 0, 0);
for (const k of palette) push(k >> 16, (k >> 8) & 255, k & 255);
push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
function lzw(pixels) {
  const minCode = 8, clear = 256, eoi = 257;
  const outBytes = [];
  let cur = 0, nbits = 0;
  const emit = (code, size) => { cur |= code << nbits; nbits += size; while (nbits >= 8) { outBytes.push(cur & 255); cur >>= 8; nbits -= 8; } };
  let dict = new Map(), next = 258, size = 9;
  emit(clear, size);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i];
    const key = prefix * 256 + c;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear, size); dict = new Map(); next = 258; size = 9; }
    prefix = c;
  }
  emit(prefix, size); emit(eoi, size);
  if (nbits > 0) outBytes.push(cur & 255);
  return outBytes;
}
let prev = null, acc = 0, shown = 0;
for (let f = 0; f < imgs.length; f++) {
  const d = imgs[f].data;
  const idx = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) idx[p] = nearest((d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2]);
  let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
  if (prev) {
    x0 = W; y0 = H; x1 = -1; y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (idx[y * W + x] !== prev[y * W + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
  }
  const t0 = Math.round(acc / 10); acc += list[f].ms; const delay = Math.max(2, Math.round(acc / 10) - t0);
  push(0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  push(0x2c); u16(x0); u16(y0); u16(w); u16(h); push(0);
  const sub = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) sub.set(idx.subarray((y + y0) * W + x0, (y + y0) * W + x0 + w), y * w);
  const data = lzw(sub);
  push(8);
  for (let i = 0; i < data.length; i += 255) { const chunk = data.slice(i, i + 255); push(chunk.length, ...chunk); }
  push(0);
  prev = idx; shown += delay;
}
push(0x3b);
writeFileSync(out, Buffer.from(bytes));
console.log('frames', imgs.length, 'seconds', shown / 100, 'colors used', counts.size, 'bytes', bytes.length);
