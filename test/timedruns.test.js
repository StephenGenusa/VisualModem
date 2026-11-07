import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOrder, summarise, tCritical95, RUN_COUNTS, DEFAULT_RUN_COUNT, RUN_LIMIT_MS, STALL_MS } from '../src/optimize/timedruns.js';
import { saveTimed, loadTimed } from '../src/optimize/timedruns.js';

const ok = (which, ms) => ({ which, ms, failed: null });
const BYTES = 204800;

test('constants', () => {
  assert.deepEqual(RUN_COUNTS, [3, 5, 10]);
  assert.equal(DEFAULT_RUN_COUNT, 5);
  assert.equal(RUN_LIMIT_MS, 180000);
  assert.equal(STALL_MS, 30000);
});

test('run order alternates A and B, or repeats A alone', () => {
  assert.deepEqual(runOrder(3, false), ['a', 'a', 'a']);
  assert.deepEqual(runOrder(2, true), ['a', 'b', 'a', 'b']);
});

test('separated times summarise per side and differ', () => {
  const r = summarise([ok('a', 6000), ok('b', 7500), ok('a', 6500), ok('b', 8000), ok('a', 7000), ok('b', 8500)], BYTES);
  assert.equal(r.a.mean, 6500);
  assert.equal(r.a.min, 6000);
  assert.equal(r.a.max, 7000);
  assert.deepEqual(r.a.times, [6000, 6500, 7000]);
  assert.equal(r.a.bytesPerSecond, BYTES / 6.5);
  assert.equal(r.b.mean, 8000);
  assert.equal(r.b.bytesPerSecond, BYTES / 8);
  assert.equal(r.differ, true);
});

test('overlapping times do not differ', () => {
  const r = summarise([ok('a', 6000), ok('b', 6500), ok('a', 7500), ok('b', 7000)], BYTES);
  assert.equal(r.differ, false);
});

test('without B, b and differ are null', () => {
  const r = summarise([ok('a', 6000), ok('a', 6100)], BYTES);
  assert.equal(r.b, null);
  assert.equal(r.differ, null);
});

test('a failed run counts as failed, not in the times', () => {
  const r = summarise([ok('a', 6000), { which: 'a', ms: null, failed: 'stalled' }, ok('a', 7000)], BYTES);
  assert.equal(r.a.failed, 1);
  assert.deepEqual(r.a.times, [6000, 7000]);
  assert.equal(r.a.mean, 6500);
});

test('a side with no completed run has a null mean and differ is null', () => {
  const r = summarise([{ which: 'a', ms: null, failed: 'stalled' }, ok('b', 7000), ok('b', 7100)], BYTES);
  assert.equal(r.a.mean, null);
  assert.equal(r.a.bytesPerSecond, null);
  assert.equal(r.a.min, null);
  assert.equal(r.differ, null);
});

test('a side with only one completed run gives null differ', () => {
  const r = summarise([ok('a', 6000), ok('b', 9000), ok('b', 9100)], BYTES);
  assert.equal(r.differ, null);
});

test('the 95% critical value is Student t for the pooled degrees of freedom', () => {
  assert.equal(tCritical95(1), 12.706);
  assert.equal(tCritical95(2), 4.303);
  assert.equal(tCritical95(4), 2.776);
  assert.equal(tCritical95(18), 2.101);
  assert.equal(tCritical95(30), 2.042);
  assert.ok(Math.abs(tCritical95(40) - 2.021) < 0.005);
  assert.ok(Math.abs(tCritical95(1000) - 1.962) < 0.005);
});

test('two runs each, separated by 4.2 standard errors: z would call it, t with 2 degrees of freedom does not', () => {
  const r = summarise([ok('a', 1000), ok('b', 1300), ok('a', 1100), ok('b', 1400)], BYTES);
  assert.equal(r.differ, false);
});

test('the summary names the faster setting and the ratio of its time', () => {
  const r = summarise([ok('a', 6000), ok('b', 7500), ok('a', 6500), ok('b', 8000), ok('a', 7000), ok('b', 8500)], BYTES);
  assert.equal(r.faster, 'a');
  const g = (xs) => Math.exp(xs.map(Math.log).reduce((s, x) => s + x, 0) / xs.length);
  assert.ok(Math.abs(r.ratio - g([7500, 8000, 8500]) / g([6000, 6500, 7000])) < 1e-12, 'B\'s time over A\'s, geometric means');
  const flipped = summarise([ok('a', 8000), ok('b', 6000), ok('a', 8100), ok('b', 6100)], BYTES);
  assert.equal(flipped.faster, 'b');
  assert.ok(flipped.ratio < 1);
});

test('without two timed sides there is no faster setting or ratio', () => {
  const r = summarise([ok('a', 6000), ok('a', 6100)], BYTES);
  assert.equal(r.faster, null);
  assert.equal(r.ratio, null);
});

function memoryStore() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
}
const S28 = { blockSize: 28, parity: 32, fps: 15, white: 255, scheme: 'cube', levels: 2 };
const S23 = { blockSize: 23, parity: 32, fps: 10, white: 255, scheme: 'cube', levels: 2 };

test('timed settings are kept per screen, newest first, one entry per setting, at most 6', () => {
  const store = memoryStore();
  saveTimed(store, 'k', [{ settings: S28, mean: 8600, runs: 5 }, { settings: S23, mean: 8050, runs: 5 }], '2026-11-07');
  saveTimed(store, 'k', [{ settings: S28, mean: 9000, runs: 5 }], '2026-11-08');
  const list = loadTimed(store, 'k');
  assert.deepEqual(list.map((t) => [t.settings.blockSize, t.mean, t.savedOn]), [[28, 9000, '2026-11-08'], [23, 8050, '2026-11-07']]);
  for (let i = 0; i < 8; i++) saveTimed(store, 'k', [{ settings: { ...S23, parity: 8 * i }, mean: 7000, runs: 3 }], '2026-11-09');
  assert.equal(loadTimed(store, 'k').length, 6);
  assert.deepEqual(loadTimed(store, 'other'), []);
});

test('timed storage that is blocked or corrupt is harmless', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadTimed(broken, 'k'), []);
  assert.doesNotThrow(() => saveTimed(broken, 'k', [{ settings: S28, mean: 1, runs: 1 }], '2026-11-07'));
  const bad = memoryStore();
  bad.setItem('visual-modem:timed:k', '{nope');
  assert.deepEqual(loadTimed(bad, 'k'), []);
  bad.setItem('visual-modem:timed:k', JSON.stringify([{ settings: { blockSize: 'x' }, mean: 5 }, { settings: S28, mean: 8600, runs: 5, savedOn: '2026-11-07' }]));
  assert.equal(loadTimed(bad, 'k').length, 1);
});
