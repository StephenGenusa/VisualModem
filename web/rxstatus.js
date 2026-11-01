// Run status for the phone panel: one word for where the run is, the share of
// recent camera reads that worked, the main reason the rest failed, an aim
// hint and a time-left estimate. No DOM, so it runs in Node tests.
import { aimFromCorners } from '../src/optimize/aim.js';
import { FRAME_TYPES } from '../src/core/frame.js';
import { schemeName } from '../src/core/scheme.js';

export const MISS_TEXT = {
  'no markers': "The TV's corners are not in view",
  'timing mismatch': 'An edge of the grid is blocked or cut off',
  'header unreadable': 'Frames found but the header did not read: blur or glare',
  'payload failed': 'Frames found but too many errors: tearing, blur or glare',
};
const OTHER_MISS = 'Other read failures';
const RATE_SPAN_MS = 5000;
const MIN_RATE_MS = 3000;
const PROBE_RECENT_MS = 3000;
const GOOD_SHARE = 0.8;

export function formatClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const total = Math.round(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The camera stream's width over height, for the camera box; 16:9 until the size is known. */
export function cameraAspect(width, height) {
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

/**
 * The grid size and colors of the last read, a quick check that the
 * phone reads the sender's setting: "Grid 137×77, rgb 2/2/2". Empty with no grid.
 */
export function gridText(read) {
  if (!read || !read.markersFound || !read.cols || !read.rows) return '';
  const colors = read.schemeName ?? (read.scheme ? schemeName(read.scheme) : `${read.levels} levels`);
  return `Grid ${read.cols}×${read.rows}, ${colors}`;
}

export function createRunStatus({ window = 30 } = {}) {
  let attempts = [];
  let lastHeader = null;
  let lastAim = null;
  let lastProbe = null; // the last probe or characterization header
  let collector = null;
  let samples = [];
  let recommendation = null;
  let error = null;
  // Probe frames never reach the collector, so a finished or stopped transfer
  // stays in every status. The latest of these two decides which one the word shows.
  let probeAtMs = null; // the last probe or characterization header
  let progressAtMs = null; // the last time the collector gained pieces or changed transmission

  function noteAttempt({ atMs, stage, header, gridCorners, imageW, imageH }) {
    attempts.push({ atMs, stage });
    if (attempts.length > window) attempts = attempts.slice(-window);
    if (header) lastHeader = header;
    const t = header && header.frameType;
    if (t === FRAME_TYPES.probe || t === FRAME_TYPES.characterization) { probeAtMs = atMs; lastProbe = header; }
    lastAim = gridCorners && imageW && imageH ? { gridCorners, imageW, imageH } : null;
  }

  function noteCollector({ atMs, ...status }) {
    if (!collector || collector.txId !== status.txId) samples = [];
    if (!collector || collector.txId !== status.txId || collector.have !== status.have) progressAtMs = atMs;
    collector = status;
    samples.push({ atMs, have: status.have });
  }

  function leftMs(nowMs) {
    if (!collector || collector.complete) return null;
    const recent = samples.filter((s) => s.atMs >= nowMs - RATE_SPAN_MS);
    if (recent.length < 2) return null;
    const first = recent[0], last = recent[recent.length - 1];
    const span = last.atMs - first.atMs;
    if (span < MIN_RATE_MS) return null;
    const rate = (last.have - first.have) / span;
    if (!(rate > 0)) return null;
    return Math.max(0, (collector.count - last.have) / rate);
  }

  function probeWord(nowMs) {
    const recent = probeAtMs !== null && nowMs - probeAtMs <= PROBE_RECENT_MS;
    if (recent && lastProbe) {
      return lastProbe.frameType === FRAME_TYPES.probe
        ? { word: `Probe ${lastProbe.probeId} of ${lastProbe.probeCount}`, kind: 'work' }
        : { word: 'Probe setup', kind: 'work' };
    }
    if (recommendation) return { word: recommendation, kind: 'ok' };
    if (probeAtMs !== null) return { word: 'Probe stopped', kind: 'warn' };
    return null;
  }

  function word(nowMs) {
    if (error) return { word: error, kind: 'fail' };
    // A probe run after the last collector progress outranks that stale transfer.
    const probeNewer = probeAtMs !== null && (progressAtMs === null || probeAtMs > progressAtMs);
    if (collector && !probeNewer) return collector.complete ? { word: 'Complete', kind: 'ok' } : { word: 'Receiving', kind: 'work' };
    return probeWord(nowMs) ?? (collector
      ? (collector.complete ? { word: 'Complete', kind: 'ok' } : { word: 'Receiving', kind: 'work' })
      : { word: 'Looking for markers', kind: 'warn' });
  }

  function missOf() {
    const counts = new Map();
    for (const a of attempts) {
      if (a.stage === 'ok') continue;
      const key = MISS_TEXT[a.stage] ? a.stage : null;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    if (!bestN) return null;
    return best ? MISS_TEXT[best] : OTHER_MISS;
  }

  function hintOf() {
    if (!lastAim) return null;
    const a = aimFromCorners(lastAim.gridCorners, { width: lastAim.imageW, height: lastAim.imageH });
    if (a.advice && a.advice.length) return a.advice[0];
    const pct = Math.round(a.widthShare * 100);
    if (a.widthShare < GOOD_SHARE) return `Move closer: the TV fills ${pct}% of the width (aim for 85 to 90%)`;
    return `Aim is good, the TV fills ${pct}% of the width`;
  }

  function state(nowMs) {
    const w = word(nowMs);
    return {
      ...w,
      reads: { ok: attempts.filter((a) => a.stage === 'ok').length, of: attempts.length },
      miss: missOf(),
      hint: hintOf(),
      elapsedMs: collector ? collector.elapsedMs ?? null : null,
      leftMs: leftMs(nowMs),
    };
  }

  return {
    noteAttempt, noteCollector, state,
    noteRecommendation(text) { recommendation = text || null; },
    noteError(text) { error = text || null; },
  };
}
