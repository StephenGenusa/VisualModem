import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackBuffer } from '../tools/feedback.js';

const entry = (n) => ({ tests: { 1: { attempts: 8, ok: n, frame: 0, markers: 0 } } });

test('sequence numbers increase and since returns only newer entries', () => {
  const buffer = createFeedbackBuffer();
  assert.equal(buffer.add(entry(1), 1000), 1);
  assert.equal(buffer.add(entry(2), 2000), 2);
  assert.equal(buffer.add(entry(3), 3000), 3);
  const newer = buffer.since(1);
  assert.deepEqual(newer.entries.map((e) => e.seq), [2, 3]);
  assert.equal(newer.entries[0].atMs, 2000);
  assert.equal(newer.entries[0].tests[1].ok, 2);
  assert.deepEqual(buffer.since(3), { seq: 3, entries: [] });
});

test('the buffer keeps the newest entries only', () => {
  const buffer = createFeedbackBuffer(5);
  for (let i = 1; i <= 8; i++) buffer.add(entry(i), i);
  assert.deepEqual(buffer.since(0).entries.map((e) => e.seq), [4, 5, 6, 7, 8]);
});

test('entries keep tests, health and collector', () => {
  const buffer = createFeedbackBuffer();
  const entry = {
    tests: { 3: { attempts: 8, ok: 2, frame: 5, markers: 1 } },
    health: { visible: true, camera: 'running', noMarkersStreak: 0, video: { width: 1920, height: 1080, resolution: '1080p' } },
    collector: { txId: 77, count: 1, have: 1, complete: true },
    attemptMs: [120, 130],
  };
  buffer.add(entry, 1000);
  const [got] = buffer.since(0).entries;
  assert.deepEqual(got.tests, entry.tests);
  assert.deepEqual(got.health, entry.health);
  assert.deepEqual(got.collector, entry.collector);
  assert.deepEqual(got.attemptMs, entry.attemptMs);
});

test("entries keep the phone's counts for the current test", () => {
  const buffer = createFeedbackBuffer();
  const counts = [{ runId: 7, probeId: 3, packets: 40, reads: 12, goodReads: 10, firstMs: 100, lastMs: 900 }];
  buffer.add({ testCounts: counts, cameraReads: 120, markerReads: 90, widthShare: 0.65 }, 1000);
  buffer.add({}, 2000);
  const [got, bare] = buffer.since(0).entries;
  assert.deepEqual(got.testCounts, counts);
  assert.equal(got.cameraReads, 120);
  assert.equal(got.markerReads, 90);
  assert.equal(got.widthShare, 0.65);
  assert.deepEqual(bare.testCounts, []);
  assert.equal(bare.cameraReads, null);
  assert.equal(bare.widthShare, null);
});

test('bad values in a report are dropped, not stored', () => {
  const buffer = createFeedbackBuffer();
  const good = { runId: 7, probeId: 3, packets: 40, reads: 12, goodReads: 10, firstMs: 100.5, lastMs: 900.25 };
  const cases = [
    [{ testCounts: 'many' }, []],
    [{ testCounts: { length: 1 } }, []],
    [{ testCounts: [null, 7, 'x', [], {}, { ...good, packets: -1 }, { ...good, reads: '12' }, { ...good, firstMs: null }, { ...good, lastMs: 1e308 }, good] }, [good]],
    [{ testCounts: Array.from({ length: 500 }, () => good) }, [good, good, good]],
    [{ testCounts: [{ ...good, extra: 'x'.repeat(50) }] }, [good]],
  ];
  for (const [report, want] of cases) {
    buffer.add(report, 1);
    assert.deepEqual(buffer.since(buffer.since(0).seq - 1).entries[0].testCounts, want);
  }
  for (const [field, bad] of [['cameraReads', -1], ['cameraReads', 'x'], ['cameraReads', 1e308], ['markerReads', -5], ['markerReads', {}], ['widthShare', -0.1], ['widthShare', 1.5], ['widthShare', '0.5']]) {
    buffer.add({ [field]: bad }, 1);
    assert.equal(buffer.since(buffer.since(0).seq - 1).entries[0][field], null, `${field} ${bad}`);
  }
  buffer.add({ cameraReads: 0, markerReads: 0, widthShare: 1 }, 1);
  const last = buffer.since(buffer.since(0).seq - 1).entries[0];
  assert.deepEqual([last.cameraReads, last.markerReads, last.widthShare], [0, 0, 1]);
});

test('the feedback buffer keeps a valid Probe best and drops a malformed one', () => {
  const best = { blockSize: 23, scheme: 'g4', levels: 2, parity: 32, fps: 7.5, white: 255, bytesPerSecond: 20000 };
  const keep = (b) => {
    const buffer = createFeedbackBuffer();
    buffer.add({ ...entry(1), setup: { best: b } }, 1);
    return buffer.since(0).entries[0].probeBest;
  };
  assert.deepEqual(keep({ ...best, extra: 'x' }), best);
  assert.equal(keep(undefined), null);
  const { fps, ...missing } = best;
  assert.equal(keep(missing), null);
  assert.equal(keep({ ...best, bytesPerSecond: -1 }), null);
  assert.equal(keep({ ...best, blockSize: 201 }), null);
  assert.equal(keep({ ...best, scheme: 'plaid' }), null);
  assert.equal(keep({ ...best, fps: '10' }), null);
  assert.equal(keep({ ...best, levels: 3 }), null);
  assert.equal(keep({ ...best, white: 0 }), null);
  // Parity has the Send page's range: even, 0 to 128.
  assert.equal(keep({ ...best, parity: 128 }).parity, 128);
  assert.equal(keep({ ...best, parity: 80 }).parity, 80);
  assert.equal(keep({ ...best, parity: 130 }), null);
  assert.equal(keep({ ...best, parity: 33 }), null);
  const buffer = createFeedbackBuffer();
  buffer.add(entry(1), 1);
  assert.equal(buffer.since(0).entries[0].probeBest, null);
});
