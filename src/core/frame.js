// Frame format: the wire layout of one screen frame. Version 3 is written;
// versions 2 and 3 are read.
//
// Layout of a frame of grossBytes:
//   1. Header codeword: rsEncode(header, HEADER_PARITY).
//      Version 3: 32 + 32 = 64 bytes. Version 2: 22 + 32 = 54 bytes.
//   2. Payload codewords: full 255 byte codewords carrying 255 - parity data
//      bytes each, then one shortened codeword if the leftover space is larger
//      than parity. With parity 0 the codewords are plain data.
//   3. Zero fill for any space left over.
//
// Version 3 header (32 bytes, big endian):
//   0..1 magic, 2 version, 3 blockSize, 4..5 scheme (src/core/scheme.js),
//   6 parity, 7 frameType (0 data, 1 characterization, 2 probe, 3 report),
//   8..11 txId, 12..13 index, 14..15 count, 16..19 payloadLength,
//   20..21 probeId, 22..23 probeCount, 24 probeFps x 10 (0 none),
//   25 probe flags (bit 0 static), 26..27 reserved (0),
//   28..31 CRC-32 over bytes 0..27 followed by the payload bytes.
//
// On screen, a version 3 header codeword is always drawn in the first
// HEADER_CELLS data cells with HEADER_SCHEME, whatever the frame's scheme, so
// a receiver can read the header even where the payload fails. The payload
// codewords fill the cells after it with the frame's scheme.
//
// Version 2 header (22 bytes): 0..1 magic, 2 version, 3 blockSize, 4 levels
// (0 means 256), 5 parity, 6..9 txId, 10..11 index, 12..13 count,
// 14..17 payloadLength, 18..21 CRC-32 over bytes 0..17 and the payload.
// A version 2 frame is drawn entirely in its cube.

import { rsEncode, rsDecode } from './rs.js';
import { crc32 } from './crc32.js';
import { VmError } from './errors.js';
import { encodeScheme, decodeScheme, schemeFromLevels } from './scheme.js';
import { blocksFromBytes, bytesFromBlocks, grossBytes } from './symbols.js';

export const HEADER_BYTES = 32;
export const HEADER_PARITY = 32;
export const CODEWORD = 255;
export const MAGIC = [0xDA, 0x7A];
export const VERSION = 3;
export const VERSION_2 = 2;
export const HEADER_BYTES_V2 = 22;
export const FRAME_TYPES = { data: 0, characterization: 1, probe: 2, report: 3 };
export const PROBE_FLAGS = { static: 1 };
export const HEADER_SCHEME = { kind: 'rgb', levels: [2, 2, 2] };
export const HEADER_CODEWORD = HEADER_BYTES + HEADER_PARITY; // 64
export const HEADER_CELLS = Math.ceil(HEADER_CODEWORD * 8 / 3); // 171

const HEADER_CODEWORD_V2 = HEADER_BYTES_V2 + HEADER_PARITY;
const CRC_OFFSET = 28;
const CRC_OFFSET_V2 = 18;
const LEVELS = [2, 4, 8, 16, 256];

/** Payload codeword spans after a header codeword of headerLength bytes. */
function payloadCodewords(grossBytes, parity, headerLength = HEADER_CODEWORD) {
  const spans = [];
  let offset = headerLength;
  while (grossBytes - offset >= CODEWORD) {
    spans.push({ offset, length: CODEWORD });
    offset += CODEWORD;
  }
  const tail = grossBytes - offset;
  if (tail > parity) spans.push({ offset, length: tail });
  return spans;
}

function capacityOf(grossBytes, parity, headerLength) {
  let total = 0;
  for (const { length } of payloadCodewords(grossBytes, parity, headerLength)) total += length - parity;
  return total;
}

/** Payload bytes a version 3 frame of grossBytes can carry at this parity. */
export function frameCapacity(grossBytes, parity) {
  return capacityOf(grossBytes, parity, HEADER_CODEWORD);
}

/** Total byte length of a version 3 frame drawn in dataBlockCount cells. */
export function frameGrossBytes(dataBlockCount, scheme) {
  if (dataBlockCount < HEADER_CELLS) return 0;
  return HEADER_CODEWORD + grossBytes(dataBlockCount - HEADER_CELLS, scheme);
}

/** The cell colors of a version 3 frame: the header in HEADER_SCHEME, then the payload. */
export function frameToBlocks(frameBytes, scheme, dataBlockCount) {
  const rgb = new Uint8Array(dataBlockCount * 3);
  rgb.set(blocksFromBytes(frameBytes.subarray(0, HEADER_CODEWORD), HEADER_SCHEME, HEADER_CELLS), 0);
  const rest = dataBlockCount - HEADER_CELLS;
  if (rest > 0) rgb.set(blocksFromBytes(frameBytes.subarray(HEADER_CODEWORD), scheme, rest), HEADER_CELLS * 3);
  return rgb;
}

/** The header codeword bytes from the first HEADER_CELLS cells. */
export function headerBytesFromBlocks(rgb, headerThresholds) {
  return bytesFromBlocks(rgb.subarray(0, HEADER_CELLS * 3), HEADER_SCHEME, headerThresholds).subarray(0, HEADER_CODEWORD);
}

/** The inverse of frameToBlocks. */
export function blocksToFrameBytes(rgb, scheme, headerThresholds, thresholds) {
  const head = headerBytesFromBlocks(rgb, headerThresholds);
  const body = bytesFromBlocks(rgb.subarray(HEADER_CELLS * 3), scheme, thresholds);
  const out = new Uint8Array(HEADER_CODEWORD + body.length);
  out.set(head, 0);
  out.set(body, HEADER_CODEWORD);
  return out;
}

function payloadCrc(headerStart, payload) {
  const buf = new Uint8Array(headerStart.length + payload.length);
  buf.set(headerStart, 0);
  buf.set(payload, headerStart.length);
  return crc32(buf);
}

function writeCodewords(frame, payload, parity, headerLength) {
  let read = 0;
  for (const { offset, length } of payloadCodewords(frame.length, parity, headerLength)) {
    const data = new Uint8Array(length - parity);
    data.set(payload.subarray(read, read + data.length));
    read += data.length;
    frame.set(rsEncode(data, parity), offset);
  }
}

function checkFits(payload, capacity) {
  if (payload.length > capacity) {
    throw new VmError('PAYLOAD_TOO_LARGE', `payload of ${payload.length} bytes exceeds frame capacity ${capacity}`);
  }
}

/**
 * Builds a version 3 frame.
 * @param {{ payload: Uint8Array, index: number, count: number, txId: number,
 *   blockSize: number, scheme?: object, levels?: number, parity: number,
 *   frameType?: number, probeId?: number, probeCount?: number,
 *   probeFps?: number, probeFlags?: number }} fields
 * @param {number} grossBytes
 * @returns {Uint8Array} exactly grossBytes long
 */
export function buildFrame(fields, grossBytes) {
  const { payload, index, count, txId, blockSize, parity, frameType = 0, probeId = 0, probeCount = 0, probeFps = 0, probeFlags = 0 } = fields;
  const scheme = fields.scheme ?? (LEVELS.includes(fields.levels) ? schemeFromLevels(fields.levels) : null);
  if (!scheme) throw new RangeError(`unsupported levels ${fields.levels}`);
  const [s0, s1] = encodeScheme(scheme);
  if (!decodeScheme(s0, s1)) throw new RangeError('unsupported scheme');
  checkFits(payload, frameCapacity(grossBytes, parity));

  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = MAGIC[0]; header[1] = MAGIC[1];
  header[2] = VERSION;
  header[3] = blockSize;
  header[4] = s0; header[5] = s1;
  header[6] = parity;
  header[7] = frameType;
  view.setUint32(8, txId >>> 0);
  view.setUint16(12, index);
  view.setUint16(14, count);
  view.setUint32(16, payload.length);
  view.setUint16(20, probeId);
  view.setUint16(22, probeCount);
  header[24] = Math.min(255, Math.max(0, Math.round(probeFps * 10)));
  header[25] = probeFlags & 0xff;
  view.setUint32(CRC_OFFSET, payloadCrc(header.subarray(0, CRC_OFFSET), payload));

  const frame = new Uint8Array(grossBytes);
  frame.set(rsEncode(header, HEADER_PARITY), 0);
  writeCodewords(frame, payload, parity, HEADER_CODEWORD);
  return frame;
}

/** Builds a version 2 frame, for tests and for reading old files. */
export function buildFrameV2(fields, grossBytes) {
  const { payload, index, count, txId, blockSize, levels, parity } = fields;
  if (!LEVELS.includes(levels)) throw new RangeError(`unsupported levels ${levels}`);
  checkFits(payload, capacityOf(grossBytes, parity, HEADER_CODEWORD_V2));
  const header = new Uint8Array(HEADER_BYTES_V2);
  const view = new DataView(header.buffer);
  header[0] = MAGIC[0]; header[1] = MAGIC[1];
  header[2] = VERSION_2;
  header[3] = blockSize;
  header[4] = levels === 256 ? 0 : levels;
  header[5] = parity;
  view.setUint32(6, txId >>> 0);
  view.setUint16(10, index);
  view.setUint16(12, count);
  view.setUint32(14, payload.length);
  view.setUint32(CRC_OFFSET_V2, payloadCrc(header.subarray(0, CRC_OFFSET_V2), payload));
  const frame = new Uint8Array(grossBytes);
  frame.set(rsEncode(header, HEADER_PARITY), 0);
  writeCodewords(frame, payload, parity, HEADER_CODEWORD_V2);
  return frame;
}

function validParity(parity) {
  return parity % 2 === 0 && parity <= 128;
}

function decodeV3(bytes) {
  if (bytes.length < HEADER_CODEWORD) return null;
  const decoded = rsDecode(bytes.subarray(0, HEADER_CODEWORD), HEADER_PARITY);
  if (!decoded) return null;
  const h = decoded.data;
  if (h[0] !== MAGIC[0] || h[1] !== MAGIC[1] || h[2] !== VERSION) return null;
  const scheme = decodeScheme(h[4], h[5]);
  const parity = h[6];
  if (!scheme || !validParity(parity) || h[7] > 3) return null;
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const header = {
    version: VERSION,
    blockSize: h[3],
    scheme,
    parity,
    frameType: h[7],
    txId: view.getUint32(8),
    index: view.getUint16(12),
    count: view.getUint16(14),
    payloadLength: view.getUint32(16),
    probeId: view.getUint16(20),
    probeCount: view.getUint16(22),
    probeFps: h[24] === 0 ? null : h[24] / 10,
    probeStatic: (h[25] & PROBE_FLAGS.static) !== 0,
  };
  const [r, g, b] = scheme.kind === 'rgb' ? scheme.levels : [];
  if (scheme.kind === 'rgb' && r === g && g === b) header.levels = r;
  return { header, headerStart: h.subarray(0, CRC_OFFSET), crc: view.getUint32(CRC_OFFSET), corrected: decoded.corrected, headerLength: HEADER_CODEWORD };
}

function decodeV2(bytes) {
  if (bytes.length < HEADER_CODEWORD_V2) return null;
  const decoded = rsDecode(bytes.subarray(0, HEADER_CODEWORD_V2), HEADER_PARITY);
  if (!decoded) return null;
  const h = decoded.data;
  if (h[0] !== MAGIC[0] || h[1] !== MAGIC[1] || h[2] !== VERSION_2) return null;
  const levels = h[4] === 0 ? 256 : h[4];
  const parity = h[5];
  if (!LEVELS.includes(levels) || !validParity(parity)) return null;
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  return {
    header: {
      version: VERSION_2,
      blockSize: h[3],
      levels,
      scheme: schemeFromLevels(levels),
      parity,
      frameType: 0,
      txId: view.getUint32(6),
      index: view.getUint16(10),
      count: view.getUint16(12),
      payloadLength: view.getUint32(14),
      probeId: 0,
      probeCount: 0,
    },
    headerStart: h.subarray(0, CRC_OFFSET_V2),
    crc: view.getUint32(CRC_OFFSET_V2),
    corrected: decoded.corrected,
    headerLength: HEADER_CODEWORD_V2,
  };
}

function decodeHeader(bytes) {
  return decodeV3(bytes) ?? decodeV2(bytes);
}

/**
 * Decodes the header codeword only, of either version.
 * @param {Uint8Array} bytes
 * @returns {object | null} FrameHeader
 */
export function peekHeader(bytes) {
  return decodeHeader(bytes)?.header ?? null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ header: object, payload: Uint8Array, corrected: number } | null}
 */
export function parseFrame(bytes) {
  const decodedHeader = decodeHeader(bytes);
  if (!decodedHeader) return null;
  const { header, headerStart, crc, headerLength } = decodedHeader;
  const { parity, payloadLength } = header;
  if (payloadLength > capacityOf(bytes.length, parity, headerLength)) return null;

  let corrected = decodedHeader.corrected;
  const payload = new Uint8Array(payloadLength);
  let write = 0;
  // Codewords past payloadLength hold only zero fill, so they are not decoded:
  // their errors cannot touch the payload, which the CRC still covers.
  for (const { offset, length } of payloadCodewords(bytes.length, parity, headerLength)) {
    if (write >= payloadLength) break;
    const decoded = rsDecode(bytes.subarray(offset, offset + length), parity);
    if (!decoded) return null;
    const take = decoded.data.subarray(0, payloadLength - write);
    payload.set(take, write);
    write += take.length;
    corrected += decoded.corrected;
  }

  if (payloadCrc(headerStart, payload) !== crc) return null;
  return { header, payload, corrected };
}
