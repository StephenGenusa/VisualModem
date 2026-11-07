// Timed runs: the order of real transfers (setting A, optionally B,
// alternating) and a summary of their times. No DOM, no clock.

export const RUN_COUNTS = [3, 5, 10];
export const DEFAULT_RUN_COUNT = 5;
export const RUN_LIMIT_MS = 180000;
export const STALL_MS = 30000;

const Z975 = 1.959964;
// Two-sided 95% critical values of Student's t, for 1 to 30 degrees of freedom.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

/**
 * The two-sided 95% critical value of Student's t with df degrees of freedom:
 * from the table up to 30, then the normal value with its first correction
 * for df, z + (z^3 + z) / (4 df), within 0.003 of the true value.
 */
export function tCritical95(df) {
  if (df <= T95.length) return T95[Math.max(1, Math.ceil(df)) - 1];
  return Z975 + (Z975 ** 3 + Z975) / (4 * df);
}

/** @returns {Array<'a'|'b'>} count rounds; each round is A, then B when there is one. */
export function runOrder(count, hasOther) {
  const order = [];
  for (let i = 0; i < count; i++) {
    order.push('a');
    if (hasOther) order.push('b');
  }
  return order;
}

function side(runs, which, streamBytes) {
  const mine = runs.filter((r) => r.which === which);
  const times = mine.filter((r) => typeof r.failed !== 'string' && Number.isFinite(r.ms)).map((r) => r.ms);
  const failed = mine.length - times.length;
  if (!times.length) return { times, mean: null, min: null, max: null, bytesPerSecond: null, failed };
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  return {
    times,
    mean,
    min: Math.min(...times),
    max: Math.max(...times),
    bytesPerSecond: streamBytes / (mean / 1000),
    failed,
  };
}

const meanLog = (times) => times.reduce((s, t) => s + Math.log(t), 0) / times.length;

// Two-sided 95% t test on the difference of mean log times, standard error
// from the pooled spread of both sides, na + nb - 2 degrees of freedom.
function differs(a, b) {
  const na = a.times.length;
  const nb = b.times.length;
  if (na < 2 || nb < 2) return null;
  const la = a.times.map(Math.log);
  const lb = b.times.map(Math.log);
  const m = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ss = (xs) => { const mu = m(xs); return xs.reduce((s, x) => s + (x - mu) ** 2, 0); };
  const pooled = (ss(la) + ss(lb)) / (na - 1 + nb - 1);
  const se = Math.sqrt(pooled) * Math.sqrt(1 / na + 1 / nb);
  return Math.abs(m(la) - m(lb)) > tCritical95(na + nb - 2) * se;
}

/**
 * @param {Array<{ which: 'a'|'b', ms: number|null, failed: string|null }>} runs
 * @param {number} streamBytes
 * @returns {{ a: object, b: object | null, differ: boolean | null, ratio: number | null, faster: 'a'|'b'|null }}
 *   ratio is B's time over A's, from the geometric means of the timed runs;
 *   faster is the side with the shorter time, null when they are equal or a side has no time
 */
export function summarise(runs, streamBytes) {
  const a = side(runs, 'a', streamBytes);
  const hasB = runs.some((r) => r.which === 'b');
  const b = hasB ? side(runs, 'b', streamBytes) : null;
  const ratio = b && a.times.length && b.times.length ? Math.exp(meanLog(b.times) - meanLog(a.times)) : null;
  const faster = ratio === null || ratio === 1 ? null : ratio < 1 ? 'b' : 'a';
  return { a, b, differ: b ? differs(a, b) : null, ratio, faster };
}

const TIMED_KEY = 'visual-modem:timed:';
const MAX_TIMED = 6;
const TIMED_FIELDS = ['blockSize', 'parity', 'fps', 'white'];
const sameTimed = (a, b) => TIMED_FIELDS.every((f) => a[f] === b[f]) && a.scheme === b.scheme && a.levels === b.levels;
const validTimed = (t) => Boolean(t) && t.settings && TIMED_FIELDS.every((f) => Number.isFinite(t.settings[f]))
  && typeof t.settings.scheme === 'string' && Number.isFinite(t.settings.levels) && Number.isFinite(t.mean) && t.mean > 0;

/** The settings timed on a screen, newest first. Blocked or bad storage gives none. */
export function loadTimed(storage, screenKey) {
  try {
    const list = JSON.parse(storage.getItem(TIMED_KEY + screenKey));
    return Array.isArray(list) ? list.filter(validTimed).slice(0, MAX_TIMED) : [];
  } catch {
    return [];
  }
}

/**
 * Keeps each timed setting's mean time on a screen, newest first, one entry per
 * setting, so it can be chosen again. Failure is harmless.
 * @param {Array<{ settings: object, mean: number, runs: number }>} timed
 * @param {string} today 'YYYY-MM-DD'
 */
export function saveTimed(storage, screenKey, timed, today) {
  try {
    // Settings with no scheme were sent with the color cube at 2 levels.
    const fresh = timed.map(({ settings, mean, runs }) => {
      const { blockSize, parity, fps, white, scheme = 'cube', levels = 2 } = settings ?? {};
      return { settings: { blockSize, parity, fps, white, scheme, levels }, mean, runs, savedOn: today };
    }).filter(validTimed);
    const others = loadTimed(storage, screenKey).filter((t) => !fresh.some((f) => sameTimed(f.settings, t.settings)));
    storage.setItem(TIMED_KEY + screenKey, JSON.stringify([...fresh, ...others].slice(0, MAX_TIMED)));
  } catch {
    // The menu simply does not offer them.
  }
}
