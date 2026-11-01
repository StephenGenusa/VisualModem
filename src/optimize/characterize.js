// The characterization frame and the camera profile. The frame shows flat
// color patches and checkerboard targets in its data cells; the receiver
// measures how much brightness and color detail survives at 1, 2 and 4 cell
// squares, the noise of flat patches and the color cast of white. No DOM.
// See the spec, "Version 3: the optimizer".

import { buildFrame, frameGrossBytes, frameToBlocks, FRAME_TYPES, HEADER_CELLS, HEADER_SCHEME } from '../core/frame.js';
import { levelValue, luminance } from '../core/symbols.js';
import { renderFrame } from '../picture/render.js';

const MIN_PITCH = 3; // camera pixels per block below which nothing is measured
const TARGET_CELLS = 8;
const PATCH_CELLS = 2;
const SIZES = [1, 2, 4];
const PAIR_A = [255, 0, 128];
const PAIR_B = [0, 140, 70]; // about the brightness of PAIR_A

function makePatches() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const bits = [(i >> 2) & 1, (i >> 1) & 1, i & 1];
    out.push({ id: `cube-${bits.join('')}`, color: bits.map((b) => b * 255) });
  }
  for (let k = 0; k < 8; k++) {
    const v = levelValue(8, k);
    out.push({ id: `gray-${k}`, color: [v, v, v] });
  }
  ['r', 'g', 'b'].forEach((ch, c) => {
    for (const v of [85, 170, 255]) {
      const color = [0, 0, 0];
      color[c] = v;
      out.push({ id: `${ch}${v}`, color });
    }
  });
  out.push({ id: 'pair-a', color: PAIR_A }, { id: 'pair-b', color: PAIR_B });
  return out;
}

export const CHARACTERIZATION_PATCHES = makePatches();
const COLOR = Object.fromEntries(CHARACTERIZATION_PATCHES.map((p) => [p.id, p.color]));

/**
 * Where the patches and targets go, from the grid size alone. Targets come
 * first, scanning from the top left; then the flat patches fill every free
 * 2 x 2 square in turn, so each repeats across the data area.
 */
export function characterizationLayout(layout) {
  const { cols } = layout;
  const free = new Set(layout.dataCells.slice(HEADER_CELLS));
  const rows = layout.rows;
  const fits = (c0, r0, n) => {
    for (let r = r0; r < r0 + n; r++) {
      for (let c = c0; c < c0 + n; c++) if (c >= cols || r >= rows || !free.has(r * cols + c)) return false;
    }
    return true;
  };
  const take = (c0, r0, n) => {
    const cells = [];
    for (let r = r0; r < r0 + n; r++) {
      for (let c = c0; c < c0 + n; c++) { cells.push(r * cols + c); free.delete(r * cols + c); }
    }
    return cells;
  };
  const targets = [];
  const wanted = [];
  for (const kind of ['luma', 'chroma']) for (const size of SIZES) wanted.push({ kind, size });
  for (let r = 0; r < rows && targets.length < wanted.length; r++) {
    for (let c = 0; c < cols && targets.length < wanted.length; c++) {
      if (!fits(c, r, TARGET_CELLS)) continue;
      const { kind, size } = wanted[targets.length];
      const cells = take(c, r, TARGET_CELLS);
      const phase = cells.map((cell) => {
        const dc = (cell % cols) - c, dr = Math.floor(cell / cols) - r;
        return (Math.floor(dc / size) + Math.floor(dr / size)) % 2;
      });
      targets.push({ kind, size, cells, phase });
    }
  }
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (fits(c, r, PATCH_CELLS)) slots.push(take(c, r, PATCH_CELLS));
  }
  const byId = new Map(CHARACTERIZATION_PATCHES.map((p) => [p.id, []]));
  slots.forEach((cells, i) => byId.get(CHARACTERIZATION_PATCHES[i % CHARACTERIZATION_PATCHES.length].id).push(...cells));
  const patches = [...byId].filter(([, cells]) => cells.length > 0).map(([id, cells]) => ({ id, cells }));
  return { patches, targets };
}

const targetColors = (kind) => (kind === 'luma' ? [[0, 0, 0], [255, 255, 255]] : [PAIR_A, PAIR_B]);

/**
 * A version 3 frame of frameType 1 whose data cells after the header hold the
 * layout. probeId and probeCount name the probe that follows it, so a phone
 * knows where in the run it is.
 */
export function renderCharacterization({ layout, blockSize, white = 255, probeId = 0, probeCount = 0 }) {
  const scheme = HEADER_SCHEME;
  const gross = frameGrossBytes(layout.dataBlockCount, scheme);
  const frameBytes = buildFrame({
    payload: new Uint8Array(0), index: 0, count: 1, txId: 0, blockSize, scheme, parity: 0, frameType: FRAME_TYPES.characterization, probeId, probeCount,
  }, gross);
  const blocks = frameToBlocks(frameBytes, scheme, layout.dataBlockCount);
  const dataIndex = new Map(Array.from(layout.dataCells, (cell, i) => [cell, i]));
  const paint = (cell, color) => blocks.set(color, dataIndex.get(cell) * 3);
  const plan = characterizationLayout(layout);
  for (const p of plan.patches) for (const cell of p.cells) paint(cell, COLOR[p.id]);
  for (const t of plan.targets) {
    const colors = targetColors(t.kind);
    t.cells.forEach((cell, i) => paint(cell, colors[t.phase[i]]));
  }
  return renderFrame({ frameBytes, index: 0, scheme, blockSize, layout, white, blocks });
}

function meanOf(samples) {
  const m = [0, 0, 0];
  for (const s of samples) for (let c = 0; c < 3; c++) m[c] += s[c] / samples.length;
  return m;
}

function spreadOf(samples, mean) {
  const v = [0, 0, 0];
  for (const s of samples) for (let c = 0; c < 3; c++) v[c] += (s[c] - mean[c]) ** 2 / samples.length;
  return v.map(Math.sqrt);
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Measures a camera from a characterization frame.
 * @param {(col: number, row: number) => number[] | null} sample mean color of a cell
 * @param {object} layout the frame's grid layout
 * @param {number} pitchPx camera pixels per block
 * @returns {object} Profile
 */
export function analyzeCharacterization(sample, layout, pitchPx) {
  if (!(pitchPx >= MIN_PITCH)) return { measured: false, reason: 'too small', pitchPx };
  const { cols } = layout;
  const at = (cell) => sample(cell % cols, Math.floor(cell / cols));
  const plan = characterizationLayout(layout);
  const patches = {};
  for (const p of plan.patches) {
    const samples = p.cells.map(at).filter(Boolean);
    if (samples.length === 0) continue;
    const mean = meanOf(samples);
    patches[p.id] = { mean, spread: spreadOf(samples, mean) };
  }
  const flat = { luma: ['cube-000', 'cube-111'], chroma: ['pair-a', 'pair-b'] };
  if (!['cube-000', 'cube-111', 'pair-a', 'pair-b'].every((id) => patches[id])) {
    return { measured: false, reason: 'patches not seen', pitchPx };
  }
  const contrast = { luma: {}, chroma: {} };
  for (const t of plan.targets) {
    const phases = [[], []];
    t.cells.forEach((cell, i) => { const s = at(cell); if (s) phases[t.phase[i]].push(s); });
    if (phases[0].length === 0 || phases[1].length === 0) { contrast[t.kind][t.size] = null; continue; }
    const [a, b] = flat[t.kind].map((id) => patches[id].mean);
    const reference = distance(a, b);
    contrast[t.kind][t.size] = reference > 0 ? clamp01(distance(meanOf(phases[0]), meanOf(phases[1])) / reference) : 0;
  }
  const white = patches['cube-111'].mean;
  const avg = (white[0] + white[1] + white[2]) / 3;
  return {
    measured: true,
    patches,
    luma: contrast.luma,
    chroma: contrast.chroma,
    cast: white.map((v) => (avg > 0 ? v / avg : 1)),
    brightness: luminance(white[0], white[1], white[2]) - luminance(...patches['cube-000'].mean),
    pitchPx,
  };
}
