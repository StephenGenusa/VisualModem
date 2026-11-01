import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProbeSequence, FPS_SWEEP, PROBE_BLOCKS, PROBE_SCHEMES, PROBE_HOLD_MS, PROBE_FPS, SETTLE_MS,
} from '../src/optimize/probes.js';

test('constants', () => {
  assert.deepEqual(PROBE_BLOCKS, [45, 35, 28, 23, 19, 16, 13, 11, 9]);
  assert.deepEqual(PROBE_SCHEMES, ['cube2', 'g4', 'gray2', 'gray4']);
  assert.equal(PROBE_HOLD_MS, 2500); assert.equal(PROBE_FPS, 4); assert.equal(SETTLE_MS, 4000);
});

test('the sequence covers every block at or below the cap with every scheme in order', () => {
  const { probes } = createProbeSequence({ cap: 40, parity: 32 });
  assert.equal(probes.length, 5 * 8 + 10);
  assert.equal(probes[0].blockSize, 40);
  assert.deepEqual(probes.slice(0, 4).map((p) => p.schemeId), PROBE_SCHEMES);
  assert.ok(probes.slice(0, 4).every((p) => p.blockSize === 40));
  assert.deepEqual([...new Set(probes.map((p) => p.blockSize))], [40, 28, 23, 19, 16, 13, 11, 9, 35]);
  assert.deepEqual(probes[0].scheme, { kind: 'rgb', levels: [2, 2, 2] });
  assert.deepEqual(probes[3].scheme, { kind: 'gray', levels: 4 });
  const big = createProbeSequence({ cap: 120, parity: 32 }).probes;
  assert.equal(big.length, 5 * 9 + 10);
  assert.equal(big[0].blockSize, 45);
});

test('ids are unique and the loop time adds up', () => {
  const seq = createProbeSequence({ cap: 120, parity: 32 });
  assert.deepEqual(seq.probes.map((p) => p.id), seq.probes.map((_, i) => i + 1));
  assert.equal(seq.settleMs, SETTLE_MS);
  assert.ok(seq.probes.every((p) => typeof p.static === 'boolean' && p.holdMs === PROBE_HOLD_MS && p.parity === 32));
});
test('each probe has a label for the status line', () => {
  const { probes } = createProbeSequence({ cap: 120, parity: 32 });
  assert.deepEqual(probes.slice(0, 4).map((p) => p.label),
    ['Color cube, 2 levels', 'Green 4, red and blue 2', 'Black and white', '4 shades of gray']);
});
test('each block size starts with a characterization step', async () => {
  const { CHARACTERIZE_MS } = await import('../src/optimize/probes.js');
  const seq = createProbeSequence({ cap: 120, parity: 32 });
  assert.equal(CHARACTERIZE_MS, 2500);
  assert.equal(seq.steps.length, 9 * 6 + 10);
  assert.deepEqual(seq.steps.slice(0, 7).map((s) => s.kind), ['characterize', 'probe', 'probe', 'probe', 'probe', 'probe', 'characterize']);
  assert.equal(seq.steps[0].blockSize, 45); assert.equal(seq.steps[0].probeId, 1);
  assert.equal(seq.steps[6].blockSize, 35); assert.equal(seq.steps[6].probeId, 6);
  assert.equal(seq.steps[1].probe, seq.probes[0]);
  assert.equal(seq.loopMs, seq.steps.reduce((t, s) => t + s.holdMs, 0));
  assert.equal(seq.loopMs, 9 * 2500 + 55 * 2500);
});

test('each block has a static cube twin after its four probes', () => {
  const { probes } = createProbeSequence({ cap: 120, parity: 32 });
  for (let b = 0; b < 9; b++) {
    const group = probes.slice(b * 5, b * 5 + 5);
    assert.ok(group.every((p) => p.blockSize === group[0].blockSize));
    assert.deepEqual(group.slice(0, 4).map((p) => p.static), [false, false, false, false]);
    assert.ok(group.slice(0, 4).every((p) => p.fps === PROBE_FPS));
    const twin = group[4];
    assert.equal(twin.static, true); assert.equal(twin.schemeId, 'cube2');
    assert.equal(twin.fps, PROBE_FPS); assert.equal(twin.holdMs, PROBE_HOLD_MS);
    assert.deepEqual(twin.scheme, { kind: 'rgb', levels: [2, 2, 2] });
    assert.match(twin.label, /static/i);
  }
});
test('the frame rate sweep follows the blocks and skips blocks above the cap', () => {
  assert.deepEqual(FPS_SWEEP, { blocks: [35, 28], schemeId: 'cube2', fps: [4, 6, 7.5, 10, 15] });
  const all = createProbeSequence({ cap: 120, parity: 32 }).probes.slice(45);
  assert.deepEqual(all.map((p) => [p.blockSize, p.fps]), [35, 28].flatMap((b) => FPS_SWEEP.fps.map((f) => [b, f])));
  assert.ok(all.every((p) => !p.static && p.schemeId === 'cube2' && p.holdMs === PROBE_HOLD_MS));
  assert.ok(all.every((p) => p.label.includes(String(p.fps))));
  const { probes } = createProbeSequence({ cap: 30, parity: 32 });
  const sweep = probes.slice(5 * 7);
  assert.deepEqual(sweep.map((p) => [p.blockSize, p.fps]), FPS_SWEEP.fps.map((f) => [28, f]));
  assert.equal(new Set(probes.map((p) => p.id)).size, probes.length);
});
test('loop time adds up', () => {
  const seq = createProbeSequence({ cap: 45, parity: 32 });
  assert.equal(seq.loopMs, 160000);
});
