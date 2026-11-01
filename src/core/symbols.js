import { BitWriter, BitReader } from './bits.js';
import { schemeFromLevels, bitsPerBlock } from './scheme.js';

export const LEVEL_OPTIONS = [2, 4, 8, 16, 256];

export function bitsPerChannel(levels) {
  return Math.round(Math.log2(levels));
}

export function levelValue(levels, n) {
  return Math.round(n * 255 / (levels - 1));
}

export function midpointThresholds(levels) {
  const out = [];
  for (let n = 0; n < levels - 1; n++) {
    out.push((levelValue(levels, n) + levelValue(levels, n + 1)) / 2);
  }
  return out;
}

export function decideLevel(value, thresholds) {
  if (thresholds.length === 0) return value;
  let i = 0;
  while (i < thresholds.length && thresholds[i] <= value) i++;
  return i;
}

// A number means the version 2 cube, so existing callers work unchanged.
function asScheme(schemeOrLevels) {
  return typeof schemeOrLevels === 'number' ? schemeFromLevels(schemeOrLevels) : schemeOrLevels;
}

/** Midpoint thresholds for a scheme: { r, g, b } for rgb, { y } for gray. */
export function schemeThresholds(schemeOrLevels) {
  const s = asScheme(schemeOrLevels);
  if (s.kind === 'gray') return { y: midpointThresholds(s.levels) };
  const [r, g, b] = s.levels.map(midpointThresholds);
  return { r, g, b };
}

export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function blocksFromBytes(bytes, schemeOrLevels, blockCount) {
  const s = asScheme(schemeOrLevels);
  const reader = new BitReader(bytes);
  const rgb = new Uint8Array(blockCount * 3);
  if (s.kind === 'gray') {
    const bits = bitsPerChannel(s.levels);
    for (let i = 0; i < blockCount; i++) rgb.fill(levelValue(s.levels, reader.read(bits)), i * 3, i * 3 + 3);
    return rgb;
  }
  const bits = s.levels.map(bitsPerChannel);
  for (let i = 0; i < rgb.length; i++) rgb[i] = levelValue(s.levels[i % 3], reader.read(bits[i % 3]));
  return rgb;
}

export function bytesFromBlocks(rgb, schemeOrLevels, thresholds) {
  const s = asScheme(schemeOrLevels);
  const t = thresholds ?? schemeThresholds(s);
  const blockCount = Math.floor(rgb.length / 3);
  const total = grossBytes(blockCount, s);
  const writer = new BitWriter(total);
  const limit = total * 8;
  let written = 0;
  if (s.kind === 'gray') {
    const bits = bitsPerChannel(s.levels);
    for (let i = 0; i < blockCount && written + bits <= limit; i++) {
      writer.write(decideLevel(luminance(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]), t.y), bits);
      written += bits;
    }
    return writer.bytes();
  }
  const bits = s.levels.map(bitsPerChannel);
  const channels = [t.r, t.g, t.b];
  for (let i = 0; i < blockCount * 3 && written + bits[i % 3] <= limit; i++) {
    writer.write(decideLevel(rgb[i], channels[i % 3]), bits[i % 3]);
    written += bits[i % 3];
  }
  return writer.bytes();
}

export function grossBytes(blockCount, schemeOrLevels) {
  return Math.floor(blockCount * bitsPerBlock(asScheme(schemeOrLevels)) / 8);
}
