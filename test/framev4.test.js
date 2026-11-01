import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERSION_4, HEADER_BYTES_V4, HEADER_CODEWORD_V4, PACKET_OVERHEAD, frameShapeV4, buildFrameV4,
  peekHeaderV4, parseFrameV4, frameToBlocksV4, blocksToFrameBytesV4,
} from '../src/core/framev4.js';
import { buildFrame, peekHeader, headerBytesFromBlocks, HEADER_CELLS } from '../src/core/frame.js';
import { rsEncode } from '../src/core/rs.js';
import { crc16 } from '../src/core/crc16.js';
import { computeLayoutV4 } from '../src/picture/layout.js';
import { schemeThresholds, grossBytes } from '../src/core/symbols.js';
import { schemeFromLevels } from '../src/core/scheme.js';

const cube2 = schemeFromLevels(2);
const layout = computeLayoutV4(137, 77);
const shape = frameShapeV4(layout, cube2, 32);
const TX = 0x12345678;

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}

function makePackets(count, parity = 32) {
  const next = seeded(7);
  return Array.from({ length: count }, (_, i) => ({
    symbolId: 40 + i,
    data: Uint8Array.from({ length: frameShapeV4(layout, cube2, parity).packetBytes }, next),
  }));
}

const base = { blockSize: 10, scheme: cube2, parity: 32, txId: TX, sourceCount: 900, streamLength: 194000 };
const packets = makePackets(shape.packets);
const build = () => buildFrameV4({ ...base, packets }, shape);

test('constants and shape', () => {
  assert.equal(VERSION_4, 4);
  assert.equal(HEADER_BYTES_V4, 24);
  assert.equal(HEADER_CODEWORD_V4, 48);
  assert.equal(PACKET_OVERHEAD, 7);
  assert.equal(shape.payloadCells, layout.dataBlockCount - 256);
  assert.equal(shape.grossBytes, 96 + shape.payloadBytes);
});

test('shape counts the packets', () => {
  const big = computeLayoutV4(213, 120);
  const s = frameShapeV4(big, cube2, 32);
  assert.equal(s.packets, Math.ceil(grossBytes(big.dataBlockCount - 256, cube2) / 255));
});

test('a frame round trips through bytes', () => {
  const bytes = build();
  assert.equal(bytes.length, shape.grossBytes);
  const out = parseFrameV4(bytes);
  assert.equal(out.header.version, 4);
  assert.equal(out.header.blockSize, 10);
  assert.deepEqual(out.header.scheme, cube2);
  assert.equal(out.header.levels, 2);
  assert.equal(out.header.parity, 32);
  assert.equal(out.header.frameType, 0);
  assert.equal(out.header.probeFps, null);
  assert.equal(out.header.probeStatic, false);
  assert.equal(out.header.txId, TX);
  assert.equal(out.header.sourceCount, 900);
  assert.equal(out.header.streamLength, 194000);
  assert.equal(out.corrected, 0);
  assert.equal(out.packets.length, shape.packets);
  out.packets.forEach((p, i) => {
    assert.equal(p.symbolId, packets[i].symbolId);
    assert.deepEqual(p.data, packets[i].data);
  });
});

test('probe fields round trip', () => {
  const bytes = buildFrameV4({ ...base, frameType: 2, probeId: 5, probeCount: 9, probeFps: 7.5, probeFlags: 1, packets }, shape);
  const h = parseFrameV4(bytes).header;
  assert.equal(h.frameType, 2);
  assert.equal(h.probeId, 5);
  assert.equal(h.probeCount, 9);
  assert.equal(h.probeFps, 7.5);
  assert.equal(h.probeStatic, true);
});

test('a frame round trips through cells', () => {
  const bytes = build();
  const rgb = frameToBlocksV4(bytes, cube2, layout);
  assert.equal(rgb.length, layout.dataBlockCount * 3);
  const back = blocksToFrameBytesV4(rgb, cube2, schemeThresholds({ kind: 'rgb', levels: [2, 2, 2] }), schemeThresholds(cube2), layout);
  assert.deepEqual(parseFrameV4(back), parseFrameV4(bytes));
  assert.equal(back.length, bytes.length);
});

test('the second header copy reads when the first is destroyed', () => {
  const bytes = build();
  bytes.fill(0, 0, 48);
  const out = parseFrameV4(bytes);
  assert.equal(out.header.txId, TX);
  assert.equal(out.packets.filter((p) => p).length, shape.packets);
});

test('neither header copy readable gives null', () => {
  const bytes = build();
  bytes.fill(0, 0, 48);
  bytes.fill(0, bytes.length - 48);
  assert.equal(parseFrameV4(bytes), null);
});

test('a torn band costs only the packets inside it', () => {
  const bytes = build();
  const next = seeded(99);
  for (let i = 48 + 3 * shape.codewordBytes; i < 48 + 5 * shape.codewordBytes; i++) bytes[i] = next();
  const out = parseFrameV4(bytes);
  out.packets.forEach((p, i) => {
    if (i === 3 || i === 4) assert.equal(p, null);
    else assert.deepEqual(p.data, packets[i].data);
  });
});

test('scattered errors within each packet are corrected', () => {
  const bytes = build();
  for (let k = 0; k < shape.packets; k++) {
    for (let j = 0; j < 16; j++) bytes[48 + k * shape.codewordBytes + j * 15] ^= 0x5a;
  }
  const out = parseFrameV4(bytes);
  out.packets.forEach((p, i) => assert.deepEqual(p.data, packets[i].data));
  assert.equal(out.corrected, 16 * shape.packets);
});

function handPacket(txTag, crcDelta) {
  const body = new Uint8Array(2 + 3 + shape.packetBytes);
  body[0] = txTag >> 8; body[1] = txTag & 0xff;
  body[4] = 41;
  const crc = (crc16(body) + crcDelta) & 0xffff;
  const withCrc = new Uint8Array(body.length + 2);
  withCrc.set(body);
  withCrc[body.length] = crc >> 8; withCrc[body.length + 1] = crc & 0xff;
  return rsEncode(withCrc, 32);
}

test('a packet whose CRC fails is rejected', () => {
  const bytes = build();
  bytes.set(handPacket(TX & 0xffff, 1), 48 + shape.codewordBytes);
  const out = parseFrameV4(bytes);
  assert.equal(out.packets[1], null);
  assert.deepEqual(out.packets[0].data, packets[0].data);
});

test('a hand built packet with a right CRC is accepted, one from another transmission is not', () => {
  const bytes = build();
  bytes.set(handPacket(TX & 0xffff, 0), 48 + shape.codewordBytes);
  bytes.set(handPacket((TX + 1) & 0xffff, 0), 48 + 2 * shape.codewordBytes);
  const out = parseFrameV4(bytes);
  assert.equal(out.packets[1].symbolId, 41);
  assert.equal(out.packets[2], null);
});

test('parity 0 packets are plain and guarded by the CRC', () => {
  const s0 = frameShapeV4(layout, cube2, 0);
  const pk = makePackets(s0.packets, 0);
  const bytes = buildFrameV4({ ...base, parity: 0, packets: pk }, s0);
  const out = parseFrameV4(bytes);
  out.packets.forEach((p, i) => assert.deepEqual(p.data, pk[i].data));
  bytes[48 + s0.codewordBytes + 10] ^= 1;
  assert.equal(parseFrameV4(bytes).packets[1], null);
});

test('build rejects a wrong packet count or size', () => {
  assert.throws(() => buildFrameV4({ ...base, packets: packets.slice(1) }, shape), RangeError);
  const bad = packets.map((p) => ({ ...p }));
  bad[0] = { symbolId: 1, data: new Uint8Array(10) };
  assert.throws(() => buildFrameV4({ ...base, packets: bad }, shape), RangeError);
});

test('version 3 and version 4 headers are not confused', () => {
  const v3 = buildFrame({ payload: new Uint8Array(100), index: 0, count: 1, txId: 1, blockSize: 10, levels: 4, parity: 32 }, 64 + 255);
  assert.equal(peekHeaderV4(v3.subarray(0, 48)), null);
  const rgb = frameToBlocksV4(build(), cube2, layout);
  const seen = peekHeader(headerBytesFromBlocks(rgb.subarray(0, HEADER_CELLS * 3)));
  assert.ok(seen === null || seen.version !== 3);
});

const gray2 = { kind: 'gray', levels: 2 };

test('tiled packets at 137 x 77 cube 2 parity 32', () => {
  assert.equal(shape.payloadBytes, 3543);
  assert.equal(shape.packets, 14);
  assert.equal(shape.codewordBytes, 253);
  assert.equal(shape.packetBytes, 214);
});

test('tiled packets at 68 x 38 gray 2 parity 32', () => {
  const s = frameShapeV4(computeLayoutV4(68, 38), gray2, 32);
  assert.equal(s.packets, 1);
  assert.equal(s.codewordBytes, 231);
  assert.equal(s.packetBytes, 192);
});

test('a payload too small for a packet has none', () => {
  const s = frameShapeV4(computeLayoutV4(33, 20), gray2, 32);
  assert.ok(s.payloadBytes < 40);
  assert.equal(s.packets, 0);
  assert.ok(s.packetBytes <= 0);
});

test('tiled frames round trip', () => {
  const cases = [[layout, cube2], [computeLayoutV4(68, 38), gray2]];
  for (const [lay, scheme] of cases) {
    const sh = frameShapeV4(lay, scheme, 32);
    const next = seeded(11);
    const pk = Array.from({ length: sh.packets }, (_, i) => ({
      symbolId: 500 + i, data: Uint8Array.from({ length: sh.packetBytes }, next),
    }));
    const bytes = buildFrameV4({ ...base, scheme, packets: pk }, sh);
    assert.equal(bytes.length, sh.grossBytes);
    for (let k = 0; k < sh.packets; k++) {
      bytes[48 + k * sh.codewordBytes + 3] ^= 0xa5;
      bytes[48 + k * sh.codewordBytes + sh.codewordBytes - 2] ^= 0x3c;
    }
    const out = parseFrameV4(bytes);
    assert.equal(out.packets.length, sh.packets);
    assert.equal(out.packetBytes, sh.packetBytes);
    out.packets.forEach((p, i) => {
      assert.equal(p.symbolId, pk[i].symbolId);
      assert.deepEqual(p.data, pk[i].data);
    });
  }
});

test('a probe header with sourceCount 0 and streamLength 0 round trips', () => {
  const frame = buildFrameV4({ ...base, frameType: 2, probeId: 9, probeCount: 50, probeFps: 4, sourceCount: 0, streamLength: 0, packets }, shape);
  const out = parseFrameV4(frame);
  assert.equal(out.header.frameType, 2);
  assert.equal(out.header.sourceCount, 0);
  assert.equal(out.header.streamLength, 0);
  assert.equal(out.header.probeFps, 4);
  assert.ok(out.packets.every(Boolean));
});

test('a codeword never exceeds 255 bytes: 42x41 gray4 at parity 128 builds and round trips', () => {
  const L = computeLayoutV4(42, 41);
  const gray4 = { kind: 'gray', levels: 4 };
  const s = frameShapeV4(L, gray4, 128);
  assert.ok(s.codewordBytes <= 255, `codewordBytes ${s.codewordBytes}`);
  assert.ok(s.packets > 0 && s.packetBytes >= 1);
  const next = seeded(3);
  const pk = Array.from({ length: s.packets }, (_, i) => ({ symbolId: i, data: Uint8Array.from({ length: s.packetBytes }, next) }));
  const bytes = buildFrameV4({ ...base, blockSize: 20, scheme: gray4, parity: 128, packets: pk }, s);
  assert.equal(bytes.length, s.grossBytes);
  const out = parseFrameV4(bytes);
  assert.equal(out.packets.length, s.packets);
  assert.deepEqual(out.packets[0].data, pk[0].data);
});

test('no grid, scheme or parity yields a codeword over 255 bytes or an empty packet', () => {
  const schemes = [{ kind: 'gray', levels: 2 }, { kind: 'gray', levels: 4 }, { kind: 'rgb', levels: 2 }, { kind: 'rgb', levels: [2, 2, 4] }, cube2];
  for (let c = 33; c <= 60; c++) for (let r = 20; r <= 45; r++) {
    let L; try { L = computeLayoutV4(c, r); } catch { continue; }
    for (const sc of schemes) for (let p = 0; p <= 128; p += 2) {
      let s; try { s = frameShapeV4(L, sc, p); } catch { continue; }
      assert.ok(s.codewordBytes <= 255, `${c}x${r} ${JSON.stringify(sc)} parity ${p}: ${s.codewordBytes}`);
      if (s.packets > 0) assert.ok(s.packetBytes >= 1, `${c}x${r} parity ${p}: packetBytes ${s.packetBytes}`);
    }
  }
});
