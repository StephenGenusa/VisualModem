// Test and tool helper: image file IO. The only place under src/ that may use fs, pngjs and jpeg-js.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export function readImage(path) {
  const lower = path.toLowerCase();
  const buf = readFileSync(path);
  if (lower.endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { data: new Uint8ClampedArray(j.data), width: j.width, height: j.height };
  }
  throw new RangeError(`Unsupported image extension: ${path}`);
}

export function writePng(path, img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}
