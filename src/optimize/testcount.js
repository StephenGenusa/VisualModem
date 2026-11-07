// What the phone saw of each test on the screen: the distinct good pieces,
// and how many camera reads carried that test's header. Raw counts only; the
// computer turns them into a rate. No DOM.

import { FRAME_TYPES } from '../core/frame.js';
import { aimFromCorners } from './aim.js';

const KEEP_TESTS = 3; // tests held at once, so a report stays small
const PAST_RUNS = 16; // earlier run ids remembered, so a late read of one is ignored
const RECENT_MS = 5000; // a test unseen for this long is left out of a timed report
const AIM_MS = 3000; // an aim older than this is not reported

/**
 * Counts per test within the current run. A header is one camera read that
 * got far enough to show which test it belongs to; a read with no header
 * belongs to no test and is not counted. A read whose packets all failed
 * (no symbolIds) still counts as a read.
 */
export function createTestCounter() {
  let runId = null;
  let past = [];
  let cameraReads = 0; // every camera read attempt, decoded or not
  let markerReads = 0; // attempts where the corner markers were found
  let tests = new Map(); // probeId -> { probeId, ids: Set, reads, goodReads, firstMs, lastMs }

  function add({ atMs, header, markers = false }) {
    cameraReads++;
    if (markers) markerReads++;
    if (!header || header.frameType !== FRAME_TYPES.probe) return;
    const run = header.streamLength ?? 0;
    if (run !== runId) {
      if (past.includes(run)) return; // a late read of an earlier run
      if (runId !== null) { past.push(runId); if (past.length > PAST_RUNS) past.shift(); }
      runId = run;
      tests = new Map();
    }
    let t = tests.get(header.probeId);
    if (!t) {
      t = { probeId: header.probeId, ids: new Set(), reads: 0, goodReads: 0, firstMs: atMs, lastMs: atMs };
      tests.set(header.probeId, t);
      if (tests.size > KEEP_TESTS) {
        let oldest = null;
        for (const o of tests.values()) if (o !== t && (oldest === null || o.lastMs < oldest.lastMs)) oldest = o;
        tests.delete(oldest.probeId);
      }
    }
    t.reads++;
    const good = header.symbolIds ?? [];
    if (good.length) t.goodReads++;
    for (const id of good) t.ids.add(id);
    if (atMs < t.firstMs) t.firstMs = atMs;
    if (atMs > t.lastMs) t.lastMs = atMs;
  }

  /** @param {{ nowMs?: number }} [opts] with a clock, tests unseen for a few seconds are left out */
  function report({ nowMs } = {}) {
    const out = [];
    for (const t of tests.values()) {
      if (nowMs !== undefined && nowMs - t.lastMs > RECENT_MS) continue;
      out.push({ runId, probeId: t.probeId, packets: t.ids.size, reads: t.reads, goodReads: t.goodReads, firstMs: t.firstMs, lastMs: t.lastMs });
    }
    return out;
  }

  /** Running totals since the counter was made; they never reset with a run. */
  const totals = () => ({ cameraReads, markerReads });

  return { add, report, totals };
}

/** The screen's share of the camera width from the latest read's grid corners, as the aim guide computes it. */
export function createAimTracker() {
  let last = null;
  return {
    note({ atMs, gridCorners, imageW, imageH }) {
      // A read with no grid or a missing corner keeps the last share; only its age blanks it.
      if (!gridCorners || !gridCorners.tl || !gridCorners.tr || !gridCorners.bl || !imageW || !imageH) return;
      last = { atMs, share: aimFromCorners(gridCorners, { width: imageW, height: imageH }).widthShare };
    },
    /** The latest share, or null when none was seen in the last few seconds. */
    get(nowMs) {
      return last && nowMs - last.atMs <= AIM_MS ? last.share : null;
    },
  };
}
