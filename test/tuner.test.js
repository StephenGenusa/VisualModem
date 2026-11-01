import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTuner } from '../src/tune/tuner.js';

const capacity = (b, l) => Math.floor((3840 / b) * (2160 / b) * 3 * Math.log2(l) / 8);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A simulated phone. see(blockSize, levels, nowMs) gives the chance an attempt
// finds markers, then that it recognizes this test's frame, then that it reads
// it. Each attempt is sorted the way the real phone sorts it.
function run(tuner, see, { attemptsPerSecond = 8, stepMs = 500, limitMs = 60 * 60 * 1000, phone = () => ({}), seed = 1 } = {}) {
  const random = rng(seed);
  let now = 0;
  let shownId = null;
  let carry = 0;
  let streak = 0;
  const states = [];
  while (now < limitMs) {
    const t = tuner.current();
    if (t.id !== shownId) {
      tuner.shown(t.id, now);
      shownId = t.id;
    }
    const p = see(t.blockSize, t.levels, now);
    carry += (attemptsPerSecond * stepMs) / 1000;
    const counts = { attempts: 0, ok: 0, frame: 0, markers: 0 };
    for (; carry >= 1; carry--) {
      counts.attempts++;
      if (random() >= p.markers) { streak++; continue; }
      streak = 0;
      if (random() >= p.frame) counts.markers++;
      else if (random() < p.read) counts.ok++;
      else counts.frame++;
    }
    tuner.addCounts(t.id, counts);
    const r = tuner.tick(now, { reportAtMs: now, visible: true, camera: 'running', noMarkersStreak: streak, ...phone(now) });
    states.push({ now, ...r, trial: t });
    if (r.state === 'done' || r.state === 'stopped') break;
    now += stepMs;
  }
  return { result: tuner.result(), states, now };
}

const reads = (ok) => ({ markers: 1, frame: 1, read: ok ? 1 : 0 });

test('finds the smallest readable block', () => {
  const { result } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }), (b) => reads(b >= 21));
  assert.equal(result.perLevel[0].smallestBlock, 21);
  assert.equal(result.perLevel[0].workingBlock, 25);
});

test('searches each level count and picks the most bytes per frame', () => {
  const { result } = run(createTuner({ maxBlock: 108, levelOptions: [2, 4], capacity }),
    (b, l) => reads((l === 2 && b >= 21) || (l === 4 && b >= 30)));
  const [two, four] = result.perLevel;
  assert.deepEqual([two.levels, two.smallestBlock, two.workingBlock], [2, 21, 25]);
  assert.deepEqual([four.levels, four.smallestBlock, four.workingBlock], [4, 30, 35]);
  assert.equal(two.bytesPerFrame, capacity(25, 2));
  assert.equal(four.bytesPerFrame, capacity(35, 4));
  assert.equal(result.best.levels, capacity(35, 4) > capacity(25, 2) ? 4 : 2);
});

test('an unreadable level count is marked unusable', () => {
  const { result, states } = run(createTuner({ maxBlock: 108, levelOptions: [2, 4], capacity }),
    (b, l) => reads(l === 2 && b >= 21));
  assert.ok(states.every((s) => s.state !== 'paused' && s.state !== 'stopped'));
  assert.equal(result.perLevel[1].usable, false);
  assert.equal(result.best.levels, 2);
});

test('a phone that cannot see the screen pauses and does not fail', () => {
  const { result, states } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }),
    (b, l, now) => (now >= 3000 && now < 30000 ? { markers: 0, frame: 0, read: 0 } : reads(b >= 21)));
  const during = states.filter((s) => s.now >= 6000 && s.now < 30000);
  assert.ok(during.length > 0 && during.every((s) => s.state === 'paused'));
  assert.match(during[0].message, /cannot see the screen/);
  assert.equal(result.perLevel[0].smallestBlock, 21);
});

test('a hidden page pauses', () => {
  const { states } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }), (b) => reads(b >= 21),
    { phone: (now) => ({ visible: !(now >= 5000 && now < 25000) }) });
  const s = states.find((x) => x.now === 10000);
  assert.equal(s.state, 'paused');
  assert.match(s.message, /in the background/);
});

test('no reports pauses', () => {
  const { states } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }), (b) => reads(b >= 21),
    { phone: (now) => (now >= 2000 && now < 20000 ? { reportAtMs: 2000 } : {}) });
  const s = states.find((x) => x.now === 10000);
  assert.equal(s.state, 'paused');
  assert.match(s.message, /No reports/);
});

test('markers-only attempts do not count as misses', () => {
  const tuner = createTuner({ maxBlock: 108, levelOptions: [2], capacity });
  const first = tuner.current();
  tuner.shown(first.id, 0);
  for (let i = 0; i < 50; i++) {
    tuner.addCounts(first.id, { attempts: 4, ok: 0, frame: 0, markers: 4 });
    tuner.tick(i * 500, { reportAtMs: i * 500, visible: true, camera: 'running', noMarkersStreak: 0 });
  }
  assert.equal(tuner.current().id, first.id);
});

test('a slow camera with the same read rate gets the same verdict', () => {
  const see = (b) => ({ markers: 1, frame: 1, read: b >= 21 ? 0.5 : 0 });
  for (const attemptsPerSecond of [8, 2.4]) {
    const { result } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }), see, { attemptsPerSecond });
    assert.equal(result.perLevel[0].smallestBlock, 21, `at ${attemptsPerSecond} attempts per second`);
  }
});

test('unreadable at block 45 stops the run', () => {
  const { states, result } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }), () => reads(false));
  assert.equal(states.at(-1).state, 'stopped');
  assert.match(states.at(-1).message, /cannot read even block 45/);
  assert.equal(result, null);
});

test('the start block follows the display cap', () => {
  const tuner = createTuner({ maxBlock: 30, levelOptions: [2], capacity });
  assert.equal(tuner.current().blockSize, 30);
  const { states } = run(tuner, (b) => reads(b >= 21));
  assert.ok(states.every((s) => s.trial.blockSize <= 30));
});

test('settle falls back to a larger passing block', () => {
  const { result } = run(createTuner({ maxBlock: 108, levelOptions: [2], capacity }), (b) => reads(b >= 21 && b !== 25));
  assert.equal(result.perLevel[0].workingBlock, 26);
});

test('a trial that only ever sees unrecognized markers fails at the backstop', () => {
  // Live capture 17-05: the finder took a reflection for a marker, so every
  // attempt at a too-small block counted as markers only and the trial never ended.
  const tuner = createTuner({ maxBlock: 108, levelOptions: [2], capacity });
  const first = tuner.current();
  tuner.shown(first.id, 0);
  let r;
  for (let i = 0; i < 70 && tuner.current().id === first.id; i++) {
    tuner.addCounts(first.id, { attempts: 4, ok: 0, frame: 0, markers: 4 });
    r = tuner.tick(i * 500, { reportAtMs: i * 500, visible: true, camera: 'running', noMarkersStreak: 0 });
  }
  assert.equal(r.state, 'stopped'); // the baseline failing at block 45 stops the run
  assert.match(r.message, /cannot read even block 45/);
});
