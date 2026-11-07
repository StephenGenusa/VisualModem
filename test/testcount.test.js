import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayoutV4 } from '../src/picture/layout.js';
import { schemeFromLevels } from '../src/core/scheme.js';
import { parseFrameV4 } from '../src/core/framev4.js';
import { FRAME_TYPES } from '../src/core/frame.js';
import { buildProbeFrameV4 } from '../src/optimize/probes.js';
import { attemptHeader } from '../src/optimize/readroute.js';
import { createTestCounter, createAimTracker } from '../src/optimize/testcount.js';

const hdr = (runId, probeId, symbolIds, extra = {}) => ({
  frameType: FRAME_TYPES.probe, streamLength: runId, probeId, ...(symbolIds ? { symbolIds } : {}), ...extra,
});

test('distinct pieces only: the same id read twice counts once', () => {
  const c = createTestCounter();
  c.add({ atMs: 100, header: hdr(7, 1, [1, 2, 3]) });
  c.add({ atMs: 200, header: hdr(7, 1, [2, 3, 4]) });
  const [t] = c.report();
  assert.equal(t.packets, 4);
  assert.equal(t.reads, 2);
  assert.equal(t.goodReads, 2);
  assert.equal(t.firstMs, 100);
  assert.equal(t.lastMs, 200);
  assert.equal(t.runId, 7);
  assert.equal(t.probeId, 1);
});

test('a late read of an earlier test counts for that test, not the current one', () => {
  const c = createTestCounter();
  c.add({ atMs: 100, header: hdr(7, 1, [1]) });
  c.add({ atMs: 200, header: hdr(7, 2, [1, 2]) });
  c.add({ atMs: 250, header: hdr(7, 1, [5, 6]) });
  const byId = Object.fromEntries(c.report().map((t) => [t.probeId, t]));
  assert.equal(byId[1].packets, 3);
  assert.equal(byId[1].reads, 2);
  assert.equal(byId[2].packets, 2);
  assert.equal(byId[2].reads, 1);
});

test('an earlier run id is ignored', () => {
  const c = createTestCounter();
  c.add({ atMs: 100, header: hdr(7, 1, [1]) });
  c.add({ atMs: 200, header: hdr(8, 1, [1, 2]) });
  c.add({ atMs: 300, header: hdr(7, 1, [9]) });
  const r = c.report();
  assert.equal(r.length, 1);
  assert.equal(r[0].runId, 8);
  assert.equal(r[0].packets, 2);
  assert.equal(r[0].reads, 1);
});

test('a probe header with no good packets is a read for its test; a read with no header is counted for none', () => {
  const c = createTestCounter();
  c.add({ atMs: 100, header: hdr(7, 1) });
  c.add({ atMs: 150, header: null });
  c.add({ atMs: 160, header: hdr(7, 1, []) });
  const r = c.report();
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].reads, r[0].goodReads, r[0].packets], [2, 0, 0]);
});

test('data and characterization frames are not tests', () => {
  const c = createTestCounter();
  c.add({ atMs: 1, header: { frameType: FRAME_TYPES.data, streamLength: 5, probeId: 0, symbolIds: [1] } });
  c.add({ atMs: 2, header: { frameType: FRAME_TYPES.characterization, streamLength: 5, probeId: 0 } });
  assert.deepEqual(c.report(), []);
});

test('the report stays small after 300 tests, and old tests fall out', () => {
  const c = createTestCounter();
  for (let id = 1; id <= 300; id++) c.add({ atMs: id * 10, header: hdr(7, id, [1, 2, 3]) });
  const r = c.report();
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((t) => t.probeId).sort((a, b) => a - b), [298, 299, 300]);
});

test('with a clock, tests not seen for a few seconds are left out', () => {
  const c = createTestCounter();
  c.add({ atMs: 1000, header: hdr(7, 1, [1]) });
  c.add({ atMs: 9000, header: hdr(7, 2, [1]) });
  assert.deepEqual(c.report({ nowMs: 9500 }).map((t) => t.probeId), [2]);
});

test('a real probe frame through attemptHeader reaches the counter with the right ids', () => {
  const layoutV4 = computeLayoutV4(137, 77);
  const probe = { id: 7, blockSize: 13, scheme: schemeFromLevels(2), parity: 32, fps: 4, static: false };
  const { frameBytes } = buildProbeFrameV4({ probe, txId: 0x5eed1234, index: 2, layoutV4, probeCount: 50, runId: 0xabcdef01 });
  const frame = parseFrameV4(frameBytes);
  frame.packets[1] = null; // one packet did not survive
  const c = createTestCounter();
  c.add({ atMs: 500, header: attemptHeader(frame.header, frame) });
  const [t] = c.report();
  assert.equal(t.runId, 0xabcdef01);
  assert.equal(t.probeId, 7);
  assert.equal(t.packets, frame.packets.filter(Boolean).length);
  assert.ok(t.packets > 0 && t.packets < frame.packets.length);
});

test('width share uses the aim calculation and is null without a recent aim', () => {
  const a = createAimTracker();
  assert.equal(a.get(0), null);
  const gridCorners = { tl: [100, 100], tr: [900, 100], bl: [100, 600], br: [900, 600] };
  a.note({ atMs: 1000, gridCorners, imageW: 1000, imageH: 800 });
  assert.ok(Math.abs(a.get(1500) - 0.8) < 1e-9);
  assert.equal(a.get(10000), null);
  a.note({ atMs: 11000, gridCorners, imageW: 1000, imageH: 800 });
  a.note({ atMs: 11100, gridCorners: null, imageW: 1000, imageH: 800 });
  assert.ok(Math.abs(a.get(11200) - 0.8) < 1e-9, 'one read with no grid keeps the last share');
  a.note({ atMs: 11300, gridCorners: { tl: [100, 100], tr: null, bl: [100, 600], br: null }, imageW: 1000, imageH: 800 });
  assert.ok(Math.abs(a.get(11400) - 0.8) < 1e-9, 'a read with an unplaced corner keeps it too');
  assert.equal(a.get(14500), null, 'only age blanks it');
});

test('reads with no header raise the camera totals and create no test entry', () => {
  const c = createTestCounter();
  c.add({ atMs: 1, header: null });
  c.add({ atMs: 2, header: null, markers: true });
  c.add({ atMs: 3, header: hdr(7, 1, [1]), markers: true });
  c.add({ atMs: 4, header: { frameType: FRAME_TYPES.data, streamLength: 0 } });
  assert.deepEqual(c.totals(), { cameraReads: 4, markerReads: 2 });
  assert.equal(c.report().length, 1);
  const d = createTestCounter();
  d.add({ atMs: 1, header: null });
  assert.deepEqual(d.report(), []);
  assert.equal(d.totals().cameraReads, 1);
});
