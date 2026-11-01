import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../src/picture/layout.js';
import { encodePayload, decodePayload } from '../src/core/payload.js';
import { renderFrame } from '../src/picture/render.js';
import { readImageFrame } from '../src/picture/filereader.js';
import { encodeTransmission, frameCount, Collector } from '../src/core/transmission.js';

const layout = computeLayout(40, 30);
const settings = { blockSize: 4, levels: 4, parity: 32 };

test('multi frame round trip through render and file reader', async () => {
  const record = { type: 'message', name: '', mime: 'text/plain',
    data: new TextEncoder().encode(Array.from({ length: 400 }, (_, i) => `line ${i} ${Math.sin(i)}`).join('\n')) };
  const stream = await encodePayload(record);
  const tx = encodeTransmission(stream, layout, settings);
  assert.ok(tx.count > 1);
  const c = new Collector();
  for (const index of [...tx.frames.keys()].reverse()) { // out of order on purpose
    const img = renderFrame({ frameBytes: tx.frames[index], index, levels: 4, blockSize: 4, layout });
    const read = readImageFrame(img);
    c.add(read.frame);
  }
  assert.equal(c.status().complete, true);
  assert.deepEqual(c.stream(), stream);
  assert.deepEqual(await decodePayload(c.stream()), record);
});
test('a new transmission id resets the collector', () => {
  const c = new Collector({ now: () => 5 });
  c.add({ header: { txId: 1, index: 0, count: 2 }, payload: new Uint8Array([1]) });
  assert.equal(c.status().have, 1);
  c.add({ header: { txId: 2, index: 1, count: 2 }, payload: new Uint8Array([2]) });
  assert.deepEqual(c.status(), { txId: 2, count: 2, have: 1, complete: false, unit: 'frames', elapsedMs: 0, crcPass: 1, crcFail: 0 });
});
test('duplicate frames are ignored and failures are counted', () => {
  const c = new Collector();
  c.add({ header: { txId: 1, index: 0, count: 1 }, payload: new Uint8Array([1]) });
  c.add({ header: { txId: 1, index: 0, count: 1 }, payload: new Uint8Array([9]) });
  c.noteFailure();
  assert.deepEqual(c.stream(), new Uint8Array([1]));
  assert.equal(c.status().crcFail, 1);
});
test('too large for the settings', async () => {
  const stream = await encodePayload({ type: 'file', name: 'x', mime: 'application/octet-stream',
    data: Uint8Array.from({ length: 3_000_000 }, (_, i) => (i * 2654435761) >>> 24) });
  const tiny = computeLayout(33, 20);
  // parity 128 leaves zero capacity on the smallest grid at 2 levels
  assert.equal(frameCount(stream.length, tiny, { blockSize: 4, levels: 2, parity: 128 }), null);
  assert.throws(() => encodeTransmission(stream, tiny, { blockSize: 4, levels: 2, parity: 128 }), { code: 'PAYLOAD_TOO_LARGE' });
  // parity 0 has capacity, but 10 MB needs more than 65535 frames
  assert.equal(frameCount(10_000_000, tiny, { blockSize: 4, levels: 2, parity: 0 }), null);
  assert.ok(frameCount(1000, tiny, { blockSize: 4, levels: 2, parity: 0 }) > 1);
});
test('out of range indexes are rejected and do not complete the set', () => {
  const c = new Collector();
  c.add({ header: { txId: 1, index: 0, count: 2 }, payload: new Uint8Array([1]) });
  c.add({ header: { txId: 1, index: 5, count: 2 }, payload: new Uint8Array([9]) });
  const s = c.status();
  assert.equal(s.have, 1); assert.equal(s.complete, false); assert.equal(s.crcFail, 1);
  assert.equal(c.stream(), null);
  c.add({ header: { txId: 1, index: 1, count: 2 }, payload: new Uint8Array([2]) });
  assert.equal(c.status().complete, true);
  assert.deepEqual(c.stream(), new Uint8Array([1, 2]));
});
test('same txId with a new parity resets the collector', () => {
  const c = new Collector();
  const h = (index, parity) => ({ txId: 1, index, count: 3, blockSize: 16, levels: 4, parity });
  c.add({ header: h(0, 32), payload: new Uint8Array([1]) });
  c.add({ header: h(1, 32), payload: new Uint8Array([2]) });
  c.add({ header: h(2, 34), payload: new Uint8Array([9]) });
  assert.equal(c.status().have, 1);
  assert.equal(c.frames.has(0), false);
  assert.equal(c.frames.has(1), false);
  assert.deepEqual(c.frames.get(2), new Uint8Array([9]));
});
test('same txId with a new frame count resets and adopts the count', () => {
  const c = new Collector();
  const h = (index, count) => ({ txId: 1, index, count, blockSize: 16, levels: 4, parity: 32 });
  c.add({ header: h(0, 6), payload: new Uint8Array([1]) });
  c.add({ header: h(1, 6), payload: new Uint8Array([2]) });
  c.add({ header: h(3, 7), payload: new Uint8Array([4]) });
  const s = c.status();
  assert.equal(s.have, 1);
  assert.equal(s.count, 7);
  assert.equal(s.crcFail, 0);
});
test('same txId with a new block size or levels resets the collector', () => {
  const c = new Collector();
  c.add({ header: { txId: 1, index: 0, count: 2, blockSize: 16, levels: 4, parity: 32 }, payload: new Uint8Array([1]) });
  c.add({ header: { txId: 1, index: 1, count: 2, blockSize: 12, levels: 4, parity: 32 }, payload: new Uint8Array([2]) });
  assert.equal(c.status().have, 1);
  c.add({ header: { txId: 1, index: 0, count: 2, blockSize: 12, levels: 8, parity: 32 }, payload: new Uint8Array([3]) });
  assert.equal(c.status().have, 1);
  assert.equal(c.frames.has(1), false);
});
test('a transmission at rgb 2/4/2 collects and reassembles', async () => {
  const { frameToBlocks, blocksToFrameBytes, parseFrame, HEADER_SCHEME } = await import('../src/core/frame.js');
  const { schemeThresholds } = await import('../src/core/symbols.js');
  const scheme = { kind: 'rgb', levels: [2, 4, 2] };
  const record = { type: 'message', name: '', mime: 'text/plain',
    data: new TextEncoder().encode(Array.from({ length: 300 }, (_, i) => `row ${i} ${Math.cos(i)}`).join('\n')) };
  const stream = await encodePayload(record);
  const tx = encodeTransmission(stream, layout, { blockSize: 4, scheme, parity: 32 });
  assert.ok(tx.count > 1);
  const c = new Collector();
  for (const bytes of tx.frames) {
    const rgb = frameToBlocks(bytes, scheme, layout.dataBlockCount);
    const read = parseFrame(blocksToFrameBytes(rgb, scheme, schemeThresholds(HEADER_SCHEME), schemeThresholds(scheme)));
    assert.deepEqual(read.header.scheme, scheme);
    c.add(read);
  }
  assert.equal(c.status().complete, true);
  assert.deepEqual(await decodePayload(c.stream()), record);
});
test('same txId with a new scheme resets the collector', () => {
  const c = new Collector();
  const h = (index, scheme) => ({ txId: 1, index, count: 3, blockSize: 16, scheme, parity: 32 });
  c.add({ header: h(0, { kind: 'gray', levels: 4 }), payload: new Uint8Array([1]) });
  c.add({ header: h(1, { kind: 'rgb', levels: [2, 4, 2] }), payload: new Uint8Array([2]) });
  assert.equal(c.status().have, 1);
});
