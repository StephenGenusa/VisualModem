// A dense fountain code over GF(2). The first K pieces are the source pieces
// themselves; every later piece is the XOR of a pseudorandom subset of them,
// fixed by (txId, piece id, K) so the phone rebuilds the subset without it
// being sent. The decoder eliminates as pieces arrive, so each packet read
// adds to the file and the cost per packet stays small. No DOM; pure.

import { random32 } from '../optimize/prbs.js';
import { VmError } from './errors.js';

export const MAX_SOURCE = 1024;

/**
 * Which source pieces a repair piece covers, as a bitset (bit i of word i >> 5).
 * @param {number} txId
 * @param {number} symbolId
 * @param {number} K
 * @returns {Uint32Array}
 */
export function repairRow(txId, symbolId, K) {
  const words = (K + 31) >>> 5;
  const next = random32((txId ^ Math.imul(symbolId + 1, 0x85EBCA6B)) >>> 0);
  const row = new Uint32Array(words);
  for (let w = 0; w < words; w++) row[w] = next();
  // Bits at K and above do not name a piece; clear them.
  if (K & 31) row[words - 1] &= (1 << (K & 31)) - 1;
  // An empty subset would carry nothing, so fall back to one piece.
  if (row.every((w) => w === 0)) {
    const bit = symbolId % K;
    row[bit >>> 5] |= 1 << (bit & 31);
  }
  return row;
}

/** XOR src into dst, 32 bits at a time. */
function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

/**
 * @param {Uint8Array} stream
 * @param {number} symbolBytes
 * @param {number} txId
 * @returns {{K: number, symbol: (id: number) => Uint8Array}}
 */
export function createEncoder(stream, symbolBytes, txId) {
  if (stream.length === 0) throw new VmError('EMPTY_PAYLOAD', 'nothing to send');
  const K = Math.ceil(stream.length / symbolBytes);
  if (K > MAX_SOURCE) {
    throw new VmError('TOO_MANY_PIECES', `${K} pieces is more than ${MAX_SOURCE}`);
  }
  // Each source piece sits in a 4-byte padded slot so XOR can run on words.
  const W = (symbolBytes + 3) >>> 2;
  const words = new Uint32Array(K * W);
  const padded = new Uint8Array(words.buffer);
  for (let i = 0; i < K; i++) {
    padded.set(stream.subarray(i * symbolBytes, (i + 1) * symbolBytes), i * W * 4);
  }

  function symbol(id) {
    if (id < K) return padded.slice(id * W * 4, id * W * 4 + symbolBytes);
    const row = repairRow(txId, id, K);
    const acc = new Uint32Array(W);
    for (let w = 0; w < row.length; w++) {
      let bits = row[w];
      while (bits !== 0) {
        const low = bits & -bits;
        const i = (w << 5) + (31 - Math.clz32(low));
        xorInto(acc, words.subarray(i * W, (i + 1) * W));
        bits ^= low;
      }
    }
    return new Uint8Array(acc.buffer, 0, symbolBytes).slice();
  }

  return { K, symbol };
}

/**
 * Incremental elimination into reduced row echelon form: each pivot column
 * owns one row, and no row has a bit set at another pivot column.
 * @param {number} K
 * @param {number} symbolBytes
 * @param {number} txId
 */
export function createDecoder(K, symbolBytes, txId) {
  if (!Number.isInteger(K) || K < 1) throw new RangeError('K must be a positive integer');
  if (K > MAX_SOURCE) throw new VmError('TOO_MANY_PIECES', `${K} pieces is more than ${MAX_SOURCE}`);
  const rowWords = (K + 31) >>> 5;
  const W = (symbolBytes + 3) >>> 2;
  const bitsByPivot = new Array(K).fill(null);
  const dataByPivot = new Array(K).fill(null);
  let rank = 0;

  function add(id, data) {
    if (!Number.isInteger(id) || id < 0 || data.length !== symbolBytes) return false;
    let bits;
    if (id < K) {
      bits = new Uint32Array(rowWords);
      bits[id >>> 5] = 1 << (id & 31);
    } else {
      bits = repairRow(txId, id, K);
    }
    const d = new Uint32Array(W);
    new Uint8Array(d.buffer).set(data);

    // Pivot rows hold no other pivot columns, so one pass over the original
    // bits is enough: XORing a pivot row only changes non-pivot columns.
    const original = bits.slice();
    for (let w = 0; w < rowWords; w++) {
      let m = original[w];
      while (m !== 0) {
        const low = m & -m;
        const col = (w << 5) + (31 - Math.clz32(low));
        m ^= low;
        if (bitsByPivot[col] !== null) {
          xorInto(bits, bitsByPivot[col]);
          xorInto(d, dataByPivot[col]);
        }
      }
    }

    let pivot = -1;
    for (let w = 0; w < rowWords; w++) {
      if (bits[w] !== 0) {
        pivot = (w << 5) + (31 - Math.clz32(bits[w] & -bits[w]));
        break;
      }
    }
    if (pivot < 0) return false;

    const pw = pivot >>> 5;
    const pm = 1 << (pivot & 31);
    for (let c = 0; c < K; c++) {
      const rb = bitsByPivot[c];
      if (rb !== null && (rb[pw] & pm) !== 0) {
        xorInto(rb, bits);
        xorInto(dataByPivot[c], d);
      }
    }
    bitsByPivot[pivot] = bits;
    dataByPivot[pivot] = d;
    rank++;
    return true;
  }

  function stream() {
    if (rank < K) return null;
    const out = new Uint8Array(K * symbolBytes);
    for (let c = 0; c < K; c++) {
      out.set(new Uint8Array(dataByPivot[c].buffer, 0, symbolBytes), c * symbolBytes);
    }
    return out;
  }

  return { add, rank: () => rank, done: () => rank === K, stream };
}
