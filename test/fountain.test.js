import { test } from 'node:test';
import assert from 'node:assert/strict';
import { random32 } from '../src/optimize/prbs.js';
import { MAX_SOURCE, repairRow, createEncoder, createDecoder } from '../src/core/fountain.js';

function bytes(n, seed) {
  const next = random32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next() & 0xff;
  return out;
}

function shuffled(n, seed) {
  const next = random32(seed);
  const ids = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

test('the source pieces come first, zero padded', () => {
  const stream = bytes(1000, 1);
  const enc = createEncoder(stream, 216, 3);
  assert.equal(enc.K, 5);
  const last = enc.symbol(4);
  assert.equal(last.length, 216);
  assert.deepEqual([...last.subarray(0, 136)], [...stream.subarray(864, 1000)]);
  assert.ok(last.subarray(136).every((b) => b === 0));
  assert.deepEqual([...enc.symbol(1)], [...stream.subarray(216, 432)]);
});

test('a repair row depends only on txId, symbol id and K, and never covers past K', () => {
  assert.deepEqual(repairRow(9, 75, 70), repairRow(9, 75, 70));
  for (let id = 70; id < 200; id++) {
    const row = repairRow(5, id, 70);
    assert.equal(row.length, 3);
    assert.equal(row[2] >>> 6, 0); // bits 70..95 are the top 26 bits of word 2
    assert.ok(row.some((w) => w !== 0));
  }
  assert.notDeepEqual(repairRow(5, 70, 70), repairRow(5, 71, 70));
});

test('a phone that reads every source piece is done without repairs', () => {
  const stream = bytes(50 * 33, 2);
  const enc = createEncoder(stream, 33, 4);
  const dec = createDecoder(enc.K, 33, 4);
  for (let i = 0; i < 50; i++) {
    assert.equal(dec.done(), false);
    assert.equal(dec.stream(), null);
    dec.add(i, enc.symbol(i));
  }
  assert.ok(dec.done());
  assert.deepEqual(dec.stream(), stream);
});

test('a stream that is not a multiple of the piece size round trips with exact lengths', () => {
  const stream = bytes(1001, 3);
  const enc = createEncoder(stream, 7, 11);
  const dec = createDecoder(enc.K, 7, 11);
  for (let id = enc.K; !dec.done(); id++) dec.add(id, enc.symbol(id));
  const out = dec.stream();
  assert.equal(out.length, enc.K * 7);
  assert.deepEqual(out.subarray(0, 1001), stream);
});

test('a single piece decodes', () => {
  const stream = bytes(5, 4);
  const enc = createEncoder(stream, 16, 1);
  assert.equal(enc.K, 1);
  const dec = createDecoder(1, 16, 1);
  assert.ok(dec.add(1, enc.symbol(1)));
  assert.ok(dec.done());
  assert.deepEqual(dec.stream().subarray(0, 5), stream);
});

test('1,000 pieces decode from any 1,050 in under one second', () => {
  const stream = bytes(1000 * 216, 5);
  const enc = createEncoder(stream, 216, 7);
  const ids = shuffled(3000, 99).slice(0, 1050);
  const pieces = ids.map((id) => [id, enc.symbol(id)]);
  // The fastest of three, so other work on the machine does not fail the test.
  let dec, ms = Infinity;
  for (let i = 0; i < 3; i++) {
    dec = createDecoder(enc.K, 216, 7);
    const t0 = performance.now();
    for (const [id, data] of pieces) dec.add(id, data);
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(dec.done());
  assert.deepEqual(dec.stream(), stream);
});

test('repairs alone rebuild the file with about two extra pieces', () => {
  const K = 200;
  const stream = bytes(K * 16, 6);
  let extra = 0;
  for (let trial = 0; trial < 40; trial++) {
    const enc = createEncoder(stream, 16, 1000 + trial);
    const dec = createDecoder(K, 16, 1000 + trial);
    let n = 0;
    for (let id = K; !dec.done(); id++) {
      dec.add(id, enc.symbol(id));
      n++;
      assert.ok(n <= K + 40, 'trial ran past K + 40');
    }
    assert.deepEqual(dec.stream(), stream);
    extra += n - K;
  }
  assert.ok(extra / 40 <= 10, `mean extra ${extra / 40}`);
});

test('a duplicate or dependent piece does not raise the rank', () => {
  const enc = createEncoder(bytes(10 * 16, 7), 16, 2);
  const dec = createDecoder(10, 16, 2);
  assert.equal(dec.add(3, enc.symbol(3)), true);
  assert.equal(dec.rank(), 1);
  assert.equal(dec.add(3, enc.symbol(3)), false);
  assert.equal(dec.rank(), 1);
});

test('a phone near full rank reduces a frame of packets quickly', () => {
  const K = 1024;
  const enc = createEncoder(bytes(K * 216, 8), 216, 5);
  const dec = createDecoder(K, 216, 5);
  let id = K;
  for (let i = 0; i < 1000; i++) dec.add(id++, enc.symbol(id - 1));
  const pieces = [];
  for (let i = 0; i < 47; i++) pieces.push([id, enc.symbol(id++)]);
  const t0 = performance.now();
  for (const [pid, data] of pieces) dec.add(pid, data);
  const ms = performance.now() - t0;
  assert.ok(ms < 20, `took ${ms} ms`);
});

test('too many pieces is refused', () => {
  assert.equal(MAX_SOURCE, 1024);
  assert.throws(() => createEncoder(new Uint8Array(1025 * 16), 16, 1), { code: 'TOO_MANY_PIECES' });
  assert.throws(() => createEncoder(new Uint8Array(0), 16, 1), { code: 'EMPTY_PAYLOAD' });
});
