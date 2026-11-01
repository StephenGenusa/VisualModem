import { levelValue } from './symbols.js';

// Color schemes: how a block's color carries bits. 'rgb' gives each channel
// its own level count; 'gray' draws the same value in all three channels and
// is decided on brightness. Frames of version 3 name their scheme in two
// header bytes. See the spec, "Version 3: the optimizer".

const CHANNEL_LEVELS = [2, 4, 8, 16];
const GRAY_LEVELS = [2, 4, 8, 16];
const FULL = 0xff; // rgb 256/256/256

/** @typedef {{ kind: 'rgb', levels: number[] } | { kind: 'gray', levels: number }} Scheme */

export function schemeFromLevels(levels) {
  return { kind: 'rgb', levels: [levels, levels, levels] };
}

export function encodeScheme(scheme) {
  if (scheme.kind === 'gray') return [1, scheme.levels];
  const [r, g, b] = scheme.levels;
  if (r === 256 && g === 256 && b === 256) return [0, FULL];
  const code = (n) => CHANNEL_LEVELS.indexOf(n);
  return [0, (code(r) << 4) | (code(g) << 2) | code(b)];
}

export function decodeScheme(byte0, byte1) {
  if (byte0 === 1) return GRAY_LEVELS.includes(byte1) ? { kind: 'gray', levels: byte1 } : null;
  if (byte0 !== 0) return null;
  if (byte1 === FULL) return schemeFromLevels(256);
  if (byte1 < 0 || byte1 > 0x3f) return null;
  return { kind: 'rgb', levels: [CHANNEL_LEVELS[byte1 >> 4], CHANNEL_LEVELS[(byte1 >> 2) & 3], CHANNEL_LEVELS[byte1 & 3]] };
}

export function bitsPerBlock(scheme) {
  if (scheme.kind === 'gray') return Math.round(Math.log2(scheme.levels));
  return scheme.levels.reduce((sum, n) => sum + Math.round(Math.log2(n)), 0);
}

export function schemeName(scheme) {
  return scheme.kind === 'gray' ? `gray ${scheme.levels}` : `rgb ${scheme.levels.join('/')}`;
}

/**
 * A scheme from a scheme object or a SCHEME_CHOICES id. The cube, an unknown
 * id or none gives the cube of `levels`.
 */
export function resolveScheme(schemeOrId, levels) {
  if (schemeOrId && typeof schemeOrId === 'object') return schemeOrId;
  const choice = SCHEME_CHOICES.find((c) => c.id === schemeOrId);
  return choice?.scheme ?? schemeFromLevels(levels);
}

/** The sender's choices. The cube has no fixed scheme: it follows the levels slider. */
export const SCHEME_CHOICES = [
  { id: 'cube', scheme: null, label: 'Color cube' },
  { id: 'g4', scheme: { kind: 'rgb', levels: [2, 4, 2] }, label: 'Green 4, red and blue 2' },
  { id: 'gray2', scheme: { kind: 'gray', levels: 2 }, label: 'Black and white' },
  { id: 'gray4', scheme: { kind: 'gray', levels: 4 }, label: '4 shades of gray' },
];

/** Every color of the scheme, in color number order, as [r, g, b] values. */
export function schemeColors(scheme) {
  if (scheme.kind === 'gray') {
    return Array.from({ length: scheme.levels }, (_, n) => {
      const v = levelValue(scheme.levels, n);
      return [v, v, v];
    });
  }
  const [lr, lg, lb] = scheme.levels;
  const colors = [];
  for (let c = 0; c < lr * lg * lb; c++) {
    colors.push([
      levelValue(lr, c % lr),
      levelValue(lg, Math.floor(c / lr) % lg),
      levelValue(lb, Math.floor(c / (lr * lg))),
    ]);
  }
  return colors;
}
