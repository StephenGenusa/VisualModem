// The phone's per-test read counts, health and collector status, kept in memory by the project server so the sender
// can poll them during Refine and Timed runs. Each entry gets an increasing sequence
// number; since(seq) returns the entries after it. Only the newest `limit`
// entries are kept.

import { LEVEL_OPTIONS } from '../src/core/symbols.js';
import { SCHEME_CHOICES } from '../src/core/scheme.js';
import { PARITY_MAX } from '../src/optimize/probes.js';

const MAX_TEST_COUNTS = 3; // what the phone sends; a report stays small
const COUNT_FIELDS = ['runId', 'probeId', 'packets', 'reads', 'goodReads', 'firstMs', 'lastMs'];

const isCount = (v) => typeof v === 'number' && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const countOrNull = (v) => (isCount(v) ? v : null);

// Reports come from whatever can reach the server: only what a phone would send is kept.
function cleanTestCounts(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const c of list) {
    if (clean.length === MAX_TEST_COUNTS) break;
    if (c && COUNT_FIELDS.every((f) => isCount(c[f]))) clean.push(Object.fromEntries(COUNT_FIELDS.map((f) => [f, c[f]])));
  }
  return clean;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BEST_FIELDS = ['blockSize', 'scheme', 'levels', 'parity', 'fps', 'white', 'bytesPerSecond'];

// The phone's recommended setting, kept only when every field is one the Send page could apply.
function cleanBest(b) {
  if (!b || typeof b !== 'object') return null;
  const ok = isInt(b.blockSize, 1, 200) && isInt(b.parity, 0, PARITY_MAX) && b.parity % 2 === 0 && isInt(b.white, 1, 255)
    && typeof b.fps === 'number' && b.fps > 0 && b.fps <= 60
    && LEVEL_OPTIONS.includes(b.levels) && SCHEME_CHOICES.some((c) => c.id === b.scheme)
    && typeof b.bytesPerSecond === 'number' && Number.isFinite(b.bytesPerSecond) && b.bytesPerSecond >= 0;
  return ok ? Object.fromEntries(BEST_FIELDS.map((f) => [f, b[f]])) : null;
}

/**
 * @param {number} [limit]
 * @returns {{ add(entry: { tests: object, health: object, collector: object, testCounts: object[], cameraReads: number, markerReads: number, widthShare: number }, nowMs: number): number,
 *   since(seq: number): { seq: number, entries: Array<{ seq: number, atMs: number, tests: object, health: object, collector: object }> } }}
 */
export function createFeedbackBuffer(limit = 300) {
  const entries = [];
  let seq = 0;
  return {
    add({ tests, health, collector, attemptMs, testCounts, cameraReads, markerReads, widthShare, setup }, nowMs) {
      seq++;
      entries.push({
        seq, atMs: nowMs, tests: tests ?? {}, health: health ?? null, collector: collector ?? null, attemptMs: attemptMs ?? [],
        testCounts: cleanTestCounts(testCounts), cameraReads: countOrNull(cameraReads), markerReads: countOrNull(markerReads),
        probeBest: cleanBest(setup?.best),
        widthShare: typeof widthShare === 'number' && widthShare >= 0 && widthShare <= 1 ? widthShare : null,
      });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return seq;
    },
    since(after) {
      return { seq, entries: entries.filter((e) => e.seq > after) };
    },
  };
}
