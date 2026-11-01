import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameCapacity, buildFrame, buildFrameV2, peekHeader, parseFrame, frameGrossBytes, frameToBlocks,
  blocksToFrameBytes, headerBytesFromBlocks, PROBE_FLAGS, HEADER_SCHEME, HEADER_CELLS, HEADER_CODEWORD, VERSION, FRAME_TYPES,
} from '../src/core/frame.js';
import { schemeThresholds, grossBytes } from '../src/core/symbols.js';
import { SCHEME_CHOICES, schemeFromLevels } from '../src/core/scheme.js';

const fields = { index: 3, count: 9, txId: 0xDEADBEEF, blockSize: 16, levels: 4, parity: 32 };
const payload = Uint8Array.from({ length: 500 }, (_, i) => i & 0xff);
const H = 64;
const SCHEMES = SCHEME_CHOICES.map((c) => c.scheme ?? schemeFromLevels(4));

test('header constants', () => {
  assert.equal(VERSION, 3);
  assert.equal(HEADER_CODEWORD, 64);
  assert.equal(HEADER_CELLS, 171);
  assert.deepEqual(HEADER_SCHEME, { kind: 'rgb', levels: [2, 2, 2] });
  assert.equal(frameGrossBytes(171 + 100, { kind: 'gray', levels: 4 }), 64 + 25);
  assert.equal(frameGrossBytes(171 + 100, 4), 64 + grossBytes(100, 4));
});

test('capacity arithmetic', () => {
  assert.equal(frameCapacity(H, 32), 0);
  assert.equal(frameCapacity(H + 255, 32), 223);
  assert.equal(frameCapacity(H + 255 + 40, 32), 223 + 8);
  assert.equal(frameCapacity(H + 510, 0), 510);
});

test('version 3 round trip with each scheme and frame type', () => {
  for (const scheme of SCHEMES) {
    for (const frameType of Object.values(FRAME_TYPES)) {
      const bytes = buildFrame({ ...fields, levels: undefined, scheme, frameType, payload }, H + 255 * 3);
      const out = parseFrame(bytes);
      assert.equal(out.header.version, 3);
      assert.deepEqual(out.header.scheme, scheme);
      assert.equal(out.header.frameType, frameType);
      assert.equal(out.header.txId, fields.txId);
      assert.deepEqual(out.payload, payload);
    }
  }
  const cube = parseFrame(buildFrame({ ...fields, payload }, H + 255 * 3)).header;
  assert.equal(cube.levels, 4);
  assert.deepEqual(cube.scheme, schemeFromLevels(4));
});

test('a probe frame carries its probe id and count', () => {
  const bytes = buildFrame({ ...fields, frameType: FRAME_TYPES.probe, probeId: 17, probeCount: 36, payload }, H + 255 * 3);
  const h = peekHeader(bytes);
  assert.equal(h.frameType, 2); assert.equal(h.probeId, 17); assert.equal(h.probeCount, 36);
});

test('v3 probe fps and static flag round trip in reserved bytes', () => {
  const bytes = buildFrame({ ...fields, frameType: FRAME_TYPES.probe, probeId: 1, probeCount: 2, payload, probeFps: 7.5, probeFlags: PROBE_FLAGS.static }, H + 255 * 3);
  for (const h of [peekHeader(bytes), parseFrame(bytes).header]) {
    assert.equal(h.probeFps, 7.5); assert.equal(h.probeStatic, true);
  }
});

test('v3 frames with zero reserved bytes read as unknown fps, not static', () => {
  const bytes = buildFrame({ ...fields, payload }, H + 255 * 3);
  for (const h of [peekHeader(bytes), parseFrame(bytes).header]) {
    assert.equal(h.probeFps, null); assert.equal(h.probeStatic, false);
  }
});

test('the header codeword reads with HEADER_SCHEME thresholds when the payload scheme is gray 4', () => {
  const scheme = { kind: 'gray', levels: 4 };
  const cells = 171 + 1200;
  const gross = frameGrossBytes(cells, scheme);
  const bytes = buildFrame({ ...fields, levels: undefined, scheme, payload: payload.subarray(0, 100) }, gross);
  const rgb = frameToBlocks(bytes, scheme, cells);
  // the payload cells are gray; the header cells use only 0 and 255 per channel
  for (let i = 0; i < HEADER_CELLS * 3; i++) assert.ok(rgb[i] === 0 || rgb[i] === 255);
  const head = headerBytesFromBlocks(rgb, schemeThresholds(HEADER_SCHEME));
  assert.equal(peekHeader(head).blockSize, 16);
  const back = blocksToFrameBytes(rgb, scheme, schemeThresholds(HEADER_SCHEME), schemeThresholds(scheme));
  assert.equal(back.length, gross);
  assert.deepEqual(parseFrame(back).payload, payload.subarray(0, 100));
});

test('version 2 frames still parse', () => {
  const gross = 54 + 255 * 3;
  const bytes = buildFrameV2({ ...fields, payload }, gross);
  const out = parseFrame(bytes);
  assert.deepEqual(out.header, {
    version: 2, ...fields, payloadLength: 500, scheme: schemeFromLevels(4), frameType: 0, probeId: 0, probeCount: 0,
  });
  assert.deepEqual(out.payload, payload);
});

test('corrects byte errors within the parity budget', () => {
  const bytes = buildFrame({ ...fields, payload }, H + 255 * 3);
  for (let i = 0; i < 15; i++) bytes[H + i * 17] ^= 0xff;
  bytes[5] ^= 0xff;
  const out = parseFrame(bytes);
  assert.deepEqual(out.payload, payload); assert.equal(out.corrected, 16);
});

test('corrupt the payload past parity and the CRC rejects it', () => {
  const bytes = buildFrame({ ...fields, payload, parity: 0 }, H + 255 * 3);
  bytes[H + 10] ^= 0x01;
  assert.equal(parseFrame(bytes), null);
  const withParity = buildFrame({ ...fields, payload }, H + 255 * 3);
  for (let i = 0; i < 40; i++) withParity[H + i * 6] ^= 0x5a;
  assert.equal(parseFrame(withParity), null);
});

test('a frame spliced from two frames fails the CRC', () => {
  const a = buildFrame({ ...fields, payload }, H + 255 * 3);
  const b = buildFrame({ ...fields, index: 4, payload: payload.map((x) => x ^ 1) }, H + 255 * 3);
  const mixed = new Uint8Array(a); mixed.set(b.subarray(400), 400);
  assert.equal(parseFrame(mixed), null);
});

test('overfull payload throws', () => {
  assert.throws(() => buildFrame({ ...fields, payload }, H + 255));
});

test('a corrupted padding only codeword does not fail the frame', () => {
  const gross = H + 255 * 5;
  const short = payload.subarray(0, 100);
  const bytes = buildFrame({ ...fields, payload: short }, gross);
  const last = H + 255 * 4;
  for (let i = 0; i < 40; i++) bytes[last + i * 6] ^= 0x5a;
  assert.deepEqual(parseFrame(bytes).payload, short);
});
