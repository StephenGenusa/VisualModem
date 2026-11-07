import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  refineStep, createRefineState, createScreenShapes, refineOutcome, resultRows, describeSettings, testReading, blocksToPrepare,
  loadWinners, saveWinner, saveLastResult, loadLastResult, seedsFrom, seedCountFor, KNOWN_GOOD, FIRST_REPORT_MS, AWAY_LIMIT_MS, REPORT_STALE_MS, LIMIT_MINUTES, DEFAULT_LIMIT_MINUTES, phoneAwayReason,
} from '../src/optimize/refineloop.js';
import { createSearch, EARLY_MS, SCREEN_MS, TEST_MS, SWITCH_MS, TEST_COST_MS, candidateKey } from '../src/optimize/search.js';
import { createLinkSim, seededRandom, trueRate, bestTrueRate, withDeadArea } from '../src/testutil/linksim.js';
import { createTestCounter } from '../src/optimize/testcount.js';
import { FRAME_TYPES } from '../src/core/frame.js';

const CUBE = { kind: 'rgb', levels: [2, 2, 2] };
const START = { blockSize: 23, parity: 32, fps: 10, white: 255 };
const RUN = 77;
const TICK = 200;
const K4 = { widthPx: 3840, heightPx: 2160 };

const shapes4k = createScreenShapes({ ...K4, scheme: CUBE });

/** A loop over a stub or real search, driven by hand with a fake clock. */
function harness({ limitMs = 180000, search, seeds = [START] } = {}) {
  const s = search ?? createSearch({ cap: 45, seeds, fixed: { scheme: CUBE }, random: seededRandom(5), ceilingOf: shapes4k.ceilingOf });
  const h = {
    now: 0,
    search: s,
    state: createRefineState({ search: s, limitMs, runId: RUN, shapes: shapes4k, previous: START, first: seeds[0] }),
    reads: 100,
    /** One step; entries are this tick's reports. */
    step(entries = [], extra = {}) {
      const out = refineStep(h.state, { nowMs: h.now, entries, ...extra });
      h.state = out.state;
      return out.action;
    },
    /** A report as the phone posts it. */
    post({ add = 15, testCounts = [], widthShare = null, health = {}, cameraReads } = {}) {
      h.reads = cameraReads ?? h.reads + add;
      return {
        health: { visible: true, camera: 'running', noMarkersStreak: 0, ...health },
        cameraReads: h.reads, markerReads: h.reads, widthShare, testCounts,
      };
    },
    /** Past the first report and the settling time, up to the first test's show action. */
    begin() {
      h.step([h.post()]);
      h.step([], { shown: true });
      let action;
      for (let i = 0; i < 100; i++) {
        h.now += TICK;
        action = h.step();
        if (action.type === 'show') return action;
      }
      assert.fail('the first test never came');
    },
    /** Starts the test named by a show action: shown now, with one report on screen. */
    shown(action) {
      const a = h.step([], { shown: true });
      assert.equal(a.type, 'wait');
      return action;
    },
    /** Moves time on with no reports, stopping at any action that is not a plain wait. */
    until(ms) {
      const end = h.now + ms;
      while (h.now < end) {
        h.now += TICK;
        const action = h.step();
        if (action.type !== 'wait') return action;
      }
      return h.step();
    },
    counts: (probeId, packets, reads, firstMs = 150, lastMs = firstMs + 5900) => ({ runId: RUN, probeId, packets, reads, goodReads: reads, firstMs, lastMs }),
  };
  return h;
}

/** A stub search that records what it is told and always offers one full test, then ends. */
function stubSearch(candidates = [{ ...START, scheme: CUBE }], result = {}) {
  const log = { records: [], moved: 0, nexts: 0, streak: 0, setAside: 0 };
  let pending = null;
  const queue = [...candidates];
  return {
    log,
    next(remainingMs) {
      log.nexts++;
      if (remainingMs < TEST_COST_MS) return null;
      if (!pending) {
        const candidate = queue.shift();
        if (!candidate) return null;
        pending = { candidate, reason: 'seed', testMs: candidate.testMs ?? TEST_MS };
      }
      return pending;
    },
    record(candidate, reading) {
      log.records.push({ candidate, reading });
      pending = null;
      log.streak = reading.bytesPerSecond > 0 ? 0 : log.streak + 1;
    },
    markMoved() { log.moved++; log.streak = 0; },
    zeroStreak: () => {
      const row = result.leader && (result.ranked ?? [])[0];
      return { count: log.streak, before: row ? { candidate: result.leader, mean: row.mean } : null };
    },
    setAsideZeros() { log.setAside += log.streak; log.streak = 0; pending = null; },
    result: () => ({ winner: null, leader: null, provisional: false, ranked: [], separated: false, tests: log.records.length, coverage: { screened: 0, full: 0 }, ...result }),
  };
}

// ---- the first report ----

test('waits for the phone, then stops with a message after 20 s', () => {
  const h = harness();
  assert.equal(h.step().type, 'wait');
  const waited = h.until(FIRST_REPORT_MS - 2 * TICK);
  assert.equal(waited.type, 'wait');
  assert.match(waited.why, /phone/i);
  const end = h.until(5 * TICK);
  assert.equal(end.type, 'abort');
  assert.match(end.message, /Receive page/);
  assert.equal(h.search.result().tests, 0);
});

test('a hidden page or a stopped camera is named when the wait ends', () => {
  for (const [health, pattern] of [[{ visible: false }, /background/], [{ camera: 'off' }, /camera/]]) {
    const h = harness();
    assert.equal(h.step([h.post({ health })]).type, 'wait');
    const end = h.until(FIRST_REPORT_MS + TICK);
    assert.equal(end.type, 'abort');
    assert.match(end.message, pattern);
  }
});

test('a phone page that sends no read counts is told to reload', () => {
  const h = harness();
  h.step([{ health: { visible: true, camera: 'running' }, testCounts: [] }]);
  const end = h.until(FIRST_REPORT_MS + TICK);
  assert.match(end.message, /[Rr]eload/);
});

test('the time limit starts after the phone has reported and the camera has settled', () => {
  const h = harness({ limitMs: 60000 });
  h.step();
  h.until(15000);
  h.begin();
  assert.ok(h.state.endMs > h.now + 59000 && h.state.endMs <= h.now + 60000 + TICK);
});

// ---- telling a dead setting from a gone phone ----

/** Starts a test on a stub search; a first report after the show sets the read baseline. */
function inTest(search = stubSearch(), limitMs = 180000) {
  const h = harness({ search, limitMs });
  const show = h.begin();
  assert.equal(show.type, 'show');
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ add: 5 })]);
  return { h, show, search };
}

test('a dead setting: no entry at all but camera reads rise, so it is a zero at the early check', () => {
  const { h, search } = inTest();
  h.now += 1000;
  assert.equal(h.step([h.post()]).type, 'wait');
  h.now = h.state.test.shownMs + EARLY_MS + 100;
  const a = h.step([h.post()]);
  assert.equal(a.type, 'record');
  assert.equal(a.counted, true);
  assert.equal(search.log.records.length, 1);
  assert.deepEqual(search.log.records[0].reading, { bytesPerSecond: 0, reads: 30, zeroAtEarlyCheck: true });
});

test('the early check ends a test with no pieces', () => {
  const { h, show, search } = inTest();
  h.now = h.state.test.shownMs + EARLY_MS + 100;
  const a = h.step([h.post({ testCounts: [h.counts(show.probeId, 0, 4)] })]);
  assert.equal(a.type, 'record');
  assert.equal(search.log.records[0].reading.zeroAtEarlyCheck, true);
  assert.equal(search.log.records[0].reading.bytesPerSecond, 0);
});

test('the early check does not end a test with pieces, or before a report covers it', () => {
  const { h, show, search } = inTest();
  h.now = h.state.test.shownMs + EARLY_MS + 100;
  assert.equal(h.step().type, 'wait', 'no report since the check came due');
  assert.equal(h.step([h.post({ testCounts: [h.counts(show.probeId, 3, 4)] })]).type, 'wait');
  assert.equal(search.log.records.length, 0);
});

test('reads from before the test do not make a zero: the baseline is the first report after the show', () => {
  const h = harness({ search: stubSearch() });
  h.begin();
  h.step([], { shown: true });
  // Only one report since the show, carrying a large rise from earlier reads: no judgement yet.
  h.now = h.state.test.shownMs + EARLY_MS + 100;
  assert.equal(h.step([h.post({ add: 60 })]).type, 'wait');
});

test('no rise and no entry: the phone is away, the test does not count, and it repeats when the phone returns', () => {
  const { h, show, search } = inTest();
  h.now = h.state.test.shownMs + TEST_MS + 100;
  const a = h.step([h.post({ add: 0 })]);
  assert.equal(a.type, 'record');
  assert.equal(a.counted, false);
  assert.equal(search.log.records.length, 0);
  assert.equal(h.state.phase, 'away');
  // Still not reading: it waits.
  h.now += 1000;
  const waiting = h.step([h.post({ add: 0 })]);
  assert.equal(waiting.type, 'wait');
  assert.match(waiting.why, /not reading/);
  // Reading again: the same candidate shows again under a new probe id.
  h.now += 1000;
  const again = h.step([h.post({ add: 10 })]);
  assert.equal(again.type, 'show');
  assert.equal(candidateKey(again.candidate), candidateKey(show.candidate));
  assert.ok(again.probeId > show.probeId);
});

test('a test does not count while the phone is away: hidden, camera off, or reports stopped', () => {
  for (const make of [
    (h) => h.step([h.post({ health: { visible: false } })]),
    (h) => h.step([h.post({ health: { camera: 'off' } })]),
    (h) => h.until(REPORT_STALE_MS + TICK),
  ]) {
    const { h, search } = inTest();
    const a = make(h);
    assert.equal(a.type, 'record');
    assert.equal(a.counted, false);
    assert.equal(search.log.records.length, 0);
    assert.equal(h.state.phase, 'away');
  }
});

test('stops after 30 s away with a provisional result', () => {
  const result = {
    winner: { ...START, scheme: CUBE }, leader: { ...START, scheme: CUBE }, provisional: false,
    ranked: [{ candidate: { ...START, scheme: CUBE }, mean: 30000, min: 29000, max: 31000, readings: 3, alive: true }],
  };
  const { h } = inTest(stubSearch(undefined, result));
  h.step([h.post({ health: { visible: false } })]);
  const before = h.now;
  assert.equal(h.until(AWAY_LIMIT_MS - 2 * TICK).type, 'wait');
  const end = h.until(5 * TICK);
  assert.equal(end.type, 'finish');
  assert.ok(h.now - before >= AWAY_LIMIT_MS);
  assert.equal(end.outcome.provisional, true);
  assert.deepEqual(end.outcome.apply, result.winner);
  assert.match(end.outcome.message, /provisional/);
  assert.match(end.outcome.message, /phone/);
});

test('a drop in camera reads is a page reload: no negative difference, the test repeats', () => {
  const { h, show, search } = inTest();
  h.now += 1000;
  const a = h.step([h.post({ cameraReads: 3 })]);
  assert.equal(a.type, 'record');
  assert.equal(a.counted, false);
  assert.match(a.why, /reload/);
  assert.equal(search.log.records.length, 0);
  const again = h.step();
  assert.equal(again.type, 'show');
  assert.equal(candidateKey(again.candidate), candidateKey(show.candidate));
  assert.notEqual(again.probeId, show.probeId);
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ add: 5 })]);
  assert.equal(h.state.test.baseline, h.reads);
});

test('a test that is not counted never reaches the search, even with entries', () => {
  const { h, show, search } = inTest();
  h.step([h.post({ testCounts: [h.counts(show.probeId, 50, 40)], health: { visible: false } })]);
  assert.equal(search.log.records.length, 0);
});

// ---- reports that lag ----

test('a late report does not count for the next test', () => {
  const search = stubSearch([{ ...START, scheme: CUBE }, { ...START, fps: 12, scheme: CUBE }]);
  const { h, show } = inTest(search);
  h.now = h.state.test.shownMs + TEST_MS + 100;
  const a = h.step([h.post({ testCounts: [h.counts(show.probeId, 200, 90)] })]);
  assert.equal(a.counted, true);
  const next = h.step();
  assert.equal(next.type, 'show');
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ add: 5 })]);
  // The old test's later counts and another run's entry with this probe id arrive in this test.
  const shownAt = h.state.test.shownMs;
  h.now = shownAt + TEST_MS + 100;
  const b = h.step([h.post({
    testCounts: [h.counts(show.probeId, 999, 99), { ...h.counts(next.probeId, 999, 99), runId: RUN + 1 }, h.counts(next.probeId, 150, 90)],
  })]);
  assert.equal(b.type, 'record');
  const { reading } = search.log.records[1];
  assert.ok(Math.abs(reading.bytesPerSecond - (150 * shapes4k.shapeOf(23, 32).packetBytes) / 5.9) < 1);
});

test('a finished test waits for its final report, but no longer than the switch time', () => {
  const { h, show, search } = inTest();
  h.now = h.state.test.shownMs + TEST_MS - 400;
  h.step([h.post({ testCounts: [h.counts(show.probeId, 180, 80)] })]);
  h.now = h.state.test.shownMs + TEST_MS + 10;
  assert.equal(h.step().type, 'wait', 'no report since the test ended');
  assert.equal(search.log.records.length, 0);
  h.now = h.state.test.shownMs + TEST_MS + 500;
  const a = h.step([h.post({ testCounts: [h.counts(show.probeId, 200, 90)] })]);
  assert.equal(a.type, 'record');

  const late = inTest();
  const earlier = [late.h.counts(late.show.probeId, 120, 60, 150, 5000)];
  late.h.now = late.h.state.test.shownMs + TEST_MS - 800;
  late.h.step([late.h.post({ testCounts: earlier })]);
  late.h.now = late.h.state.test.shownMs + TEST_MS + SWITCH_MS - 100;
  assert.equal(late.h.step().type, 'wait');
  late.h.now += 200;
  const judged = late.h.step();
  assert.equal(judged.type, 'record', 'judged on the latest report once the switch time is up');
  assert.equal(judged.counted, true);
});

// ---- the rate ----

test('the rate uses the phone\'s own span, held between the test length less 1 s and the test length', () => {
  const pb = 214;
  const at = (span, testMs = TEST_MS) => testReading({
    counts: { packets: 100, reads: 90, firstMs: 1000, lastMs: 1000 + span }, rise: 90, testMs, packetBytes: pb,
  });
  assert.equal(at(5500).bytesPerSecond, (100 * pb) / 5.5);
  assert.equal(at(4000).bytesPerSecond, (100 * pb) / 5, 'a short span cannot make a huge rate');
  assert.equal(at(0).bytesPerSecond, (100 * pb) / 5);
  assert.equal(at(6900).bytesPerSecond, (100 * pb) / 6, 'frames repeat after the test length, so more time is not more data');
  assert.equal(at(300, SCREEN_MS).bytesPerSecond, (100 * pb) / 1);
  assert.equal(at(2800, SCREEN_MS).bytesPerSecond, (100 * pb) / 2);
});

test('reads taken while settling do not inflate the read rate the search tracks', () => {
  const r = testReading({ counts: { packets: 30, reads: 45, firstMs: 0, lastMs: 3000 }, rise: 45, testMs: SCREEN_MS, packetBytes: 214 });
  assert.equal(r.reads, 30);
  const plain = testReading({ counts: { packets: 30, reads: 80, firstMs: 0, lastMs: 5900 }, rise: 80, testMs: TEST_MS, packetBytes: 214 });
  assert.equal(plain.reads, 80);
});

test('a setting with few readable headers while the phone reads on is a low reading, not an absence', () => {
  const r = testReading({ counts: { packets: 2, reads: 3, firstMs: 0, lastMs: 5000 }, rise: 80, testMs: TEST_MS, packetBytes: 214 });
  assert.equal(r.reads, 80);
  assert.ok(r.bytesPerSecond > 0);
  assert.equal(testReading({ counts: { packets: 2, reads: 3, firstMs: 0, lastMs: 5000 }, rise: 3, testMs: TEST_MS, packetBytes: 214 }), null);
});

test('the zero rules: no pieces with reads is a zero, with too few it is nothing', () => {
  assert.deepEqual(testReading({ counts: null, rise: 40, testMs: TEST_MS, packetBytes: 214 }), { bytesPerSecond: 0, reads: 40, zeroAtEarlyCheck: false });
  assert.deepEqual(testReading({ counts: { packets: 0, reads: 7, firstMs: 0, lastMs: 100 }, rise: 2, testMs: TEST_MS, packetBytes: 214 }), { bytesPerSecond: 0, reads: 7, zeroAtEarlyCheck: false });
  assert.equal(testReading({ counts: null, rise: 5, testMs: TEST_MS, packetBytes: 214 }), null);
  assert.deepEqual(testReading({ counts: null, rise: 3, testMs: SCREEN_MS, packetBytes: 214 }), { bytesPerSecond: 0, reads: 3, zeroAtEarlyCheck: true });
  assert.equal(testReading({ counts: null, rise: 2, testMs: SCREEN_MS, packetBytes: 214 }), null);
});

// ---- framing ----

test('a framing change marks the run as moved, and the test in progress starts over', () => {
  const { h, show, search } = inTest();
  h.now += 500;
  h.step([h.post({ widthShare: 0.65 })]);
  h.now += 1000;
  assert.equal(h.step([h.post({ widthShare: 0.72 })]).type, 'wait', 'one report is not a move');
  assert.equal(search.log.moved, 0);
  h.now += 1000;
  const a = h.step([h.post({ widthShare: 0.72 })]);
  assert.equal(a.type, 'record');
  assert.equal(a.counted, false);
  assert.match(a.why, /framing/);
  assert.equal(search.log.moved, 1);
  const again = h.step();
  assert.equal(again.type, 'show');
  assert.equal(candidateKey(again.candidate), candidateKey(show.candidate));
  // The new framing is the new start.
  h.step([], { shown: true });
  h.now += 1000;
  h.step([h.post({ widthShare: 0.72 })]);
  h.now += 1000;
  h.step([h.post({ widthShare: 0.73 })]);
  assert.equal(search.log.moved, 1);
});

test('an unknown framing is neither a move nor the phone leaving', () => {
  const { h, show, search } = inTest();
  h.now += 500;
  h.step([h.post({ widthShare: 0.65 })]);
  for (let i = 0; i < 3; i++) {
    h.now += 1000;
    assert.equal(h.step([h.post({ widthShare: null, testCounts: [h.counts(show.probeId, 10, 10)] })]).type, 'wait');
  }
  assert.equal(search.log.moved, 0);
  assert.equal(h.state.phase, 'test');
});

// ---- ending ----

test('Escape keeps the Send page\'s settings', () => {
  const leader = { ...START, blockSize: 25, scheme: CUBE };
  const { h } = inTest(stubSearch(undefined, { winner: leader, leader, ranked: [{ candidate: leader, mean: 3e4, min: 3e4, max: 3e4, readings: 3, alive: true }] }));
  const end = h.step([], { stopped: true });
  assert.equal(end.type, 'finish');
  assert.equal(end.outcome.apply, null);
  assert.match(end.outcome.message, /not changed/);
  assert.match(end.outcome.message, /block 23, parity 32, 10 fps/);
});

const reading = (candidate, mean, readings = 3, alive = true) => ({ candidate, mean, min: mean * 0.9, max: mean * 1.1, readings, alive, reason: 'race' });
const c25 = { ...START, blockSize: 25, scheme: CUBE };

test('all zeros keeps them', () => {
  for (const markersSeen of [true, false]) {
    const o = refineOutcome({
      result: { winner: null, leader: null, provisional: false, ranked: [reading(c25, 0, 2)], tests: 4, coverage: { screened: 0, full: 1 } },
      how: 'done', previous: START, markersSeen,
    });
    assert.equal(o.apply, null);
    assert.equal(o.provisional, false);
    assert.match(o.message, /not changed/);
    assert.match(o.message, markersSeen ? /No setting/ : /markers/);
  }
});

test('a finished run applies the winner and names the previous settings', () => {
  const o = refineOutcome({
    result: { winner: c25, leader: c25, provisional: false, ranked: [reading(c25, 33000)], separated: true, tests: 20, coverage: { screened: 9, full: 3 } },
    how: 'done', previous: START, markersSeen: true,
  });
  assert.deepEqual(o.apply, c25);
  assert.equal(o.provisional, false);
  assert.match(o.message, /block 25, parity 32, 10 fps/);
  assert.match(o.message, /33\.0 KB\/s/);
  assert.match(o.message, /Previous settings: block 23, parity 32, 10 fps/);
  assert.doesNotMatch(o.message, /provisional/);
});

test('a flagged winner, or a leader with no winner, is applied and labelled provisional', () => {
  const flagged = refineOutcome({ result: { winner: c25, leader: c25, provisional: true, ranked: [reading(c25, 33000)], coverage: {} }, how: 'done', previous: START, markersSeen: true });
  assert.deepEqual(flagged.apply, c25);
  assert.equal(flagged.provisional, true);
  assert.match(flagged.message, /provisional/);
  const leaderOnly = refineOutcome({ result: { winner: null, leader: c25, provisional: true, ranked: [reading(c25, 33000, 1)], coverage: {} }, how: 'done', previous: START, markersSeen: true });
  assert.deepEqual(leaderOnly.apply, c25);
  assert.equal(leaderOnly.provisional, true);
});

test('a dropped candidate is never applied', () => {
  const o = refineOutcome({ result: { winner: c25, leader: c25, provisional: false, ranked: [reading(c25, 33000, 3, false)], coverage: {} }, how: 'done', previous: START, markersSeen: true });
  assert.equal(o.apply, null);
  assert.match(o.message, /not changed/);
});

test('the same settings winning is said plainly', () => {
  const same = { ...START, scheme: CUBE };
  const o = refineOutcome({ result: { winner: same, leader: same, provisional: false, ranked: [reading(same, 33000)], coverage: {} }, how: 'done', previous: START, markersSeen: true });
  assert.match(o.message, /kept/);
});

test('settings still untested are not presented as a failure', () => {
  const o = refineOutcome({ result: { winner: c25, leader: c25, provisional: false, ranked: [reading(c25, 33000)], coverage: { screened: 9, full: 3, untestedPlausible: 400 } }, how: 'done', previous: START, markersSeen: true });
  assert.doesNotMatch(o.message, /400/);
  assert.equal(o.kind, 'ok');
});

test('a finished real search ends in a finish action when the time runs out', () => {
  const h = harness({ limitMs: 1000 });
  h.step([h.post()]);
  h.step([], { shown: true });
  const end = h.until(10000);
  assert.equal(end.type, 'finish');
  assert.equal(end.outcome.apply, null);
});

test('the table lists tested settings only, with mean, range and readings', () => {
  const rows = resultRows({ ranked: [reading(c25, 33000, 4), { candidate: START, mean: null, min: null, max: null, readings: 0, rough: 9000, alive: true }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settings, 'block 25, parity 32, 10 fps');
  assert.equal(rows[0].mean, '33.0');
  assert.equal(rows[0].range, '29.7 to 36.3');
  assert.equal(rows[0].readings, 4);
});

test('settings are described with white only when it is not full', () => {
  assert.equal(describeSettings(START), 'block 23, parity 32, 10 fps');
  assert.equal(describeSettings({ ...START, white: 223, fps: 7.5 }), 'block 23, parity 32, 7.5 fps, white 223');
});

// ---- frames that hold nothing ----

test('a candidate whose frame holds nothing is not shown, and counts as a zero', () => {
  const tiny = createScreenShapes({ widthPx: 1280, heightPx: 720, scheme: CUBE });
  const none = { blockSize: 35, parity: 48, fps: 10, white: 255, scheme: CUBE };
  const search = stubSearch([none, { ...START, scheme: CUBE }]);
  const h = harness({ search });
  h.state = createRefineState({ search, limitMs: 180000, runId: RUN, shapes: tiny, previous: START, first: START });
  h.step([h.post()]);
  h.step([], { shown: true });
  let action;
  for (let i = 0; i < 100; i++) {
    h.now += TICK;
    action = h.step();
    if (action.type !== 'wait') break;
  }
  assert.equal(action.type, 'record');
  assert.equal(action.shown, false);
  assert.equal(search.log.records[0].reading.bytesPerSecond, 0);
  assert.equal(h.step().type, 'show');
});

// ---- the screen's real grid ----

test('the ceiling uses the real grid: a known value on a 4K and a 1080p screen', () => {
  assert.deepEqual(shapes4k.shapeOf(23, 32), { packets: 21, packetBytes: 214 });
  const c = { blockSize: 23, parity: 32, fps: 10, white: 255 };
  assert.equal(shapes4k.ceilingOf(c, 15), 21 * 214 * 10);
  assert.equal(shapes4k.ceilingOf({ ...c, fps: 30 }, 15), 21 * 214 * 15);
  const hd = createScreenShapes({ widthPx: 1920, heightPx: 1080, scheme: CUBE });
  assert.deepEqual(hd.shapeOf(23, 32), { packets: 5, packetBytes: 188 });
  assert.equal(hd.ceilingOf(c, 15), 5 * 188 * 10);
});

test('the ceiling follows the rate the screen really shows', () => {
  const s = createScreenShapes({ ...K4, scheme: CUBE, shownFps: (f) => (f === 7.5 ? 8 : f) });
  assert.equal(s.ceilingOf({ blockSize: 23, parity: 32, fps: 7.5, white: 255 }, 15), 21 * 214 * 8);
});

test('the ceiling is always a finite number, and 0 where no frame fits', () => {
  const tiny = createScreenShapes({ widthPx: 1280, heightPx: 720, scheme: CUBE });
  assert.equal(tiny.shapeOf(35, 48), null, 'parity leaves no room');
  assert.equal(tiny.ceilingOf({ blockSize: 35, parity: 48, fps: 10, white: 255 }, 15), 0);
  assert.equal(tiny.ceilingOf({ blockSize: 99, parity: 8, fps: 10, white: 255 }, 15), 0, 'a grid under the minimum');
  for (const rate of [NaN, undefined, 0, -3, Infinity]) {
    const v = shapes4k.ceilingOf({ blockSize: 23, parity: 32, fps: 10, white: 255 }, rate);
    assert.equal(v, 21 * 214 * 10, `read rate ${rate}`);
  }
  const bad = createScreenShapes({ ...K4, scheme: CUBE, shownFps: () => NaN });
  assert.equal(bad.ceilingOf({ blockSize: 23, parity: 32, fps: 10, white: 255 }, 15), 21 * 214 * 10);
});

test('each block and parity is worked out once, and all can be prepared before the run', () => {
  let layouts = 0;
  const s = createScreenShapes({ ...K4, scheme: CUBE, onLayout: () => { layouts++; } });
  const blocks = blocksToPrepare(45, [START]);
  assert.ok(blocks.includes(19) && blocks.includes(35) && blocks.every((b) => b >= 19), 'the space, and no smaller blocks');
  for (const b of blocks) s.prepare(b, [0, 32]);
  const made = layouts;
  assert.equal(made, blocks.length);
  s.ceilingOf({ blockSize: 19, parity: 32, fps: 10, white: 255 }, 15);
  s.shapeOf(19, 0);
  s.layoutOf(23);
  assert.equal(layouts, made);
});

// ---- saved winners ----

function fakeStore() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data };
}
const won = (blockSize, mean) => ({ blockSize, parity: 32, fps: 10, white: 255, mean, readings: 5, widthShare: 0.65 });

test('saved winners are kept per screen size, best first, at most 8, with only their settings and figures', () => {
  const store = fakeStore();
  for (let i = 0; i < 10; i++) saveWinner(store, '3840x2160', won(19 + i * 2, 1000 * i));
  saveWinner(store, '1920x1080', won(23, 5));
  const list = loadWinners(store, '3840x2160');
  assert.equal(list.length, 8);
  assert.deepEqual(list.map((w) => w.mean), [9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['blockSize', 'fps', 'levels', 'mean', 'parity', 'readings', 'scheme', 'white', 'widthShare']);
  assert.equal(loadWinners(store, '1920x1080').length, 1);
  saveWinner(store, '1920x1080', won(23, 9));
  assert.deepEqual(loadWinners(store, '1920x1080').map((w) => w.mean), [9], 'the same settings replace their old figures');
});

test('storage failure is harmless, and bad stored data is left out', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadWinners(broken, 'a'), []);
  assert.doesNotThrow(() => saveWinner(broken, 'a', won(23, 1)));
  assert.deepEqual(loadWinners(null, 'a'), []);
  assert.doesNotThrow(() => saveWinner(null, 'a', won(23, 1)));
  const store = fakeStore();
  store.setItem('visual-modem:refine:a', 'not json');
  assert.deepEqual(loadWinners(store, 'a'), []);
  store.setItem('visual-modem:refine:a', JSON.stringify([won(23, 1), { blockSize: 'x' }, { ...won(21, 2), fps: -1 }, { ...won(21, 2), parity: NaN }, null]));
  assert.deepEqual(loadWinners(store, 'a').map((w) => w.blockSize), [23]);
});

test('seeds are the Send page settings, then saved winners, at most 5, leaving out any that cannot fit', () => {
  const saved = [won(25, 9), won(27, 8), won(29, 7), won(31, 6), won(33, 5)];
  const seeds = seedsFrom(START, saved, shapes4k);
  assert.equal(seeds.length, 5);
  assert.deepEqual(seeds[0], START);
  assert.equal(seeds[1].blockSize, 25);
  assert.ok(!('mean' in seeds[1]));
  const tiny = createScreenShapes({ widthPx: 1280, heightPx: 720, scheme: CUBE });
  assert.deepEqual(seedsFrom({ ...START, blockSize: 35, parity: 48 }, [won(23, 1)], tiny).map((s) => s.blockSize), [23]);
});

test('the limits are 1, 3, 5 and 30 minutes, 3 by default', () => {
  assert.deepEqual(LIMIT_MINUTES, [1, 3, 5, 30]);
  assert.equal(DEFAULT_LIMIT_MINUTES, 3);
});

// ---- the whole loop, on the simulator ----

const READS_PER_SECOND = 15;
const POST_MS = 1000;
const CAMERA_LAG_MS = 150;

/**
 * Runs the real search and refineStep against a fake phone: it reads what was on
 * screen a moment ago through the real test counter, posts once a second, and
 * each post reaches the computer after a lag of up to lagMs.
 */
function simulate({ limitMs, seed, lagMs, away, offAim, stall, moveAtMs = Infinity, noise = 0.12, rate = trueRate, seeds = [START] }) {
  const random = seededRandom(seed);
  const sim = createLinkSim({ random, noise, rate });
  const search = createSearch({ cap: 45, seeds, fixed: { scheme: CUBE }, random: seededRandom(seed + 1), ceilingOf: shapes4k.ceilingOf, longRun: limitMs >= 1800000 });
  let state = createRefineState({ search, limitMs, runId: RUN, shapes: shapes4k, previous: START, first: START });
  const counter = createTestCounter();
  const shows = []; // { atMs, probeId, drawn, nextId, packetBytes, testMs }
  const shownLog = [];
  const drawn = new Map();
  const inFlight = [];
  const counted = [];
  let now = 0;
  let nextRead = 0;
  let nextPost = 300;
  let shown = false;
  let tests = 0;
  const onScreen = (atMs) => {
    for (let i = shows.length - 1; i >= 0; i--) if (shows[i].atMs <= atMs) return shows[i];
    return null;
  };
  const phoneUp = (t) => !(away && t >= away.fromMs && t < away.toMs);
  const sinceStart = (t) => (state.startMs === null ? -1 : t - state.startMs);
  const aimedOff = (t) => Boolean(offAim) && sinceStart(t) >= offAim.fromMs && sinceStart(t) < offAim.toMs;
  const stalled = (t) => Boolean(stall) && sinceStart(t) >= stall.fromMs && sinceStart(t) < stall.fromMs + stall.ms;
  const advance = (to) => {
    while (nextRead <= to || nextPost <= to) {
      if (nextRead <= nextPost) {
        const t = nextRead;
        nextRead += 1000 / READS_PER_SECOND;
        if (!phoneUp(t)) continue;
        const show = onScreen(t - CAMERA_LAG_MS);
        let header = null;
        if (show && show.probeId > 0 && show.rate > 0 && !aimedOff(t)) {
          const ids = [];
          // Frames repeat after the test length: no new pieces from then on.
          if (t - CAMERA_LAG_MS - show.atMs < show.testMs) {
            show.owed += show.rate / show.packetBytes / READS_PER_SECOND;
            while (show.owed >= 1) { ids.push(show.nextId++); show.owed--; }
          }
          header = { frameType: FRAME_TYPES.probe, streamLength: RUN, probeId: show.probeId, symbolIds: ids };
        }
        counter.add({ atMs: t, header, markers: Boolean(show) });
      } else {
        const t = nextPost;
        nextPost += POST_MS;
        if (!phoneUp(t) || stalled(t)) continue;
        inFlight.push({
          arriveMs: t + lagMs * random(),
          entry: { health: { visible: true, camera: 'running' }, ...counter.totals(), testCounts: counter.report({ nowMs: t }), widthShare: sinceStart(t) >= moveAtMs ? 0.8 : 0.65 },
        });
      }
    }
  };
  for (let guard = 0; guard < 200000; guard++) {
    advance(now);
    inFlight.sort((a, b) => a.arriveMs - b.arriveMs);
    const entries = [];
    while (inFlight.length && inFlight[0].arriveMs <= now) entries.push(inFlight.shift().entry);
    const out = refineStep(state, { nowMs: now, entries, shown });
    shown = false;
    state = out.state;
    const a = out.action;
    if (a.type === 'finish' || a.type === 'abort') {
      return { action: a, state, drawn, counted, endMs: now, tests, search, shownLog };
    }
    if (a.type === 'show') {
      now += 30; // building the frames takes a moment
      advance(now);
      const m = a.probeId > 0 ? sim.measure(a.candidate, a.testMs) : { bytesPerSecond: 0 };
      if (a.probeId > 0) { drawn.set(a.probeId, m.bytesPerSecond); tests++; shownLog.push(a); }
      shows.push({ atMs: now, probeId: a.probeId, rate: m.bytesPerSecond, testMs: a.testMs, nextId: 0, owed: 0, packetBytes: shapes4k.shapeOf(a.candidate.blockSize, a.candidate.parity).packetBytes });
      shown = true;
    } else if (a.type === 'record') {
      if (a.counted) counted.push(a);
    } else {
      now += TICK;
    }
  }
  assert.fail('the loop never finished');
}

for (const lagMs of [0, 1000]) {
  test(`three minutes on the simulator with reports lagging up to ${lagMs} ms: on time, a good winner, no reading misattributed`, () => {
    const best = bestTrueRate();
    for (const seed of [11, 22, 33]) {
      const { action, state, drawn, counted, endMs, search } = simulate({ limitMs: 180000, seed, lagMs });
      assert.equal(action.type, 'finish', `seed ${seed}`);
      assert.ok(endMs - state.startMs <= 180000 + TEST_COST_MS, `seed ${seed}: ran ${endMs - state.startMs} ms`);
      assert.ok(counted.length >= 15, `seed ${seed}: ${counted.length} tests counted`);
      const winner = action.outcome.apply;
      assert.ok(winner, `seed ${seed}: applied a setting`);
      assert.ok(trueRate(winner) >= 0.8 * best, `seed ${seed}: ${candidateKey(winner)} reads ${trueRate(winner)} of ${best}`);
      assert.equal(search.result().tests >= counted.length, true);
      // Each reading is what the phone was shown for that test, not another's.
      for (const r of counted) {
        const d = drawn.get(r.probeId);
        if (r.reading.bytesPerSecond === 0) {
          assert.equal(d, 0, `seed ${seed}: test ${r.probeId} read zero but was drawn at ${d}`);
          continue;
        }
        const ratio = r.reading.bytesPerSecond / d;
        assert.ok(ratio > 0.7 && ratio < 1.3, `seed ${seed}: test ${r.probeId} read ${r.reading.bytesPerSecond}, drawn ${d}`);
      }
    }
  });
}

test('on the simulator a phone that leaves for 12 s costs a repeat, not a false reading', () => {
  const { action, state, drawn, counted } = simulate({ limitMs: 180000, seed: 44, lagMs: 500, away: { fromMs: 60000, toMs: 72000 } });
  assert.equal(action.type, 'finish');
  assert.ok(action.outcome.apply);
  assert.ok(state.startMs < 60000);
  for (const r of counted) {
    if (r.reading.bytesPerSecond === 0) assert.equal(drawn.get(r.probeId), 0, `test ${r.probeId} read zero while away`);
  }
});

test('on the simulator a phone that never returns ends the run with a provisional result', () => {
  const { action, endMs } = simulate({ limitMs: 180000, seed: 55, lagMs: 500, away: { fromMs: 60000, toMs: Infinity } });
  assert.equal(action.type, 'finish');
  assert.equal(action.outcome.provisional, true);
  assert.ok(endMs < 60000 + 7000 + REPORT_STALE_MS + AWAY_LIMIT_MS + 2000, `ended at ${endMs}`);
});

// ---- a phone off aim: its reads go on, but nothing on the screen reads ----

const checksOf = (run) => run.shownLog.filter((a) => a.reason === 'check').length;
const ofBest = (run, rate = trueRate) => rate(run.action.outcome.apply) / bestTrueRate(rate);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const leaderRow = { ...START, scheme: CUBE };
const withLeader = { winner: leaderRow, leader: leaderRow, provisional: false, ranked: [{ candidate: leaderRow, mean: 30000, min: 29000, max: 31000, readings: 5, alive: true }] };
const others = () => [19, 21, 25, 27, 29, 31].map((blockSize) => ({ ...START, blockSize, scheme: CUBE }));

/** Runs one test of a stub search to a reading: packets 0 ends it at the early check. */
function runTestTo(h, show, packets) {
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ add: 5 })]);
  const counts = packets > 0 ? [h.counts(show.probeId, packets, 80)] : [];
  if (packets > 0) {
    h.now = h.state.test.shownMs + 3000;
    h.step([h.post({ testCounts: counts })]);
  }
  h.now = h.state.test.shownMs + (packets > 0 ? TEST_MS + 100 : EARLY_MS + 100);
  return h.step([h.post({ add: 60, testCounts: counts })]);
}

/** Three zeros in a row on a stub search, up to the leader check's show action. */
function threeZeros() {
  const search = stubSearch(others(), withLeader);
  const h = harness({ search });
  let show = h.begin();
  for (let i = 0; i < 3; i++) {
    assert.equal(show.reason, 'seed');
    assert.equal(runTestTo(h, show, 0).counted, true);
    show = h.step();
    assert.equal(show.type, 'show');
  }
  return { h, search, show };
}

test('after 3 zeros in a row the leader is tested again, in full', () => {
  const { show, search } = threeZeros();
  assert.equal(show.reason, 'check');
  assert.equal(candidateKey(show.candidate), candidateKey(leaderRow));
  assert.equal(show.testMs, TEST_MS);
  assert.equal(search.log.setAside, 0, 'nothing is set aside until the leader has read');
});

test('a leader that still reads: the zeros stand, its reading counts, and the run goes on', () => {
  const { h, show, search } = threeZeros();
  const a = runTestTo(h, show, 400);
  assert.equal(a.type, 'record');
  assert.equal(a.counted, true);
  assert.equal(search.log.setAside, 0);
  assert.equal(search.log.records.length, 4);
  assert.equal(h.step().reason, 'seed');
});

test('a leader that reads zero too: the phone lost its aim, the zeros are set aside and the leader is shown again with no banner', () => {
  const { h, show, search } = threeZeros();
  const a = runTestTo(h, show, 0);
  assert.equal(a.type, 'record');
  assert.equal(a.counted, false);
  assert.match(a.why, /lost its aim/);
  assert.equal(search.log.setAside, 3);
  assert.equal(search.log.records.length, 3, 'the zero is withheld');
  const again = h.step();
  assert.equal(again.type, 'show', 'it does not wait as for a phone that left');
  assert.equal(again.reason, 'check');
  assert.equal(again.aimLost, true);
  assert.notEqual(again.probeId, show.probeId);
  h.step([], { shown: true });
  h.now += 500;
  const during = h.step([h.post()]);
  assert.equal(during.type, 'wait');
  assert.equal(during.why, null, 'a reason would freeze the frames behind a banner');
  // The leader reads again: its reading counts and the search takes over.
  h.now = h.state.test.shownMs + 3000;
  h.step([h.post({ testCounts: [h.counts(again.probeId, 90, 40)] })]);
  h.now = h.state.test.shownMs + TEST_MS + 100;
  const back = h.step([h.post({ add: 60, testCounts: [h.counts(again.probeId, 400, 80)] })]);
  assert.equal(back.counted, true);
  assert.equal(h.step().reason, 'seed');
});

test('a leader reading under the reject share is a partial knock, and is treated as a zero', () => {
  const pb = shapes4k.shapeOf(23, 32).packetBytes;
  const low = Math.floor((0.2 * 30000 * 5.9) / pb);
  const { h, show, search } = threeZeros();
  const a = runTestTo(h, show, low);
  assert.equal(a.counted, false);
  assert.match(a.why, /lost its aim/);
  assert.equal(search.log.setAside, 3);
  assert.equal(search.log.records.length, 3);

  const fair = threeZeros();
  const ok = runTestTo(fair.h, fair.show, Math.ceil((0.3 * 30000 * 5.9) / pb));
  assert.equal(ok.counted, true);
  assert.equal(fair.search.log.setAside, 0);
});

test('aim lost for 30 s ends the run, provisional, saying the aim was lost', () => {
  const { h, search, show: first } = threeZeros();
  let action = null;
  let show = first;
  const startedMs = h.now;
  for (let i = 0; i < 40; i++) {
    action = runTestTo(h, show, 0);
    if (action.type === 'finish') break;
    show = h.step();
  }
  assert.equal(action.type, 'finish');
  assert.equal(action.how, 'away');
  assert.ok(h.now - startedMs >= AWAY_LIMIT_MS - 3000, `ended after ${h.now - startedMs} ms`);
  assert.ok(h.now - startedMs <= AWAY_LIMIT_MS + TEST_COST_MS, `ended after ${h.now - startedMs} ms`);
  assert.equal(action.outcome.provisional, true);
  assert.deepEqual(action.outcome.apply, leaderRow);
  assert.match(action.outcome.message, /lost its aim/);
  assert.doesNotMatch(action.outcome.message, /went away/);
  assert.equal(search.log.records.length, 3);
});

test('aim lost before any setting read says so plainly, and changes nothing', () => {
  const o = refineOutcome({ result: { winner: null, leader: null, provisional: false, ranked: [], tests: 4, coverage: {} }, how: 'away', lostAim: true, previous: START, markersSeen: true });
  assert.equal(o.apply, null);
  assert.match(o.message, /lost its aim/);
  assert.match(o.message, /not changed/);
});

test('a framing move resets the leader check', () => {
  const { h, search } = threeZeros();
  h.step([], { shown: true });
  h.now += 500;
  h.step([h.post({ widthShare: 0.65 })]);
  h.now += 1000;
  h.step([h.post({ widthShare: 0.8 })]);
  h.now += 1000;
  const a = h.step([h.post({ widthShare: 0.8 })]);
  assert.equal(a.counted, false);
  assert.equal(search.log.moved, 1);
  assert.equal(h.step().reason, 'seed');
});

test('off aim from 5 min of a 30 min run: the leader so far is applied, provisional, soon after', () => {
  const ratios = [];
  for (const seed of [1, 2, 3, 4]) {
    const run = simulate({ limitMs: 1800000, seed, lagMs: 300, offAim: { fromMs: 300000, toMs: Infinity } });
    assert.equal(run.action.how, 'away', `seed ${seed}`);
    assert.equal(run.action.outcome.provisional, true);
    assert.match(run.action.outcome.message, /lost its aim/);
    assert.ok(run.endMs - run.state.startMs < 300000 + 70000, `seed ${seed} ended at ${run.endMs - run.state.startMs}`);
    ratios.push(ofBest(run));
  }
  assert.ok(median(ratios) >= 0.9, `median ${median(ratios)}`);
});

test('off aim from 20 min of a 30 min run: the settings are not spoiled, and not called done', () => {
  const ratios = [];
  for (const seed of [1, 2, 3, 4]) {
    const run = simulate({ limitMs: 1800000, seed, lagMs: 300, offAim: { fromMs: 1200000, toMs: Infinity } });
    assert.equal(run.action.outcome.provisional, true);
    assert.match(run.action.outcome.word, /provisional/);
    ratios.push(ofBest(run));
  }
  assert.ok(Math.min(...ratios) >= 0.9, `worst ${Math.min(...ratios)}`);
});

test('off aim at 5 minutes: not called done, and the leader so far stands', () => {
  for (const seed of [1, 2, 3, 4]) {
    const run = simulate({ limitMs: 300000, seed, lagMs: 300, offAim: { fromMs: 60000, toMs: Infinity } });
    assert.equal(run.action.outcome.provisional, true, `seed ${seed}`);
    assert.match(run.action.outcome.message, /lost its aim/);
    assert.ok(ofBest(run) >= 0.8, `seed ${seed}: ${ofBest(run)}`);
  }
});

test('a persistent 30 min run where the aim comes back within 30 s carries on and uses its time', () => {
  const ratios = [];
  for (const seed of [1, 2, 3, 4]) {
    const run = simulate({ limitMs: 1800000, seed, lagMs: 300, offAim: { fromMs: 300000, toMs: 318000 } });
    assert.equal(run.action.how, 'done', `seed ${seed}`);
    assert.ok(checksOf(run) >= 1, `seed ${seed}: the loss was noticed`);
    assert.ok(run.endMs - run.state.startMs > 1800000 - 2 * TEST_COST_MS, `seed ${seed} ended at ${run.endMs - run.state.startMs}`);
    assert.doesNotMatch(run.action.outcome.message, /lost its aim/);
    ratios.push(ofBest(run));
  }
  assert.ok(median(ratios) >= 0.95, `median ${median(ratios)}`);
});

test('clean runs and real dead areas pay little for the leader check: at most one test in 10 minutes', () => {
  for (const [limitMs, rate] of [
    [180000, trueRate], [300000, trueRate], [1800000, trueRate],
    [180000, withDeadArea(trueRate, { blockSize: 21, fps: 6 })], [1800000, withDeadArea(trueRate, { blockSize: 21, fps: 6 })],
    [180000, withDeadArea(trueRate, { blockSize: 23, fps: 12 })],
  ]) {
    for (const seed of [1, 2, 3]) {
      const run = simulate({ limitMs, seed, lagMs: 300, rate });
      // Tuning steps to the edge of a cliff can read zero three times running: a check then costs one test.
      assert.ok(checksOf(run) <= Math.floor(limitMs / 600000), `limit ${limitMs} seed ${seed}: ${checksOf(run)} checks`);
      assert.equal(run.action.how, 'done');
    }
  }
});

// ---- a report that stalls ----

test('a test whose reports stopped well before its end repeats, and a report near the end counts', () => {
  for (const [testMs, lastPost, repeats] of [
    [TEST_MS, 2200, true], [TEST_MS, 3000, true], [TEST_MS, 4500, true], [TEST_MS, 4900, true], [TEST_MS, 5100, false],
    [SCREEN_MS, 900, true], [SCREEN_MS, 1100, false],
  ]) {
    const search = stubSearch([{ ...START, scheme: CUBE, testMs }]);
    const h = harness({ search });
    const show = h.begin();
    h.step([], { shown: true });
    const at = h.state.test.shownMs;
    h.now = at + 300;
    h.step([h.post({ add: 5, testCounts: [h.counts(show.probeId, 1, 2, 150, 200)] })]);
    h.now = at + lastPost;
    h.step([h.post({ testCounts: [h.counts(show.probeId, 100, 60, 150, 150 + lastPost - 100)] })]);
    h.now = at + testMs + SWITCH_MS + 10;
    const a = h.step();
    assert.equal(a.type, 'record', `last report at ${lastPost} of ${testMs}`);
    assert.equal(a.counted, !repeats, `last report at ${lastPost} of ${testMs}`);
    assert.equal(search.log.records.length, repeats ? 0 : 1);
    if (repeats) {
      assert.equal(h.state.phase, 'next');
      const again = h.step();
      assert.equal(again.type, 'show');
      assert.equal(candidateKey(again.candidate), candidateKey(show.candidate));
    }
  }
});

test('with noise off, a stall in the reports under 5 s never gives a low reading', () => {
  const worst = { [TEST_MS]: Infinity, [SCREEN_MS]: Infinity };
  for (const ms of [1500, 2500, 4000, 4900]) {
    for (const fromMs of [7000, 8000, 9000, 10000, 11000, 12000, 25000, 30000, 31000, 33000]) {
      const { counted: rows, drawn } = simulate({ limitMs: 60000, seed: 1, lagMs: 100, noise: 0, stall: { fromMs, ms } });
      for (const r of rows) {
        if (r.probeId === 0 || r.reading.bytesPerSecond === 0) continue;
        worst[r.testMs] = Math.min(worst[r.testMs], r.reading.bytesPerSecond / Math.min(drawn.get(r.probeId), shapes4k.ceilingOf(r.candidate, 15)));
      }
    }
  }
  assert.ok(worst[TEST_MS] > 0.85, `worst full reading was ${worst[TEST_MS]} of the true rate`);
  // A short look is rough: its last report may be a second from its end, under the rate's floor.
  assert.ok(worst[SCREEN_MS] > 0.6, `worst short reading was ${worst[SCREEN_MS]} of the true rate`);
});

// ---- other endings and bad reports ----

test('a framing move that leaves no reading says so', () => {
  const o = refineOutcome({ result: { winner: null, leader: null, provisional: false, ranked: [{ candidate: c25, mean: null, min: null, max: null, readings: 0, alive: true }], tests: 30, coverage: {} }, how: 'done', previous: START, markersSeen: true, moved: 1 });
  assert.equal(o.apply, null);
  assert.match(o.message, /framing moved/);
  assert.doesNotMatch(o.message, /No setting tested/);
  assert.match(o.message, /not changed/);
});

test('a real framing move at the very end gives that message from the run itself', () => {
  // The first test ends about 6.1 s in, and a second full test just fits: moved 0.6 s into it, it cannot repeat.
  const h = harness({ limitMs: 13400 });
  const show = h.begin();
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ add: 5, widthShare: 0.65 })]);
  h.now = h.state.test.shownMs + 3000;
  h.step([h.post({ testCounts: [h.counts(show.probeId, 90, 40)], widthShare: 0.65 })]);
  h.now = h.state.test.shownMs + TEST_MS + 100;
  assert.equal(h.step([h.post({ testCounts: [h.counts(show.probeId, 200, 80)], widthShare: 0.65 })]).counted, true);
  assert.equal(h.step().type, 'show');
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ widthShare: 0.8 })]);
  h.now += 300;
  const moved = h.step([h.post({ widthShare: 0.8 })]);
  assert.match(moved.why, /framing/);
  const finish = h.step();
  assert.equal(finish.type, 'finish');
  assert.equal(finish.outcome.apply, null);
  assert.match(finish.outcome.message, /framing moved/);
});

test('bad reports neither stop a run nor become a reading', () => {
  const { h, show, search } = inTest();
  for (const bad of [
    { health: { visible: true, camera: 'running' }, cameraReads: 'many', testCounts: 'lots', widthShare: 'wide' },
    { health: { visible: true, camera: 'running' }, cameraReads: null, testCounts: [null, 7, { runId: RUN, probeId: show.probeId }] },
    { health: 'fine', testCounts: {} },
    null, 7,
  ]) {
    h.now += 100;
    assert.doesNotThrow(() => h.step([bad]));
  }
  assert.equal(search.log.records.length, 0);
});

// ---- a framing move during a leader check ----

/** Reports that set the framing's start and then move it, all in one step's entries. */
const moveReports = (h, extra = {}) => [h.post({ widthShare: 0.65, ...extra }), h.post({ widthShare: 0.8, ...extra }), h.post({ widthShare: 0.8, ...extra })];

/** Steps on with a reading phone until the run shows its next test or ends. */
function onToNextShow(h) {
  for (let i = 0; i < 100; i++) {
    h.now += TICK;
    const a = h.step([h.post()]);
    if (a.type === 'show' || a.type === 'finish') return a;
  }
  return assert.fail('the run never moved on');
}

test('a framing move while a leader check is about to show is safe, whatever the check then reads', () => {
  for (const packets of [0, 400, 5]) {
    const { h, show, search } = threeZeros();
    assert.equal(h.state.phase, 'showing');
    assert.equal(h.step(moveReports(h)).type, 'wait');
    assert.equal(search.log.moved, 1);
    assert.equal(h.state.check, null);
    const a = runTestTo(h, show, packets);
    assert.equal(a.type, 'record', `${packets} pieces`);
    assert.equal(a.counted, true, 'the readings it would be judged against are gone, so it is an ordinary reading');
    assert.equal(search.log.setAside, 0);
    assert.equal(h.step().reason, 'seed');
  }
});

test('a framing move in every other phase of a leader check throws nothing and drops the check', () => {
  // While the check is on screen.
  const on = threeZeros();
  on.h.step([], { shown: true });
  on.h.now += 300;
  const during = on.h.step(moveReports(on.h));
  assert.equal(during.counted, false);
  assert.match(during.why, /framing/);
  assert.equal(on.h.step().reason, 'seed');

  // Between checks, with the aim already lost.
  const between = threeZeros();
  runTestTo(between.h, between.show, 0);
  assert.equal(between.h.state.phase, 'next');
  assert.equal(between.h.step(moveReports(between.h)).reason, 'seed');
  assert.equal(between.h.state.aimLostMs, null);

  // While the phone is away during a check.
  const away = threeZeros();
  away.h.step([], { shown: true });
  away.h.now += 300;
  away.h.step([away.h.post({ health: { visible: false } })]);
  assert.equal(away.h.state.phase, 'away');
  away.h.now += 500;
  away.h.step(moveReports(away.h, { health: { visible: false } }));
  assert.equal(away.h.state.check, null);
  assert.equal(onToNextShow(away.h).reason, 'seed');
});

test('with the real search, a framing move at any moment around a lost aim never stops the run with an error', () => {
  for (let moveAtMs = 60000; moveAtMs < 80000; moveAtMs += 300) {
    const run = simulate({ limitMs: 180000, seed: 3, lagMs: 300, offAim: { fromMs: 60000, toMs: 72000 }, moveAtMs });
    assert.equal(run.action.type, 'finish', `moved at ${moveAtMs}`);
    assert.ok(run.state.moved >= 1, `moved at ${moveAtMs}`);
  }
});

// ---- the lost-aim clock ----

test('a phone that flickers away and back does not restart the lost-aim clock', () => {
  const search = stubSearch(others(), withLeader);
  const h = harness({ search, limitMs: 1800000 });
  let show = h.begin();
  for (let i = 0; i < 3; i++) {
    runTestTo(h, show, 0);
    show = h.step();
  }
  runTestTo(h, show, 0); // the leader reads zero: the clock starts here
  assert.equal(h.state.aimLostMs, h.now);
  const startedMs = h.now;
  let awayTotal = 0;
  let end = null;
  let action = h.step();
  for (let cycle = 0; cycle < 200; cycle++) {
    if (action.type === 'finish') { end = action; break; }
    assert.equal(action.type, 'show');
    assert.equal(action.reason, 'check');
    h.step([], { shown: true });
    h.now += 1000; // on screen for a second, too short to read
    assert.equal(h.step([h.post({ health: { visible: false } })]).counted, false);
    assert.equal(h.state.phase, 'away');
    h.now += 2000;
    awayTotal += 2000;
    action = h.step([h.post()]);
  }
  assert.ok(end, 'the run ended');
  assert.equal(end.how, 'away');
  assert.match(end.outcome.message, /lost its aim/);
  const lostMs = h.now - startedMs - awayTotal;
  assert.ok(lostMs >= AWAY_LIMIT_MS - 1000 && lostMs <= AWAY_LIMIT_MS + 2000, `${lostMs} ms of lost aim, ${awayTotal} ms away`);
});

test('a long absence during a lost aim still ends as the phone being away', () => {
  const { h, show } = threeZeros();
  runTestTo(h, show, 0);
  const again = h.step();
  assert.equal(again.reason, 'check');
  h.step([], { shown: true });
  h.now += 300;
  h.step([h.post({ health: { visible: false } })]);
  const end = h.until(AWAY_LIMIT_MS + TICK);
  assert.equal(end.type, 'finish');
  assert.match(end.outcome.message, /went away/);
});

test('the aim coming back ends the lost-aim clock', () => {
  const { h, show } = threeZeros();
  runTestTo(h, show, 0);
  assert.notEqual(h.state.aimLostMs, null);
  const again = h.step();
  assert.equal(runTestTo(h, again, 400).counted, true);
  assert.equal(h.state.aimLostMs, null);
  assert.equal(h.state.check, null);
});

// ---- starting from known good settings ----

const settings = (blockSize, parity, fps, white = 255) => ({ blockSize, parity, fps, white });
const FULL_LIST = [
  [23, 32, 10], [23, 32, 12], [23, 16, 15], [23, 32, 15], [23, 24, 15], [23, 20, 15], [23, 32, 20], [23, 40, 15], [23, 48, 15], [27, 16, 15],
  [23, 16, 12], [23, 16, 10], [28, 24, 15], [28, 8, 15], [23, 16, 7.5], [28, 32, 12], [28, 16, 12], [28, 16, 10], [19, 32, 15], [28, 32, 10],
].map(([b, p, f]) => settings(b, p, f));
const LIST = FULL_LIST.slice(0, 5);

test('the built-in list is the one measured, in order', () => {
  assert.equal(KNOWN_GOOD.length, 20);
  assert.deepEqual([...KNOWN_GOOD].map((c) => ({ ...c })), FULL_LIST);
});

test('the seed count scales with the time limit', () => {
  assert.deepEqual(LIMIT_MINUTES.map(seedCountFor), [3, 7, 11, 20]);
});

test('the count covers the Send page and saved winners, and the list fills the rest in order', () => {
  for (const minutes of LIMIT_MINUTES) {
    const count = seedCountFor(minutes);
    assert.deepEqual(seedsFrom(START, [], shapes4k, CUBE, count), FULL_LIST.slice(0, count));
    const page = settings(25, 32, 10);
    const seeds = seedsFrom(page, [won(29, 9)], shapes4k, CUBE, count);
    assert.equal(seeds.length, count);
    assert.deepEqual(seeds.slice(0, 3), [page, settings(29, 32, 10), FULL_LIST[0]]);
  }
});

test('at most 5 saved winners are seeds, even if more are stored', () => {
  const store = fakeStore();
  const eight = Array.from({ length: 8 }, (_, i) => won(25 + i * 2, 100 - i));
  store.setItem('visual-modem:refine:a', JSON.stringify(eight));
  assert.equal(loadWinners(store, 'a').length, 8);
  const seeds = seedsFrom(START, eight, shapes4k, CUBE, 20);
  assert.deepEqual(seeds.slice(1, 6).map((c) => c.blockSize), [25, 27, 29, 31, 33]);
  assert.deepEqual(seeds[6], FULL_LIST[1], 'the sixth winner is not used; the list carries on');
});

test('a run of each limit shows all its seeds, full, before any short look', () => {
  for (const minutes of LIMIT_MINUTES) {
    const seeds = seedsFrom(START, [], shapes4k, CUBE, seedCountFor(minutes));
    const run = simulate({ limitMs: minutes * 60000, seed: 7, lagMs: 300, seeds });
    const opening = run.shownLog.slice(0, seeds.length);
    assert.deepEqual(opening.map((a) => candidateKey(a.candidate)), seeds.map(candidateKey), `${minutes} min`);
    assert.ok(opening.every((a) => a.reason === 'seed' && a.testMs === TEST_MS), `${minutes} min`);
    const firstLook = run.shownLog.findIndex((a) => a.testMs === SCREEN_MS);
    assert.ok(firstLook === -1 || firstLook >= seeds.length, `${minutes} min`);
  }
});

test('a seed that reads nothing on this framing does no harm: only its usual dead area', () => {
  const dead = (c) => (c.blockSize <= 19 && c.fps >= 15 ? 0 : trueRate(c));
  for (const seed of [1, 2, 3]) {
    const seeds = seedsFrom(START, [], shapes4k, CUBE, 20);
    const run = simulate({ limitMs: 300000, seed, lagMs: 300, seeds, rate: dead });
    assert.equal(run.action.how, 'done');
    assert.equal(run.state.check, null);
    assert.equal(run.shownLog.filter((a) => a.reason === 'check').length, 0, 'one zero is not a lost aim');
    assert.ok(trueRate(run.action.outcome.apply) >= 0.8 * bestTrueRate());
    // Larger blocks and lower rates stay open.
    assert.ok(run.shownLog.slice(20).every((a) => !(a.candidate.blockSize < 19 && a.candidate.fps >= 15)));
  }
});

test('a first run with nothing saved has 5 seeds, in order', () => {
  assert.deepEqual(seedsFrom(START, [], shapes4k, CUBE), LIST);
});

test('the Send page settings come first, even when poor, and the list fills the rest', () => {
  const poor = settings(35, 0, 30);
  assert.deepEqual(seedsFrom(poor, [], shapes4k, CUBE), [poor, ...LIST.slice(0, 4)]);
});

test('a saved winner outranks the list, and duplicates keep their earliest place', () => {
  const page = settings(25, 32, 10);
  const saved = [won(29, 9), { ...won(23, 8), parity: 16, fps: 15 }, { ...won(25, 7) }];
  assert.deepEqual(seedsFrom(page, saved, shapes4k, CUBE), [page, settings(29, 32, 10), settings(23, 16, 15), settings(23, 32, 10), settings(23, 32, 12)]);
  // Enough winners and the list fades out.
  const many = [won(25, 9), won(27, 8), won(29, 7), won(31, 6), won(33, 5)];
  assert.deepEqual(seedsFrom(page, many, shapes4k, CUBE).map((c) => c.blockSize), [25, 27, 29, 31, 33], 'the page and its saved twin are one place');
});

test('settings above the cap or whose frame holds nothing are skipped', () => {
  const page = settings(19, 32, 10);
  const small = createScreenShapes({ widthPx: 830, heightPx: 500, scheme: CUBE }); // cap 25
  assert.deepEqual(seedsFrom(page, [], small, CUBE), [page, ...LIST.slice(0, 4)], 'block 27 is over the cap');
  const least = createScreenShapes({ widthPx: 760, heightPx: 460, scheme: CUBE }); // cap 23, the smallest grid
  assert.equal(least.holds(settings(23, 32, 10)), false);
  const left = seedsFrom(page, [], least, CUBE);
  assert.deepEqual(left.slice(0, 2), [page, settings(23, 16, 15)]);
  assert.ok(left.every((c) => least.holds(c) && c.blockSize <= 23));
  assert.ok(!left.some((c) => c.blockSize === 23 && c.parity >= 24), 'parity 24 and 32 leave no room at block 23');
  const tiny = createScreenShapes({ widthPx: 660, heightPx: 400, scheme: CUBE }); // cap 20
  assert.ok(seedsFrom(settings(19, 32, 10), [], tiny, CUBE).every((c) => c.blockSize <= 20), 'only the page and what fits under the cap');
});

test('other schemes keep only the Send page settings and saved winners', () => {
  for (const scheme of [{ kind: 'gray', levels: 2 }, { kind: 'rgb', levels: [4, 4, 4] }, { kind: 'rgb', levels: [2, 4, 2] }, undefined]) {
    const shapes = createScreenShapes({ ...K4, scheme: scheme ?? CUBE });
    assert.deepEqual(seedsFrom(START, [], shapes, scheme), [START]);
    assert.deepEqual(seedsFrom(START, [won(25, 9)], shapes, scheme), [START, settings(25, 32, 10)]);
  }
  assert.deepEqual(seedsFrom(START, [], shapes4k, { kind: 'rgb', levels: [2, 2, 2] }), LIST, 'an equal scheme, not only the same object');
});

test('a full run tests the seeds first, then surveys, and its winner has 3 full readings', () => {
  for (const [limitMs, seed] of [[180000, 1], [180000, 2], [180000, 3], [300000, 4]]) {
    const seeds = seedsFrom(START, [], shapes4k, CUBE);
    const run = simulate({ limitMs, seed, lagMs: 300, seeds });
    const shown = run.shownLog;
    assert.deepEqual(shown.slice(0, 5).map((a) => candidateKey(a.candidate)), LIST.map(candidateKey), `seed ${seed}`);
    assert.ok(shown.slice(0, 5).every((a) => a.reason === 'seed' && a.testMs === TEST_MS));
    const firstLook = shown.findIndex((a) => a.testMs === SCREEN_MS);
    assert.equal(firstLook, 5, `seed ${seed}`);
    assert.equal(shown[firstLook].reason, 'survey');
    const winner = run.search.result().winner;
    assert.ok(winner, `seed ${seed}`);
    const readings = run.counted.filter((r) => r.testMs === TEST_MS && candidateKey(r.candidate) === candidateKey(winner)).length;
    assert.ok(readings >= 3, `seed ${seed}: ${readings}`);
  }
});

test('a 1 minute run from the full seed list still names a setting that reads well', () => {
  const best = bestTrueRate();
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = simulate({ limitMs: 60000, seed, lagMs: 300, seeds: seedsFrom(START, [], shapes4k, CUBE) });
    assert.equal(run.action.type, 'finish');
    assert.ok(run.action.outcome.apply, `seed ${seed}`);
    assert.ok(trueRate(run.action.outcome.apply) >= 0.8 * best, `seed ${seed}`);
    assert.ok(run.endMs - run.state.startMs <= 60000 + TEST_COST_MS);
  }
});

test('the outcome names ties and a change in conditions', () => {
  const win = settings(23, 48, 10);
  const tie = settings(23, 16, 10);
  const row = (candidate, mean) => ({ candidate, mean, min: mean, max: mean, readings: 3, alive: true, reason: 'final' });
  const result = { winner: win, leader: win, provisional: false, separated: false, tied: [win, tie], conditionsChanged: true, ranked: [row(win, 30000), row(tie, 31000)] };
  const { message } = refineOutcome({ result, how: 'done', previous: START, markersSeen: true });
  assert.match(message, /Tied within the noise: block 23, parity 16, 10 fps\./);
  assert.match(message, /highest parity/);
  assert.match(message, /read differently later in the run/);
  const plain = refineOutcome({ result: { ...result, tied: [win], conditionsChanged: false }, how: 'done', previous: START, markersSeen: true });
  assert.doesNotMatch(plain.message, /Tied|differently/);
});

test('a change in conditions names the best before, the best after and the steadiest', () => {
  const win = settings(28, 32, 15);
  const row = (candidate, mean) => ({ candidate, mean, min: mean, max: mean, readings: 3, alive: true, reason: 'final' });
  const byConditions = {
    before: { candidate: settings(23, 40, 15), mean: 36900, readings: 4 },
    after: { candidate: settings(28, 24, 15), mean: 31000, readings: 3 },
    steady: { candidate: win, before: 29400, after: 32300 },
  };
  const result = { winner: win, leader: win, provisional: false, separated: false, tied: [win], conditionsChanged: true, byConditions, ranked: [row(win, 31100)] };
  const { message } = refineOutcome({ result, how: 'done', previous: START, markersSeen: true });
  assert.match(message, /Best before the change: block 23, parity 40, 15 fps at 36\.9 KB\/s \(4 readings\)/);
  assert.match(message, /best after: block 28, parity 24, 15 fps at 31\.0 KB\/s \(3 readings\)/);
  assert.match(message, /steadiest across both: block 28, parity 32, 15 fps at 29\.4 then 32\.3 KB\/s/);
  assert.match(message, /rough/);
});

test('a saved winner keeps the day it was saved, and an older entry without one still loads', () => {
  const store = fakeStore();
  saveWinner(store, '1920x1080', { ...won(23, 9), savedOn: '2026-11-07' });
  assert.equal(loadWinners(store, '1920x1080')[0].savedOn, '2026-11-07');
  store.setItem('visual-modem:refine:old', JSON.stringify([won(25, 4)]));
  const old = loadWinners(store, 'old');
  assert.equal(old.length, 1);
  assert.equal(old[0].savedOn, undefined);
});

test('the last Refine result is kept per screen with its day, and bad storage gives null', () => {
  const store = fakeStore();
  const cand = (blockSize, parity) => ({ blockSize, parity, fps: 12, white: 255, scheme: { kind: 'rgb', levels: [2, 2, 2] } });
  const result = {
    winner: cand(23, 40), tied: [cand(23, 40), cand(25, 48)],
    ranked: [{ candidate: cand(23, 40), mean: 37400, readings: 6 }, { candidate: cand(25, 48), mean: 37000, readings: 5 }],
    byConditions: { before: { candidate: cand(23, 40), mean: 30000, readings: 3 }, after: null, steady: null },
  };
  saveLastResult(store, '1920x1080', result, '2026-11-07');
  const last = loadLastResult(store, '1920x1080');
  assert.equal(last.date, '2026-11-07');
  assert.equal(last.winner.mean, 37400);
  assert.deepEqual(last.winner.settings, { blockSize: 23, parity: 40, fps: 12, white: 255, scheme: 'cube', levels: 2 });
  assert.equal(last.tie.settings.parity, 48);
  assert.equal(last.byConditions.before.mean, 30000);
  assert.equal(loadLastResult(store, '1280x720'), null);
  store.setItem('visual-modem:refine-last:bad', '{nope');
  assert.equal(loadLastResult(store, 'bad'), null);
  assert.equal(loadLastResult({ getItem() { throw new Error('x'); } }, 'a'), null);
  assert.doesNotThrow(() => saveLastResult(null, 'a', result, '2026-11-07'));
});

test('the last Refine result and a saved winner keep the scheme and levels they were measured on', () => {
  const store = fakeStore();
  const cand = (blockSize, parity) => ({ blockSize, parity, fps: 12, white: 255, scheme: { kind: 'rgb', levels: [2, 4, 2] } });
  const result = {
    winner: cand(23, 40), tied: [cand(23, 40), cand(25, 48)],
    ranked: [{ candidate: cand(23, 40), mean: 37400, readings: 6 }, { candidate: cand(25, 48), mean: 37000, readings: 5 }],
    byConditions: { before: null, after: { candidate: cand(27, 32), mean: 20000, readings: 3 }, steady: { candidate: cand(29, 32), before: 9000, after: 8000 } },
  };
  saveLastResult(store, '1920x1080', result, '2026-11-07', { scheme: 'g4', levels: 4 });
  const last = loadLastResult(store, '1920x1080');
  for (const p of [last.winner, last.tie, last.byConditions.after, last.byConditions.steady]) {
    assert.equal(p.settings.scheme, 'g4');
    assert.equal(p.settings.levels, 4);
  }
  saveWinner(store, '1920x1080', { ...won(23, 9), scheme: 'gray4', levels: 2, savedOn: '2026-11-07' });
  assert.equal(loadWinners(store, '1920x1080')[0].scheme, 'gray4');
  // Older entries kept no scheme: they were measured on the color cube at 2 levels.
  store.setItem('visual-modem:refine:old', JSON.stringify([won(25, 4)]));
  assert.deepEqual([loadWinners(store, 'old')[0].scheme, loadWinners(store, 'old')[0].levels], ['cube', 2]);
  store.setItem('visual-modem:refine-last:old', JSON.stringify({ date: '2026-11-01', winner: { settings: { blockSize: 23, parity: 40, fps: 12, white: 255 }, mean: 30000, readings: 4 } }));
  assert.deepEqual(loadLastResult(store, 'old').winner.settings, { blockSize: 23, parity: 40, fps: 12, white: 255, scheme: 'cube', levels: 2 });
  // A scheme that is not one of the Send page's is not kept.
  store.setItem('visual-modem:refine-last:odd', JSON.stringify({ winner: { settings: { blockSize: 23, parity: 40, fps: 12, white: 255, scheme: 'plaid', levels: 2 }, mean: 30000, readings: 4 } }));
  assert.equal(loadLastResult(store, 'odd').winner, null);
});

test('the phone-away rule: stale or missing reports, a hidden page or a stopped camera', () => {
  const ok = { visible: true, camera: 'running' };
  assert.equal(phoneAwayReason({ lastReportMs: 1000, health: ok }, 1000 + REPORT_STALE_MS - 1), null);
  assert.match(phoneAwayReason({ lastReportMs: 1000, health: ok }, 1000 + REPORT_STALE_MS), /No reports from the phone/);
  assert.match(phoneAwayReason({ lastReportMs: null, health: null }, 0), /No reports from the phone/);
  assert.match(phoneAwayReason({ lastReportMs: 0, health: { ...ok, visible: false } }, 0), /background/);
  assert.match(phoneAwayReason({ lastReportMs: 0, health: { ...ok, camera: 'off' } }, 0), /camera is not running/);
});

test('each block size keeps its best winner before faster settings at one block fill the list', () => {
  const store = fakeStore();
  const at = (blockSize, parity, mean) => ({ ...won(blockSize, mean), parity });
  saveWinner(store, 'k', at(28, 32, 31100));
  for (let i = 0; i < 10; i++) saveWinner(store, 'k', at(23, 8 + 4 * i, 34000 + 100 * i));
  const list = loadWinners(store, 'k');
  assert.equal(list.length, 8);
  assert.ok(list.some((w) => w.blockSize === 28), 'block 28 stays');
  assert.deepEqual(list.map((w) => w.mean), [...list.map((w) => w.mean)].sort((x, y) => y - x), 'best first');
});

test('a phone that loses its aim too near the end for a check ends the run as away, not done', () => {
  for (const seed of [11, 22, 33, 44, 55, 66, 77, 88]) {
    const run = simulate({ limitMs: 180000, seed, lagMs: 300, offAim: { fromMs: 180000 - 15000, toMs: Infinity } });
    const zerosLeft = run.search.zeroStreak().count;
    assert.ok(!(run.action.how === 'done' && zerosLeft >= 3), `seed ${seed}: done with ${zerosLeft} zeros still counted`);
    if (run.action.how === 'away') {
      assert.equal(run.action.outcome.provisional, true, `seed ${seed}`);
      assert.match(run.action.outcome.message, /lost its aim/);
    }
  }
});
