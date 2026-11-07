import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChoices } from '../src/optimize/choices.js';
import { saveLastResult, loadLastResult } from '../src/optimize/refineloop.js';

const DEFAULTS = { blockSize: 23, levels: 2, scheme: 'cube', parity: 32, fps: 10, white: 255, fountain: true };
const CURRENT = { blockSize: 30, parity: 24, fps: 8, white: 255 };
const s = (blockSize, parity, fps, white = 255) => ({ blockSize, parity, fps, white });
const part = (settings, mean, readings = 5) => ({ settings, mean, readings });

test('the first choice is always the current settings, and the safe default is always offered', () => {
  const list = buildChoices({ current: CURRENT, defaults: DEFAULTS, last: null, probe: null, saved: [], cap: 100 });
  assert.equal(list[0].id, 'current');
  assert.equal(list[0].label, 'Current: block 30, parity 24, 8 fps');
  assert.equal(list.at(-1).id, 'default');
  assert.equal(list.at(-1).label, 'Safe default (block 23, parity 32, 10 fps)');
});

test('entries come in the order of the plan and a repeated setting keeps its first place', () => {
  const last = {
    date: '2026-11-07',
    winner: part(s(23, 32, 10), 37400),
    tie: part(s(25, 48, 10), 37000),
    byConditions: {
      steady: { settings: s(27, 40, 9), before: 20000, after: 18000 },
      before: part(s(21, 32, 12), 30000, 3),
      after: part(s(29, 32, 8), 22000, 3),
    },
  };
  const probe = { settings: s(31, 16, 10), bytesPerSecond: 15000, ageMs: 5 * 60000 };
  const saved = [{ ...s(23, 32, 10), mean: 36000, readings: 4, savedOn: '2026-11-06' }, { ...s(33, 32, 10), mean: 12000, readings: 4, savedOn: '2026-11-05' }];
  const list = buildChoices({ current: CURRENT, defaults: DEFAULTS, last, probe, saved, cap: 100 });
  assert.deepEqual(list.map((c) => c.id), ['current', 'refine-winner', 'refine-tie', 'refine-steady', 'refine-before', 'refine-after', 'probe', 'saved-1']);
  assert.equal(list.filter((c) => c.settings.blockSize === 23 && c.settings.parity === 32).length, 1);
  assert.match(list[1].label, /^Fastest here - 37\.4 KB\/s/);
  assert.match(list.find((c) => c.id === 'probe').label, /^Probe's best - 15\.0 KB\/s, 5 min ago \(block 31, parity 16, 10 fps\)$/);
  assert.equal(list.find((c) => c.id === 'saved-1').label, 'Earlier winner, 2026-11-05 - 12.0 KB/s (block 33, parity 32, 10 fps)');
  assert.equal(list.find((c) => c.id === 'refine-tie').label, 'Glare-tolerant tie - 37.0 KB/s (block 25, parity 48, 10 fps)');
  assert.equal(list.find((c) => c.id === 'refine-steady').label, 'Steadiest when the light changed - 20.0 then 18.0 KB/s (block 27, parity 40, 9 fps) (rough)');
  assert.match(list.find((c) => c.id === 'refine-before').label, /^Fastest before the light changed - 30\.0 KB\/s .*\(rough\)$/);
  assert.match(list.find((c) => c.id === 'refine-after').label, /^Fastest after the light changed - 22\.0 KB\/s .*\(rough\)$/);
});

test('labels read name, speed, then settings', () => {
  const last = { date: '2026-11-07', winner: part(s(23, 40, 12), 37400), tie: null, byConditions: null };
  const list = buildChoices({ current: CURRENT, defaults: DEFAULTS, last, probe: null, saved: [], cap: 100 });
  assert.equal(list[1].label, 'Fastest here - 37.4 KB/s (block 23, parity 40, 12 fps)');
  const dim = buildChoices({ current: CURRENT, defaults: DEFAULTS, last: { ...last, winner: part(s(23, 40, 12, 200), 37400) }, probe: null, saved: [], cap: 100 });
  assert.equal(dim[1].label, 'Fastest here - 37.4 KB/s (block 23, parity 40, 12 fps, white 200)');
});

test('labels name the scheme as the Scheme control does, and levels only for the color cube', () => {
  const label = (current) => buildChoices({ current, defaults: DEFAULTS, last: null, probe: null, saved: [], cap: 100 })[0].label;
  assert.equal(label({ ...CURRENT, scheme: 'gray4', levels: 4 }), 'Current: block 30, parity 24, 8 fps, 4 shades of gray');
  assert.equal(label({ ...CURRENT, scheme: 'g4', levels: 2 }), 'Current: block 30, parity 24, 8 fps, Green 4, red and blue 2');
  assert.equal(label({ ...CURRENT, scheme: 'cube', levels: 4 }), 'Current: block 30, parity 24, 8 fps, Color cube, 4 levels');
  assert.equal(label({ ...CURRENT, scheme: 'cube', levels: 2 }), 'Current: block 30, parity 24, 8 fps');
});

test('a setting that differs from Current only in levels its scheme ignores is not offered again', () => {
  const current = { ...CURRENT, scheme: 'g4', levels: 4 };
  const probe = { settings: { ...CURRENT, scheme: 'g4', levels: 2 }, bytesPerSecond: 15000, ageMs: 0 };
  const list = buildChoices({ current, defaults: DEFAULTS, last: null, probe, saved: [], cap: 100 });
  assert.deepEqual(list.map((c) => c.id), ['current', 'default']);
  const cube = buildChoices({ current: { ...CURRENT, scheme: 'cube', levels: 4 }, defaults: DEFAULTS, last: null, probe: { ...probe, settings: { ...CURRENT, scheme: 'cube', levels: 2 } }, saved: [], cap: 100 });
  assert.deepEqual(cube.map((c) => c.id), ['current', 'probe', 'default'], 'the cube does use its levels');
});

test("a choice over this screen's cap is left out", () => {
  const last = { date: '2026-11-07', winner: part(s(40, 40, 12), 37400), tie: null, byConditions: null };
  const probe = { settings: s(50, 16, 10), bytesPerSecond: 1000, ageMs: 1000 };
  const list = buildChoices({ current: { ...CURRENT, blockSize: 60 }, defaults: DEFAULTS, last, probe, saved: [], cap: 30 });
  assert.deepEqual(list.map((c) => c.id), ['current', 'default']);
});

test('nothing known gives current and safe default only, and corrupt stored data gives the same', () => {
  const none = buildChoices({ current: CURRENT, defaults: DEFAULTS, last: null, probe: null, saved: [], cap: 100 });
  assert.deepEqual(none.map((c) => c.id), ['current', 'default']);
  const bad = { getItem: () => '{nope' };
  const thrower = { getItem() { throw new Error('blocked'); } };
  for (const st of [bad, thrower]) {
    const list = buildChoices({ current: CURRENT, defaults: DEFAULTS, last: loadLastResult(st, 'a'), probe: null, saved: [], cap: 100 });
    assert.deepEqual(list.map((c) => c.id), ['current', 'default']);
  }
  assert.equal(typeof saveLastResult, 'function');
});

test('timed settings are offered with their time, after Probe and before earlier winners', () => {
  const timed = [{ settings: { ...s(28, 32, 15), scheme: 'cube', levels: 2 }, mean: 8600, runs: 5, savedOn: '2026-11-07' }];
  const saved = [{ ...s(23, 40, 12), scheme: 'cube', levels: 2, mean: 37400, readings: 3, savedOn: '2026-11-07' }];
  const list = buildChoices({ current: CURRENT, defaults: DEFAULTS, last: null, probe: null, timed, saved, cap: 100 });
  assert.deepEqual(list.map((c) => c.id), ['current', 'timed-0', 'saved-0', 'default']);
  assert.equal(list[1].label, 'Timed, 2026-11-07 - 8.6 s over 5 runs (block 28, parity 32, 15 fps)');
});

test('a line with the safe default\'s settings says so', () => {
  const saved = [{ ...s(23, 32, 10), scheme: 'cube', levels: 2, mean: 34100, readings: 3, savedOn: '2026-11-07' }];
  const list = buildChoices({ current: CURRENT, defaults: DEFAULTS, last: null, probe: null, saved, cap: 100 });
  assert.deepEqual(list.map((c) => c.id), ['current', 'saved-0']);
  assert.equal(list[1].label, 'Earlier winner, 2026-11-07 - 34.1 KB/s (block 23, parity 32, 10 fps), the safe default');
  const current = buildChoices({ current: { ...s(23, 32, 10), scheme: 'cube', levels: 2 }, defaults: DEFAULTS, last: null, probe: null, saved: [], cap: 100 });
  assert.equal(current[0].label, 'Current: block 23, parity 32, 10 fps, the safe default');
});
