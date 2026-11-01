// Frame format version 4: a frame of fountain coded pieces.
//
// A frame is header copy A, the payload, header copy B:
//   1. Header codeword, rsEncode(header, 24): 24 + 24 = 48 bytes, drawn in
//      the first HEADER_CELLS_V4 data cells with HEADER_SCHEME.
//   2. Payload in the frame's scheme: n = ceil(P / 255) packets of
//      L = min(255, floor(P / n)) bytes laid end to end, packet k at payload bytes
//      [k * L, (k + 1) * L), then zero fill (under n bytes, or more when L was capped at 255). A reader
//      derives n and L from the frame's byte length. Packets are not
//      interleaved, so a torn band of the picture costs only the packets it
//      touches.
//   3. Header codeword again, in the last HEADER_CELLS_V4 data cells.
//
// Header (24 bytes, big endian):
//   0..1 magic, 2 version (4), 3 blockSize, 4..5 scheme, 6 parity,
//   7 frameType (0 data, 1 characterization, 2 probe, 3 report),
//   8..9 probeId, 10..11 probeCount, 12 probeFps x 10 (0 none),
//   13 probe flags (bit 0 static), 14..17 txId, 18..19 sourceCount K,
//   20..23 streamLength.
//
// Packet (L bytes): rsEncode of txTag (2, low 16 bits of txId), symbolId (3),
// piece data (L - parity - 7), CRC-16 over those 5 + data bytes (2). With
// parity 0 the packet is those bytes plain and the CRC alone guards it.

import { rsEncode, rsDecode } from './rs.js';
import { crc16 } from './crc16.js';
import { encodeScheme, decodeScheme } from './scheme.js';
import { blocksFromBytes, bytesFromBlocks, grossBytes } from './symbols.js';
import { MAGIC, PROBE_FLAGS, HEADER_SCHEME, CODEWORD } from './frame.js';
import { HEADER_CELLS_V4 } from '../picture/layout.js';

export const VERSION_4 = 4;
export const HEADER_BYTES_V4 = 24;
export const HEADER_PARITY_V4 = 24;
export const HEADER_CODEWORD_V4 = HEADER_BYTES_V4 + HEADER_PARITY_V4; // 48
export const PACKET_OVERHEAD = 7; // txTag 2 + symbolId 3 + CRC-16 2

/**
 * How a payload of this many bytes tiles into packets: n = ceil(P / 255)
 * codewords of floor(P / n) bytes, with fewer when a codeword would be too
 * short to hold parity, 5 header bytes, a data byte and the CRC.
 */
function tile(payloadBytes, parity) {
  const min = parity + PACKET_OVERHEAD + 1;
  let packets = payloadBytes >= min ? Math.ceil(payloadBytes / CODEWORD) : 0;
  while (packets > 0 && Math.floor(payloadBytes / packets) < min) packets--;
  // Dropping a packet for parity can leave floor(P / n) over 255: cap it, the rest is zero fill.
  const codewordBytes = packets > 0 ? Math.min(CODEWORD, Math.floor(payloadBytes / packets)) : 0;
  return { packets, codewordBytes, packetBytes: codewordBytes - parity - PACKET_OVERHEAD };
}

/** Cell and byte counts of a version 4 frame drawn on this layout. */
export function frameShapeV4(layout, scheme, parity) {
  const payloadCells = layout.dataBlockCount - 2 * HEADER_CELLS_V4;
  const payloadBytes = grossBytes(payloadCells, scheme);
  return {
    payloadCells,
    payloadBytes,
    ...tile(payloadBytes, parity),
    grossBytes: 2 * HEADER_CODEWORD_V4 + payloadBytes,
  };
}

function encodePacket(txTag, packet, parity, codewordBytes) {
  const size = codewordBytes - parity - PACKET_OVERHEAD;
  if (!packet.data || packet.data.length !== size) {
    throw new RangeError(`packet data must be ${size} bytes`);
  }
  const body = new Uint8Array(codewordBytes - parity);
  body[0] = txTag >> 8; body[1] = txTag & 0xff;
  body[2] = (packet.symbolId >>> 16) & 0xff;
  body[3] = (packet.symbolId >>> 8) & 0xff;
  body[4] = packet.symbolId & 0xff;
  body.set(packet.data, 5);
  const crc = crc16(body.subarray(0, 5 + size));
  body[5 + size] = crc >> 8; body[6 + size] = crc & 0xff;
  return parity > 0 ? rsEncode(body, parity) : body;
}

/**
 * Builds a version 4 frame.
 * @param {object} fields blockSize, scheme, parity, frameType, probe fields,
 *   txId, sourceCount, streamLength and packets: [{ symbolId, data }]
 * @param {{ packets: number, codewordBytes: number, grossBytes: number }} shape from frameShapeV4
 * @returns {Uint8Array} exactly shape.grossBytes long
 */
export function buildFrameV4(fields, shape) {
  const {
    blockSize, scheme, parity, frameType = 0, probeId = 0, probeCount = 0, probeFps = 0, probeFlags = 0,
    txId, sourceCount, streamLength, packets,
  } = fields;
  if (packets.length !== shape.packets) {
    throw new RangeError(`frame holds ${shape.packets} packets, got ${packets.length}`);
  }
  const [s0, s1] = encodeScheme(scheme);
  if (!decodeScheme(s0, s1)) throw new RangeError('unsupported scheme');

  const header = new Uint8Array(HEADER_BYTES_V4);
  const view = new DataView(header.buffer);
  header[0] = MAGIC[0]; header[1] = MAGIC[1];
  header[2] = VERSION_4;
  header[3] = blockSize;
  header[4] = s0; header[5] = s1;
  header[6] = parity;
  header[7] = frameType;
  view.setUint16(8, probeId);
  view.setUint16(10, probeCount);
  header[12] = Math.min(255, Math.max(0, Math.round(probeFps * 10)));
  header[13] = probeFlags & 0xff;
  view.setUint32(14, txId >>> 0);
  view.setUint16(18, sourceCount);
  view.setUint32(20, streamLength >>> 0);
  const copy = rsEncode(header, HEADER_PARITY_V4);

  const frame = new Uint8Array(shape.grossBytes);
  frame.set(copy, 0);
  const txTag = txId & 0xFFFF;
  packets.forEach((packet, k) => {
    frame.set(encodePacket(txTag, packet, parity, shape.codewordBytes), HEADER_CODEWORD_V4 + k * shape.codewordBytes);
  });
  frame.set(copy, shape.grossBytes - HEADER_CODEWORD_V4);
  return frame;
}

/**
 * Decodes one 48 byte header codeword.
 * @param {Uint8Array} bytes48
 * @returns {object | null} FrameHeader
 */
export function peekHeaderV4(bytes48) {
  return decodeHeader(bytes48)?.header ?? null;
}

function decodeHeader(bytes) {
  if (bytes.length < HEADER_CODEWORD_V4) return null;
  const decoded = rsDecode(bytes.subarray(0, HEADER_CODEWORD_V4), HEADER_PARITY_V4);
  if (!decoded) return null;
  const h = decoded.data;
  if (h[0] !== MAGIC[0] || h[1] !== MAGIC[1] || h[2] !== VERSION_4) return null;
  const scheme = decodeScheme(h[4], h[5]);
  const parity = h[6];
  if (!scheme || parity % 2 !== 0 || parity > 128 || h[7] > 3) return null;
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const header = {
    version: VERSION_4,
    blockSize: h[3],
    scheme,
    parity,
    frameType: h[7],
    probeId: view.getUint16(8),
    probeCount: view.getUint16(10),
    probeFps: h[12] === 0 ? null : h[12] / 10,
    probeStatic: (h[13] & PROBE_FLAGS.static) !== 0,
    txId: view.getUint32(14),
    sourceCount: view.getUint16(18),
    streamLength: view.getUint32(20),
  };
  const [r, g, b] = scheme.kind === 'rgb' ? scheme.levels : [];
  if (scheme.kind === 'rgb' && r === g && g === b) header.levels = r;
  return { header, corrected: decoded.corrected };
}

function decodePacket(slot, header) {
  const { parity } = header;
  let body = slot;
  let corrected = 0;
  if (parity > 0) {
    const decoded = rsDecode(slot, parity);
    if (!decoded) return null;
    body = decoded.data;
    corrected = decoded.corrected;
  }
  const size = slot.length - parity - PACKET_OVERHEAD;
  const crc = (body[5 + size] << 8) | body[6 + size];
  if (crc16(body.subarray(0, 5 + size)) !== crc) return null;
  if (((body[0] << 8) | body[1]) !== (header.txId & 0xFFFF)) return null;
  const symbolId = (body[2] << 16) | (body[3] << 8) | body[4];
  return { packet: { symbolId, data: body.slice(5, 5 + size) }, corrected };
}

/**
 * Reads a version 4 frame from its bytes. The header comes from copy A, else
 * copy B; a packet is null when it fails RS or CRC or belongs to another
 * transmission.
 * @param {Uint8Array} bytes
 * @returns {{ header: object, packets: Array<{ symbolId: number, data: Uint8Array } | null>, packetBytes: number, corrected: number } | null}
 */
export function parseFrameV4(bytes) {
  if (bytes.length < 2 * HEADER_CODEWORD_V4) return null;
  const decoded = decodeHeader(bytes.subarray(0, HEADER_CODEWORD_V4))
    ?? decodeHeader(bytes.subarray(bytes.length - HEADER_CODEWORD_V4));
  if (!decoded) return null;
  const { header } = decoded;
  const { packets: count, codewordBytes, packetBytes } = tile(bytes.length - 2 * HEADER_CODEWORD_V4, header.parity);
  let corrected = 0;
  const packets = [];
  for (let k = 0; k < count; k++) {
    const start = HEADER_CODEWORD_V4 + k * codewordBytes;
    const got = decodePacket(bytes.subarray(start, start + codewordBytes), header);
    packets.push(got ? got.packet : null);
    if (got) corrected += got.corrected;
  }
  return { header, packets, packetBytes, corrected };
}

/** Cell colors of a version 4 frame: header A, payload in scheme, header B. */
export function frameToBlocksV4(frameBytes, scheme, layout) {
  const total = layout.dataBlockCount;
  const rgb = new Uint8Array(total * 3);
  const headerA = frameBytes.subarray(0, HEADER_CODEWORD_V4);
  const headerB = frameBytes.subarray(frameBytes.length - HEADER_CODEWORD_V4);
  const payload = frameBytes.subarray(HEADER_CODEWORD_V4, frameBytes.length - HEADER_CODEWORD_V4);
  rgb.set(blocksFromBytes(headerA, HEADER_SCHEME, HEADER_CELLS_V4), 0);
  rgb.set(blocksFromBytes(payload, scheme, total - 2 * HEADER_CELLS_V4), HEADER_CELLS_V4 * 3);
  rgb.set(blocksFromBytes(headerB, HEADER_SCHEME, HEADER_CELLS_V4), (total - HEADER_CELLS_V4) * 3);
  return rgb;
}

/** The inverse of frameToBlocksV4. */
export function blocksToFrameBytesV4(rgb, scheme, headerThresholds, thresholds, layout) {
  const total = layout.dataBlockCount;
  const head = (from) => bytesFromBlocks(
    rgb.subarray(from * 3, (from + HEADER_CELLS_V4) * 3), HEADER_SCHEME, headerThresholds,
  ).subarray(0, HEADER_CODEWORD_V4);
  const body = bytesFromBlocks(
    rgb.subarray(HEADER_CELLS_V4 * 3, (total - HEADER_CELLS_V4) * 3), scheme, thresholds,
  );
  const out = new Uint8Array(2 * HEADER_CODEWORD_V4 + body.length);
  out.set(head(0), 0);
  out.set(body, HEADER_CODEWORD_V4);
  out.set(head(total - HEADER_CELLS_V4), HEADER_CODEWORD_V4 + body.length);
  return out;
}
