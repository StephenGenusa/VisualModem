import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptRecord, createAttemptLog, summarizeAttempts, MAX_ATTEMPT_BYTES } from '../src/optimize/attemptlog.js';

const rec = (over = {}) => ({
  t: 0, grabMs: 0, decodeMs: 30, stage: 'ok', probeId: 1, frameType: 2, blockSize: 9, scheme: 'rgb 2/2/2',
  fps: 4, static: false, txId: 1, index: 0, ok: true, corrected: 0, margin: 0.5, cols: 200, rows: 112, err: null, ...over,
});

test('the log keeps the newest records and counts the dropped', () => {
  const log = createAttemptLog({ max: 120 });
  for (let i = 0; i < 130; i++) log.add(rec({ t: i }));
  const { attempts, dropped } = log.drain();
  assert.equal(attempts.length, 120);
  assert.equal(dropped, 10);
  assert.equal(attempts[0].t, 10);
  assert.equal(log.drain().attempts.length, 0);
});

test('one drained post stays under the byte budget at 4K block 9', () => {
  // 426x240 cells, g4 at 4 bits a cell: about 196 codewords. A bad link: many byte errors, many flagged.
  const errors = {
    cells: 102240, cellErrors: 30000, shifts: 9000, region: { errors: new Array(25).fill(1200), cells: new Array(25).fill(4000) },
    codewords: Array.from({ length: 196 }, (_, i) => ({ errors: 20 + (i % 90), flagged: 40 + (i % 60), flaggedErrors: 10 + (i % 30) })),
  };
  const log = createAttemptLog({ max: 120 });
  for (let i = 0; i < 120; i++) {
    log.add(attemptRecord({
      atMs: 1700000000000 + i, grabMs: 1234567.5, decodeMs: 31.4159,
      read: { margin: 0.4321, cols: 426, rows: 240, frameHeader: null },
      frame: null,
      debug: { stage: 'payload failed', header: { frameType: 2, probeId: 7, blockSize: 9, scheme: { kind: 'rgb', levels: [4, 2, 2] }, probeFps: 7.5, probeStatic: false, txId: 4000000000, index: 11 } },
      errors,
    }));
  }
  const { attempts, dropped } = log.drain();
  assert.ok(JSON.stringify({ attempts, dropped }).length < MAX_ATTEMPT_BYTES + 100);
  assert.ok(attempts.length > 0);
  assert.equal(attempts.length + dropped, 120);
  assert.ok(dropped > 0);
  assert.equal(attempts.at(-1).t, 1700000000119); // the newest survive
});

test('new frames per second counts each frame once', () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(rec({ txId: 7, index: i % 4 }));
  const [row, ...rest] = summarizeAttempts(records);
  assert.equal(rest.length, 0);
  assert.equal(row.okFrames, 4);
  assert.equal(row.showings, 1);
  assert.equal(row.newFramesPerSecond, 4 / 2.5);
});

test('rows split static twins and frame rates', () => {
  const rows = summarizeAttempts([rec({ fps: 4 }), rec({ fps: 7.5 }), rec({ fps: 7.5, static: true })]);
  assert.equal(rows.length, 3);
});

test('predicted success uses the codeword histogram', () => {
  const err = () => ({
    cells: 100, cellErrors: 1, shifts: 0, region: new Array(25).fill(0),
    cw: [0, 10, 20], cwFlagged: [0, 0, 0], cwFlaggedErr: [0, 0, 0],
  });
  const [row] = summarizeAttempts([rec({ err: err() }), rec({ err: err(), index: 1 })]);
  assert.equal(row.predicted[32].plain, 2 / 3);
  assert.equal(row.predicted[16].plain, 1 / 3);
});

test('attempts with no full codeword stay out of the predicted averages', () => {
  const none = { cells: 1, cellErrors: 0, shifts: 0, region: new Array(25).fill(0), cw: [], cwFlagged: [], cwFlaggedErr: [] };
  const some = { ...none, cw: [0, 0], cwFlagged: [0, 0], cwFlaggedErr: [0, 0] };
  const [row] = summarizeAttempts([rec({ err: none }), rec({ err: some, index: 1 })]);
  assert.equal(row.predicted[0].plain, 1);
});

const cwErr = (cw) => ({
  cells: 100, cellErrors: 1, shifts: 0, region: new Array(25).fill(0),
  cw, cwFlagged: cw.map(() => 0), cwFlaggedErr: cw.map(() => 0),
});

test('predicted frame success needs every codeword of the attempt to pass', () => {
  // Errors of 16 pass at parity 32 (16 <= 32 / 2), 10 and 16 fail at 16.
  const [row] = summarizeAttempts([rec({ err: cwErr([0, 10, 16]) }), rec({ err: cwErr([0, 0, 0]), index: 1 })]);
  assert.equal(row.predictedFrame[32].plain, 1);
  assert.equal(row.predictedFrame[16].plain, 0.5);
  assert.equal(row.predictedFrame[16].erasures, 0.5);
  // The per codeword share stays as it was: 5 of 6 codewords pass at 16.
  assert.ok(Math.abs(row.predicted[16].plain - 4 / 6) < 1e-12);
});

test('predicted frame success is lower than the codeword share when one codeword fails', () => {
  const [row] = summarizeAttempts([rec({ err: cwErr([0, 10, 20]) }), rec({ err: cwErr([0, 0, 0]), index: 1 })]);
  assert.ok(Math.abs(row.predicted[32].plain - 5 / 6) < 1e-12);
  assert.equal(row.predictedFrame[32].plain, 0.5);
  assert.equal(row.predictedFrame[48].plain, 1);
});

test('predicted frame success skips attempts with no full codeword', () => {
  const none = { ...cwErr([]) };
  const [row] = summarizeAttempts([rec({ err: none }), rec({ err: cwErr([0]), index: 1 })]);
  assert.equal(row.predictedFrame[0].plain, 1);
  const [empty] = summarizeAttempts([rec({ err: none })]);
  assert.deepEqual(empty.predictedFrame[32], { plain: null, erasures: null });
});

test('ok share counts ok attempts, not distinct frames', () => {
  const records = [rec(), rec(), rec({ ok: false, stage: 'payload failed' }), rec({ ok: false, stage: 'payload failed' })];
  const [row] = summarizeAttempts(records);
  assert.equal(row.okShare, 0.5);
  assert.equal(row.okFrames, 1);
});

test('attempts per second divides by the probe hold time of every showing', () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(rec({ txId: 1 }));
  for (let i = 0; i < 5; i++) records.push(rec({ txId: 2 }));
  const [row] = summarizeAttempts(records);
  assert.equal(row.attemptsPerSecond, 15 / 5);
});

test('decode time median', () => {
  const [row] = summarizeAttempts([rec({ decodeMs: 10 }), rec({ decodeMs: 50 }), rec({ decodeMs: 20 })]);
  assert.equal(row.decodeMsMedian, 20);
  const [even] = summarizeAttempts([rec({ decodeMs: 10 }), rec({ decodeMs: 20 })]);
  assert.equal(even.decodeMsMedian, 15);
});

test('grab gap median is taken within a showing, never across showings', () => {
  const records = [
    rec({ txId: 1, grabMs: 1000 }), rec({ txId: 1, grabMs: 1100 }), rec({ txId: 1, grabMs: 1300 }),
    rec({ txId: 2, grabMs: 9000 }), rec({ txId: 2, grabMs: 9150 }),
  ];
  const [row] = summarizeAttempts(records);
  assert.equal(row.grabGapMedian, 150); // gaps 100, 200, 150; the 7700 between showings is not one
  const [one] = summarizeAttempts([rec({ txId: 1, grabMs: 5 }), rec({ txId: 2, grabMs: 50 })]);
  assert.equal(one.grabGapMedian, null);
});

test('the report row has a partial gain from the packet masks', () => {
  const base = { blockSize: 20, scheme: 'x', fps: 4, static: false, stage: 'ok', txId: 1, index: 0, decodeMs: 1, grabMs: 1, ok: true };
  const [row] = summarizeAttempts([{ ...base, packetMask: '1111' }, { ...base, packetMask: '1100' }, { ...base, packetMask: '0000' }]);
  assert.equal(row.partialGain, (0.5 + 0.5 * 0 + 1 / 3 * 0) > 0 ? (1.5 / 3) / (1 / 3) : null);
});
