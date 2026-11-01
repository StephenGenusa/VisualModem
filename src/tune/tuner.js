// Auto tune: decides which block size and levels per channel to show next,
// from the phone's per-test reports. No DOM; the browser glue in web/tune.js
// shows the trials and feeds the reports in.
//
// For each level count: baseline, descent, refine by bisection, settle with
// headroom. A trial passes on good reads and fails on attempts that saw its
// frame but could not read it. Attempts that only saw markers, or nothing,
// never count against a setting. When the phone cannot see the screen, has
// its page in the background, has its camera off or stops reporting, the run
// pauses instead.

export const START_BLOCK = 45;
export const BLOCK_STEPS = [45, 40, 35, 30, 26, 23, 20, 18, 16, 14, 12, 10, 9, 8];
export const PASS_READS = 3;
export const FAIL_FRAMES = 30;
// Attempts that found markers but never recognized this test's frame, after
// which the trial fails anyway: on a real capture the finder took a reflection
// for a marker at a too-small block, and the trial would otherwise never end.
export const MARKERS_BACKSTOP = 240;
export const LOST_STREAK = 16;
export const STALE_MS = 5000;
export const HEADROOM = 1.15;

/**
 * Why a run should wait instead of judging attempts, or null. phone is the
 * latest health report: { reportAtMs, visible, camera, noMarkersStreak }.
 */
export function phonePause(nowMs, phone) {
  if (!phone || nowMs - phone.reportAtMs >= STALE_MS) return 'No reports from the phone. Is the Receive page open?';
  if (!phone.visible) return 'The Receive page is in the background on the phone.';
  if (phone.camera !== 'running') return "The phone's camera is not running.";
  if (phone.noMarkersStreak >= LOST_STREAK) return 'The phone cannot see the screen. Check the aim.';
  return null;
}

/**
 * @param {{ maxBlock: number, levelOptions?: number[], capacity: (blockSize: number, levels: number) => number }} options
 */
export function createTuner({ maxBlock, levelOptions = [2, 4], capacity }) {
  const startBlock = Math.min(START_BLOCK, maxBlock);
  const trials = [];
  const perLevel = [];
  let nextId = 1;
  let levelIndex = 0;
  let levels = levelOptions[0];
  let phase;
  let good; // smallest block known to read at this level count
  let failBlock; // largest block known to fail below good
  let smallest;
  let passed; // blocks that passed at this level count
  let settleTried;
  let current;
  let done = false;
  let stopMessage = null;
  let resultValue = null;

  const make = (kind, blockSize) => ({
    id: nextId++, kind, blockSize, levels, attempts: 0, ok: 0, frame: 0, markers: 0, shownAt: null,
  });
  const show = (trial) => { current = trial; };

  function startLevel() {
    levels = levelOptions[levelIndex];
    phase = 'baseline';
    good = null;
    failBlock = null;
    smallest = null;
    passed = [];
    settleTried = new Set();
    show(make('baseline', startBlock));
  }

  function nextLevel() {
    levelIndex++;
    if (levelIndex < levelOptions.length) return startLevel();
    const usable = perLevel.filter((p) => p.usable);
    const best = usable.reduce((a, b) => (b.bytesPerFrame > a.bytesPerFrame ? b : a));
    done = true;
    resultValue = { best, perLevel, trials };
  }

  function finishLevel(workingBlock) {
    perLevel.push({
      levels, usable: true, smallestBlock: smallest, workingBlock, bytesPerFrame: capacity(workingBlock, levels),
    });
    nextLevel();
  }

  function startSettle() {
    phase = 'settle';
    const working = Math.min(maxBlock, Math.ceil(smallest * HEADROOM));
    const larger = passed.filter((b) => b > working).sort((a, b) => a - b);
    const next = [working, ...larger].find((b) => !settleTried.has(b));
    if (next === undefined) return finishLevel(Math.max(...passed)); // never below the headroom
    settleTried.add(next);
    show(make('settle', next));
  }

  function advance() {
    if (phase === 'descent') {
      if (failBlock !== null) {
        phase = 'refine';
        return advance();
      }
      const step = BLOCK_STEPS.find((b) => b < good);
      if (step === undefined) {
        smallest = good;
        return startSettle();
      }
      return show(make('descent', step));
    }
    if (phase === 'refine') {
      if (good - failBlock > 1) return show(make('refine', Math.floor((good + failBlock) / 2)));
      smallest = good;
      return startSettle();
    }
    return startSettle();
  }

  function onPass(trial) {
    passed.push(trial.blockSize);
    if (trial.kind === 'settle') return finishLevel(trial.blockSize);
    good = trial.blockSize;
    if (trial.kind === 'baseline') phase = 'descent';
    return advance();
  }

  function onFail(trial) {
    if (trial.kind === 'baseline') {
      if (levelIndex === 0) {
        stopMessage = `The phone sees the screen but cannot read even block ${trial.blockSize}. Move it closer.`;
        return;
      }
      perLevel.push({ levels, usable: false, smallestBlock: null, workingBlock: null, bytesPerFrame: 0 });
      return nextLevel();
    }
    if (trial.kind === 'settle') return startSettle();
    failBlock = trial.blockSize;
    return advance();
  }

  function finish(trial, outcome, nowMs) {
    const { shownAt, ...rest } = trial;
    trials.push({ ...rest, outcome, ms: shownAt === null ? 0 : nowMs - shownAt });
  }

  startLevel();

  return {
    current: () => current,

    shown(trialId, nowMs) {
      if (trialId === current.id && current.shownAt === null) current.shownAt = nowMs;
    },

    addCounts(trialId, counts) {
      if (trialId !== current.id || done || stopMessage) return;
      for (const key of ['attempts', 'ok', 'frame', 'markers']) current[key] += counts[key] ?? 0;
    },

    tick(nowMs, phone) {
      if (done) return { state: 'done', message: 'Done' };
      if (stopMessage) return { state: 'stopped', message: stopMessage };
      const pause = phonePause(nowMs, phone);
      if (pause) return { state: 'paused', message: pause };
      const trial = current;
      if (trial.ok >= PASS_READS) {
        finish(trial, 'pass', nowMs);
        onPass(trial);
      } else if (trial.frame >= FAIL_FRAMES || trial.markers >= MARKERS_BACKSTOP) {
        finish(trial, 'fail', nowMs);
        onFail(trial);
      }
      if (done) return { state: 'done', message: 'Done' };
      if (stopMessage) return { state: 'stopped', message: stopMessage };
      return {
        state: 'running',
        message: `Trial ${current.id}: block ${current.blockSize}, ${current.levels} levels, `
          + `${current.ok} of ${PASS_READS} reads, ${current.frame} of ${FAIL_FRAMES} misses`
          + (current.markers > 0 ? `, ${current.markers} unrecognized` : ''),
      };
    },

    result: () => resultValue,
  };
}
