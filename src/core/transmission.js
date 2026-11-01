import { VmError } from './errors.js';
import { peekManifest } from './payload.js';
import { buildFrame, frameCapacity, frameGrossBytes } from './frame.js';
import { resolveScheme, schemeName } from './scheme.js';
import { createEncoder, createDecoder, MAX_SOURCE } from './fountain.js';
import { frameShapeV4, buildFrameV4, VERSION_4 } from './framev4.js';

const MAX_FRAMES = 65535;
const ADOPT_FIELDS = ['txId', 'count', 'blockSize', 'schemeName', 'parity'];

/** The scheme of these settings: settings.scheme (an object or a SCHEME_CHOICES id), or the cube of settings.levels. */
export function settingsScheme(settings) {
  return resolveScheme(settings.scheme, settings.levels);
}

// The adoption key of a header: its scheme's name, or its levels for headers
// that carry no scheme.
function adoptKey(header, key) {
  if (key !== 'schemeName') return header[key];
  if (header.scheme) return schemeName(header.scheme);
  return header.levels ?? null;
}

function plan(streamLength, layout, settings) {
  const gross = frameGrossBytes(layout.dataBlockCount, settingsScheme(settings));
  const capacity = frameCapacity(gross, settings.parity);
  if (!(capacity > 0)) return { gross, capacity, count: null };
  const count = Math.max(1, Math.ceil(streamLength / capacity));
  return { gross, capacity, count: count > MAX_FRAMES ? null : count };
}

export function frameCount(streamLength, layout, settings) {
  return plan(streamLength, layout, settings).count;
}

export function encodeTransmission(stream, layout, settings) {
  const manifest = peekManifest(stream);
  if (!manifest) throw new VmError('BAD_MANIFEST', 'The payload has no readable manifest.');
  const { gross, capacity, count } = plan(stream.length, layout, settings);
  if (count === null) throw new VmError('PAYLOAD_TOO_LARGE', 'The payload does not fit these settings.');
  const { blockSize, parity } = settings;
  const scheme = settingsScheme(settings);
  const frames = [];
  for (let index = 0; index < count; index++) {
    const payload = stream.subarray(index * capacity, Math.min((index + 1) * capacity, stream.length));
    frames.push(buildFrame({ payload, index, count, txId: manifest.txId, blockSize, scheme, parity }, gross));
  }
  return { txId: manifest.txId, count, grossBytes: gross, capacity, scheme, frames };
}

/** Repair symbol ids live in 24 bits, after the K source ids. */
export const REPAIR_IDS = 2 ** 24;

/** How a stream of this length splits into pieces and frames, or null when it cannot be version 4. */
export function planV4(streamLength, layoutV4, settings) {
  const shape = frameShapeV4(layoutV4, settingsScheme(settings), settings.parity);
  const size = shape.packetBytes;
  if (shape.packets < 1 || !(size > 0)) return null;
  const K = Math.max(1, Math.ceil(streamLength / size));
  if (K > MAX_SOURCE) return null;
  return { K, packets: shape.packets, packetBytes: size, limitBytes: MAX_SOURCE * size, sourceFrames: Math.ceil(K / shape.packets) };
}

export function encodeTransmissionV4(stream, layoutV4, settings) {
  const manifest = peekManifest(stream);
  if (!manifest) throw new VmError('BAD_MANIFEST', 'The payload has no readable manifest.');
  const plan = planV4(stream.length, layoutV4, settings);
  if (!plan) throw new VmError('PAYLOAD_TOO_LARGE', 'The payload does not fit these settings.');
  const { blockSize, parity } = settings;
  const scheme = settingsScheme(settings);
  const shape = frameShapeV4(layoutV4, scheme, parity);
  const { K, packets: n, sourceFrames } = plan;
  const encoder = createEncoder(stream, shape.packetBytes, manifest.txId);
  const period = 2 * sourceFrames;

  // A period sends every source piece once, then the same number of frames of
  // repairs. Repair ids keep counting up across periods so a phone that joins
  // late never sees the same repair twice for a long time. The padding slots of
  // the last source frame take ids from r, not i, so every source frame is
  // identical in each period and can be cached by i % period. Those offsets
  // are below sourceFrames * n, real repair offsets are not, so ids stay distinct.
  function frameAt(i) {
    const r = i % period;
    const packets = [];
    for (let j = 0; j < n; j++) {
      const source = r * n + j;
      let symbolId;
      if (r < sourceFrames) symbolId = source < K ? source : K + ((source - K) % (REPAIR_IDS - K));
      else symbolId = K + ((i * n + j) % (REPAIR_IDS - K));
      packets.push({ symbolId, data: encoder.symbol(symbolId) });
    }
    return buildFrameV4({
      blockSize, scheme, parity, txId: manifest.txId, sourceCount: K, streamLength: stream.length, packets,
    }, shape);
  }

  return { version: VERSION_4, txId: manifest.txId, scheme, K, packetsPerFrame: n, sourceFrames, period, frameAt };
}

export class Collector {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.version = null;
    this.keyV4 = null;
    this.sourceCount = 0;
    this.streamLength = 0;
    this.decoder = null;
    this.startedAt = null;
    this.lastAt = null;
    this.doneAt = null;
    this.frames = new Map();
    this.txId = null;
    this.count = 0;
    this.blockSize = null;
    this.schemeName = null;
    this.parity = null;
    this.crcPass = 0;
    this.crcFail = 0;
    this.received = 0;
    this.seenIds = new Set();
  }

  addV4({ header, packets, packetBytes }) {
    // The piece size depends on the frame's block size and scheme, so a change
    // of either starts a new collection: packetBytes is part of the key.
    const size = packetBytes;
    const key = [header.version, header.txId, header.sourceCount, header.parity, header.streamLength, size];
    const K = header.sourceCount;
    // A screen is untrusted input: refuse headers that would size the decoder wildly.
    const sane = K >= 1 && K <= MAX_SOURCE && size >= 1
      && header.streamLength > (K - 1) * size && header.streamLength <= K * size;
    if (!sane) { this.crcFail++; return this.status(); }
    if (header.frameType !== 0 || !key.every((v, i) => v === (this.keyV4 ?? [])[i])) {
      if (header.frameType !== 0) { this.crcFail++; return this.status(); }
      this.reset();
      this.keyV4 = key;
      this.version = header.version;
      this.txId = header.txId;
      this.count = header.sourceCount;
      this.parity = header.parity;
      this.streamLength = header.streamLength;
      this.decoder = createDecoder(header.sourceCount, size, header.txId);
    }
    if (!packets.some((p) => p)) { this.crcFail++; return this.status(); }
    const at = this.now();
    this.startedAt ??= at;
    this.lastAt = at;
    this.crcPass++;
    // Once the file is rebuilt, more packets only cost time. They still count
    // as received so the overhead of a run can be measured.
    for (const p of packets) {
      if (!p) continue;
      this.received++;
      if (this.decoder.done()) continue;
      this.seenIds.add(p.symbolId);
      this.decoder.add(p.symbolId, p.data);
    }
    if (this.decoder.done()) this.doneAt ??= at;
    return this.status();
  }

  add(frame) {
    if (frame.header.version === VERSION_4) return this.addV4(frame);
    const { header, payload } = frame;
    // The transmission id is the body hash, so a sender that only changes its
    // sliders keeps the id. Any change in these fields starts a new collection,
    // so old and new chunks never mix.
    if (this.version === VERSION_4 || ADOPT_FIELDS.some((key) => adoptKey(header, key) !== this[key])) {
      this.reset();
      for (const key of ADOPT_FIELDS) this[key] = adoptKey(header, key);
    }
    const { index } = header;
    if (!Number.isInteger(index) || index < 0 || index >= this.count || header.count !== this.count) {
      this.crcFail++;
      return this.status();
    }
    const at = this.now();
    this.startedAt ??= at;
    this.lastAt = at;
    if (!this.frames.has(index)) this.frames.set(index, payload);
    if (this.frames.size === this.count) this.doneAt ??= at;
    this.crcPass++;
    return this.status();
  }

  noteFailure() {
    this.crcFail++;
    return this.status();
  }

  status() {
    const v4 = this.decoder !== null;
    const have = v4 ? this.decoder.rank() : this.frames.size;
    const complete = v4 ? this.decoder.done() : this.count > 0 && this.frames.size === this.count;
    return {
      ...(v4 ? { received: this.received, fresh: this.seenIds.size } : {}),
      txId: this.txId,
      count: this.count,
      have,
      complete,
      unit: v4 ? 'pieces' : 'frames',
      elapsedMs: this.startedAt === null ? 0 : (this.doneAt ?? this.lastAt) - this.startedAt,
      crcPass: this.crcPass,
      crcFail: this.crcFail,
    };
  }

  stream() {
    if (!this.status().complete) return null;
    if (this.decoder) return this.decoder.stream().slice(0, this.streamLength);
    const parts = [];
    for (let i = 0; i < this.count; i++) {
      const part = this.frames.get(i);
      if (!part) return null;
      parts.push(part);
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
}
