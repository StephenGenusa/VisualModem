import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayoutV4 } from '../src/picture/layout.js';
import { encodePayload, decodePayload } from '../src/core/payload.js';
import { parseFrameV4 } from '../src/core/framev4.js';
import { createDecoder } from '../src/core/fountain.js';
import { schemeFromLevels } from '../src/core/scheme.js';
import { planV4, encodeTransmissionV4, Collector } from '../src/core/transmission.js';

const layout = computeLayoutV4(137, 77);
const settings = { blockSize: 28, levels: 2, parity: 32 };

function seeded(length, seed = 7) {
  let s = seed;
  return Uint8Array.from({ length }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; });
}
const record = { type: 'file', name: 'x.bin', mime: 'application/octet-stream', data: seeded(30000) };
const stream = await encodePayload(record);
const tx = encodeTransmissionV4(stream, layout, settings);
const read = (t, i) => parseFrameV4(t.frameAt(i));

test('every source frame read once completes the file', async () => {
  const c = new Collector();
  for (let i = 0; i < tx.sourceFrames; i++) c.add(read(tx, i));
  const s = c.status();
  assert.equal(s.complete, true);
  assert.equal(s.unit, 'pieces');
  assert.equal(s.count, tx.K);
  assert.deepEqual(await decodePayload(c.stream()), record);
});

test('a phone that joins late finishes on repairs', async () => {
  const c = new Collector();
  for (let i = 10 * tx.period; i < 12 * tx.period && !c.status().complete; i++) {
    if (i % 3 !== 0) c.add(read(tx, i));
  }
  assert.equal(c.status().complete, true);
  assert.deepEqual(await decodePayload(c.stream()), record);
});

test('a lost packet costs only that packet', async () => {
  const c = new Collector();
  for (let i = 0; i < tx.sourceFrames + 2 * tx.period && !c.status().complete; i++) {
    const f = read(tx, i);
    f.packets[i % f.packets.length] = null;
    c.add(f);
  }
  assert.equal(c.status().complete, true);
  assert.deepEqual(await decodePayload(c.stream()), record);
});

test('the collector restarts when the packet size changes', () => {
  const other = encodeTransmissionV4(stream, computeLayoutV4(120, 67), { ...settings, blockSize: 32 });
  assert.equal(other.txId, tx.txId);
  const f0 = read(tx, 0);
  const f1 = read(other, 0);
  assert.notEqual(f0.packetBytes, f1.packetBytes);
  const c = new Collector();
  for (let i = 0; i < 3; i++) c.add(read(tx, i));
  assert.ok(c.status().received > f1.packets.length);
  const s = c.add(f1);
  assert.equal(s.received, f1.packets.filter((p) => p).length);
  assert.equal(s.have, f1.packets.length);
});

test('the 200 KB gate file takes 69 source frames', () => {
  const p = planV4(204800, computeLayoutV4(137, 77), { scheme: schemeFromLevels(2), parity: 32 });
  assert.equal(p.K, Math.ceil(204800 / 214));
  assert.equal(p.K, 958);
  assert.equal(p.sourceFrames, 69);
});

test('a payload too small for a packet does not plan', () => {
  assert.equal(planV4(1000, computeLayoutV4(33, 20), { scheme: { kind: 'gray', levels: 2 }, parity: 32 }), null);
});

test('changing the parity mid-file starts again', () => {
  const lighter = encodeTransmissionV4(stream, layout, { ...settings, parity: 16 });
  const c = new Collector();
  for (let i = 0; i < 3; i++) c.add(read(tx, i));
  assert.ok(c.status().have > lighter.packetsPerFrame);
  const f = read(lighter, 0);
  const s = c.add(f);
  assert.equal(s.have, f.packets.length);
});

test('a frame with no good packet counts as a failure', () => {
  const c = new Collector();
  const f = read(tx, 0);
  f.packets.fill(null);
  c.add(f);
  assert.equal(c.status().crcFail, 1);
  assert.equal(c.status().crcPass, 0);
});

test('elapsedMs runs from the first accepted frame to completion', () => {
  let t = 1000;
  const c = new Collector({ now: () => t });
  for (let i = 0; i < tx.sourceFrames; i++) { c.add(read(tx, i)); t += 100; }
  assert.equal(c.status().complete, true);
  const done = c.status().elapsedMs;
  assert.equal(done, 100 * (tx.sourceFrames - 1));
  t += 5000;
  assert.equal(c.status().elapsedMs, done);
});

test('a file of more than 1,024 pieces does not plan as version 4', async () => {
  const huge = await encodePayload({ type: 'file', name: 'h', mime: 'application/octet-stream', data: seeded(400_000) });
  assert.equal(planV4(huge.length, layout, settings), null);
  assert.throws(() => encodeTransmissionV4(huge, layout, settings), { code: 'PAYLOAD_TOO_LARGE' });
});

test('a repair frame builds in under 30 ms at K 1,024 on a 240 by 135 grid', async () => {
  const big = computeLayoutV4(240, 135);
  const data = await encodePayload({ type: 'file', name: 'b', mime: 'application/octet-stream', data: seeded(60000) });
  const plan = planV4(data.length, big, settings);
  const target = plan.K;
  // size the stream so K is as close to 1,024 as the packet size allows
  const per = Math.floor(data.length / target);
  const sized = new Uint8Array(1024 * per - 1);
  sized.set(data.subarray(0, Math.min(data.length, sized.length)));
  sized.set(data.subarray(0, 48), 0);
  const t = encodeTransmissionV4(sized, big, settings);
  assert.ok(t.K > 900 && t.K <= 1024, `K ${t.K}`);
  t.frameAt(t.sourceFrames);
  const start = performance.now();
  t.frameAt(t.sourceFrames + 1);
  const ms = performance.now() - start;
  assert.ok(ms < 30, `${ms} ms`);
});

test('source frames repeat byte for byte in every period', async () => {
  const odd = await encodePayload({ type: 'file', name: 'o', mime: 'application/octet-stream', data: seeded(30000, 3) });
  const t = encodeTransmissionV4(odd, layout, settings);
  assert.notEqual(t.K % t.packetsPerFrame, 0);
  for (let i = 0; i < t.sourceFrames; i++) assert.deepEqual(t.frameAt(i), t.frameAt(i + t.period));
  assert.notDeepEqual(t.frameAt(t.sourceFrames), t.frameAt(t.sourceFrames + t.period));
});

test('implausible headers are rejected and start no collection', () => {
  const c = new Collector();
  const f = read(tx, 0);
  c.add({ ...f, header: { ...f.header, sourceCount: 2000 } });
  assert.equal(c.status().crcFail, 1);
  assert.equal(c.status().count, 0);
  c.add({ ...f, header: { ...f.header, streamLength: f.header.streamLength + 1000 } });
  assert.equal(c.status().crcFail, 2);
  assert.equal(c.status().count, 0);
  assert.equal(c.add(f).count, tx.K);
});

test('createDecoder refuses more than 1,024 pieces', () => {
  assert.throws(() => createDecoder(1025, 214, 1), { code: 'TOO_MANY_PIECES' });
  assert.throws(() => createDecoder(0, 214, 1), RangeError);
});

test('status counts packets received and distinct symbols added, and stops feeding a finished decoder', () => {
  const c = new Collector();
  const f0 = read(tx, 0);
  c.add(f0);
  c.add(f0);
  let s = c.status();
  const good = f0.packets.filter(Boolean).length;
  assert.equal(s.received, 2 * good);
  assert.equal(s.fresh, good);
  for (let i = 1; i < tx.sourceFrames + 2 * tx.period && !c.status().complete; i++) c.add(read(tx, i));
  s = c.status();
  assert.equal(s.complete, true);
  const freshAtDone = s.fresh;
  const rankAtDone = c.decoder.rank();
  c.add(read(tx, 3));
  s = c.status();
  assert.equal(s.fresh, freshAtDone);
  assert.equal(c.decoder.rank(), rankAtDone);
  assert.ok(s.received > s.fresh);
});
