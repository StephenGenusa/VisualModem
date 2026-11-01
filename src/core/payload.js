/**
 * Payload layer: inner record -> gzip -> optional AES-GCM -> manifest + body.
 *
 * Manifest: 'VMDM' | version 1 | flags (bit 0 = encrypted) | u32 BE body length
 * | 32 byte SHA-256 of the body as stored | (16 byte salt | 12 byte IV if encrypted).
 * Inner record: type (0 message, 1 file) | name len | name | mime len | mime | data.
 */
import { gzipCompress, gzipDecompress, sha256 } from './compression.js';
import { encryptBytes, decryptBytes } from './crypto.js';
import { VmError } from './errors.js';

const MAGIC = [0x56, 0x4d, 0x44, 0x4d]; // 'VMDM'
const VERSION = 1;
const PLAIN_SIZE = 42;
const ENCRYPTED_SIZE = 70;
const MAX_FIELD = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode text as UTF-8, cut to at most `max` bytes without splitting a character. */
function encodeCut(text, max) {
  const bytes = encoder.encode(text);
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.slice(0, end);
}

/**
 * @param {Uint8Array} bodyHash
 * @returns {number}
 */
export function transmissionId(bodyHash) {
  return ((bodyHash[0] << 24) | (bodyHash[1] << 16) | (bodyHash[2] << 8) | bodyHash[3]) >>> 0;
}

/**
 * @param {Uint8Array} stream
 * @returns {{ encrypted: boolean, bodyLength: number, bodyHash: Uint8Array, txId: number } | null}
 */
export function peekManifest(stream) {
  if (stream.length < PLAIN_SIZE) return null;
  for (let i = 0; i < 4; i++) if (stream[i] !== MAGIC[i]) return null;
  if (stream[4] !== VERSION) return null;
  const encrypted = (stream[5] & 1) === 1;
  if (encrypted && stream.length < ENCRYPTED_SIZE) return null;
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const bodyHash = stream.slice(10, 42);
  return { encrypted, bodyLength: view.getUint32(6), bodyHash, txId: transmissionId(bodyHash) };
}

/**
 * @param {{ type: 'message' | 'file', name: string, mime: string, data: Uint8Array }} record
 * @param {string} [password]
 * @returns {Promise<Uint8Array>}
 */
export async function encodePayload(record, password) {
  if (record.data.length === 0) throw new VmError('EMPTY_PAYLOAD', 'Nothing to send');
  const name = encodeCut(record.name, MAX_FIELD);
  const mime = encoder.encode(record.mime);
  if (mime.length > MAX_FIELD) throw new VmError('NAME_TOO_LONG', 'MIME type is longer than 255 bytes');

  const inner = new Uint8Array(3 + name.length + mime.length + record.data.length);
  inner[0] = record.type === 'file' ? 1 : 0;
  inner[1] = name.length;
  inner.set(name, 2);
  inner[2 + name.length] = mime.length;
  inner.set(mime, 3 + name.length);
  inner.set(record.data, 3 + name.length + mime.length);

  const compressed = await gzipCompress(inner);
  let body = compressed;
  let salt = null;
  let iv = null;
  if (password) {
    const enc = await encryptBytes(compressed, password);
    body = enc.ciphertext;
    salt = enc.salt;
    iv = enc.iv;
  }

  const hash = hexToBytes(await sha256(body));
  const headerSize = salt ? ENCRYPTED_SIZE : PLAIN_SIZE;
  const out = new Uint8Array(headerSize + body.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = salt ? 1 : 0;
  new DataView(out.buffer).setUint32(6, body.length);
  out.set(hash, 10);
  if (salt) {
    out.set(salt, 42);
    out.set(iv, 58);
  }
  out.set(body, headerSize);
  return out;
}

/**
 * @param {Uint8Array} stream
 * @param {string} [password]
 * @returns {Promise<{ type: 'message' | 'file', name: string, mime: string, data: Uint8Array }>}
 */
export async function decodePayload(stream, password) {
  const m = peekManifest(stream);
  if (!m) throw new VmError('BAD_MANIFEST', 'Not a visual modem payload');
  const headerSize = m.encrypted ? ENCRYPTED_SIZE : PLAIN_SIZE;
  if (stream.length - headerSize !== m.bodyLength) {
    throw new VmError('BAD_MANIFEST', 'Body length does not match the manifest');
  }
  const body = stream.slice(headerSize);
  const actual = hexToBytes(await sha256(body));
  for (let i = 0; i < 32; i++) {
    if (actual[i] !== m.bodyHash[i]) throw new VmError('BAD_HASH', 'Body hash mismatch');
  }

  let compressed = body;
  if (m.encrypted) {
    if (!password) throw new VmError('NEEDS_PASSWORD', 'This payload is encrypted');
    compressed = await decryptBytes(body, password, stream.slice(42, 58), stream.slice(58, 70));
  }

  let inner;
  try {
    inner = await gzipDecompress(compressed);
  } catch {
    throw new VmError('BAD_MANIFEST', 'Payload could not be decompressed');
  }

  try {
    if (inner.length < 3 || inner[0] > 1) throw new Error('bad record');
    const nameLen = inner[1];
    const mimeLenAt = 2 + nameLen;
    if (mimeLenAt >= inner.length) throw new Error('bad record');
    const mimeLen = inner[mimeLenAt];
    const dataAt = mimeLenAt + 1 + mimeLen;
    if (dataAt > inner.length) throw new Error('bad record');
    return {
      type: inner[0] === 1 ? 'file' : 'message',
      name: decoder.decode(inner.subarray(2, mimeLenAt)),
      mime: decoder.decode(inner.subarray(mimeLenAt + 1, dataAt)),
      data: inner.slice(dataAt),
    };
  } catch {
    throw new VmError('BAD_MANIFEST', 'Malformed inner record');
  }
}
