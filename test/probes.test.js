import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProbeSequence, FPS_SWEEP, PARITY_SWEEP, PROBE_BLOCKS, PROBE_SCHEMES, PROBE_HOLD_MS, PROBE_FPS, SETTLE_MS,
} from '../src/optimize/probes.js';

test('constants', () => {
  assert.deepEqual(PROBE_BLOCKS, [45, 35, 28, 23, 19, 16, 13, 11, 9]);
  assert.deepEqual(PROBE_SCHEMES, ['cube2', 'g4', 'gray2', 'gray4']);
  assert.equal(PROBE_HOLD_MS, 2500); assert.equal(PROBE_FPS, 4); assert.equal(SETTLE_MS, 4000);
});

test('the sequence covers every block at or below the cap with every scheme in order', () => {
  const { probes } = createProbeSequence({ cap: 40, parity: 32 });
  assert.equal(probes.length, 5 * 8 + 29 + 10);
  assert.equal(probes[0].blockSize, 40);
  assert.deepEqual(probes.slice(0, 4).map((p) => p.schemeId), PROBE_SCHEMES);
  assert.ok(probes.slice(0, 4).every((p) => p.blockSize === 40));
  assert.deepEqual([...new Set(probes.map((p) => p.blockSize))], [40, 28, 23, 19, 16, 13, 11, 9, 35]);
  assert.deepEqual(probes[0].scheme, { kind: 'rgb', levels: [2, 2, 2] });
  assert.deepEqual(probes[3].scheme, { kind: 'gray', levels: 4 });
  const big = createProbeSequence({ cap: 120, parity: 32 }).probes;
  assert.equal(big.length, 5 * 9 + 28 + 10);
  assert.equal(big[0].blockSize, 45);
});

test('ids are unique and the loop time adds up', () => {
  const seq = createProbeSequence({ cap: 120, parity: 32 });
  assert.deepEqual(seq.probes.map((p) => p.id), seq.probes.map((_, i) => i + 1));
  assert.equal(seq.settleMs, SETTLE_MS);
  assert.ok(seq.probes.every((p) => typeof p.static === 'boolean' && p.holdMs === PROBE_HOLD_MS));
  assert.ok(seq.probes.slice(0, 73).every((p) => p.parity === 32));
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
  assert.equal(seq.steps.length, 9 * 6 + 28 + 10);
  assert.deepEqual(seq.steps.slice(0, 7).map((s) => s.kind), ['characterize', 'probe', 'probe', 'probe', 'probe', 'probe', 'characterize']);
  assert.equal(seq.steps[0].blockSize, 45); assert.equal(seq.steps[0].probeId, 1);
  assert.equal(seq.steps[6].blockSize, 35); assert.equal(seq.steps[6].probeId, 6);
  assert.equal(seq.steps[1].probe, seq.probes[0]);
  assert.equal(seq.loopMs, seq.steps.reduce((t, s) => t + s.holdMs, 0));
  assert.equal(seq.loopMs, 9 * 2500 + 83 * 2500);
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
const key = (p) => [p.blockSize, p.schemeId, p.fps, p.static, p.parity].join('|');
// The block loop is five probes per block; the frame rate sweep follows it.
const loopEnd = (cap) => 5 * createProbeSequence({ cap, parity: 32 }).steps.filter((st) => st.kind === 'characterize').length;
test('the frame rate sweep follows the blocks and skips blocks above the cap', () => {
  assert.deepEqual(FPS_SWEEP, { blocks: [35, 28, 23, 19], schemeId: 'cube2', fps: [4, 6, 7.5, 10, 12, 15, 20, 30] });
  const seq = createProbeSequence({ cap: 120, parity: 32 });
  const all = seq.probes.slice(loopEnd(120), loopEnd(120) + 28);
  // 4 fps at blocks 35, 28, 23 and 19 is already in the block loop, so the sweep leaves it out
  assert.deepEqual(all.map((p) => [p.blockSize, p.fps]), [35, 28, 23, 19].flatMap((b) => FPS_SWEEP.fps.filter((f) => f !== 4).map((f) => [b, f])));
  assert.ok(all.every((p) => !p.static && p.schemeId === 'cube2' && p.holdMs === PROBE_HOLD_MS));
  assert.ok(all.every((p) => p.label.includes(String(p.fps))));
  for (const b of FPS_SWEEP.blocks) {
    assert.ok(seq.probes.some((p) => p.blockSize === b && p.schemeId === 'cube2' && !p.static && p.fps === 4 && p.parity === 32), `4 fps is measured at block ${b}`);
  }
  const { probes } = createProbeSequence({ cap: 30, parity: 32 });
  const sweep = probes.slice(loopEnd(30), loopEnd(30) + 8); // block 28 is not in this loop, so it keeps its 4 fps probe
  for (const f of [12, 20, 30]) assert.ok(sweep.some((p) => p.fps === f), `the sweep covers ${f} fps`);
  assert.deepEqual(sweep.map((p) => [p.blockSize, p.fps]), FPS_SWEEP.fps.map((f) => [28, f]));
  assert.equal(new Set(probes.map((p) => p.id)).size, probes.length);
});
test('the sweep covers blocks 23 and 19', () => {
  const { probes } = createProbeSequence({ cap: 120, parity: 32 });
  for (const b of [23, 19]) {
    for (const f of [6, 7.5, 10, 12, 15, 20, 30]) {
      assert.ok(probes.some((p) => p.blockSize === b && p.schemeId === 'cube2' && !p.static && p.fps === f && p.parity === 32), `block ${b} at ${f} fps`);
    }
  }
  const keys = probes.map(key);
  assert.equal(new Set(keys).size, keys.length);
});
test('loop time adds up', () => {
  const seq = createProbeSequence({ cap: 45, parity: 32 });
  assert.equal(seq.loopMs, 230000);
});

const parityProbes = (parity, cap = 120) => createProbeSequence({ cap, parity }).probes.slice(73);

test('the sweep adds parity steps at block 28', () => {
  assert.deepEqual(PARITY_SWEEP, { blockSize: 28, schemeId: 'cube2', fps: [10, 15], parity: [0, 8, 16, 24, 48] });
  const added = parityProbes(32);
  assert.equal(added.length, 10);
  assert.deepEqual(added.map((p) => [p.parity, p.fps]), PARITY_SWEEP.parity.flatMap((q) => PARITY_SWEEP.fps.map((f) => [q, f])));
  assert.ok(added.every((p) => p.blockSize === 28 && p.schemeId === 'cube2' && !p.static && p.holdMs === PROBE_HOLD_MS));
  assert.ok(added.every((p) => p.label.endsWith(`, parity ${p.parity}`)));
  const seq = createProbeSequence({ cap: 120, parity: 32 });
  assert.deepEqual(seq.probes.map((p) => p.id), seq.probes.map((_, i) => i + 1));
  assert.equal(seq.steps.length, 9 * 6 + 28 + 10);
});

test('no duplicate probe when the slider\'s parity is in the sweep', () => {
  for (const [parity, extra] of [[16, 8], [32, 10]]) {
    for (const cap of [120, 45, 28]) {
      const { probes } = createProbeSequence({ cap, parity });
      const keys = probes.map(key);
      assert.equal(new Set(keys).size, keys.length, `parity ${parity}, cap ${cap}`);
      assert.deepEqual(probes.map((p) => p.id), probes.map((_, i) => i + 1));
    }
    assert.equal(createProbeSequence({ cap: 120, parity }).probes.length - loopEnd(120) - 28, extra);
  }
});

test('no parity sweep on a screen whose cap is under 28', () => {
  const { probes } = createProbeSequence({ cap: 27, parity: 32 });
  assert.ok(probes.every((p) => p.parity === 32));
  assert.ok(!probes.some((p) => p.label.includes('parity')));
});

test('probes carry the white they show and are not refine probes', () => {
  const { probes, steps } = createProbeSequence({ cap: 40, parity: 32, white: 223 });
  assert.ok(probes.every((p) => p.white === 223 && !p.refine));
  assert.ok(steps.filter((s) => s.kind === 'characterize').every((s) => s.white === 223));
  assert.ok(createProbeSequence({ cap: 40, parity: 32 }).probes.every((p) => p.white === 255));
});

test('the fixed Refine is gone', async () => {
  const probes = await import('../src/optimize/probes.js');
  for (const name of ['createRefineSequence', 'REFINE_FPS', 'REFINE_HOLD_MS']) assert.equal(probes[name], undefined, name);
});
