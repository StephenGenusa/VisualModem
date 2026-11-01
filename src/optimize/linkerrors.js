// Error measurement against the known payload. A probe frame's payload is
// probePayload(txId, index, length) (src/optimize/prbs.js), so the phone can
// rebuild the true frame from its header alone and compare each read with it:
// cell and channel errors, where on the grid they fall, whether a wrong cell
// took a neighbour's color, how many samples sat near a threshold, and the
// byte errors of each payload codeword. No DOM; pure.
//
// The bit mapping is the decoder's own: truth levels come from the truth
// bytes in the order blocksFromBytes draws them, decisions are decideLevel on
// read.blocks (unmixed, as the reader decides), and byte errors compare the
// truth with readBytes(read).

import { BitReader } from '../core/bits.js';
import { buildFrame, FRAME_TYPES, HEADER_CELLS, HEADER_CODEWORD, CODEWORD, PROBE_FLAGS, VERSION } from '../core/frame.js';
import { bitsPerChannel, decideLevel, grossBytes, luminance } from '../core/symbols.js';
import { computeLayout } from '../picture/layout.js';
import { readBytes } from '../picture/reader.js';
import { probePayload } from './prbs.js';

/** A sample nearer a threshold than this, in half-gap units, is flagged as a likely erasure. */
export const ERASURE_DISTANCE = 0.2;

const GRID_FIFTHS = 5;

/**
 * The true frame bytes of a version 3 probe, rebuilt from its header.
 * @param {object} header a decoded FrameHeader
 * @param {number} grossBytes the frame's byte length
 * @returns {Uint8Array | null} null for any header but a version 3 probe
 */
export function truthFrame(header, grossBytes) {
  if (!header || header.version !== VERSION || header.frameType !== FRAME_TYPES.probe) return null;
  const { txId, index, count, payloadLength, blockSize, scheme, parity, probeId, probeCount } = header;
  try {
    return buildFrame({
      payload: probePayload(txId, index, payloadLength), index, count, txId, blockSize, scheme, parity,
      frameType: FRAME_TYPES.probe, probeId, probeCount,
      probeFps: header.probeFps ?? 0, probeFlags: header.probeStatic ? PROBE_FLAGS.static : 0,
    }, grossBytes);
  } catch {
    return null; // a header whose payload does not fit grossBytes
  }
}

// Distance of v to its nearest bounding threshold, over half the gap between
// that threshold's own two level means. Infinity when the channel has none.
function distance(v, k, t, m) {
  let d = Infinity;
  for (const j of [k - 1, k]) {
    if (j < 0 || j >= t.length) continue;
    const half = (m[j + 1] - m[j]) / 2;
    d = Math.min(d, half > 0 ? Math.abs(v - t[j]) / half : 0);
  }
  return d;
}

/**
 * Measures a version 3 read's payload cells (from HEADER_CELLS on) against
 * the true frame bytes.
 * @param {object} read from decodeCameraFrame
 * @param {Uint8Array} truthBytes from truthFrame
 * @returns {object | null} ErrorStats, or null without a version 3 read or truth
 */
export function measureErrors(read, truthBytes) {
  if (!read || read.version !== VERSION || !read.scheme || !truthBytes) return null;
  const { scheme, blocks, thresholds, means } = read;
  const gray = scheme.kind === 'gray';
  const chans = gray ? ['y'] : ['r', 'g', 'b'];
  const levelsOf = gray ? [scheme.levels] : scheme.levels;
  const bitsOf = levelsOf.map(bitsPerChannel);
  const per = chans.length;
  const dataCount = Math.floor(blocks.length / 3);
  const cells = Math.max(0, dataCount - HEADER_CELLS);
  const base = HEADER_CELLS * 3;

  const byChannel = Object.fromEntries(chans.map((ch) => [ch, 0]));
  const byLevel = Object.fromEntries(chans.map((ch, c) => [ch, new Array(levelsOf[c]).fill(0)]));
  const near = { flagged: 0, flaggedWrong: 0, wrong: 0 };

  // Per sample truth and decision, in the decoder's bit order.
  const payloadBytes = truthBytes.subarray(HEADER_CODEWORD);
  const limit = grossBytes(cells, scheme) * 8; // the decoder writes only samples that fit
  const flaggedBytes = new Uint8Array(limit / 8);
  const reader = new BitReader(payloadBytes);
  const truthLv = new Int32Array(cells * per);
  const decided = new Int32Array(cells * per);
  const cellWrong = new Uint8Array(cells);
  let pos = 0, fits = true;
  for (let i = 0; i < cells; i++) {
    const o = base + i * 3;
    for (let c = 0; c < per; c++) {
      const s = i * per + c;
      const ch = chans[c];
      const bits = bitsOf[c];
      truthLv[s] = reader.read(bits);
      const v = gray ? luminance(blocks[o], blocks[o + 1], blocks[o + 2]) : blocks[o + c];
      const k = decideLevel(v, thresholds[ch]);
      decided[s] = k;
      const wrong = k !== truthLv[s];
      const flagged = distance(v, k, thresholds[ch], means[ch]) < ERASURE_DISTANCE;
      if (wrong) {
        byChannel[ch]++;
        byLevel[ch][truthLv[s]]++;
        near.wrong++;
        cellWrong[i] = 1;
      }
      if (flagged) {
        near.flagged++;
        if (wrong) near.flaggedWrong++;
      }
      fits = fits && pos + bits <= limit;
      if (fits && flagged) {
        for (let b = pos >> 3; b <= (pos + bits - 1) >> 3; b++) flaggedBytes[b] = 1;
      }
      pos += bits;
    }
  }

  // Where the payload cells sit on the grid.
  const layout = computeLayout(read.cols, read.rows);
  const { cols, rows, dataCells } = layout;
  const dataAt = new Int32Array(cols * rows).fill(-1);
  for (let i = 0; i < cells; i++) dataAt[dataCells[HEADER_CELLS + i]] = i;
  const region = { errors: new Array(GRID_FIFTHS * GRID_FIFTHS).fill(0), cells: new Array(GRID_FIFTHS * GRID_FIFTHS).fill(0) };
  const sameAs = (i, j) => {
    for (let c = 0; c < per; c++) if (decided[i * per + c] !== truthLv[j * per + c]) return false;
    return true;
  };
  let cellErrors = 0, shifts = 0;
  for (let i = 0; i < cells; i++) {
    const cell = dataCells[HEADER_CELLS + i];
    const col = cell % cols, row = Math.floor(cell / cols);
    const r = Math.min(GRID_FIFTHS - 1, Math.floor((row * GRID_FIFTHS) / rows)) * GRID_FIFTHS
      + Math.min(GRID_FIFTHS - 1, Math.floor((col * GRID_FIFTHS) / cols));
    region.cells[r]++;
    if (!cellWrong[i]) continue;
    cellErrors++;
    region.errors[r]++;
    // A neighbour's truth, among payload cells only: header cells are in another scheme.
    const neighbours = [
      col > 0 ? cell - 1 : -1, col < cols - 1 ? cell + 1 : -1,
      row > 0 ? cell - cols : -1, row < rows - 1 ? cell + cols : -1,
    ];
    if (neighbours.some((n) => n >= 0 && dataAt[n] >= 0 && sameAs(i, dataAt[n]))) shifts++;
  }

  // Byte errors of each full 255 byte payload span, against the decoder's bytes.
  const readPayload = readBytes(read).subarray(HEADER_CODEWORD);
  const codewords = [];
  const full = Math.floor(Math.min(payloadBytes.length, readPayload.length, flaggedBytes.length) / CODEWORD);
  for (let w = 0; w < full; w++) {
    const cw = { errors: 0, flagged: 0, flaggedErrors: 0 };
    for (let b = w * CODEWORD; b < (w + 1) * CODEWORD; b++) {
      const wrong = readPayload[b] !== payloadBytes[b];
      if (wrong) cw.errors++;
      if (flaggedBytes[b]) {
        cw.flagged++;
        if (wrong) cw.flaggedErrors++;
      }
    }
    codewords.push(cw);
  }

  return { cells, cellErrors, byChannel, byLevel, region, shifts, near, codewords };
}

/**
 * The share of codewords that would decode at this parity.
 * Without erasures: errors <= parity / 2. With erasures (flagged bytes
 * erased): 2 * (errors - flaggedErrors) + flagged <= parity.
 * @param {Array<{ errors: number, flagged: number, flaggedErrors: number }>} codewords
 * @param {number} parity
 * @param {boolean} erasures
 * @returns {number} 0 for no codewords
 */
export function codewordSuccess(codewords, parity, erasures) {
  if (!codewords || codewords.length === 0) return 0;
  const ok = codewords.filter((c) => (erasures
    ? 2 * (c.errors - c.flaggedErrors) + c.flagged <= parity
    : c.errors <= parity / 2)).length;
  return ok / codewords.length;
}
