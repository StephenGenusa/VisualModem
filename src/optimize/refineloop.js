// The decisions of a Refine run, apart from the page: when a test starts and
// ends, whether the phone is reading or gone, what a test's reading is, and what
// the run's result means for the Send page. web/refine.js does the showing,
// polling and timing around refineStep. No DOM, network or clock; the search it
// is given carries the only state that is changed in place.

import { fitGrid, computeLayoutV4 } from '../picture/layout.js';
import { frameShapeV4 } from '../core/framev4.js';
import { SETTLE_MS } from './probes.js';
import { SCHEME_CHOICES } from '../core/scheme.js';
import { LEVEL_OPTIONS } from '../core/symbols.js';
import {
  EARLY_MS, MIN_READS, REJECT_SHARE, SCREEN_MIN_READS, SCREEN_MS, SWITCH_MS, TEST_MS, candidateKey, spaceFor,
} from './search.js';

export const LIMIT_MINUTES = Object.freeze([1, 3, 5, 30]);
export const DEFAULT_LIMIT_MINUTES = 3;
export const LONG_RUN_MINUTES = 30;
export const FIRST_REPORT_MS = 20000;
export const REPORT_STALE_MS = 5000;
export const AWAY_LIMIT_MS = 30000;
export const MOVED_SHARE = 0.05;
// A framing change must show in this many reports in a row: one bad read of the
// corners must not set aside a whole run's readings.
const MOVED_REPORTS = 2;
// Zeros in a row before the leader is tested again, to tell settings that read
// nothing from a phone that no longer sees the screen.
const ZEROS_BEFORE_CHECK = 3;
const AIM_LOST = 'The phone lost its aim';
const REPORT_STALLED = "The phone's reports stalled during the test";
const MAX_SEEDS = 5; // with no time limit to go by
const MAX_SAVED_SEEDS = 5;
// From repeated file runs and readings on the test setup, in order, measured with the color cube at 2 levels.
export const KNOWN_GOOD = Object.freeze([
  [23, 32, 10], [23, 32, 12], [23, 16, 15], [23, 32, 15], [23, 24, 15], [23, 20, 15], [23, 32, 20], [23, 40, 15], [23, 48, 15], [27, 16, 15],
  [23, 16, 12], [23, 16, 10], [28, 24, 15], [28, 8, 15], [23, 16, 7.5], [28, 32, 12], [28, 16, 12], [28, 16, 10], [19, 32, 15], [28, 32, 10],
].map(([blockSize, parity, fps]) => Object.freeze({ blockSize, parity, fps, white: 255 })));
// How many settings a run starts from at each time limit, in minutes.
// The search tests seeds for at most a quarter of the limit, so these are what fit.
const SEEDS_FOR_LIMIT = Object.freeze({ 1: 3, 3: 7, 5: 11, 30: 20 });

/** How many settings a run with this time limit starts from, the Send page and saved winners included. */
export const seedCountFor = (minutes) => SEEDS_FOR_LIMIT[minutes] ?? MAX_SEEDS;

const MAX_WINNERS = 8;
const WINNERS_KEY = 'visual-modem:refine:';
const LAST_KEY = 'visual-modem:refine-last:';
// A test's span can fall this far short of its length before the rate's floor applies.
const SPAN_SLACK_MS = 1000;
const NOT_READING = 'The phone is not reading';

// ---- what the screen can carry ----

/**
 * What frames hold on this screen, worked out once per block and parity. A first
 * layout at a small block can take a while, so the caller prepares them all
 * before the run, when it costs no test any time.
 * @param {{ widthPx: number, heightPx: number, scheme: object, shownFps?: (fps: number) => number, onLayout?: () => void }} options
 *   shownFps gives the rate the stage really shows for a frame rate.
 */
export function createScreenShapes({ widthPx, heightPx, scheme, shownFps = (fps) => fps, onLayout = () => {} }) {
  const layouts = new Map();
  const shapes = new Map();

  /** The version 4 layout for a block size, or null when the grid is under the minimum. */
  function layoutOf(blockSize) {
    if (!layouts.has(blockSize)) {
      onLayout();
      let layout = null;
      try {
        const { cols, rows } = fitGrid(widthPx, heightPx, blockSize);
        layout = computeLayoutV4(cols, rows);
      } catch {
        layout = null;
      }
      layouts.set(blockSize, layout);
    }
    return layouts.get(blockSize);
  }

  /** The packets a frame holds, or null when it can hold none. */
  function shapeOf(blockSize, parity) {
    const key = blockSize * 1000 + parity;
    if (!shapes.has(key)) {
      const layout = layoutOf(blockSize);
      const shape = layout ? frameShapeV4(layout, scheme, parity) : null;
      shapes.set(key, shape && shape.packets >= 1 && shape.packetBytes >= 1 ? { packets: shape.packets, packetBytes: shape.packetBytes } : null);
    }
    return shapes.get(key);
  }

  /** The most a setting could carry, in bytes per second: always finite, and 0 only where no frame fits. */
  function ceilingOf(candidate, readsPerSecond) {
    const shape = shapeOf(candidate.blockSize, candidate.parity);
    if (!shape) return 0;
    const shown = shownFps(candidate.fps);
    const fps = Number.isFinite(shown) && shown > 0 ? shown : candidate.fps;
    const usable = Number.isFinite(readsPerSecond) && readsPerSecond > 0;
    return shape.packets * shape.packetBytes * (usable ? Math.min(fps, readsPerSecond) : fps);
  }

  return {
    layoutOf, shapeOf, ceilingOf,
    holds: (candidate) => shapeOf(candidate.blockSize, candidate.parity) !== null,
    prepare(blockSize, parities) { for (const parity of parities) shapeOf(blockSize, parity); },
  };
}

/** Every block a search on this screen may reach. */
export function blocksToPrepare(cap, seeds) {
  return spaceFor(cap, seeds).blockSize;
}

// ---- one test's reading ----

/**
 * What one test measured, or null when the phone was not reading during it. The
 * rate is pieces x piece bytes over the phone's own span of first to last read:
 * the counts and the span come from the same report, so a report up to a second
 * old still gives a true rate, where the time on screen would not match the
 * counts. The span is held at no less than the test length less 1 s, so a very
 * short span cannot make a huge rate, and no more than the test length, because
 * the frames repeat after that and the time spent settling adds few new pieces.
 * @param {{ counts: object | null, rise: number, testMs: number, packetBytes: number }} p
 *   rise is how far the phone's camera reads rose during the test.
 */
export function testReading({ counts, rise, testMs, packetBytes }) {
  const isScreen = testMs === SCREEN_MS;
  const minReads = isScreen ? SCREEN_MIN_READS : MIN_READS;
  if (!counts || counts.packets === 0) {
    const reads = Math.max(counts?.reads ?? 0, rise);
    return reads >= minReads ? { bytesPerSecond: 0, reads, zeroAtEarlyCheck: isScreen } : null;
  }
  const span = counts.lastMs - counts.firstMs;
  const windowMs = Math.min(testMs, Math.max(testMs - SPAN_SLACK_MS, span));
  // The search takes reads over the test length; reads while settling are not in that.
  const inTest = span > testMs ? Math.round((counts.reads * testMs) / span) : counts.reads;
  // A setting whose headers rarely read while the camera reads on is a low reading.
  const reads = inTest >= minReads ? inTest : rise;
  if (reads < minReads) return null;
  return { bytesPerSecond: (counts.packets * packetBytes) / (windowMs / 1000), reads, zeroAtEarlyCheck: false };
}

// ---- the state machine ----

/**
 * @param {{ search: object, limitMs: number, runId: number, shapes: object, previous: object, first: object }} options
 *   previous is the Send page's settings; first is what to show while the camera settles.
 */
export function createRefineState({ search, limitMs, runId, shapes, previous, first }) {
  return {
    search, limitMs, runId, shapes, previous, first,
    phase: 'phone',
    openedMs: null, startMs: null, endMs: null, warmUntilMs: null,
    lastReportMs: null, health: null, reads: null, oldPage: false,
    markerStart: null, markersSeen: false,
    share: null, startShare: null, movedReports: 0, movedNow: false, moved: 0,
    reloaded: false,
    test: null, lastProbeId: 0,
    awayMs: null, awayReads: null,
    check: null, aimLostMs: null, lostAim: false,
  };
}

function absorb(s, entries, nowMs) {
  for (const e of entries) {
    if (!e || !e.health) continue;
    s.lastReportMs = nowMs;
    s.health = e.health;
    if (Number.isFinite(e.cameraReads)) {
      s.oldPage = false;
      // Counts run since the phone's page loaded, so a drop means it reloaded.
      if (s.reads !== null && e.cameraReads < s.reads) {
        s.reloaded = true;
        if (s.awayReads !== null) s.awayReads = e.cameraReads;
      }
      s.reads = e.cameraReads;
    } else {
      s.oldPage = true;
    }
    if (Number.isFinite(e.markerReads)) {
      if (s.markerStart === null || e.markerReads < s.markerStart) s.markerStart = e.markerReads;
      else if (e.markerReads > s.markerStart) s.markersSeen = true;
    }
    if (typeof e.widthShare === 'number' && Number.isFinite(e.widthShare)) noteFraming(s, e.widthShare);
    if (s.test && s.test.shownMs !== null) {
      const t = { ...s.test, lastPostMs: nowMs };
      // The first report after the show is the base, so reads from before it are not this test's.
      if (t.baseline === null && Number.isFinite(e.cameraReads)) t.baseline = e.cameraReads;
      const list = Array.isArray(e.testCounts) ? e.testCounts : [];
      const counts = list.find((c) => c?.runId === s.runId && c.probeId === t.probeId && Number.isFinite(c.packets));
      if (counts) t.counts = counts;
      s.test = t;
    }
  }
}

function noteFraming(s, share) {
  s.share = share;
  if (s.startShare === null) {
    s.startShare = share;
  } else if (Math.abs(share - s.startShare) > MOVED_SHARE) {
    s.movedReports++;
    if (s.movedReports >= MOVED_REPORTS) {
      s.movedNow = true;
      s.startShare = share;
      s.movedReports = 0;
    }
  } else {
    s.movedReports = 0;
  }
}

/**
 * Why the phone cannot be counted on now, or null: no report for 5 s, the
 * Receive page in the background, or the camera not running. A framing that
 * is unknown is no reason.
 * @param {{ lastReportMs: number | null, health: { visible?: boolean, camera?: string } | null }} s
 */
export function phoneAwayReason({ lastReportMs, health }, nowMs) {
  if (lastReportMs === null || lastReportMs === undefined || !health || nowMs - lastReportMs >= REPORT_STALE_MS) return 'No reports from the phone. Is the Receive page open?';
  if (health.visible === false) return 'The Receive page is in the background on the phone';
  if (health.camera !== 'running') return "The phone's camera is not running";
  return null;
}

const riseOf = (s) => (s.test.baseline === null || s.reads === null ? 0 : s.reads - s.test.baseline);
const remaining = (s, nowMs) => s.endMs - nowMs;
const wait = (s, why = null) => ({ state: s, action: { type: 'wait', why } });

function finish(s, how) {
  s.phase = 'done';
  const result = s.search.result();
  return {
    state: s,
    action: { type: 'finish', how, result, outcome: refineOutcome({ result, how, previous: s.previous, markersSeen: s.markersSeen, moved: s.moved, lostAim: s.lostAim }) },
  };
}

/** Ends the test without a reading. The search holds it and offers it again. */
function notCounted(s, why, phase, nowMs) {
  const { test } = s;
  s.test = null;
  s.phase = phase;
  if (phase === 'away') {
    s.awayMs = nowMs;
    s.awayReads = s.reads;
  }
  return { state: s, action: { type: 'record', counted: false, shown: true, why, reading: null, candidate: test.candidate, reason: test.reason, probeId: test.probeId, testMs: test.testMs } };
}

function counted(s, reading, nowMs) {
  const { test } = s;
  // A framing move takes the check away with the readings it judged by: then this is an ordinary reading.
  if (test.check && s.check && reading.bytesPerSecond < REJECT_SHARE * s.check.mean) return aimStillLost(s, reading, nowMs);
  s.search.record(test.candidate, reading);
  s.test = null;
  s.phase = 'next';
  s.check = null;
  s.aimLostMs = null;
  return { state: s, action: { type: 'record', counted: true, shown: true, why: null, reading, candidate: test.candidate, reason: test.reason, probeId: test.probeId, testMs: test.testMs } };
}

/**
 * The leader reads nothing either, or under a quarter of its mean: it is the
 * phone, not the settings. The zeros are undone, this reading is withheld, and the
 * leader stays on screen, retested until it reads: the phone's camera reads go on
 * rising, so its reads alone cannot say it is back.
 */
function aimStillLost(s, reading, nowMs) {
  const { test } = s;
  s.search.setAsideZeros();
  s.aimLostMs ??= nowMs;
  s.test = null;
  if (aimLostTooLong(s, nowMs)) return finishLostAim(s);
  s.phase = 'next';
  return { state: s, action: { type: 'record', counted: false, shown: true, why: AIM_LOST, reading, candidate: test.candidate, reason: test.reason, probeId: test.probeId, testMs: test.testMs } };
}

const aimLostTooLong = (s, nowMs) => s.aimLostMs !== null && nowMs - s.aimLostMs >= AWAY_LIMIT_MS;

function finishLostAim(s) {
  s.lostAim = true;
  return finish(s, 'away');
}

/** What to test the leader against, when zeros in a row call for that. */
function checkDue(s) {
  if (s.check) return s.check;
  const { count, before } = s.search.zeroStreak();
  return count >= ZEROS_BEFORE_CHECK ? before : null;
}

function startTest(s, step, nowMs, extra = {}) {
  s.lastProbeId++;
  s.test = { ...step, probeId: s.lastProbeId, shownMs: null, baseline: null, counts: null, lastPostMs: null, check: step.reason === 'check' };
  s.phase = 'showing';
  return { state: s, action: { type: 'show', ...step, probeId: s.lastProbeId, remainingMs: remaining(s, nowMs), ...extra } };
}

function nextTest(s, nowMs) {
  s.phase = 'next';
  const check = checkDue(s);
  if (check) {
    s.check = check;
    if (aimLostTooLong(s, nowMs)) return finishLostAim(s);
    if (remaining(s, nowMs) < TEST_MS + SWITCH_MS) {
      // No time to check the leader: zeros in a row this late are most likely the
      // phone losing its aim, so they are set aside and the result is provisional.
      s.search.setAsideZeros();
      return finishLostAim(s);
    }
    return startTest(s, { candidate: check.candidate, reason: 'check', testMs: TEST_MS }, nowMs, { aimLost: s.aimLostMs !== null });
  }
  const step = s.search.next(remaining(s, nowMs));
  if (!step) return finish(s, 'done');
  const { candidate, reason, testMs } = step;
  if (!s.shapes.holds(candidate)) {
    // Its frame holds no packet: nothing to show, and nothing it could ever carry.
    const reading = { bytesPerSecond: 0, reads: MIN_READS, zeroAtEarlyCheck: false };
    s.search.record(candidate, reading);
    return { state: s, action: { type: 'record', counted: true, shown: false, why: 'Its frame holds no data', reading, candidate, reason, probeId: 0, testMs } };
  }
  return startTest(s, { candidate, reason, testMs }, nowMs);
}

function runningTest(s, nowMs) {
  const { test } = s;
  const why = phoneAwayReason(s, nowMs);
  if (why) return notCounted(s, why, 'away', nowMs);
  const elapsed = nowMs - test.shownMs;
  const packets = test.counts?.packets ?? 0;
  // Reports lag, so the check waits for one that arrived after it came due.
  if (elapsed >= EARLY_MS && packets === 0 && test.lastPostMs !== null && test.lastPostMs >= test.shownMs + EARLY_MS) {
    const reads = Math.max(test.counts?.reads ?? 0, riseOf(s));
    if (reads >= SCREEN_MIN_READS) return counted(s, { bytesPerSecond: 0, reads, zeroAtEarlyCheck: true }, nowMs);
  }
  if (elapsed < test.testMs) return wait(s);
  const finalReport = test.lastPostMs !== null && test.lastPostMs > test.shownMs + test.testMs;
  if (!finalReport && elapsed < test.testMs + SWITCH_MS) return wait(s);
  // Reports that stalled leave counts from early in the test over too long a floor.
  if (test.lastPostMs === null || test.lastPostMs < test.shownMs + test.testMs - SWITCH_MS) return notCounted(s, REPORT_STALLED, 'next', nowMs);
  const { packetBytes } = s.shapes.shapeOf(test.candidate.blockSize, test.candidate.parity);
  const reading = testReading({ counts: test.counts, rise: riseOf(s), testMs: test.testMs, packetBytes });
  return reading ? counted(s, reading, nowMs) : notCounted(s, NOT_READING, 'away', nowMs);
}

function waitingAway(s, nowMs) {
  if (nowMs - s.awayMs >= AWAY_LIMIT_MS || nowMs >= s.endMs) return finish(s, 'away');
  const why = phoneAwayReason(s, nowMs);
  if (!why && s.reads !== null && s.reads > s.awayReads) {
    // Time truly away is not time with the aim lost, and the aim is still unproven.
    if (s.aimLostMs !== null) s.aimLostMs += nowMs - s.awayMs;
    s.awayMs = null;
    s.awayReads = null;
    return nextTest(s, nowMs);
  }
  return wait(s, why ?? NOT_READING);
}

function waitingForPhone(s, nowMs) {
  s.openedMs ??= nowMs;
  const why = s.lastReportMs === null ? 'No phone on the Receive page yet'
    : s.health.visible === false ? 'The Receive page is in the background on the phone'
      : s.health.camera !== 'running' ? "The phone's camera is not running"
        : s.oldPage ? 'The Receive page on the phone is out of date. Reload it'
          : null;
  if (!why) {
    s.phase = 'warming';
    return { state: s, action: { type: 'show', candidate: s.first, reason: 'settle', testMs: SETTLE_MS, probeId: 0, remainingMs: s.limitMs } };
  }
  if (nowMs - s.openedMs < FIRST_REPORT_MS) return wait(s, why);
  s.phase = 'done';
  const message = s.lastReportMs === null ? 'No phone reported in 20 s. Open the Receive page on the phone, by this computer\'s address, and press Refine again.' : `${why}. Fix that and press Refine again.`;
  return { state: s, action: { type: 'abort', message: `${message} The Send page's settings were not changed.` } };
}

/**
 * One step of a run. The wrapper calls it about five times a second with the
 * phone's new reports, and again at once after any action other than wait.
 * Actions: show (build and show this candidate, then step with shown: true),
 * wait, record (a test ended: log it), finish, abort.
 * @param {object} state from createRefineState or the last step
 * @param {{ nowMs: number, entries: object[], shown?: boolean, stopped?: boolean }} input
 *   shown says the last show action's frames are now up; stopped says the operator closed the stage.
 * @returns {{ state: object, action: object }}
 */
export function refineStep(state, { nowMs, entries = [], shown = false, stopped = false }) {
  const s = { ...state };
  absorb(s, entries, nowMs);
  if (stopped) return finish(s, 'stopped');
  // Only a run under way has readings to set aside.
  if (s.endMs === null) s.movedNow = false;
  const moved = s.movedNow;
  if (moved) {
    s.movedNow = false;
    s.moved++;
    s.search.markMoved();
    s.check = null;
    s.aimLostMs = null;
  }
  switch (s.phase) {
    case 'phone':
      return waitingForPhone(s, nowMs);
    case 'warming':
      if (shown) s.warmUntilMs = nowMs + SETTLE_MS;
      if (s.warmUntilMs === null || nowMs < s.warmUntilMs) return wait(s);
      s.startMs = nowMs;
      s.endMs = nowMs + s.limitMs;
      return nextTest(s, nowMs);
    case 'showing':
      if (!shown) return wait(s);
      s.test = { ...s.test, shownMs: nowMs };
      s.phase = 'test';
      s.reloaded = false;
      return wait(s);
    case 'test':
      if (s.reloaded) {
        s.reloaded = false;
        return notCounted(s, 'The phone\'s page reloaded', 'next', nowMs);
      }
      if (moved) return notCounted(s, 'The framing moved', 'next', nowMs);
      return runningTest(s, nowMs);
    case 'away':
      s.reloaded = false;
      return waitingAway(s, nowMs);
    case 'next':
      s.reloaded = false;
      return nextTest(s, nowMs);
    default:
      return wait(s);
  }
}

// ---- the result ----

const kb = (bytesPerSecond) => (bytesPerSecond / 1000).toFixed(1);

/** A setting in a few words. */
export function describeSettings({ blockSize, parity, fps, white }) {
  return `block ${blockSize}, parity ${parity}, ${fps} fps${white !== 255 ? `, white ${white}` : ''}`;
}

const sameSettings = (a, b) => candidateKey(a) === candidateKey(b);

/**
 * What a finished run means for the Send page. Only a live candidate is ever
 * applied; a run stopped by the operator, or with nothing that read, changes nothing.
 * @param {{ result: object, how: 'done' | 'away' | 'stopped', previous: object, markersSeen: boolean, moved?: number, lostAim?: boolean }} p
 *   moved is how many times the framing moved; lostAim says a run ended 'away' because the phone no longer saw the screen.
 * @returns {{ apply: object | null, provisional: boolean, kind: string, word: string, message: string }}
 */
export function refineOutcome({ result, how, previous, markersSeen, moved = 0, lostAim = false }) {
  const before = describeSettings(previous);
  const unchanged = `The Send page's settings were not changed (${before}).`;
  const none = (kind, word, text) => ({ apply: null, provisional: false, kind, word, message: `${text} ${unchanged}` });
  if (how === 'stopped') return none('warn', 'Refine stopped', 'Refine stopped.');
  const chosen = result.winner ?? result.leader;
  const row = chosen && result.ranked.find((r) => sameSettings(r.candidate, chosen));
  if (!chosen || !row?.alive) {
    if (how === 'away' && lostAim) return none('warn', 'Refine stopped: aim lost', 'Refine stopped because the phone lost its aim before any setting read.');
    if (how === 'away') return none('warn', 'Refine stopped: phone away', 'Refine stopped because the phone went away before any setting read.');
    if (moved > 0) return none('warn', 'Refine: framing moved', 'The framing moved, so the readings from before it were set aside, and no setting has read since.');
    return markersSeen
      ? none('warn', 'Refine: no setting read', 'No setting tested gave any good data. Check the aim and the phone\'s focus.')
      : none('warn', 'Refine: screen not seen', 'The phone never found the screen\'s markers. Aim it at the screen and try again.');
  }
  const provisional = how === 'away' || result.provisional || !result.winner;
  const label = provisional ? ', provisional' : '';
  const figure = `About ${kb(row.mean)} KB/s over ${row.readings} ${row.readings === 1 ? 'reading' : 'readings'}.`;
  const closing = how !== 'away' ? '' : lostAim ? ' It stopped early because the phone lost its aim.' : ' It stopped early because the phone went away.';
  const verdict = sameSettings(chosen, previous)
    ? `Refine kept ${describeSettings(chosen)}${label}.`
    : `Refine set ${describeSettings(chosen)}${label}.`;
  const tied = (result.tied ?? []).filter((c) => !sameSettings(c, chosen));
  const noise = tied.length
    ? ` Tied within the noise: ${tied.map(describeSettings).join('; ')}. The tie goes to the highest parity, which holds up better under glare.`
    : result.ranked.filter((r) => r.readings > 0).length < 2 ? ''
      : result.separated ? ' The top two differ by more than the noise.' : ' The top two are within the noise.';
  const changed = result.conditionsChanged ? ` The first setting read differently later in the run, so the light or the aim changed.${conditionsText(result.byConditions)}` : '';
  return {
    apply: chosen,
    provisional,
    kind: provisional ? 'warn' : 'ok',
    word: `Refine ${provisional ? 'provisional' : 'done'}: ${describeSettings(chosen)}`,
    message: `${verdict} ${figure}${noise}${changed}${closing} Previous settings: ${before}.`,
  };
}

const readingsWord = (n) => `${n} ${n === 1 ? 'reading' : 'readings'}`;

/** The best before and after a change and the steadiest across both, from fewer readings than the winner's. */
function conditionsText(by) {
  if (!by) return '';
  const parts = [];
  if (by.before) parts.push(`Best before the change: ${describeSettings(by.before.candidate)} at ${kb(by.before.mean)} KB/s (${readingsWord(by.before.readings)})`);
  if (by.after) parts.push(`best after: ${describeSettings(by.after.candidate)} at ${kb(by.after.mean)} KB/s (${readingsWord(by.after.readings)})`);
  if (by.steady) parts.push(`steadiest across both: ${describeSettings(by.steady.candidate)} at ${kb(by.steady.before)} then ${kb(by.steady.after)} KB/s`);
  return parts.length ? ` ${parts.join('; ')}. These are rough, from few readings each.` : '';
}

/** The settings that had full tests, for the result table: mean and range in KB/s. */
export function resultRows(result) {
  return result.ranked.filter((r) => r.readings > 0).map((r) => ({
    settings: describeSettings(r.candidate),
    mean: kb(r.mean),
    range: `${kb(r.min)} to ${kb(r.max)}`,
    readings: r.readings,
    alive: r.alive,
  }));
}

// ---- saved winners ----

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The scheme (a Scheme control id) and levels a setting was measured on. Entries
 * kept before these were saved were all measured on the color cube at 2 levels.
 * Null when they are not values the Send page could set.
 */
function measuredOn(s) {
  const scheme = s.scheme ?? 'cube';
  const levels = s.levels ?? 2;
  return SCHEME_CHOICES.some((c) => c.id === scheme) && LEVEL_OPTIONS.includes(levels) ? { scheme, levels } : null;
}

function validWinner(w) {
  return Boolean(w) && positive(w.blockSize) && Number.isFinite(w.parity) && w.parity >= 0 && positive(w.fps) && positive(w.white) && positive(w.mean) && positive(w.readings)
    && measuredOn(w) !== null;
}

const sameWinner = (a, b) => sameSettings(a, b) && a.scheme === b.scheme && a.levels === b.levels;

/** The winners saved for a screen, best first, each with its scheme and levels. Blocked or bad storage gives none. */
export function loadWinners(storage, screenKey) {
  try {
    const list = JSON.parse(storage.getItem(WINNERS_KEY + screenKey));
    return Array.isArray(list) ? list.filter(validWinner).slice(0, MAX_WINNERS).map((w) => ({ ...w, ...measuredOn(w) })) : [];
  } catch {
    return [];
  }
}

/**
 * Keeps a winner for a screen with the scheme and levels it was measured on, and
 * the day (YYYY-MM-DD) when given. Only settings and figures are kept; failure is harmless.
 */
/**
 * The winners to keep, best first: the best at each block size goes in first,
 * so faster settings at one block cannot push every other block out, then the
 * rest by speed.
 */
function keepVaried(list) {
  const byMean = [...list].sort((a, b) => b.mean - a.mean);
  const kept = [];
  for (const w of byMean) if (kept.length < MAX_WINNERS && !kept.some((k) => k.blockSize === w.blockSize)) kept.push(w);
  for (const w of byMean) if (kept.length < MAX_WINNERS && !kept.includes(w)) kept.push(w);
  return kept.sort((a, b) => b.mean - a.mean);
}

export function saveWinner(storage, screenKey, { blockSize, parity, fps, white, scheme = 'cube', levels = 2, mean, readings, widthShare = null, savedOn }) {
  try {
    const entry = { blockSize, parity, fps, white, scheme, levels, mean, readings, widthShare };
    if (typeof savedOn === 'string') entry.savedOn = savedOn;
    const others = loadWinners(storage, screenKey).filter((w) => !sameWinner(w, entry));
    const list = keepVaried([entry, ...others]);
    storage.setItem(WINNERS_KEY + screenKey, JSON.stringify(list));
  } catch {
    // The next run starts from the Send page's settings alone.
  }
}

// ---- the last Refine result ----

/** Plain settings with the scheme id and levels the run used (a candidate's scheme object is dropped). */
function plainSettings(c, on) {
  const out = { blockSize: c.blockSize, parity: c.parity, fps: c.fps, white: c.white };
  if (on) Object.assign(out, measuredOn(on));
  return out;
}

const validSettings = (c) => Boolean(c) && positive(c.blockSize) && Number.isFinite(c.parity) && c.parity >= 0 && positive(c.fps) && positive(c.white)
  && measuredOn(c) !== null;
const validPart = (p) => Boolean(p) && validSettings(p.settings) && positive(p.mean);
const withScheme = (p) => p && { ...p, settings: { ...p.settings, ...measuredOn(p.settings) } };

/**
 * Keeps what a finished Refine found, for the Send page's list of choices:
 * the winner, the glare-tolerant tie, the best across a change of light, the
 * day, and the scheme id and levels the run used (on, the Send page's settings
 * at the start; a run never changes them). today is passed in (YYYY-MM-DD).
 * Failure is harmless.
 */
export function saveLastResult(storage, screenKey, result, today, on = null) {
  try {
    const rows = result.ranked ?? [];
    const part = (c, mean, readings) => {
      const row = mean === undefined ? rows.find((r) => sameSettings(r.candidate, c)) : null;
      return { settings: plainSettings(c, on), mean: mean ?? row?.mean ?? 0, readings: readings ?? row?.readings ?? 0 };
    };
    const winner = result.winner ? part(result.winner) : null;
    const top = (result.tied ?? []).reduce((a, b) => (!a || b.parity > a.parity ? b : a), null);
    const tie = top && !(result.winner && sameSettings(top, result.winner)) ? part(top) : null;
    const by = result.byConditions;
    const byConditions = by ? {
      before: by.before ? part(by.before.candidate, by.before.mean, by.before.readings) : null,
      after: by.after ? part(by.after.candidate, by.after.mean, by.after.readings) : null,
      steady: by.steady ? { settings: plainSettings(by.steady.candidate, on), before: by.steady.before, after: by.steady.after } : null,
    } : null;
    storage.setItem(LAST_KEY + screenKey, JSON.stringify({ date: today, winner, tie, byConditions }));
  } catch {
    // Nothing is offered from the last run.
  }
}

/** The last Refine result saved for a screen, or null. Blocked or bad storage gives null. */
export function loadLastResult(storage, screenKey) {
  try {
    const o = JSON.parse(storage.getItem(LAST_KEY + screenKey));
    if (!o || typeof o !== 'object') return null;
    const keep = (p) => (validPart(p) ? withScheme(p) : null);
    const by = o.byConditions && typeof o.byConditions === 'object' ? o.byConditions : null;
    const st = by?.steady;
    return {
      date: typeof o.date === 'string' ? o.date : null,
      winner: keep(o.winner),
      tie: keep(o.tie),
      byConditions: by ? {
        before: keep(by.before),
        after: keep(by.after),
        steady: st && validSettings(st.settings) && positive(st.before) && positive(st.after) ? withScheme(st) : null,
      } : null,
    };
  } catch {
    return null;
  }
}

const isCube2 = (scheme) => scheme?.kind === 'rgb' && scheme.levels.every((l) => l === 2);

/**
 * The settings a run starts from: the Send page's, then saved winners, then the
 * built-in list where it was measured to apply, up to count. A setting keeps its
 * earliest place, and any whose frame holds nothing on this screen is left out.
 */
export function seedsFrom(base, saved, shapes, scheme, count = MAX_SEEDS) {
  const seeds = new Map();
  for (const { blockSize, parity, fps, white } of [base, ...saved.slice(0, MAX_SAVED_SEEDS), ...(isCube2(scheme) ? KNOWN_GOOD : [])]) {
    const c = { blockSize, parity, fps, white };
    if (seeds.size < count && shapes.holds(c) && !seeds.has(candidateKey(c))) seeds.set(candidateKey(c), c);
  }
  return [...seeds.values()];
}
