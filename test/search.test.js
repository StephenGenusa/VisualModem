import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSearch, candidateKey, spaceFor, TEST_MS, SCREEN_MS, SWITCH_MS, EARLY_MS, MIN_READS, TEST_COST_MS, SCREEN_COST_MS,
  SCREEN_MIN_READS, WIN_READINGS, SEED_SHARE, SURVEY_SHARE, TUNE_SHARE, PASS_MS, DROP_SHARE, CANDIDATE_SHARE, MAX_CANDIDATES,
  CANDIDATE_STEPS, MAX_MOVES, FINALISTS, TIE_SHARE, BASE_SPACE, BLOCK_FAIL_TESTS, BLOCK_FAIL_SHARE,
} from '../src/optimize/search.js';
import { createLinkSim, trueRate, seededRandom, screenCeiling, peakRate } from '../src/testutil/linksim.js';

const SEEDS_TO_TRY = [1, 2, 3, 7, 42];
const DEFAULTS = { blockSize: 23, parity: 32, fps: 10, white: 255 };
const fixed = { scheme: 'cube' };
const MINUTE = 60000;

const make = (seed, seeds, cap = 80, extra = {}) => createSearch({ cap, seeds, fixed, random: seededRandom(seed), ...extra });
const good = (bytesPerSecond) => ({ bytesPerSecond, reads: 50, zeroAtEarlyCheck: false });
const zero = () => ({ bytesPerSecond: 0, reads: 5, zeroAtEarlyCheck: true });
const same = (a, b) => a.blockSize === b.blockSize && a.parity === b.parity && a.fps === b.fps && a.white === b.white;
const rowOf = (s, c) => s.result().ranked.find((r) => same(r.candidate, c));
const PHASE = { seed: 0, reference: 1, survey: 1, candidate: 2, tune: 2, final: 3 };

/** Runs a search to its end, charging each test its full length. measure gets the time used. */
function drive(search, measure, limitMs) {
  const shown = [];
  let usedMs = 0;
  while (true) {
    const step = search.next(limitMs - usedMs);
    if (!step) break;
    shown.push({ ...step, atMs: usedMs });
    search.record(step.candidate, measure(step.candidate, step.testMs, usedMs));
    usedMs += step.testMs + SWITCH_MS;
  }
  shown.usedMs = usedMs;
  return shown;
}
const exact = (rateOf) => (c) => {
  const r = rateOf(c);
  return r === 0 ? zero() : good(r);
};
/** A measure with noise, so that repeated readings of one setting differ. */
function noisy(seed, rateOf, spread = 0.16) {
  const random = seededRandom(seed + 1000);
  return (c) => {
    const r = rateOf(c);
    return r === 0 ? zero() : good(r * (1 - spread / 2 + spread * random()));
  };
}
const flat = () => 30000;

test('test lengths and phase shares are the plan\'s', () => {
  assert.equal(TEST_MS, 6000);
  assert.equal(SWITCH_MS, 1000);
  assert.equal(EARLY_MS, 2000);
  assert.equal(MIN_READS, 6);
  assert.equal(TEST_COST_MS, 7000);
  assert.equal(SCREEN_MS, 2000);
  assert.equal(SCREEN_COST_MS, 3000);
  assert.equal(WIN_READINGS, 3);
  assert.deepEqual([SEED_SHARE, SURVEY_SHARE, TUNE_SHARE, PASS_MS], [0.25, 0.5, 0.8, 600000]);
  assert.deepEqual([BLOCK_FAIL_TESTS, BLOCK_FAIL_SHARE], [3, 0.75]);
  assert.deepEqual([DROP_SHARE, CANDIDATE_SHARE, MAX_CANDIDATES, CANDIDATE_STEPS, MAX_MOVES, FINALISTS, TIE_SHARE], [0.5, 0.7, 6, 2, 2, 5, 0.9]);
});

test('seeds come first, in order, as full tests', () => {
  const seeds = [DEFAULTS, { ...DEFAULTS, fps: 12 }, { ...DEFAULTS, blockSize: 25 }, { ...DEFAULTS, parity: 24 }];
  for (const seed of SEEDS_TO_TRY) {
    const s = make(seed, seeds);
    for (const expected of seeds) {
      const step = s.next(30 * MINUTE);
      assert.equal(step.reason, 'seed');
      assert.ok(same(step.candidate, expected));
      assert.equal(step.candidate.scheme, 'cube');
      assert.equal(step.testMs, TEST_MS);
      s.record(step.candidate, good(30000));
    }
    assert.notEqual(s.next(30 * MINUTE).reason, 'seed');
  }
});

test('a repeated seed counts once, and seeds above the cap are dropped', () => {
  const s = make(1, [DEFAULTS, DEFAULTS, { ...DEFAULTS, blockSize: 41 }, { ...DEFAULTS, fps: 12 }], 30);
  const shown = drive(s, exact(flat), 3 * MINUTE);
  assert.deepEqual(shown.filter((x) => x.reason === 'seed').map((x) => candidateKey(x.candidate)), [DEFAULTS, { ...DEFAULTS, fps: 12 }].map(candidateKey));
  assert.ok(shown.every((x) => x.candidate.blockSize <= 30));
});

test('seeds stop at a quarter of the limit, the first always', () => {
  const seeds = [];
  for (const blockSize of [19, 21, 23, 25, 27]) for (const parity of [16, 24, 32, 40, 48]) seeds.push({ ...DEFAULTS, blockSize, parity });
  const at3 = drive(make(1, seeds), exact(flat), 3 * MINUTE).filter((x) => x.reason === 'seed');
  assert.equal(at3.length, Math.ceil((SEED_SHARE * 3 * MINUTE) / TEST_COST_MS), 'seeds start before 45 s');
  const at30 = drive(make(1, seeds), exact(flat), 30 * MINUTE).filter((x) => x.reason === 'seed');
  assert.equal(at30.length, 20, 'up to 20');
  assert.deepEqual(at30.map((x) => candidateKey(x.candidate)), seeds.slice(0, 20).map(candidateKey));
  assert.equal(make(1, seeds).next(TEST_COST_MS - 1), null, 'no test starts that cannot finish');
});

test('the phases run in order: seeds, survey, candidates and tuning, finals', () => {
  for (const seed of SEEDS_TO_TRY) {
    for (const minutes of [3, 5]) {
      const shown = drive(make(seed, [DEFAULTS, { ...DEFAULTS, fps: 12 }]), noisy(seed, trueRate), minutes * MINUTE);
      const order = shown.map((x) => PHASE[x.reason]);
      for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1] || shown[i].reason === 'reference', `${minutes} min: ${shown[i - 1].reason} then ${shown[i].reason}`);
      const reasons = new Set(shown.map((x) => x.reason));
      for (const r of ['seed', 'survey', 'tune', 'final']) assert.ok(reasons.has(r), `${minutes} min has ${r}`);
      assert.ok(shown.filter((x) => x.reason === 'survey').every((x) => x.atMs < SURVEY_SHARE * minutes * MINUTE));
      assert.ok(shown.filter((x) => x.reason === 'tune').every((x) => x.atMs < TUNE_SHARE * minutes * MINUTE));
    }
  }
});

test('the survey is short tests at full white, farthest first', () => {
  const s = make(1, [DEFAULTS]);
  const shown = drive(s, exact(flat), 30 * MINUTE).filter((x) => x.reason === 'survey');
  assert.ok(shown.length > 20);
  assert.ok(shown.every((x) => x.testMs === SCREEN_MS && x.candidate.white === 255));
  // The first is as far as it can be from the seed: the far end of block, parity and fps not held back.
  assert.ok(same(shown[0].candidate, { blockSize: 35, parity: 8, fps: 20, white: 255 }), candidateKey(shown[0].candidate));
  // Each pick is at least as far from what came before as any later pick was from it then.
  const space = spaceFor(80, [DEFAULTS]);
  const at = (axis, v) => space[axis].indexOf(v) / (space[axis].length - 1);
  const dist = (a, b) => ['blockSize', 'parity', 'fps'].reduce((sum, axis) => sum + Math.abs(at(axis, a[axis]) - at(axis, b[axis])), 0);
  const firstPass = shown.filter((x) => x.atMs < PASS_MS);
  let covered = [DEFAULTS];
  let last = Infinity;
  for (const x of firstPass.slice(0, 40)) {
    const near = Math.min(...covered.map((c) => dist(c, x.candidate)));
    assert.ok(near <= last + 1e-9, `${candidateKey(x.candidate)} at ${near} after ${last}`);
    last = near;
    covered = [...covered, x.candidate];
  }
});

test('parity 0 and 30 fps are surveyed only after the rest', () => {
  const s = make(1, [DEFAULTS], 21);
  const shown = drive(s, exact(flat), 60 * MINUTE).filter((x) => x.reason === 'survey');
  const held = (c) => c.parity === 0 || c.fps === 30;
  const firstHeld = shown.findIndex((x) => held(x.candidate));
  assert.ok(firstHeld > 0, 'held-back settings are reached in a long survey');
  // Blocks 19 and 21 at 6 parities and 6 rates, less the seed, which is covered.
  assert.equal(firstHeld, 2 * 6 * 6 - 1, 'every other setting came first');
});

test('a zero rules out only its own setting', () => {
  const dead = { blockSize: 35, parity: 8, fps: 20, white: 255 };
  const s = make(1, [DEFAULTS]);
  const shown = drive(s, exact((c) => (same(c, dead) ? 0 : 30000)), 30 * MINUTE);
  assert.equal(rowOf(s, dead).alive, false);
  // The old dead-area rule would have kept out smaller blocks at the same or higher rates.
  assert.ok(shown.some((x) => x.reason === 'survey' && x.candidate.blockSize < 35 && x.candidate.fps >= 20));
});

test('a rough reading drops its setting only under half the leader', () => {
  const low = { blockSize: 35, parity: 8, fps: 20, white: 255 };
  const s = make(1, [DEFAULTS]);
  let step = s.next(3 * MINUTE);
  s.record(step.candidate, good(30000));
  step = s.next(3 * MINUTE);
  assert.ok(same(step.candidate, low));
  s.record(step.candidate, good(14900));
  assert.equal(rowOf(s, low).alive, false);
  const t = make(1, [DEFAULTS]);
  t.record(t.next(3 * MINUTE).candidate, good(30000));
  t.record(t.next(3 * MINUTE).candidate, good(15100));
  assert.equal(rowOf(t, low).alive, true);
});

test('candidates read at least 70% of the leader, are 2 steps apart, at most 6', () => {
  for (const seed of SEEDS_TO_TRY) {
    const s = make(seed, [DEFAULTS]);
    const measure = noisy(seed, trueRate);
    drive(s, measure, 5 * MINUTE);
    const { candidates } = s.result();
    assert.ok(candidates.length >= 1 && candidates.length <= MAX_CANDIDATES);
    const space = spaceFor(80, [DEFAULTS]);
    const steps = (a, b) => ['blockSize', 'parity', 'fps', 'white'].reduce((sum, axis) => sum + Math.abs(space[axis].indexOf(a[axis]) - space[axis].indexOf(b[axis])), 0);
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) assert.ok(steps(candidates[i], candidates[j]) >= CANDIDATE_STEPS);
  }
});

test('tuning goes round robin across the candidates', () => {
  // Every setting reads the same, so no candidate moves and each is a centre throughout.
  const s = make(1, [DEFAULTS]);
  const shown = drive(s, exact(flat), 5 * MINUTE);
  const { candidates } = s.result();
  assert.ok(candidates.length >= 2, `${candidates.length} candidates`);
  // Each turn is the candidate's own full test, or one of its neighbours once it has one.
  const turns = shown.filter((x) => x.reason === 'tune' || x.reason === 'candidate').slice(0, 2 * candidates.length);
  const space = spaceFor(80, [DEFAULTS]);
  const steps = (a, b) => ['blockSize', 'parity', 'fps', 'white'].reduce((sum, axis) => sum + Math.abs(space[axis].indexOf(a[axis]) - space[axis].indexOf(b[axis])), 0);
  turns.forEach((x, i) => {
    const centre = candidates[i % candidates.length];
    assert.equal(steps(x.candidate, centre), x.reason === 'candidate' ? 0 : 1, `turn ${i} belongs to candidate ${i % candidates.length}`);
  });
});

test('a better neighbour becomes the candidate, at most twice', () => {
  // Only block 23 at 10 fps and full white reads well, better at each parity step up.
  const rate = (c) => (c.blockSize === 23 && c.fps === 10 && c.white === 255 ? 20000 + 2000 * BASE_SPACE.parity.indexOf(c.parity) : 1000);
  const s = make(1, [{ ...DEFAULTS, parity: 16 }]);
  const tune = drive(s, exact(rate), 3 * MINUTE).filter((x) => x.reason === 'tune').map((x) => x.candidate);
  assert.ok(tune.some((c) => same(c, { ...DEFAULTS, parity: 24 })));
  assert.ok(tune.some((c) => same(c, { ...DEFAULTS, parity: 32 })), 'first move, to 24');
  assert.ok(tune.some((c) => same(c, { ...DEFAULTS, parity: 40 })), 'second move, to 32');
  assert.ok(!tune.some((c) => same(c, { ...DEFAULTS, parity: 48 })), 'no third move');
});

test('the top two reach 3 readings at every limit', () => {
  for (const seed of SEEDS_TO_TRY) {
    for (const minutes of [1, 3, 5, 30]) {
      const s = make(seed, [DEFAULTS, { ...DEFAULTS, fps: 12 }], 80, { ceilingOf: screenCeiling, longRun: minutes === 30 });
      const sim = createLinkSim({ random: seededRandom(seed) });
      const shown = drive(s, (c, ms) => sim.measure(c, ms), minutes * MINUTE);
      assert.ok(shown.usedMs <= minutes * MINUTE, `${minutes} min used ${shown.usedMs}`);
      const r = s.result();
      assert.ok(r.winner, `${minutes} min seed ${seed} has a winner`);
      assert.ok(rowOf(s, r.winner).readings >= WIN_READINGS);
    }
  }
});

test('a 30 minute run is 3 passes, each later one starting with the reference', () => {
  const s = make(1, [DEFAULTS, { ...DEFAULTS, fps: 12 }], 80, { longRun: true });
  const shown = drive(s, noisy(1, trueRate), 30 * MINUTE);
  const refs = shown.filter((x) => x.reason === 'reference');
  assert.ok(refs.length >= 3, `${refs.length} reference tests`);
  assert.ok(refs.every((x) => same(x.candidate, DEFAULTS)));
  for (const start of [PASS_MS, 2 * PASS_MS]) {
    const first = shown.find((x) => x.atMs >= start);
    assert.equal(first.reason, 'reference', `the pass from ${start / MINUTE} min`);
  }
  assert.equal(s.result().passes.length, 3);
  assert.ok(s.result().passes.every((p) => p && p.mean > 0));
  // Each pass surveys again.
  for (let p = 0; p < 3; p++) assert.ok(shown.some((x) => x.reason === 'survey' && x.atMs >= p * PASS_MS && x.atMs < (p + 1) * PASS_MS));
});

test('a short run tests the reference again before the finals', () => {
  const shown = drive(make(1, [DEFAULTS, { ...DEFAULTS, fps: 12 }]), noisy(1, trueRate), 5 * MINUTE);
  assert.equal(shown.filter((x) => x.reason === 'reference').length, 1);
});

test('the result says when conditions changed', () => {
  const glareAt = 15 * MINUTE;
  const glare = (c, ms, usedMs) => good(usedMs < glareAt ? 30000 : 12000);
  const s = make(1, [DEFAULTS], 80, { longRun: true });
  drive(s, glare, 30 * MINUTE);
  assert.equal(s.result().conditionsChanged, true);
  const t = make(1, [DEFAULTS], 80, { longRun: true });
  drive(t, noisy(1, flat, 0.1), 30 * MINUTE);
  assert.equal(t.result().conditionsChanged, false);
});

test('a tie goes to the higher parity at the same block and rate, and only within 90%', () => {
  const p16 = { ...DEFAULTS, parity: 16 };
  const p48 = { ...DEFAULTS, parity: 48 };
  const twoOnly = (a, b) => (c) => (same(c, p16) ? a : same(c, p48) ? b : 0);
  const s = make(1, [p16, p48]);
  drive(s, exact(twoOnly(30000, 29000)), 5 * MINUTE);
  let r = s.result();
  assert.ok(same(r.winner, p48));
  assert.equal(r.tied.length, 2);
  assert.equal(r.separated, false);
  const t = make(1, [p16, p48]);
  drive(t, exact(twoOnly(30000, 25000)), 5 * MINUTE);
  r = t.result();
  assert.ok(same(r.winner, p16));
  assert.equal(r.tied.length, 1);
  // At another block a tie goes to the higher mean.
  const other = { ...DEFAULTS, blockSize: 27, parity: 48 };
  const u = make(1, [p16, other]);
  drive(u, exact((c) => (same(c, p16) ? 30000 : same(c, other) ? 29000 : 0)), 5 * MINUTE);
  r = u.result();
  assert.equal(r.tied.length, 1, 'a setting at another block is not a tie');
  assert.ok(same(r.winner, p16));
});

test('all zeros ends soon, with no winner', () => {
  for (const seed of SEEDS_TO_TRY) {
    const s = make(seed, [DEFAULTS, { ...DEFAULTS, fps: 12 }]);
    const shown = drive(s, () => zero(), 30 * MINUTE);
    assert.ok(shown.length <= 2 + 5, `${shown.length} tests`);
    const r = s.result();
    assert.equal(r.winner, null);
    assert.equal(r.leader, null);
    assert.equal(r.provisional, false);
    assert.ok(r.ranked.every((row) => row.alive === false));
  }
});

test('a cap of 16 still gives a valid space', () => {
  for (const seeds of [[DEFAULTS], [{ ...DEFAULTS, blockSize: 14 }], []]) {
    const s = make(1, seeds, 16);
    const space = spaceFor(16, seeds);
    assert.ok(space.blockSize.length >= 1 && space.blockSize.every((b) => b <= 16));
    const shown = drive(s, noisy(1, flat), 3 * MINUTE);
    assert.ok(shown.length > 0 && shown.every((x) => x.candidate.blockSize <= 16));
    assert.ok(s.result().winner);
  }
  assert.throws(() => make(1, [DEFAULTS], 0), RangeError);
  assert.throws(() => make(1, [DEFAULTS], Number.NaN), RangeError);
});

test('every setting shown is in the space', () => {
  const seedList = [{ blockSize: 22, parity: 30, fps: 9, white: 200 }, DEFAULTS];
  const space = spaceFor(80, seedList);
  const s = make(1, seedList, 80, { longRun: true });
  const shown = drive(s, noisy(1, trueRate), 30 * MINUTE);
  for (const { candidate: c } of shown) {
    for (const axis of ['blockSize', 'parity', 'fps', 'white']) assert.ok(space[axis].includes(c[axis]), `${axis} ${c[axis]}`);
  }
});

test('a test the phone did not read does not count, and is repeated', () => {
  const s = make(1, [DEFAULTS, { ...DEFAULTS, fps: 12 }]);
  const first = s.next(3 * MINUTE);
  s.record(first.candidate, { bytesPerSecond: 0, reads: MIN_READS - 1, zeroAtEarlyCheck: false });
  const again = s.next(3 * MINUTE);
  assert.ok(same(again.candidate, first.candidate));
  assert.equal(again.reason, first.reason);
  assert.equal(rowOf(s, first.candidate).readings, 0);
  s.record(again.candidate, good(30000));
  assert.equal(rowOf(s, first.candidate).readings, 1);
  assert.ok(same(s.next(3 * MINUTE).candidate, { ...DEFAULTS, fps: 12 }));
  const t = make(1, [DEFAULTS]);
  const one = t.next(3 * MINUTE);
  assert.ok(same(t.next(3 * MINUTE).candidate, one.candidate), 'a test never recorded is shown again');
  assert.equal(t.result().tests, 2);
});

test('a screening test needs fewer reads than a full one, and a zero at the early check needs its reads', () => {
  const s = make(1, [DEFAULTS]);
  s.record(s.next(3 * MINUTE).candidate, good(30000));
  const step = s.next(3 * MINUTE);
  assert.equal(step.testMs, SCREEN_MS);
  s.record(step.candidate, { bytesPerSecond: 20000, reads: SCREEN_MIN_READS - 1, zeroAtEarlyCheck: false });
  assert.equal(rowOf(s, step.candidate).rough, null);
  s.record(step.candidate, { bytesPerSecond: 20000, reads: SCREEN_MIN_READS, zeroAtEarlyCheck: false });
  assert.equal(rowOf(s, step.candidate).rough, 20000);
  const t = make(1, [DEFAULTS]);
  const c = t.next(3 * MINUTE).candidate;
  t.record(c, { bytesPerSecond: 0, reads: SCREEN_MIN_READS - 1, zeroAtEarlyCheck: true });
  assert.equal(rowOf(t, c).readings, 0);
  t.record(c, { bytesPerSecond: 0, reads: SCREEN_MIN_READS, zeroAtEarlyCheck: true });
  assert.equal(rowOf(t, c).alive, false);
});

test('a reading is clamped to what its frames can carry, at the read rate seen', () => {
  const s = make(1, [DEFAULTS], 80, { ceilingOf: () => 40000 });
  s.record(s.next(3 * MINUTE).candidate, good(300000));
  assert.equal(s.result().ranked[0].mean, 40000);
  const t = make(1, [DEFAULTS], 80, { ceilingOf: (c, rate) => 1000 * rate });
  t.record(t.next(3 * MINUTE).candidate, { bytesPerSecond: 90000, reads: 120, zeroAtEarlyCheck: false });
  assert.equal(t.result().ranked[0].mean, 20000, '20 reads a second, not the 15 assumed before it');
});

test('a setting whose ceiling is under the leader\'s lower bound is not surveyed', () => {
  const s = make(1, [DEFAULTS], 80, { ceilingOf: screenCeiling });
  const shown = drive(s, exact((c) => (same(c, DEFAULTS) ? 30000 : 20000)), 30 * MINUTE);
  const bar = s.result().coverage.ceilingBar;
  assert.ok(bar > 0);
  assert.ok(shown.filter((x) => x.reason === 'survey').every((x) => screenCeiling(x.candidate, 15) >= 20000), 'none that cannot reach the leader');
  assert.ok(s.result().coverage.skippedByCeiling > 0);
});

test('one stray zero on a setting that reads is forgiven', () => {
  const s = make(1, [DEFAULTS]);
  const c = s.next(30 * MINUTE).candidate;
  s.record(c, good(30000));
  s.record(c, { bytesPerSecond: 0, reads: 30, zeroAtEarlyCheck: false });
  assert.equal(rowOf(s, c).alive, true);
  s.record(c, { bytesPerSecond: 0, reads: 30, zeroAtEarlyCheck: false });
  assert.equal(rowOf(s, c).alive, false, 'zeros outnumbering good readings drop it');
});

test('a run with a winner\'s rival short of readings is provisional', () => {
  const s = make(1, [DEFAULTS, { ...DEFAULTS, fps: 12 }]);
  for (let i = 0; i < 3; i++) s.record(DEFAULTS, good(30000));
  s.next(3 * MINUTE);
  s.record({ ...fixed, ...DEFAULTS }, good(30000));
  s.record(s.next(3 * MINUTE).candidate, good(40000));
  const r = s.result();
  assert.ok(r.leader);
  assert.equal(r.provisional, true);
});

// ---- the phone losing its aim, and framing moves ----

function withLeaderRead(seed = 3) {
  const search = createSearch({ cap: 45, seeds: [DEFAULTS], fixed, random: seededRandom(seed), ceilingOf: screenCeiling });
  search.record(search.next(600000).candidate, good(30000));
  search.record(DEFAULTS, good(30000));
  search.record(DEFAULTS, good(30000));
  return search;
}
const aimZero = { bytesPerSecond: 0, reads: 20, zeroAtEarlyCheck: true };

test('the zero streak counts zeros since the last positive reading and names the leader before them', () => {
  const search = withLeaderRead();
  assert.deepEqual(search.zeroStreak(), { count: 0, before: null });
  for (let i = 1; i <= 3; i++) {
    search.record(DEFAULTS, { bytesPerSecond: 0, reads: 90, zeroAtEarlyCheck: false });
    const streak = search.zeroStreak();
    assert.equal(streak.count, i);
    assert.ok(same(streak.before.candidate, DEFAULTS));
    assert.equal(streak.before.mean, 30000);
  }
  search.record(search.next(600000).candidate, good(28000));
  assert.deepEqual(search.zeroStreak(), { count: 0, before: null });
});

test('setting zeros aside undoes them, and the settings are offered again', () => {
  const search = withLeaderRead();
  const before = search.result();
  const zeroed = [];
  for (let i = 0; i < 4; i++) {
    const step = search.next(600000);
    zeroed.push(step.candidate);
    search.record(step.candidate, aimZero);
  }
  assert.equal(search.setAsideZeros(), 4);
  const after = search.result();
  assert.deepEqual(search.zeroStreak(), { count: 0, before: null });
  assert.equal(after.coverage.screened, before.coverage.screened);
  assert.deepEqual(after.ranked.map((r) => [candidateKey(r.candidate), r.readings, r.mean, r.alive]), before.ranked.map((r) => [candidateKey(r.candidate), r.readings, r.mean, r.alive]));
  assert.ok(same(search.next(600000).candidate, zeroed[0]), 'the first is offered again at once');
});

test('setting zeros aside restores a leader that read zero', () => {
  const search = createSearch({ cap: 45, seeds: [DEFAULTS], fixed, random: seededRandom(9), ceilingOf: screenCeiling });
  const first = search.next(600000);
  search.record(first.candidate, good(30000));
  search.record(first.candidate, { bytesPerSecond: 0, reads: 90, zeroAtEarlyCheck: false });
  search.record(first.candidate, { bytesPerSecond: 0, reads: 90, zeroAtEarlyCheck: false });
  assert.equal(search.result().leader, null, 'two zeros against one good reading drop it');
  assert.ok(same(search.zeroStreak().before.candidate, DEFAULTS));
  assert.equal(search.setAsideZeros(), 2);
  const row = search.result().ranked[0];
  assert.ok(same(search.result().leader, DEFAULTS));
  assert.deepEqual([row.readings, row.mean, row.alive], [1, 30000, true]);
});

test('a seed that read only zero goes back to be tested', () => {
  const other = { ...DEFAULTS, blockSize: 25 };
  const search = createSearch({ cap: 45, seeds: [other, DEFAULTS], fixed, random: seededRandom(4), ceilingOf: screenCeiling });
  search.record(search.next(600000).candidate, good(30000));
  const b = search.next(600000);
  assert.equal(b.reason, 'seed');
  search.record(b.candidate, { bytesPerSecond: 0, reads: 90, zeroAtEarlyCheck: false });
  assert.equal(search.setAsideZeros(), 1);
  const again = search.next(600000);
  assert.equal(again.reason, 'seed');
  assert.ok(same(again.candidate, b.candidate));
});

test('setting zeros aside leaves no test pending, and zeros before a positive reading stay', () => {
  const search = withLeaderRead();
  search.record(search.next(600000).candidate, aimZero);
  search.next(600000);
  assert.equal(search.setAsideZeros(), 1);
  assert.ok(search.next(600000));
  const t = withLeaderRead();
  assert.equal(t.setAsideZeros(), 0);
  t.record(t.next(600000).candidate, aimZero);
  t.record(t.next(600000).candidate, good(28000));
  assert.equal(t.setAsideZeros(), 0);
});

test('a framing move sets readings aside, ends the zero streak and starts a new pass with the reference', () => {
  const s = make(1, [DEFAULTS, { ...DEFAULTS, fps: 12 }]);
  let used = 0;
  const step = () => {
    const x = s.next(5 * MINUTE - used);
    used += x.testMs + SWITCH_MS;
    return x;
  };
  s.record(step().candidate, good(30000));
  s.record(step().candidate, good(31000));
  s.record(step().candidate, aimZero);
  s.markMoved();
  assert.deepEqual(s.zeroStreak(), { count: 0, before: null });
  const r = s.result();
  assert.equal(r.leader, null);
  assert.ok(r.ranked.every((row) => row.readings === 0));
  const next = step();
  assert.equal(next.reason, 'reference');
  assert.ok(same(next.candidate, DEFAULTS));
});

test('a framing move keeps the test that was pending, so it is shown again', () => {
  const search = withLeaderRead();
  search.record(search.next(600000).candidate, aimZero);
  const offered = search.next(600000);
  search.markMoved();
  const again = search.next(600000);
  assert.ok(same(again.candidate, offered.candidate));
  assert.equal(again.testMs, offered.testMs);
});

test('the same random seed repeats a run exactly', () => {
  const run = (seed) => drive(make(seed, [DEFAULTS]), exact(flat), 3 * MINUTE).map((x) => candidateKey(x.candidate)).join(' ');
  assert.equal(run(5), run(5));
  assert.notEqual(run(5), run(6));
});

test('the simulator and its peaks still load', () => {
  assert.ok(trueRate(DEFAULTS) > 0);
  assert.ok(peakRate(DEFAULTS)(DEFAULTS) > 0);
});

test('a survey zero counts a third of a full one toward the zero streak, and all are undone', () => {
  const search = withLeaderRead();
  for (let i = 0; i < 5; i++) {
    const step = search.next(600000);
    assert.equal(step.reason, 'survey');
    search.record(step.candidate, aimZero);
  }
  assert.equal(search.zeroStreak().count, 1, 'five short zeros are one');
  search.record(search.next(600000).candidate, aimZero);
  assert.equal(search.zeroStreak().count, 2);
  search.record(DEFAULTS, { bytesPerSecond: 0, reads: 90, zeroAtEarlyCheck: false });
  assert.equal(search.zeroStreak().count, 3, 'a full zero is one');
  assert.equal(search.setAsideZeros(), 7);
});

test('at 3 minutes from the 7 starting settings every run ends with a winner of 3 readings', async () => {
  const { KNOWN_GOOD } = await import('../src/optimize/refineloop.js');
  const seeds = [DEFAULTS, ...KNOWN_GOOD].filter((c, i, list) => list.findIndex((d) => same(c, d)) === i).slice(0, 7);
  const missed = [];
  for (let seed = 1; seed <= 25; seed++) {
    const s = createSearch({ cap: 45, seeds, fixed, random: seededRandom(seed + 1), ceilingOf: screenCeiling });
    const sim = createLinkSim({ random: seededRandom(seed), noise: 0.12 });
    drive(s, (c, ms) => sim.measure(c, ms), 3 * MINUTE);
    const r = s.result();
    if (!r.winner || rowOf(s, r.winner).readings < WIN_READINGS) missed.push(seed);
  }
  assert.deepEqual(missed, []);
});

test('only settings that differ from the winner in parity alone are listed as tied', () => {
  const p16 = { ...DEFAULTS, parity: 16 };
  const p48 = { ...DEFAULTS, parity: 48 };
  const other = { ...DEFAULTS, blockSize: 27 };
  const rates = (c) => (same(c, p16) ? 30000 : same(c, p48) ? 29800 : same(c, other) ? 29600 : 0);
  const s = make(1, [p16, p48, other]);
  drive(s, exact(rates), 10 * MINUTE);
  const r = s.result();
  assert.ok(same(r.winner, p48));
  assert.ok(rowOf(s, other).readings >= WIN_READINGS, 'the other block is proven and within the noise too');
  assert.deepEqual(r.tied.map(candidateKey).sort(), [p16, p48].map(candidateKey).sort());
});

test('a rival short of readings makes the winner provisional only when clearly above it', () => {
  const run = (rival) => {
    const s = make(1, [DEFAULTS, { ...DEFAULTS, fps: 12 }]);
    s.next(3 * MINUTE);
    for (let i = 0; i < 4; i++) s.record(DEFAULTS, good(30000));
    s.record(s.next(3 * MINUTE).candidate, good(rival));
    return s.result();
  };
  const near = run(31500);
  assert.ok(same(near.winner, DEFAULTS));
  assert.equal(near.provisional, false, 'within the noise: done');
  const far = run(60000);
  assert.ok(same(far.winner, DEFAULTS));
  assert.equal(far.provisional, true, 'clearly above: provisional');
});

test('a block that fails most of its survey tests in a pass is skipped for the rest of the pass', () => {
  const s = make(1, [DEFAULTS], 80, { longRun: true });
  const shown = drive(s, exact((c) => (c.blockSize === 19 ? 0 : 30000)), 30 * MINUTE);
  for (let p = 0; p < 3; p++) {
    const at19 = shown.filter((x) => x.reason === 'survey' && x.candidate.blockSize === 19 && x.atMs >= p * PASS_MS && x.atMs < (p + 1) * PASS_MS);
    assert.equal(at19.length, 3, `pass ${p}: 3 survey tests at block 19, then none`);
  }
});

test('a block that fails only some of its survey tests stays in the survey', () => {
  // At block 19 only parity 48 reads well: about 1 in 6 survey tests there.
  const s = make(1, [DEFAULTS]);
  let fails = 0;
  const shown = drive(s, (c) => {
    if (c.blockSize !== 19) return good(30000);
    return c.parity === 48 || c.parity === 40 || c.parity === 32 || c.parity === 24 ? good(30000) : zero();
  }, 30 * MINUTE);
  const at19 = shown.filter((x) => x.reason === 'survey' && x.candidate.blockSize === 19);
  fails = at19.filter((x) => x.candidate.parity < 24).length;
  assert.ok(at19.length > 4, `${at19.length} tests at block 19, ${fails} failed`);
});

test('when conditions change the result gives the best before, the best after and the steadiest', () => {
  // Block 23 is best until the light goes on at 15 minutes; block 28 reads the same throughout.
  const lit = (c, ms, usedMs) => {
    const on = usedMs >= 15 * MINUTE;
    if (c.blockSize === 28) return good(30000);
    if (c.blockSize === 23) return good(on ? 18000 : 36000);
    return good(on ? 12000 : 24000);
  };
  const s = make(1, [DEFAULTS, { ...DEFAULTS, blockSize: 28 }], 80, { longRun: true });
  drive(s, lit, 30 * MINUTE);
  const r = s.result();
  assert.equal(r.conditionsChanged, true);
  const { before, after, steady } = r.byConditions;
  assert.equal(before.candidate.blockSize, 23);
  assert.equal(after.candidate.blockSize, 28);
  assert.equal(steady.candidate.blockSize, 28);
  assert.ok(Math.abs(before.mean - 36000) < 1 && before.readings >= 1);
  assert.ok(Math.abs(steady.before - 30000) < 1 && Math.abs(steady.after - 30000) < 1);
  // A one-pass run splits at the reference's later readings.
  const t = make(1, [DEFAULTS, { ...DEFAULTS, blockSize: 28 }]);
  drive(t, (c, ms, usedMs) => lit(c, ms, usedMs + (usedMs >= 2.5 * MINUTE ? 15 * MINUTE : 0)), 5 * MINUTE);
  const q = t.result();
  if (q.conditionsChanged) assert.ok(q.byConditions.before && q.byConditions.after);
  const calm = make(1, [DEFAULTS], 80, { longRun: true });
  drive(calm, noisy(1, flat, 0.1), 30 * MINUTE);
  assert.equal(calm.result().byConditions, null);
});
