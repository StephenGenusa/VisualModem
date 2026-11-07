// The search behind Refine: decides which settings to test next from what has
// been measured, within a time limit. It surveys the whole space first, evenly,
// then picks a list of candidates from distinct parts of it, tunes each one a
// step at a time, and spends the end repeating the finalists. A 30 minute run
// does this three times over, so a change in the room shows.
// It has no DOM, network or clock: it is given a seeded random source and, at
// each call, the time remaining.

export const SCREEN_MS = 2000;
export const TEST_MS = 6000;
export const SWITCH_MS = 1000;
export const SCREEN_COST_MS = SCREEN_MS + SWITCH_MS;
export const TEST_COST_MS = TEST_MS + SWITCH_MS;
export const EARLY_MS = 2000;
export const MIN_READS = 6;
export const SCREEN_MIN_READS = 3;
// Under this share of the leader, a reading says the phone lost its aim (used by the loop).
export const REJECT_SHARE = 0.25;
export const WIN_READINGS = 3;
export const START_READS_PER_SECOND = 15;

// Where each phase ends, as a share of the limit (seeds) or of the pass (the rest).
export const SEED_SHARE = 0.25;
export const SURVEY_SHARE = 0.5;
export const TUNE_SHARE = 0.8;
export const PASS_MS = 600000;
// A rough reading under this share of the leader drops its setting for the pass.
export const DROP_SHARE = 0.5;
// A setting reading this share of the leader can be a candidate.
export const CANDIDATE_SHARE = 0.7;
export const MAX_CANDIDATES = 6;
// Candidates are at least this many steps apart, so each stands for its own part of the space.
export const CANDIDATE_STEPS = 2;
export const MAX_MOVES = 2;
export const FINALISTS = 5;
// Settings within the noise of the best and at this share of its mean are tied. Among
// those that differ from the best only in parity, the highest parity wins: it was
// measured to cost little in plain light and to hold up far better under glare.
export const TIE_SHARE = 0.9;
const MAX_SEEDS = 20;
// A block whose survey tests in a pass number at least this many, with at least
// this share failed, is left out of the rest of that pass's survey.
export const BLOCK_FAIL_TESTS = 3;
export const BLOCK_FAIL_SHARE = 0.75;
// Short survey zeros it takes to count as one full zero toward the zero streak:
// the survey visits far corners of the space, where zeros in a row are real.
const SURVEY_ZEROS_PER_ZERO = 3;
// Survey tests with nothing reading at all, after the seeds, before the run ends.
const NOTHING_READS_TESTS = 5;
// Two-sided 95% on the difference of two means.
const NOISE_Z = 1.96;
// The measured run-to-run variation of a setting, on a log scale, and how many
// readings' worth of weight it keeps as readings pool in.
const START_NOISE = 0.12;
const START_NOISE_WEIGHT = 4;
const HELD_BACK_PARITY = 0;
const HELD_BACK_FPS = 30;
const SAME = 1e-9;

export const BASE_SPACE = Object.freeze({
  blockSize: Object.freeze([19, 21, 23, 25, 27, 29, 31, 33, 35]),
  parity: Object.freeze([0, 8, 16, 24, 32, 40, 48]),
  fps: Object.freeze([6, 7.5, 10, 12, 15, 20, 30]),
  white: Object.freeze([191, 223, 255]),
});
const START = { blockSize: 23, parity: 32, fps: 10, white: 255 };

export const candidateKey = (c) => `${c.blockSize}/${c.parity}/${c.fps}/${c.white}`;

const ascending = (values) => [...new Set(values)].sort((a, b) => a - b);

/**
 * The values each setting can take for a screen's block cap: the base space
 * plus the seeds' own values. A cap under every base block leaves the cap itself.
 */
export function spaceFor(cap, seeds) {
  const usable = seeds.filter((s) => s.blockSize <= cap);
  const blockSize = ascending([...BASE_SPACE.blockSize, ...usable.map((s) => s.blockSize)]).filter((b) => b <= cap);
  return {
    blockSize: blockSize.length ? blockSize : [Math.floor(cap)],
    parity: ascending([...BASE_SPACE.parity, ...usable.map((s) => s.parity)]),
    fps: ascending([...BASE_SPACE.fps, ...usable.map((s) => s.fps)]),
    white: ascending([...BASE_SPACE.white, ...usable.map((s) => s.white)]),
  };
}

const sameSetting = (a, b) => a.blockSize === b.blockSize && a.parity === b.parity && a.fps === b.fps && a.white === b.white;
const isHeldBack = (c) => c.parity === HELD_BACK_PARITY || c.fps === HELD_BACK_FPS;

/**
 * @param {{ cap: number, seeds: Array<{ blockSize: number, parity: number, fps: number, white: number }>,
 *   fixed: { scheme: unknown }, random: () => number,
 *   ceilingOf?: (candidate: object, readsPerSecond: number) => number, longRun?: boolean }} options
 *   The first seed is the reference, tested again later to see whether
 *   conditions changed. ceilingOf gives the most a setting could carry at a read
 *   rate, in bytes per second; longRun splits the run into passes.
 * @returns {{ next: Function, record: Function, zeroStreak: Function, setAsideZeros: Function, markMoved: Function, result: Function }}
 */
export function createSearch({ cap, seeds, fixed, random, ceilingOf = () => Infinity, longRun = false }) {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1) throw new RangeError(`invalid block cap: ${cap}`);
  const space = spaceFor(cap, seeds);
  const topWhite = space.white[space.white.length - 1];
  const entries = new Map();
  let tests = 0;
  let pending = null;
  let pendingCand = null; // the candidate a tuning test belongs to
  let seedTested = false;
  let readsPerSecond = null;
  let totalMs = null;
  let usedMs = 0;
  let passes = null; // [{ start, end }] in ms used
  let moved = false;
  let nothingTests = 0;
  // The zeros since the last positive reading, undoable until one comes.
  let streak = { undo: [], before: null };

  const shuffle = (items) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  const indexOf = (axis, value) => space[axis].indexOf(value);
  const span = (axis) => Math.max(1, space[axis].length - 1);
  /** Distance for the survey: steps on each axis as a share of that axis, white aside. */
  const spread = (a, b) => Math.abs(indexOf('blockSize', a.blockSize) - indexOf('blockSize', b.blockSize)) / span('blockSize')
    + Math.abs(indexOf('parity', a.parity) - indexOf('parity', b.parity)) / span('parity')
    + Math.abs(indexOf('fps', a.fps) - indexOf('fps', b.fps)) / span('fps');
  /** Whole steps apart, white included. */
  const steps = (a, b) => ['blockSize', 'parity', 'fps', 'white'].reduce((sum, axis) => sum + Math.abs(indexOf(axis, a[axis]) - indexOf(axis, b[axis])), 0);

  const usableSeeds = seeds.filter((s) => s.blockSize <= cap);
  const nearestBlock = space.blockSize.reduce((a, b) => (Math.abs(b - START.blockSize) < Math.abs(a - START.blockSize) ? b : a));
  const seedQueue = [];
  for (const seed of usableSeeds.length ? usableSeeds : [{ ...START, blockSize: nearestBlock }]) {
    if (seedQueue.length < MAX_SEEDS && !seedQueue.some((c) => sameSetting(c, seed))) {
      seedQueue.push({ blockSize: seed.blockSize, parity: seed.parity, fps: seed.fps, white: seed.white, ...fixed });
    }
  }
  const referenceKey = candidateKey(seedQueue[0]);

  // ---- entries and readings ----

  const blank = () => ({ readings: [], passOf: [], seqOf: [], sum: 0, logSum: 0, logSquares: 0, positive: 0 });
  let seq = 0; // the order of every full reading in the run
  const entryOf = (candidate, reason) => {
    const key = candidateKey(candidate);
    if (!entries.has(key)) {
      entries.set(key, { candidate, reason, droppedIn: null, rough: null, roughIn: null, hint: null, ...blank() });
    }
    return entries.get(key);
  };
  const all = () => [...entries.values()];
  const measured = (e) => e.readings.length > 0;
  const mean = (e) => e.sum / e.readings.length;
  const logMean = (e) => e.logSum / e.positive;
  // The first stray zero on a setting that reads is forgiven; each further one counts against it.
  const score = (e) => logMean(e) + Math.log(e.positive / Math.max(e.positive, e.readings.length - 1));
  const zerosRule = (e) => e.readings.length - e.positive > e.positive + (e.rough > 0 ? 1 : 0);
  const byMean = (a, b) => mean(b) - mean(a);
  const pass = () => (passes ? passes.findLastIndex((p) => p.start <= usedMs) : 0);
  const alive = (e) => e.droppedIn !== pass();
  const readIn = (e, p) => e.passOf.includes(p);
  const addReading = (e, value) => {
    e.readings.push(value);
    e.passOf.push(pass());
    e.seqOf.push(seq++);
    e.sum += value;
    if (value > 0) {
      const log = Math.log(value);
      e.logSum += log;
      e.logSquares += log * log;
      e.positive++;
    }
  };

  /** Settings with full readings that count: a positive mean, and zeros not outnumbering good readings. */
  const rated = () => all().filter((e) => measured(e) && mean(e) > 0 && !zerosRule(e)).sort(byMean);
  /** The highest mean with enough readings to win or, before any has, the highest mean. */
  const leaderOf = () => {
    const options = rated();
    return options.find((e) => e.readings.length >= WIN_READINGS) ?? options[0] ?? null;
  };

  /**
   * The noise of one full reading on a log scale, pooled over all so far within
   * each pass, so a change in the room between passes does not count as noise.
   */
  const noise = () => {
    let sum = START_NOISE * START_NOISE * START_NOISE_WEIGHT;
    let weight = START_NOISE_WEIGHT;
    for (const e of entries.values()) {
      if (e.positive < 2) continue;
      const groups = new Map();
      e.readings.forEach((v, i) => {
        if (v <= 0) return;
        const g = groups.get(e.passOf[i]) ?? groups.set(e.passOf[i], []).get(e.passOf[i]);
        g.push(Math.log(v));
      });
      for (const logs of groups.values()) {
        if (logs.length < 2) continue;
        const m = logs.reduce((a, b) => a + b, 0) / logs.length;
        sum += logs.reduce((a, b) => a + (b - m) ** 2, 0);
        weight += logs.length - 1;
      }
    }
    return Math.sqrt(sum / weight);
  };

  /**
   * The reference's readings split into an early and a late group: its first pass
   * against the last pass that has any, or with one pass its first half against
   * its second. Each group says which readings of any setting belong to its side.
   */
  const referenceGroups = (reference) => {
    if (!reference) return null;
    const values = reference.readings.map((v, i) => ({ v, p: reference.passOf[i], q: reference.seqOf[i] })).filter((x) => x.v > 0);
    const passesRead = [...new Set(values.map((x) => x.p))];
    if (passesRead.length >= 2) {
      const [first, last] = [passesRead[0], passesRead[passesRead.length - 1]];
      return { early: values.filter((x) => x.p === first), late: values.filter((x) => x.p === last), inEarly: (p) => p === first, inLate: (p, q) => p === last };
    }
    const half = Math.floor(values.length / 2);
    if (!half) return null;
    const split = values[half].q;
    return { early: values.slice(0, half), late: values.slice(half), inEarly: (p, q) => q < split, inLate: (p, q) => q >= split };
  };

  /** The best before and after a change, each from its own readings, and the setting best in the worse of the two. */
  const byConditions = (reference) => {
    const groups = referenceGroups(reference);
    if (!groups) return null;
    const sides = all().map((e) => {
      const pick = (inSide) => e.readings.filter((v, i) => inSide(e.passOf[i], e.seqOf[i]));
      const b = pick(groups.inEarly);
      const a = pick(groups.inLate);
      const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
      return { e, before: avg(b), nBefore: b.length, after: avg(a), nAfter: a.length };
    });
    const bestBy = (field, n) => sides.filter((x) => x[n] > 0 && x[field] > 0).sort((x, y) => y[field] - x[field])[0] ?? null;
    const before = bestBy('before', 'nBefore');
    const after = bestBy('after', 'nAfter');
    const steady = sides.filter((x) => x.nBefore && x.nAfter && x.before > 0 && x.after > 0)
      .sort((x, y) => Math.min(y.before, y.after) - Math.min(x.before, x.after))[0] ?? null;
    return {
      before: before && { candidate: before.e.candidate, mean: before.before, readings: before.nBefore },
      after: after && { candidate: after.e.candidate, mean: after.after, readings: after.nAfter },
      steady: steady && { candidate: steady.e.candidate, before: steady.before, after: steady.after },
    };
  };

  /** Whether the reference's early and late readings differ by more than the noise. */
  const conditionsChanged = (reference, sigma) => {
    const groups = referenceGroups(reference);
    if (!groups || !groups.early.length || !groups.late.length) return false;
    const logMeanOf = (xs) => xs.reduce((sum, x) => sum + Math.log(x.v), 0) / xs.length;
    const se = sigma * Math.sqrt(1 / groups.early.length + 1 / groups.late.length);
    return Math.abs(logMeanOf(groups.early) - logMeanOf(groups.late)) > NOISE_Z * se;
  };
  /** True when a is above b by more than the noise. */
  const clearlyAbove = (a, b, sigma = noise()) => {
    if (mean(b) === 0) return true;
    const se = sigma * Math.sqrt(1 / a.positive + 1 / b.positive);
    return score(a) - score(b) > NOISE_Z * se;
  };
  /** What a ceiling must reach to stay in the search: the leader's lower bound, so a lucky leader starves nothing. */
  const ceilingBar = (leader) => (leader ? mean(leader) * Math.exp(-NOISE_Z * noise() / Math.sqrt(leader.positive)) : 0);
  const readRate = () => readsPerSecond ?? START_READS_PER_SECOND;
  const couldWin = (c, bar) => ceilingOf(c, readRate()) >= bar;

  /** What a setting is thought to read: its full mean, else this pass's rough reading, else a hint from before a move. */
  const valueOf = (e) => {
    if (measured(e)) return mean(e);
    if (e.rough !== null && e.roughIn === pass()) return e.rough;
    return e.hint ?? 0;
  };

  // ---- time ----

  const passAt = (index) => passes[index];
  const shareOfPass = () => {
    const p = passAt(pass());
    return (usedMs - p.start) / Math.max(1, p.end - p.start);
  };
  const isLastPass = () => pass() === passes.length - 1;
  const startPasses = () => {
    const count = longRun ? Math.max(1, Math.round(totalMs / PASS_MS)) : 1;
    const length = totalMs / count;
    passes = Array.from({ length: count }, (_, i) => ({ start: i * length, end: i === count - 1 ? totalMs : (i + 1) * length, reference: i === 0, finalsReference: false, candidates: null }));
  };
  /** After a framing move the time left is one new pass. */
  const startPassAfterMove = () => {
    const now = usedMs;
    passes = passes.filter((p) => p.start < now);
    if (passes.length) passes[passes.length - 1].end = now;
    passes.push({ start: now, end: totalMs, reference: false, finalsReference: false, candidates: null });
  };

  /** Time held back so the top two can reach the readings to win. */
  const reserveMs = () => TEST_COST_MS * rated().slice(0, 2).reduce((sum, e) => sum + Math.max(0, WIN_READINGS - e.readings.length), 0);
  const fits = (remainingMs, costMs) => remainingMs >= costMs && remainingMs - costMs >= reserveMs();

  const take = (entry, reason, testMs, cand = null) => {
    pending = { candidate: entry.candidate, reason, testMs };
    pendingCand = cand;
    tests++;
    return pending;
  };
  const takeFull = (entry, reason) => take(entry, reason, TEST_MS);

  // ---- survey ----

  const surveyed = (e, p) => e.roughIn === p || readIn(e, p);
  /** Every setting on the survey's grid, at full white. */
  const grid = () => {
    const out = [];
    for (const blockSize of space.blockSize) {
      for (const parity of space.parity) {
        for (const fps of space.fps) out.push({ blockSize, parity, fps, white: topWhite, ...fixed });
      }
    }
    return out;
  };
  let gridCache = null;
  const gridAll = () => (gridCache ??= grid());

  /** Blocks whose survey tests this pass mostly failed: read zero or under the drop share. */
  const failingBlocks = (p) => {
    const tally = new Map();
    for (const e of entries.values()) {
      if (e.roughIn !== p) continue;
      const t = tally.get(e.candidate.blockSize) ?? { tests: 0, fails: 0 };
      t.tests++;
      if (e.rough === 0 || e.droppedIn === p) t.fails++;
      tally.set(e.candidate.blockSize, t);
    }
    return new Set([...tally].filter(([, t]) => t.tests >= BLOCK_FAIL_TESTS && t.fails >= BLOCK_FAIL_SHARE * t.tests).map(([b]) => b));
  };

  /** The plausible setting farthest from everything tested this pass and from the seeds. */
  const farthest = (bar) => {
    const p = pass();
    const failing = failingBlocks(p);
    // Settings with full readings are known: they count as covered and are retested as candidates, not screened.
    const covered = all().filter((e) => surveyed(e, p) || e.reason === 'seed' || measured(e)).map((e) => e.candidate);
    for (const held of [false, true]) {
      let best = null;
      let bestDistance = -1;
      let bestFresh = false;
      let ties = 0;
      for (const c of gridAll()) {
        if (isHeldBack(c) !== held || failing.has(c.blockSize)) continue;
        const e = entries.get(candidateKey(c));
        if (e && (surveyed(e, p) || e.droppedIn === p || measured(e))) continue;
        if (!couldWin(c, bar)) continue;
        let near = Infinity;
        for (const d of covered) near = Math.min(near, spread(c, d));
        if (near === Infinity) near = 0;
        const fresh = !e || (e.rough === null && !measured(e));
        const better = near > bestDistance + SAME || (Math.abs(near - bestDistance) <= SAME && fresh && !bestFresh);
        if (better) {
          best = c;
          bestDistance = near;
          bestFresh = fresh;
          ties = 1;
        } else if (Math.abs(near - bestDistance) <= SAME && fresh === bestFresh && random() * ++ties < 1) {
          best = c;
        }
      }
      if (best) return best;
    }
    return null;
  };

  // ---- candidates and tuning ----

  /** One step along each axis, in the order tuning tries them: parity up first, white last. */
  const neighbours = (c) => {
    const out = [];
    const along = (axis, delta) => {
      const values = space[axis];
      const i = values.indexOf(c[axis]) + delta;
      if (i >= 0 && i < values.length) out.push({ ...c, [axis]: values[i] });
    };
    along('parity', 1);
    along('parity', -1);
    along('fps', 1);
    along('fps', -1);
    along('blockSize', 1);
    along('blockSize', -1);
    along('white', c.white === topWhite ? -1 : 1);
    return out;
  };

  /** The candidate list for this pass: good settings, best first, each from its own part of the space. */
  const chooseCandidates = () => {
    const leader = leaderOf();
    const options = all().filter((e) => alive(e) && valueOf(e) > 0 && !(measured(e) && zerosRule(e)));
    const best = leader ? mean(leader) : Math.max(0, ...options.map(valueOf));
    const chosen = [];
    for (const e of options.sort((a, b) => valueOf(b) - valueOf(a))) {
      if (chosen.length >= MAX_CANDIDATES) break;
      if (valueOf(e) < CANDIDATE_SHARE * best) break;
      if (chosen.every((c) => steps(c.centre.candidate, e.candidate) >= CANDIDATE_STEPS)) chosen.push({ centre: e, start: e.candidate, moves: 0, done: false });
    }
    return chosen;
  };
  const tuningOf = () => {
    const p = passAt(pass());
    if (!p.candidates) {
      p.candidates = chooseCandidates();
      p.turn = 0;
    }
    return p;
  };

  /** The next test for one candidate, or null when it has nothing left to try. */
  const candidateStep = (cand, bar) => {
    const p = pass();
    if (cand.done) return null;
    const { centre } = cand;
    if (!readIn(centre, p)) {
      if (!alive(centre)) {
        cand.done = true;
        return null;
      }
      return { entry: centre, reason: 'candidate' };
    }
    const leader = leaderOf();
    if (!alive(centre) || zerosRule(centre) || (leader && leader !== centre && clearlyAbove(leader, centre))) {
      cand.done = true;
      return null;
    }
    for (const c of neighbours(centre.candidate)) {
      const e = entries.get(candidateKey({ ...c, ...fixed }));
      if (e && (readIn(e, p) || !alive(e))) continue;
      if (!couldWin(c, bar)) continue;
      return { entry: entryOf({ ...c, ...fixed }, 'tune'), reason: 'tune' };
    }
    cand.done = true;
    return null;
  };
  /** Round robin across the candidates. */
  const tuneStep = (bar) => {
    const t = tuningOf();
    const list = t.candidates;
    for (let k = 0; k < list.length; k++) {
      const i = (t.turn + k) % list.length;
      const step = candidateStep(list[i], bar);
      if (step) {
        t.turn = i + 1;
        step.cand = list[i];
        return step;
      }
    }
    return null;
  };

  /** A tuned neighbour reading above its candidate takes its place, at most MAX_MOVES times. */
  const climb = (cand, entry) => {
    if (!cand || cand.done || cand.moves >= MAX_MOVES || entry === cand.centre) return;
    if (!measured(entry) || zerosRule(entry) || !measured(cand.centre)) return;
    if (mean(entry) > mean(cand.centre)) {
      cand.centre = entry;
      cand.moves++;
    }
  };

  // ---- finals ----

  const finalists = () => {
    const top = rated().slice(0, FINALISTS);
    const leader = leaderOf();
    if (leader && !top.includes(leader)) top[top.length - 1] = leader;
    return top;
  };
  let round = [];
  // The setting the finals are bringing to 3 readings. It keeps the finals until it
  // has them, so a lucky single reading elsewhere cannot spread them too thin to prove anything.
  let focus = null;
  const unproven = (e) => e && entries.has(candidateKey(e.candidate)) && e.readings.length < WIN_READINGS && mean(e) > 0 && !zerosRule(e);
  const finalStep = (remainingMs) => {
    if (!unproven(focus)) {
      // Of the top two still short of readings, the one closest to 3, then the higher mean.
      focus = rated().slice(0, 2).filter(unproven).sort((a, b) => b.readings.length - a.readings.length || byMean(a, b))[0] ?? null;
    }
    if (focus) return remainingMs >= TEST_COST_MS ? takeFull(focus, 'final') : null;
    const finals = finalists();
    if (!finals.length) {
      const best = all().filter((e) => alive(e) && valueOf(e) > 0).sort((a, b) => valueOf(b) - valueOf(a))[0];
      return best && remainingMs >= TEST_COST_MS ? takeFull(best, 'final') : null;
    }
    if (remainingMs < TEST_COST_MS) return null;
    round = round.filter((e) => finals.includes(e));
    if (!round.length) round = shuffle([...finals]);
    // Too little time for a full round: the likeliest winners go first.
    if (remainingMs < round.length * TEST_COST_MS) round.sort(byMean);
    return takeFull(round.shift(), 'final');
  };

  const anyPositive = () => all().some((e) => e.positive > 0 || e.rough > 0);

  const stepAfterSeeds = (remainingMs) => {
    if (!anyPositive() && nothingTests >= NOTHING_READS_TESTS) return null;
    const p = passAt(pass());
    const reference = entries.get(referenceKey);
    // Each later pass starts by testing the reference again.
    if (!p.reference) {
      p.reference = true;
      if (reference && fits(remainingMs, TEST_COST_MS)) return takeFull(reference, 'reference');
    }
    const share = shareOfPass();
    const bar = ceilingBar(leaderOf());
    if (share < SURVEY_SHARE && fits(remainingMs, SCREEN_COST_MS)) {
      const c = farthest(bar);
      if (c) return take(entryOf(c, 'survey'), 'survey', SCREEN_MS);
    }
    if (!anyPositive()) {
      // Nothing reads: the survey goes on until the run gives up.
      const c = remainingMs >= SCREEN_COST_MS ? farthest(0) : null;
      return c ? take(entryOf(c, 'survey'), 'survey', SCREEN_MS) : null;
    }
    if (share < TUNE_SHARE && fits(remainingMs, TEST_COST_MS)) {
      const step = tuneStep(bar);
      if (step) return take(step.entry, step.reason, TEST_MS, step.cand);
    }
    if (isLastPass() && !p.finalsReference) {
      p.finalsReference = true;
      if (reference && measured(reference) && fits(remainingMs, TEST_COST_MS)) return takeFull(reference, 'reference');
    }
    return finalStep(remainingMs);
  };

  // ---- recording ----

  const noteZero = (entry, isScreen) => {
    if (!streak.undo.length) {
      const leader = leaderOf();
      streak.before = leader ? { candidate: leader.candidate, mean: mean(leader) } : null;
    }
    const { droppedIn, rough, roughIn, hint, readings: { length: readings } } = entry;
    streak.undo.push({ entry, droppedIn, rough, roughIn, hint, readings, wasNothing: nothingTests, isScreen });
  };
  const endStreak = () => { streak = { undo: [], before: null }; };

  /** Undoes the zeros since the last positive reading. Returns how many. */
  const undoZeros = () => {
    const count = streak.undo.length;
    if (!count) return 0;
    for (const { entry, droppedIn, rough, roughIn, hint, readings, wasNothing } of streak.undo.reverse()) {
      Object.assign(entry, { droppedIn, rough, roughIn, hint });
      entry.readings.length = readings;
      entry.passOf.length = readings;
      entry.seqOf.length = readings;
      nothingTests = wasNothing;
      if (readings === 0 && rough === null && hint === null) {
        entries.delete(candidateKey(entry.candidate));
        if (entry.reason === 'seed') seedQueue.unshift(entry.candidate);
      }
    }
    endStreak();
    round = round.filter((e) => entries.has(candidateKey(e.candidate)));
    return count;
  };

  const recordScreen = (entry, rate) => {
    entry.rough = rate;
    entry.roughIn = pass();
    const leader = leaderOf();
    if (rate === 0 || (leader && rate < DROP_SHARE * mean(leader))) entry.droppedIn = pass();
  };
  const recordFull = (entry, rate) => {
    addReading(entry, rate);
    if (rate === 0 && zerosRule(entry)) entry.droppedIn = pass();
  };

  return {
    /** The next test, or null when finished. A test not counted is shown again. */
    next(remainingMs) {
      if (totalMs === null) {
        totalMs = remainingMs;
        startPasses();
      }
      usedMs = Math.max(0, totalMs - remainingMs);
      if (moved) {
        moved = false;
        startPassAfterMove();
      }
      if (pending) {
        if (remainingMs < pending.testMs + SWITCH_MS) return null;
        tests++;
        return pending;
      }
      // Seeds until their share of the limit; the first always, time allowing.
      if (seedQueue.length && (usedMs < SEED_SHARE * totalMs || !seedTested)) {
        if (seedTested ? fits(remainingMs, TEST_COST_MS) : remainingMs >= TEST_COST_MS) {
          seedTested = true;
          return takeFull(entryOf(seedQueue.shift(), 'seed'), 'seed');
        }
        if (!seedTested) return null;
      }
      seedQueue.length = 0;
      if (remainingMs < SCREEN_COST_MS) return null;
      return stepAfterSeeds(remainingMs);
    },

    /** Counts a test's reading, unless the phone was not reading during it. */
    record(candidate, { bytesPerSecond, reads, zeroAtEarlyCheck }) {
      const key = candidateKey(candidate);
      const entry = entries.get(key);
      if (!entry || !Number.isFinite(reads)) return;
      if (zeroAtEarlyCheck && reads < SCREEN_MIN_READS) return;
      const isPending = pending !== null && candidateKey(pending.candidate) === key;
      const isScreen = isPending && pending.testMs === SCREEN_MS;
      const minReads = isScreen ? SCREEN_MIN_READS : MIN_READS;
      if (!zeroAtEarlyCheck && (reads < minReads || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)) return;
      const testMs = isScreen ? SCREEN_MS : TEST_MS;
      const cand = isPending ? pendingCand : null;
      if (isPending) {
        pending = null;
        pendingCand = null;
      }
      let rate = zeroAtEarlyCheck ? 0 : bytesPerSecond;
      if (rate > 0) readsPerSecond = Math.max(readsPerSecond ?? 0, reads / (testMs / 1000));
      // A reading above what its frames can carry is a lucky count, not a rate.
      rate = Math.min(rate, ceilingOf(candidate, readRate()));
      if (rate === 0) noteZero(entry, isScreen);
      else endStreak();
      if (isScreen) recordScreen(entry, rate);
      else recordFull(entry, rate);
      if (!anyPositive() && entry.reason !== 'seed') nothingTests++;
      climb(cand, entry);
    },

    /**
     * The zeros since the last positive reading, counting each short survey zero
     * as a third, and the leader as it stood before them, if any.
     */
    zeroStreak() {
      const short = streak.undo.filter((z) => z.isScreen).length;
      return { count: streak.undo.length - short + Math.floor(short / SURVEY_ZEROS_PER_ZERO), before: streak.before };
    },

    /**
     * Undoes the zeros since the last positive reading, for when they came from a
     * phone that lost its aim. A setting they were the first news of goes back to
     * being untested. Leaves no test pending. Returns how many it undid.
     */
    setAsideZeros() {
      pending = null;
      pendingCand = null;
      return undoZeros();
    },

    /** Sets the readings so far aside, as from an earlier framing, and starts a new pass. Settings stay. */
    markMoved() {
      // Zeros in progress were likely the knock that moved the phone.
      undoZeros();
      if (pending && !entries.has(candidateKey(pending.candidate))) pending = null;
      for (const e of all()) {
        e.hint = valueOf(e) || null;
        e.rough = null;
        e.roughIn = null;
        e.droppedIn = null;
        Object.assign(e, blank());
      }
      round = [];
      focus = null;
      if (passes) moved = true;
    },

    result() {
      const leader = leaderOf();
      const sigma = noise();
      const proven = rated().filter((e) => e.readings.length >= WIN_READINGS);
      const top = proven[0] ?? null;
      // Tied: the same block, rate and white as the best, within the noise and 90% of its mean.
      const parityOnly = (e) => e.candidate.blockSize === top.candidate.blockSize && e.candidate.fps === top.candidate.fps && e.candidate.white === top.candidate.white;
      const tied = top ? proven.filter((e) => e === top || (parityOnly(e) && mean(e) >= TIE_SHARE * mean(top) && !clearlyAbove(top, e, sigma))) : [];
      const chosen = tied.length ? [...tied].sort((a, b) => b.candidate.parity - a.candidate.parity || byMean(a, b))[0] : leader;
      // A rival short of readings casts doubt only when it reads above the winner by more than the noise:
      // one or two lucky readings a little higher are what noise gives.
      const higherRival = chosen && rated().some((e) => e !== chosen && e.readings.length < WIN_READINGS && clearlyAbove(e, chosen, sigma));
      const shown = all();
      const runnerUp = rated().filter((e) => e !== chosen)[0];
      const rest = shown.filter((e) => e !== chosen).sort((a, b) => {
        if (measured(a) !== measured(b)) return Number(measured(b)) - Number(measured(a));
        return measured(a) ? byMean(a, b) : (b.rough ?? 0) - (a.rough ?? 0);
      });
      const leaderMean = leader ? mean(leader) : 0;
      const bar = ceilingBar(leader);
      const untested = gridAll().filter((c) => {
        const e = entries.get(candidateKey(c));
        return !e || (e.rough === null && !measured(e));
      });
      const skippedByCeiling = untested.filter((c) => !couldWin(c, bar)).length;
      const heldBack = untested.filter((c) => couldWin(c, bar) && isHeldBack(c)).length;
      const reference = entries.get(referenceKey);
      const referenceReadings = reference ? reference.readings.filter((v) => v > 0) : [];
      const passCount = passes ? passes.length : 0;
      const passBest = [];
      for (let p = 0; p < passCount; p++) {
        let best = null;
        for (const e of shown) {
          const values = e.readings.filter((_, i) => e.passOf[i] === p);
          if (!values.length) continue;
          const m = values.reduce((a, b) => a + b, 0) / values.length;
          if (m > 0 && (!best || m > best.mean)) best = { candidate: e.candidate, mean: m, readings: values.length };
        }
        passBest.push(best);
      }
      const current = passes ? passes[pass()]?.candidates : null;
      return {
        winner: tied.length ? chosen.candidate : null,
        leader: chosen ? chosen.candidate : null,
        provisional: chosen !== null && (!tied.length || higherRival),
        ranked: (chosen ? [chosen, ...rest] : rest).map((e) => ({
          candidate: e.candidate,
          mean: measured(e) ? mean(e) : null,
          min: measured(e) ? Math.min(...e.readings) : null,
          max: measured(e) ? Math.max(...e.readings) : null,
          readings: e.readings.length,
          rough: e.rough,
          // A setting with full readings stands on them; a later rough look does not drop it.
          alive: measured(e) ? mean(e) > 0 && !zerosRule(e) : alive(e),
          reason: e.reason,
        })),
        separated: Boolean(chosen && runnerUp && clearlyAbove(chosen, runnerUp, sigma)),
        tied: tied.map((e) => e.candidate),
        candidates: current ? current.map((c) => c.start) : [],
        reference: referenceReadings,
        conditionsChanged: conditionsChanged(reference, sigma),
        byConditions: conditionsChanged(reference, sigma) ? byConditions(reference) : null,
        passes: passBest,
        coverage: {
          screened: shown.filter((e) => e.rough !== null).length,
          full: shown.filter(measured).length,
          // With no leader nothing can be ruled in or out: null, not "nothing left".
          ceilingBar: leader ? bar : null,
          skippedByCeiling: leader ? skippedByCeiling : null,
          untestedPlausible: leader ? untested.length - skippedByCeiling - heldBack : null,
          heldBack: leader ? heldBack : null,
          roughAboveWinner: leader ? shown.filter((e) => !measured(e) && e.rough > leaderMean).length : 0,
        },
        tests,
      };
    },
  };
}
